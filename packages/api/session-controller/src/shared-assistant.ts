/** Cumulative cross-replica Assistant state projected onto the existing dense follow protocol. */

import { expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionEvent, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionAssistantStreamAttempt, SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SessionFollowFrame } from './types.ts'

/** A publisher bound to one immutable execution reservation, never its successor. */
export interface SharedAssistantWriter {
  /**
   * Replace the cumulative transient state after verifying the captured reservation.
   * @param baseline - current compact stream state; no binary attachment bytes.
   */
  publish(baseline: SessionAssistantStreamBaseline): Promise<void>
}

/** Optional shared transport for the current Assistant attempt, separate from durable Session events. */
export interface SharedAssistantStateStore {
  /**
   * Capture the currently owned execution reservation.
   * @param id - Session being executed on this replica.
   * @returns a publisher that permanently refuses a lost or replaced reservation.
   */
  createWriter(id: SessionId): SharedAssistantWriter
  /**
   * Read the current owner's cumulative state, without activating an Agent.
   * @param id - authorized Session identity.
   * @returns detached state, or undefined if no live owner has published any.
   */
  read(id: SessionId): Promise<SessionAssistantStreamBaseline | undefined>
}

/** Coalesce transient changes without serializing the complete stream for every token. */
export class SharedAssistantPublication {
  private changed = false
  private closing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private draining: Promise<void> | undefined

  /**
   * @param writer - immutable reservation-bound publisher.
   * @param snapshot - latest in-memory cumulative state.
   * @param intervalMs - deployment's shared observation interval.
   * @param report - error sink for asynchronous transport failures.
   */
  constructor(
    private readonly writer: SharedAssistantWriter,
    private readonly snapshot: () => SessionAssistantStreamBaseline,
    private readonly intervalMs: number,
    private readonly report: (error: unknown) => void,
  ) {}

  /** Mark the cumulative state dirty and arm one publication window. */
  update(): void {
    if (this.closing) return
    this.changed = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(this.report)
    }, this.intervalMs)
  }

  /** Join the pending publication and drain through its latest observed state. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    return this.draining ??= this.drain().finally(() => { this.draining = undefined })
  }

  /** Stop accepting updates and await every admitted publication. */
  close(): Promise<void> {
    this.closing = true
    return this.flush()
  }

  private async drain(): Promise<void> {
    while (this.changed) {
      this.changed = false
      try { await this.writer.publish(this.snapshot()) }
      catch (error) { this.changed = true; throw error }
    }
  }
}

/** One follower's dense transient sequence, reconciled with committed settlements. */
export class SharedAssistantFollower {
  private active: SessionAssistantStreamAttempt | undefined
  private revision = 0
  private settledThrough = -1

  /**
   * Initialize the follower from one durable cut and a possibly newer shared baseline.
   * @param events - durable events represented by the opening history.
   * @param baseline - cumulative transient state from the current execution owner.
   * @returns a baseline whose active attempt is not already durably settled.
   */
  opening(events: readonly SessionEvent[], baseline: SessionAssistantStreamBaseline | undefined): SessionAssistantStreamBaseline {
    for (const event of events) this.noteSettlement(event)
    const candidate = baseline?.activeAttempt
    const cursor = events.at(-1)?.seq ?? -1
    if (candidate !== undefined && candidate.startedAfterSeq >= this.settledThrough && candidate.startedAfterSeq <= cursor) {
      this.active = candidate
    }
    return { revision: this.revision, ...(this.active === undefined ? {} : { activeAttempt: this.active }) }
  }

  /**
   * Deliver missing chunks before the durable settlement they belong to.
   * @param event - next contiguous committed Session event.
   * @returns durable and transient frames in Client publication order.
   */
  *acceptEvent(event: SessionEvent): Generator<SessionFollowFrame> {
    const active = this.active
    const settlement = event.type === 'assistant/message' || event.type === 'assistant/attempt' ? event : undefined
    const matches = active !== undefined && settlement !== undefined
      && settlement.seq > active.startedAfterSeq && settlement.data.turn === active.turn && settlement.data.step === active.step
    if (matches) yield* this.chunks(active, settlement.data.stream)
    yield { type: 'event', event: event as unknown as Extract<SessionFollowFrame, { type: 'event' }>['event'] }
    if (matches) {
      yield this.frame({
        type: 'end', attemptId: active.attemptId, revision: ++this.revision, index: this.active?.nextIndex ?? active.nextIndex,
        outcome: { kind: 'committed', eventType: settlement.type, seq: settlement.seq },
      })
      this.active = undefined
    }
    this.noteSettlement(event)
  }

  /**
   * Project a cumulative snapshot into exactly the chunks not yet delivered.
   * @param baseline - latest state, absent after lease loss or normal release.
   * @param durableCursor - latest committed event already sent to this follower.
   * @returns dense start/chunk/abandonment frames.
   */
  *update(baseline: SessionAssistantStreamBaseline | undefined, durableCursor: SessionSeqCursor): Generator<SessionFollowFrame> {
    let candidate = baseline?.activeAttempt
    if (candidate !== undefined && candidate.startedAfterSeq > durableCursor) return
    if (candidate !== undefined && candidate.startedAfterSeq < this.settledThrough) candidate = undefined
    if (this.active !== undefined && this.active.attemptId !== candidate?.attemptId) {
      yield this.frame({
        type: 'end', attemptId: this.active.attemptId, revision: ++this.revision,
        index: this.active.nextIndex, outcome: { kind: 'abandoned' },
      })
      this.active = undefined
    }
    if (candidate === undefined) return
    if (this.active === undefined) {
      this.active = { ...candidate, nextIndex: 0 }
      yield this.frame({
        type: 'start', attemptId: candidate.attemptId, revision: ++this.revision,
        startedAfterSeq: candidate.startedAfterSeq, turn: candidate.turn, step: candidate.step,
      })
    }
    yield* this.chunks(this.active, candidate.stream as unknown as readonly AssistantStreamRecord[])
    if (this.active.nextIndex !== candidate.nextIndex) throw new Error('shared Assistant state has an inconsistent chunk count')
  }

  private *chunks(active: SessionAssistantStreamAttempt, stream: readonly AssistantStreamRecord[]): Generator<SessionFollowFrame> {
    let index = 0
    for (const member of expandAssistantStream(stream)) {
      if (index >= active.nextIndex) {
        yield this.frame({
          type: 'chunk', attemptId: active.attemptId, revision: ++this.revision, index,
          time: member.time, chunk: member.chunk as unknown as JsonValue,
        })
      }
      index++
    }
    if (index < active.nextIndex) throw new Error('shared Assistant state moved behind its delivered prefix')
    this.active = { ...active, nextIndex: index }
  }

  private frame(frame: SessionAssistantStreamFrame): SessionFollowFrame { return { type: 'assistant-stream', frame } }

  private noteSettlement(event: SessionEvent): void {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      this.settledThrough = Math.max(this.settledThrough, event.seq)
    }
  }
}
