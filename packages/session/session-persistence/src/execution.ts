/** Shared-storage execution ownership for request-scoped session activation. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** A renewable execution reservation; release only after the agent and its writes stop. */
export interface SessionExecutionLease extends AsyncDisposable {
  /** Aborts when ownership is lost or a user requests cancellation. */
  readonly signal: AbortSignal
}

/** Backend-owned exclusion and cancellation, independent of replica addresses. */
export interface SharedSessionExecution {
  /** Polling interval for committed history and cancellation. */
  readonly pollIntervalMs: number
  /**
   * Reserve a session before reading or recovering its mutable log.
   * @param id - session to execute or create.
   * @returns a renewable reservation, rejecting while another operation owns it.
   */
  acquire(id: SessionId): Promise<SessionExecutionLease>
  /**
   * Test whether this process currently holds the reservation.
   * @param id - session identity.
   * @returns local reservation presence, not proof of database ownership.
   */
  owns(id: SessionId): boolean
  /**
   * Verify ownership against authoritative storage before executing work.
   * @param id - reserved session identity.
   */
  assertOwned(id: SessionId): Promise<void>
  /**
   * Read whether a nonexpired operation owns this session.
   * @param id - session identity authorized by its persisted header.
   * @returns whether a reservation remains active.
   */
  active(id: SessionId): Promise<boolean>
  /**
   * Request cancellation through shared storage.
   * @param id - session identity authorized by its persisted header.
   */
  cancel(id: SessionId): Promise<void>
}
