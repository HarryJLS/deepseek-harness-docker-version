/** Renewable, transaction-fenced session reservations stored in the existing MySQL KV table. */

import { randomUUID } from 'node:crypto'
import type mysql from 'mysql2/promise'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionExecutionLease, SharedSessionExecution } from '@deepseek-ai/dsh-session-persistence'
import {
  assertMysqlTable, mysqlAuditValues, mysqlTable, MYSQL_AUDIT_COLUMNS, MYSQL_AUDIT_VALUES,
} from '@deepseek-ai/dsh-mysql-schema'
import { canAccessUser, currentUserId, parseUserId } from '@deepseek-ai/dsh-user-context'

const TABLE = mysqlTable('kv_record')
const UNIT = 'dsh-session-execution'

/** Deployment-owned execution and observation timings. */
export interface SharedExecutionConfig {
  /** Reservation lifetime after its most recent successful database renewal. */
  leaseMs: number
  /** Renewal interval; must leave at least two further renewal opportunities. */
  renewIntervalMs: number
  /** Committed-history and cancellation observation interval. */
  pollIntervalMs: number
}

/** Nacos/Loader validation for shared session execution. */
export const SharedExecutionConfig: z<SharedExecutionConfig> = z.object({
  leaseMs: z.number().step(1).min(3000).max(300_000).default(30_000),
  renewIntervalMs: z.number().step(1).min(100).max(100_000).default(5000),
  pollIntervalMs: z.number().step(1).min(100).max(10_000).default(500),
})

interface Reservation {
  token: string
  expiresAt: number
  cancelled: boolean
}

interface OwnedReservation {
  token: string
  abort: AbortController
}

/** Shares short-lived execution ownership without relying on Redis eviction or node identity. */
export class MysqlSessionExecution implements SharedSessionExecution {
  readonly pollIntervalMs: number
  private readonly owned = new Map<SessionId, OwnedReservation>()
  private readonly releases = new Set<() => Promise<void>>()

  /**
   * @param pool - database pool shared with the session writer.
   * @param app - application row namespace.
   * @param nextId - replica-specific Snowflake generator.
   * @param config - validated timing settings.
   */
  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    private readonly nextId: () => string,
    private readonly config: SharedExecutionConfig,
  ) {
    if (config.renewIntervalMs * 3 > config.leaseMs) {
      throw new Error('shared execution leaseMs must be at least three renewIntervalMs')
    }
    this.pollIntervalMs = config.pollIntervalMs
  }

  /** Verify the DBA-provisioned KV table before admitting any execution. */
  async init(): Promise<void> {
    await assertMysqlTable(this.pool, TABLE, ['unit', 'tbl', 'key_name'])
  }

  owns(id: SessionId): boolean {
    return this.owned.has(id)
  }

  async acquire(id: SessionId): Promise<SessionExecutionLease> {
    await this.authorize(id, true)
    if (this.owned.has(id)) throw new Error('This conversation is busy. Please retry after the current operation finishes.')
    const owner = { token: randomUUID(), abort: new AbortController() }
    this.owned.set(id, owner)
    const started = performance.now()
    try {
      await this.transaction(async (conn) => {
        await conn.query(
          `INSERT INTO \`${TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, tbl, key_name, value)
           VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, 'leases', ?, ?)
           ON DUPLICATE KEY UPDATE key_name = key_name`,
          [...mysqlAuditValues(this.nextId), this.app, UNIT, id,
            JSON.stringify({ token: '', expiresAt: 0, cancelled: false })],
        )
        const row = await this.read(conn, id, true)
        if (row.value.expiresAt > row.now) throw new Error('This conversation is busy. Please retry after the current operation finishes.')
        await this.write(conn, id, { token: owner.token, expiresAt: row.now + this.config.leaseMs, cancelled: false })
      })
    } catch (error) {
      this.owned.delete(id)
      throw error
    }
    let closed = false
    let lastRenewal = started
    let renewal: Promise<void> = Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setTimeout>
    const armWatchdog = (since: number): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        owner.abort.abort(new Error('Session execution ownership expired.'))
      }, Math.max(0, this.config.leaseMs - (performance.now() - since)))
      watchdog.unref()
    }
    armWatchdog(started)
    const schedule = (): void => {
      timer = setTimeout(() => {
        const since = performance.now()
        let renewed = false
        renewal = this.transaction(async (conn) => {
          const row = await this.assertTransaction(conn, id)
          if (row.value.cancelled) owner.abort.abort(new Error('Session execution was cancelled.'))
          if (since - lastRenewal >= this.config.renewIntervalMs) {
            await this.write(conn, id, { ...row.value, expiresAt: row.now + this.config.leaseMs })
            renewed = true
          }
        }).then(() => {
          if (!closed) {
            if (renewed) {
              lastRenewal = since
              armWatchdog(since)
            }
            schedule()
          }
        }, (error: unknown) => { owner.abort.abort(error) })
      }, Math.min(this.config.renewIntervalMs, this.config.pollIntervalMs))
      timer.unref()
    }
    schedule()
    const release = async (): Promise<void> => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      await renewal
      try {
        await this.transaction(async (conn) => {
          const row = await this.read(conn, id, true)
          if (row.value.token !== owner.token) return
          await conn.query(
            `DELETE FROM \`${TABLE}\` WHERE app = ? AND unit = ? AND tbl = 'leases' AND key_name = ?`,
            [this.app, UNIT, id],
          )
        })
      } finally {
        this.owned.delete(id)
        this.releases.delete(release)
      }
    }
    this.releases.add(release)
    return { signal: owner.abort.signal, [Symbol.asyncDispose]: release }
  }

  async assertOwned(id: SessionId): Promise<void> {
    const owner = this.owned.get(id)
    if (owner === undefined) throw new Error('Session execution requires an exclusive reservation.')
    owner.abort.signal.throwIfAborted()
    await this.transaction(async (conn) => { await this.assertTransaction(conn, id) })
  }

  /**
   * Fence a session write in the same transaction as its event INSERTs.
   * @param conn - active writer transaction.
   * @param id - session being written.
   * @returns authoritative reservation and database time while its row is locked.
   */
  async assertTransaction(
    conn: mysql.PoolConnection,
    id: SessionId,
  ): Promise<{ value: Reservation; now: number }> {
    const owner = this.owned.get(id)
    const row = await this.read(conn, id, true)
    if (owner === undefined || row.value.token !== owner.token || row.value.expiresAt <= row.now) {
      throw new Error('Session execution ownership was lost; this writer cannot commit.')
    }
    return row
  }

  async active(id: SessionId): Promise<boolean> {
    await this.authorize(id)
    const row = await this.read(this.pool, id)
    return row.value.expiresAt > row.now
  }

  async cancel(id: SessionId): Promise<void> {
    await this.authorize(id)
    await this.transaction(async (conn) => {
      const row = await this.read(conn, id, true)
      if (row.value.expiresAt > row.now) await this.write(conn, id, { ...row.value, cancelled: true })
    })
  }

  /** Release all admitted reservations before the owning database pool closes. */
  async close(): Promise<void> {
    await Promise.all([...this.releases].map(release => release()))
  }

  private async authorize(id: SessionId, allowMissing = false): Promise<void> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT user_id FROM \`${mysqlTable('session')}\` WHERE app = ? AND session_id = ? AND is_deleted = 'N'`,
      [this.app, id],
    )
    if (rows.length === 0 ? !allowMissing : !canAccessUser(parseUserId(rows[0]?.user_id))) {
      throw new Error('Session not found.')
    }
  }

  private async read(conn: mysql.Pool | mysql.PoolConnection, id: SessionId, lock = false):
  Promise<{ value: Reservation; now: number }> {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT value, ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms
       FROM \`${TABLE}\` WHERE app = ? AND unit = ? AND tbl = 'leases' AND key_name = ?${lock ? ' FOR UPDATE' : ''}`,
      [this.app, UNIT, id],
    )
    if (rows.length === 0) return { value: { token: '', expiresAt: 0, cancelled: false }, now: 0 }
    const value = rows[0]?.value as Partial<Reservation> | null
    const now = Number(rows[0]?.now_ms)
    if (value === null || typeof value !== 'object'
      || typeof value.token !== 'string' || !Number.isSafeInteger(value.expiresAt)
      || typeof value.cancelled !== 'boolean' || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('Malformed session execution reservation.')
    }
    return { value: value as Reservation, now }
  }

  private async write(conn: mysql.PoolConnection, id: SessionId, value: Reservation): Promise<void> {
    await conn.query(
      `UPDATE \`${TABLE}\` SET value = ?, modifier = ?, gmt_modified = CURRENT_TIMESTAMP
       WHERE app = ? AND unit = ? AND tbl = 'leases' AND key_name = ?`,
      [JSON.stringify(value), currentUserId(), this.app, UNIT, id],
    )
  }

  private async transaction(operation: (conn: mysql.PoolConnection) => Promise<void>): Promise<void> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      await operation(conn)
      await conn.commit()
    } catch (error) {
      await conn.rollback().catch(() => undefined)
      throw error
    } finally {
      conn.release()
    }
  }
}
