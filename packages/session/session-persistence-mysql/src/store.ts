/** Transactional OceanBase/MySQL session rows, scoped by application and durable user ownership. */

import mysql from 'mysql2/promise'
import {
  assertMysqlTable, mysqlTable, tablesPresent, toJsonText, mysqlIdGenerator, mysqlAuditValues,
  MYSQL_AUDIT_DDL, MYSQL_AUDIT_COLUMNS, MYSQL_AUDIT_VALUES,
} from '@deepseek-ai/dsh-mysql-schema'
import { canAccessUser, DEFAULT_USER_ID, parseUserId, requestUserId, type UserId } from '@deepseek-ai/dsh-user-context'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

const SESSION_TABLE = mysqlTable('session')
const EVENT_TABLE = mysqlTable('session_event')

/** Maximum event rows returned by one recovery query. */
export const MYSQL_SESSION_READ_PAGE_SIZE = 1_000

function revisionToken(source: string, row: mysql.RowDataPacket): SessionPersistenceRevision {
  return SessionPersistenceRevision(`${source}:row:${String(row.row_id)}:revision:${String(row.revision)}`)
}

function toHeader(row: mysql.RowDataPacket, id: SessionId): SessionHeader {
  const value: unknown = row.meta
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session-persistence-mysql: session ${id} has a malformed header`)
  }
  const header = value as SessionHeader
  if (header.id !== id || (header.userId ?? DEFAULT_USER_ID) !== parseUserId(row.user_id)) {
    throw new Error(`session-persistence-mysql: session ${id} has conflicting ownership metadata`)
  }
  return header
}

/** MySQL implementation of the persistence coordinator's durable operations. */
export class MysqlSessionStore implements PersistenceBackend<never> {
  readonly name = 'session-persistence-mysql'
  private readonly source: string
  private readonly nextId: () => string

  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    database: string,
    snowflakeWorkerId = 0,
  ) {
    this.source = `mysql:${database}:${app}`
    this.nextId = mysqlIdGenerator(snowflakeWorkerId)
  }

  /** Create missing tables, then reject incompatible existing layouts without altering data. */
  async migrate(): Promise<void> {
    if (!await tablesPresent(this.pool, [SESSION_TABLE, EVENT_TABLE])) {
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS \`${SESSION_TABLE}\` (
           ${MYSQL_AUDIT_DDL},
           app        varchar(64)  NOT NULL,
           session_id varchar(128) NOT NULL,
           user_id    varchar(32)  NOT NULL DEFAULT '-' COMMENT '所属用户',
           meta       json         NOT NULL,
           revision   bigint       NOT NULL DEFAULT 0,
           PRIMARY KEY (id),
           UNIQUE KEY dsh_session_identity_uk (app, session_id),
           KEY dsh_session_owner_idx (app, user_id, is_deleted, gmt_created)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
      )
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS \`${EVENT_TABLE}\` (
           ${MYSQL_AUDIT_DDL},
           app        varchar(64)  NOT NULL,
           session_id varchar(128) NOT NULL,
           user_id    varchar(32)  NOT NULL DEFAULT '-' COMMENT '所属用户',
           seq        int          NOT NULL,
           event      json         NOT NULL,
           PRIMARY KEY (id),
           UNIQUE KEY dsh_session_event_sequence_uk (app, session_id, seq),
           CONSTRAINT dsh_session_event_session_fk FOREIGN KEY (app, session_id)
             REFERENCES \`${SESSION_TABLE}\` (app, session_id) ON DELETE CASCADE
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
      )
    }
    await assertMysqlTable(this.pool, SESSION_TABLE, ['session_id', 'user_id'])
    await assertMysqlTable(this.pool, EVENT_TABLE, ['session_id', 'user_id'])
  }

  private ownerPredicate(): { sql: string; values: string[] } {
    const userId = requestUserId()
    return userId === undefined ? { sql: '', values: [] } : { sql: ' AND user_id = ?', values: [userId] }
  }

  private async header(id: SessionId): Promise<mysql.RowDataPacket | undefined> {
    const owner = this.ownerPredicate()
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, meta, revision, user_id FROM \`${SESSION_TABLE}\`
       WHERE app = ? AND session_id = ? AND is_deleted = 'N'${owner.sql}`,
      [this.app, id, ...owner.values],
    )
    return rows[0]
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id)
    if (row === undefined) return undefined
    const meta = toHeader(row, id)
    const events = await this.readEvents(id, meta.userId ?? DEFAULT_USER_ID, 0, signal)
    return { meta, events, revision: revisionToken(this.source, row) }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id)
    signal?.throwIfAborted()
    return row === undefined ? undefined : revisionToken(this.source, row)
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id)
    if (row === undefined) return undefined
    const meta = toHeader(row, id)
    return { meta, events: await this.readEvents(id, meta.userId ?? DEFAULT_USER_ID, fromSeq, signal) }
  }

  /** Materialize a header without changing the owner of an existing identity. */
  async materializeHeader(meta: SessionHeader): Promise<void> {
    await this.transaction(async (conn) => {
      await this.insertHeader(conn, meta, 1)
      await this.lockOwner(conn, meta)
    })
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.transaction(async (conn) => {
      if (!isMaterialized) await this.insertHeader(conn, meta, 0)
      await this.lockOwner(conn, meta)
      await this.insertEvents(conn, meta, events)
      await this.bumpRevision(conn, meta)
    })
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length === 0) return
    await this.transaction(async (conn) => {
      await this.lockOwner(conn, meta)
      await this.insertEvents(conn, meta, closers)
      await this.bumpRevision(conn, meta)
    })
  }

  private async transaction(operation: (conn: mysql.PoolConnection) => Promise<void>): Promise<void> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      await operation(conn)
      await conn.commit()
    } catch (error) {
      // A dropped connection can also reject rollback; retain the write failure.
      await conn.rollback().catch(() => undefined)
      throw error
    } finally {
      conn.release()
    }
  }

  private async insertHeader(conn: mysql.PoolConnection, meta: SessionHeader, revision: number): Promise<void> {
    const owner = meta.userId ?? DEFAULT_USER_ID
    if (!canAccessUser(owner)) throw new Error('session-persistence-mysql: session not found')
    await conn.query(
      `INSERT INTO \`${SESSION_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, session_id, user_id, meta, revision)
       VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE session_id = session_id`,
      [...mysqlAuditValues(this.nextId, owner), this.app, meta.id, owner, toJsonText(meta), revision],
    )
  }

  /** Lock the immutable owner before appending, including concurrent explicit-id creation. */
  private async lockOwner(conn: mysql.PoolConnection, meta: SessionHeader): Promise<void> {
    const owner = meta.userId ?? DEFAULT_USER_ID
    if (!canAccessUser(owner)) throw new Error('session-persistence-mysql: session not found')
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT user_id FROM \`${SESSION_TABLE}\`
       WHERE app = ? AND session_id = ? AND is_deleted = 'N' FOR UPDATE`,
      [this.app, meta.id],
    )
    if (rows[0]?.user_id !== owner) throw new Error('session-persistence-mysql: session not found')
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listSnapshots(signal)).map(snapshot => snapshot.header)
  }

  /**
   * List active session revisions belonging to the current user, or all for Host maintenance.
   * @param signal - optional cancellation for the read.
   * @returns snapshots in creation order.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const owner = this.ownerPredicate()
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, session_id, meta, revision, user_id FROM \`${SESSION_TABLE}\`
       WHERE app = ? AND is_deleted = 'N'${owner.sql} ORDER BY gmt_created ASC, id ASC`,
      [this.app, ...owner.values],
    )
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: toHeader(row, row.session_id as SessionId),
      revision: revisionToken(this.source, row),
    }))
  }

  locate(): undefined { return undefined }

  async close(): Promise<void> { await this.pool.end() }

  private async readEvents(id: SessionId, owner: UserId, fromSeq: number, signal?: AbortSignal): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    let afterSeq = fromSeq - 1
    for (;;) {
      signal?.throwIfAborted()
      const [page] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT seq, event FROM \`${EVENT_TABLE}\`
         WHERE app = ? AND session_id = ? AND user_id = ? AND is_deleted = 'N' AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
        [this.app, id, owner, afterSeq, MYSQL_SESSION_READ_PAGE_SIZE],
      )
      signal?.throwIfAborted()
      for (const entry of page) events.push(entry.event as SessionEvent)
      if (page.length < MYSQL_SESSION_READ_PAGE_SIZE) break
      const nextSeq: unknown = page.at(-1)?.seq
      if (typeof nextSeq !== 'number' || !Number.isSafeInteger(nextSeq) || nextSeq <= afterSeq) {
        throw new Error(`session-persistence-mysql: invalid event page cursor for session ${id}`)
      }
      afterSeq = nextSeq
    }
    return events
  }

  private async insertEvents(conn: mysql.PoolConnection, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return
    const owner = meta.userId ?? DEFAULT_USER_ID
    const values: unknown[] = []
    const tuples = events.map((event) => {
      values.push(...mysqlAuditValues(this.nextId, owner), this.app, meta.id, owner, event.seq, toJsonText(event))
      return `(${MYSQL_AUDIT_VALUES}, ?, ?, ?, ?, ?)`
    })
    await conn.query(
      `INSERT INTO \`${EVENT_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, session_id, user_id, seq, event)
       VALUES ${tuples.join(', ')}`, values,
    )
  }

  private async bumpRevision(conn: mysql.PoolConnection, meta: SessionHeader): Promise<void> {
    await conn.query(
      `UPDATE \`${SESSION_TABLE}\` SET revision = revision + 1, modifier = ?, gmt_modified = CURRENT_TIMESTAMP
       WHERE app = ? AND session_id = ? AND user_id = ? AND is_deleted = 'N'`,
      [meta.userId ?? DEFAULT_USER_ID, this.app, meta.id, meta.userId ?? DEFAULT_USER_ID],
    )
  }
}
