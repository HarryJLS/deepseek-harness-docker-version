/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { canAccessUser, requestUserId } from '@deepseek-ai/dsh-user-context'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAddress,
  SessionAssistantStreamFrame,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionWireHeader,
  SessionWireEvent,
} from './types.ts'
import { SessionAssistantStreamAccumulator } from './assistant-stream.ts'
import { SharedAssistantFollower, SharedAssistantPublication } from './shared-assistant.ts'
import type { SharedAssistantStateStore } from './shared-assistant.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()
  private readonly assistantStreams = new Map<SessionId, SessionAssistantStreamAccumulator>()
  private sharedAssistantState: SharedAssistantStateStore | undefined
  private readonly sharedPublications = new Map<SessionId, SharedAssistantPublication>()
  private readonly closingPublications = new Set<Promise<void>>()

  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
  ) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let stream = this.assistantStreams.get(agent.session.id)
      if (stream === undefined) {
        stream = new SessionAssistantStreamAccumulator()
        this.assistantStreams.set(agent.session.id, stream)
      }
      stream.accept(frame, cursorBeforeNext(agent.session.seq))
      if (this.sharedAssistantState !== undefined) {
        let publication = this.sharedPublications.get(agent.id)
        if (publication === undefined) {
          const state = stream
          const interval = this.ctx.get('sessionPersistence')?.sharedExecution?.pollIntervalMs
          if (interval === undefined) throw new Error('shared Assistant transport requires shared execution')
          publication = new SharedAssistantPublication(
            this.sharedAssistantState.createWriter(agent.id), () => state.snapshot(), interval,
            (error) => { ctx.logger.warn('shared Assistant publication failed: %s', String(error)) },
          )
          this.sharedPublications.set(agent.id, publication)
        }
        publication.update()
      }
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.assistantStreams.delete(agent.session.id)
      const publication = this.sharedPublications.get(agent.id)
      if (publication !== undefined) {
        this.sharedPublications.delete(agent.id)
        const closing = publication.close()
        this.closingPublications.add(closing)
        void closing.catch((error: unknown) => {
          ctx.logger.warn('shared Assistant transport close failed: %s', String(error))
        }).finally(() => { this.closingPublications.delete(closing) })
      }
    }, { global: true })
    ctx.on('session/flush', session => this.sharedPublications.get(session.id)?.flush())
    ctx.effect(() => async () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
      await Promise.all([
        ...this.closingPublications,
        ...[...this.sharedPublications.values()].map(publication => publication.close()),
      ])
      this.sharedPublications.clear()
    }, 'session-controller.history')
  }

  /**
   * Supply the shared transient-state provider used by cross-replica followers.
   * @param store - storage whose publishers are bound to immutable execution reservations.
   * @returns disposer removing the same provider.
   */
  registerSharedAssistantState(store: SharedAssistantStateStore): () => void {
    if (this.sharedAssistantState !== undefined) throw new Error('shared Assistant transport is already registered')
    this.sharedAssistantState = store
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.sharedAssistantState === store) this.sharedAssistantState = undefined
    }
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const throughSeq: SessionSeqCursor = request.throughSeq === -1
      ? -1
      : SessionSeq(request.throughSeq)
    const beforeSeq = request.beforeSeq === undefined
      ? undefined
      : SessionLogOffset(request.beforeSeq)
    if (this.ctx.get('sessionPersistence')?.sharedExecution !== undefined) {
      const source = await this.sharedSource(request.address, signal)
      if (throughSeq > (source.events.at(-1)?.seq ?? -1)) {
        throw new RemoteError('gateway/bad-request', 'session page cursor is past the committed log', {})
      }
      const page = paginate(source.events, beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, throughSeq)
      return { records: pageRecords(page.events), hasMore: page.hasMore }
    }
    using source = await this.sourceFor(request.address, signal, false)
    signal.throwIfAborted()
    const sourceLog = source.events
    const sourceCursor: SessionSeqCursor = sourceLog.at(-1)?.seq ?? -1
    if (throughSeq > sourceCursor) {
      throw new RemoteError(
        'gateway/bad-request',
        `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
    if (throughSeq >= 0 && sourceLog[throughSeq]?.seq !== throughSeq) {
      throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(throughSeq)}`, {})
    }
    const page = paginate(
      sourceLog,
      beforeSeq,
      request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      throughSeq,
    )
    const records = pageRecords(page.events)
    return {
      records,
      hasMore: page.hasMore,
    }
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free durable events and opted-in assistant frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateFollowRequest(request)
    if (this.ctx.get('sessionPersistence')?.sharedExecution !== undefined) {
      yield* this.followShared(request, signal)
      return
    }
    const { address } = request
    const target = addressId(address)
    const userId = requestUserId()
    const buffered = new Deque<
      | { readonly type: 'event'; readonly event: SessionEvent }
      | {
        readonly type: 'assistant-stream'
        readonly frame: SessionAssistantStreamFrame
        readonly ordinal: number
      }
    >()
    let snapshotCursor: SessionSeqCursor | undefined
    let assistantStreamOrdinal = 0
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id !== target || (userId !== undefined && !canAccessUser(session.header.userId, userId))) return
      buffered.pushBack({ type: 'event', event })
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target || (userId !== undefined && !canAccessUser(session.header.userId, userId))) return
      // Constructor seed events have no session/event notification. Normally
      // only the end-seed suffix is new; if persistence advanced after the
      // opening observation, replay everything beyond that snapshot cursor.
      const suffix = session.snapshotEvents(snapshotCursor === undefined
        ? session.firstLiveSeq
        : SessionLogOffset(snapshotCursor + 1))
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        buffered.pushFront({ type: 'event', event: suffix[index] as SessionEvent })
      }
      notify()
    }, { global: true })
    const disposeAssistantStream = request.assistantStream !== true
      ? undefined
      : this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== target || (userId !== undefined && !canAccessUser(agent.session.header.userId, userId))) return
        buffered.pushBack({
          type: 'assistant-stream',
          frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)),
          ordinal: ++assistantStreamOrdinal,
        })
        notify()
      }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      using source = await this.sourceFor(address, signal, true)
      const events = source.events
      signal.throwIfAborted()
      const cursor = source.cursor
      snapshotCursor = cursor
      const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
      const assistantStream = request.assistantStream === true
        ? this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 }
        : undefined
      // The accumulator snapshot and this watermark are synchronous. Frames
      // through the cut are represented or superseded by that baseline,
      // including larger revisions from a retired Agent; later revision
      // resets reach Client continuity validation.
      const assistantStreamOrdinalCut = assistantStreamOrdinal
      yield {
        type: 'snapshot',
        header: wireHeader(source.header),
        cursor,
        records: pageRecords(page.events),
        hasMore: page.hasMore,
        projections: source.projections === undefined
          ? { asOfSeq: cursor, values: {} }
          : projectionBlock(source.projections),
        ...assistantStream === undefined ? {} : { assistantStream },
      }
      if (address.kind === 'session' && source.source === 'prepared') {
        const promotion = source.retain()
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      }
      let nextOffset = SessionLogOffset(cursor + 1)
      while (!follower.closed && !signal.aborted) {
        const item = buffered.popFront()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.type === 'assistant-stream') {
          if (item.ordinal > assistantStreamOrdinalCut) {
            yield { type: 'assistant-stream', frame: item.frame }
          }
          continue
        }
        const expectedSeq = SessionSeq(nextOffset)
        if (item.event.seq < expectedSeq) continue
        if (item.event.seq !== expectedSeq) {
          throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
        }
        nextOffset = SessionLogOffset(nextOffset + 1)
        yield entryFor(item.event)
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
      disposeAssistantStream?.()
    }
  }

  private async sharedSource(address: SessionAddress, signal: AbortSignal) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Shared history requires session persistence.')
    await using reader = await persistence.open(addressId(address), 'read', { signal })
    const meta = reader.header
    if (meta.cwd === undefined || !canAccessUser(meta.userId)) rejectNotFound(address)
    const { events } = await reader.read(0, undefined, { signal })
    const inheritedEventCount = reader.inheritedEventCount
    const projected = this.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), meta, inheritedEventCount)
    validateAddress(address, meta, inheritedEventCount, projected.snapshot)
    return { meta, events, inheritedEventCount, ...projected }
  }

  private async *followShared(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const lifetime = new AbortController()
    const close = (): void => { lifetime.abort() }
    this.closeFollowers.add(close)
    const combined = AbortSignal.any([signal, lifetime.signal])
    try {
      yield* this.followSharedCore(request, combined)
    } catch (error) {
      if (!combined.aborted) throw error
    } finally {
      this.closeFollowers.delete(close)
    }
  }

  private async *followSharedCore(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const cancelled = (): boolean => signal.aborted
    const persistence = this.ctx.get('sessionPersistence')
    const execution = persistence?.sharedExecution
    if (persistence === undefined || execution === undefined) throw new Error('Shared history is unavailable.')
    const sharedState = request.assistantStream === true ? this.sharedAssistantState : undefined
    if (request.assistantStream === true && sharedState === undefined) throw new Error('Shared Assistant transport is unavailable.')
    const source = await this.sharedSource(request.address, signal)
    const id = addressId(request.address)
    const page = paginate(source.events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
    let nextSeq = SessionLogOffset(source.events.length)
    let checkpoint = source.checkpoint
    let snapshot = source.snapshot
    let boundary = source.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')?.type
    let wasRunning: boolean | undefined
    let publishedSeq = -2
    let publishedValues: string | undefined
    const assistant = new SharedAssistantFollower()
    const opening = sharedState === undefined ? undefined : assistant.opening(source.events, await sharedState.read(id))
    yield {
      type: 'snapshot', header: wireHeader(source.meta), cursor: cursorBeforeNext(nextSeq),
      records: pageRecords(page.events), hasMore: page.hasMore,
      projections: projectionBlock(snapshot),
      ...(opening === undefined ? {} : { assistantStream: opening }),
    }
    while (!cancelled()) {
      const running = boundary === 'turn/start' && await execution.active(id)
      const values = JSON.stringify(snapshot.values)
      if (wasRunning !== running || publishedSeq !== snapshot.asOfSeq || publishedValues !== values) {
        yield { type: 'state', running, projections: projectionBlock(snapshot) }
        wasRunning = running
        publishedSeq = snapshot.asOfSeq
        publishedValues = values
      }
      try { await delay(execution.pollIntervalMs, undefined, { signal }) }
      catch (error) { if (!cancelled()) throw error }
      if (cancelled()) return
      const latestAssistant = await sharedState?.read(id)
      await using reader = await persistence.open(id, 'read', { signal })
      const suffix = await reader.read(nextSeq, undefined, { signal })
      let appended = suffix.events
      let projected
      try {
        projected = this.ctx.sessionProjections.restore(checkpoint, appended, nextSeq, reader.header, reader.inheritedEventCount)
      } catch {
        // A preset can register a new unit after the preceding checkpoint.
        const fresh = await this.sharedSource(request.address, signal)
        if (fresh.events.length < nextSeq) throw new RemoteError('gateway/internal', 'shared session history moved behind its cursor', {})
        appended = fresh.events.slice(nextSeq)
        projected = fresh
      }
      checkpoint = projected.checkpoint
      snapshot = projected.snapshot
      for (const event of appended) {
        if (event.seq !== Number(nextSeq)) throw new RemoteError('gateway/internal', 'shared session history has an event gap', {})
        nextSeq = SessionLogOffset(nextSeq + 1)
        if (event.type === 'turn/start' || event.type === 'turn/end') boundary = event.type
        if (sharedState === undefined) yield entryFor(event)
        else yield* assistant.acceptEvent(event)
      }
      if (sharedState !== undefined) yield* assistant.update(latestAssistant, cursorBeforeNext(nextSeq))
    }
  }

  private async sourceFor(
    address: SessionAddress,
    signal: AbortSignal,
    withProjections: boolean,
  ): Promise<SessionObservation> {
    const sessionId = addressId(address)
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal,
        projectionMode: withProjections || address.kind === 'subagent' ? 'all' : 'none',
      })
      if (observation.header.cwd === undefined) {
        observation[Symbol.dispose]()
        rejectNotFound(address)
      }
      try {
        validateAddress(
          address,
          observation.header,
          observation.inheritedEventCount,
          observation.projections,
        )
      } catch (error: unknown) {
        observation[Symbol.dispose]()
        throw error
      }
      return observation
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') rejectNotFound(address)
      throw error
    }
  }

}

function cursorBeforeNext(nextSeq: SessionLogOffsetType): SessionSeqCursor {
  return nextSeq === 0 ? -1 : SessionSeq(nextSeq - 1)
}

function wireAssistantStreamFrame(
  frame: AssistantStreamFrame,
  durableCursor: SessionSeqCursor,
): SessionAssistantStreamFrame {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor }
  if (frame.type === 'end') return frame
  return {
    ...frame,
    chunk: frame.chunk as JsonValue,
  }
}

function projectionBlock(
  snapshot: NonNullable<SessionObservation['projections']>,
): SessionProjectionBaseline {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values as SessionProjectionValues,
  }
}

function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq)
      || request.beforeSeq < 0
      || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function validateFollowRequest(request: SessionFollowRequest): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor = events.at(-1)?.seq ?? -1,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let cut = SessionLogOffset(0)
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      break
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/** Translate current logical Session metadata to the browser wire. */
function wireHeader(header: SessionHeader): SessionWireHeader {
  return { ...header }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return events.map(entryFor)
}
