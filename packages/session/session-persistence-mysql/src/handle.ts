/** Ordered Session handles and retained live-write batches for the MySQL provider. */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  materializeAppendBatch,
  SessionHandleClosedError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess, SessionHandle, SessionHandleAppendOptions, SessionHandleFlushOptions,
  SessionHandleReadOptions, SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'
import type { MysqlStoredSession } from './store.ts'

/** Provider-owned operations captured by a handle without exposing them as service APIs. */
export interface MysqlHandleStorage {
  /** Read a validated suffix or a locally pending empty Session. */
  read(id: SessionId, offset: number, signal?: AbortSignal): Promise<MysqlStoredSession>
  /** Acquire or borrow this process's existing execution reservation. */
  acquire(id: SessionId): Promise<AsyncDisposable>
  /** Commit one contiguous batch, materializing its header when required. */
  append(
    header: SessionHeader, events: readonly SessionEvent[], materialized: boolean, inheritedEventCount: SessionLogOffset,
  ): Promise<void>
  /** Commit an empty header requested by an explicit flush. */
  materialize(header: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>
  /** Withdraw a closed handle and any unmaterialized creation it owns. */
  release(handle: MysqlSessionHandle): void
  /** Report an automatic drain failure without exposing credentials or event contents. */
  report(id: SessionId, error: unknown): void
}

/** Per-handle storage state, separate from the immutable logical header. */
export interface MysqlHandleState {
  /** Number of committed events known by this handle. */
  cursor: number
  /** Whether this creation has reached SQL storage. */
  materialized: boolean
  /** Exact prefix inherited from the fork parent. */
  inheritedEventCount: SessionLogOffset
  /** Physical identity established by an open or first stored read. */
  rowId?: string
}

/** One ordered reader or writer, owning its live buffer through quiescent close. */
export class MysqlSessionHandle implements SessionHandle {
  private chain: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private lease: AsyncDisposable | undefined
  private observedLength = 0
  private buffered: SessionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private paused = false
  private draining: Promise<void> | undefined

  /**
   * @param storage - operations captured from the owning provider.
   * @param header - validated immutable logical metadata.
   * @param access - allowed log operations.
   * @param state - current stored extent and fork metadata.
   * @param batchDelayMs - configured fixed live-write window.
   * @param lease - reservation already acquired for a write open.
   */
  constructor(
    private readonly storage: MysqlHandleStorage,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: MysqlHandleState,
    private readonly batchDelayMs: number,
    lease?: AsyncDisposable,
  ) {
    this.lease = lease
  }

  get id(): SessionId { return this.header.id }
  get inheritedEventCount(): SessionLogOffset { return this.state.inheritedEventCount }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    for (const [name, value] of [['offset', offset], ['length', length]] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError(`read ${name} must be a non-negative safe integer, got ${String(value)}`)
      }
    }
    const stored = await this.storage.read(this.id, offset, options?.signal)
    if (stored.eventCount < this.observedLength) {
      throw new Error(`session "${this.id}": stored log shrank below a previously observed prefix`)
    }
    if (this.state.rowId !== undefined && this.state.rowId !== stored.rowId) {
      throw new Error(`session "${this.id}": its physical database row changed; close this handle and reopen`)
    }
    if (stored.rowId !== '') this.state.rowId = stored.rowId
    this.observedLength = stored.eventCount
    return { eventState: 'detached', events: stored.events.slice(0, length) }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    this.assertWritable('append')
    const batch = materializeAppendBatch(events)
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      await this.persist(batch)
    })
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    this.assertWritable('flush')
    options?.signal?.throwIfAborted()
    await this.drain()
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      if (this.state.materialized) return
      await this.ensureLease()
      await this.storage.materialize(this.header, this.inheritedEventCount)
      this.state.materialized = true
    })
  }

  close(): Promise<void> { return this.closing ??= this.finish() }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  /**
   * Retain a live event until SQL accepts it; a failed automatic drain pauses
   * the timer and leaves the same batch available for an explicit retry.
   * @param event - published immutable event owned by this Session.
   */
  enqueueLive(event: SessionEvent): void {
    this.buffered.push(structuredClone(event))
    if (this.timer !== undefined || this.paused) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain().catch((error: unknown) => { this.storage.report(this.id, error) })
    }, this.batchDelayMs)
  }

  /** Drain all pending events, including those admitted while SQL was writing. */
  drain(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => { this.draining = undefined })
  }

  private async drainBuffered(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    this.paused = false
    while (this.buffered.length > 0) {
      await this.enqueue(async () => {
        const batch = this.buffered.splice(0)
        try {
          await this.persist(materializeAppendBatch(batch))
        } catch (error) {
          this.buffered = batch.concat(this.buffered)
          this.paused = true
          throw error
        }
      })
    }
  }

  private async persist(batch: readonly SessionEvent[]): Promise<void> {
    this.assertWritable('append')
    if (batch.length === 0) return
    assertContiguous(this.id, batch, this.state.cursor)
    await this.ensureLease()
    await this.storage.append(this.header, batch, this.state.materialized, this.inheritedEventCount)
    this.state.materialized = true
    this.state.cursor += batch.length
    this.observedLength = this.state.cursor
  }

  private async ensureLease(): Promise<void> {
    this.lease ??= await this.storage.acquire(this.id)
  }

  private async finish(): Promise<void> {
    const failures: Error[] = []
    try {
      for (;;) {
        await this.drain()
        await this.chain
        if (this.buffered.length === 0) break
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
    await this.chain
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      await this.lease?.[Symbol.asyncDispose]()
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.storage.release(this)
    }
    if (failures.length > 1) throw new AggregateError(failures, `session "${this.id}": close failed`)
    const failure = failures[0]
    if (failure !== undefined) throw failure
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation)
    this.chain = next.then(() => {}, () => {})
    return next
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }

  private assertWritable(operation: string): void {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
  }
}
