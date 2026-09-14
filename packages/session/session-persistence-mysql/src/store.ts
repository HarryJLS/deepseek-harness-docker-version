/** Transactional OceanBase/MySQL session rows, scoped by application and durable user ownership. */

import mysql from 'mysql2/promise'
import {
  assertMysqlTable, mysqlTable, tablesPresent, toJsonText, mysqlIdGenerator, mysqlAuditValues,
  MYSQL_AUDIT_DDL, MYSQL_AUDIT_COLUMNS, MYSQL_AUDIT_VALUES,
} from '@deepseek-ai/dsh-mysql-schema'
import { canAccessUser, DEFAULT_USER_ID, parseUserId, requestUserId } from '@deepseek-ai/dsh-user-context'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  assertVersion,
  SessionAlreadyExistsError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { RedisSessionCache } from './redis-cache.ts'
import type { MysqlSessionExecution } from './execution.ts'

const SESSION_TABLE = mysqlTable('session')
const EVENT_TABLE = mysqlTable('session_event')

/** Maximum event rows returned by one recovery query. */
export const MYSQL_SESSION_READ_PAGE_SIZE = 1_000

function revisionToken(source: string, row: mysql.RowDataPacket): SessionPersistenceRevision {
  return SessionPersistenceRevision(`${source}:row:${String(row.row_id)}:revision:${String(row.revision)}`)
}

/** One current-format SQL event slice and its authoritative database extent. */
export interface MysqlStoredSession {
  /** Immutable logical metadata, without SQL-only inherited-prefix fields. */
  readonly meta: SessionHeader
  /** Exact inherited prefix, stored separately from the logical header. */
  readonly inheritedEventCount: SessionLogOffset
  /** Selected contiguous event slice. */
  readonly events: SessionEvent[]
  /** Physical row identity used to refuse a recreated session. */
  readonly rowId: string
  /** Full event count, even when the returned slice is a suffix. */
  readonly eventCount: number
  /** Change token for the header row and its committed event prefix. */
  readonly revision: SessionPersistenceRevision
}

function toMetadata(row: mysql.RowDataPacket, id: SessionId): Pick<MysqlStoredSession, 'meta' | 'inheritedEventCount'> {
  const value: unknown = row.meta
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session-persistence-mysql: session ${id} has a malformed header`)
  }
  const { inheritedEventCount: storedCut, ...header } = value as SessionHeader & { inheritedEventCount?: number }
  assertVersion(header)
  if (header.id !== id || (header.userId ?? DEFAULT_USER_ID) !== parseUserId(row.user_id)) {
    throw new Error(`session-persistence-mysql: session ${id} has conflicting ownership metadata`)
  }
  const inheritedEventCount = SessionLogOffset(storedCut ?? 0)
  if (header.isSeeded ? storedCut === undefined : inheritedEventCount !== 0) {
    throw new Error(`session-persistence-mysql: session ${id} has invalid inherited-prefix metadata`)
  }
  return { meta: header, inheritedEventCount }
}

/** Transactional MySQL operations used by this provider's Session handles. */
export class MysqlSessionStore {
  private readonly source: string
  private readonly nextId: () => string

  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    database: string,
    snowflakeWorkerId = 0,
    private readonly cache?: RedisSessionCache,
    private readonly execution?: MysqlSessionExecution,
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

  private async header(id: SessionId, includeExtent = false): Promise<mysql.RowDataPacket | undefined> {
    const owner = this.ownerPredicate()
    const extent = includeExtent
      ? `,
         (SELECT COALESCE(MAX(seq) + 1, 0) FROM \`${EVENT_TABLE}\` e
          WHERE e.app = s.app AND e.session_id = s.session_id AND e.user_id = s.user_id
            AND e.is_deleted = 'N') AS next_seq,
         (SELECT COUNT(*) FROM \`${EVENT_TABLE}\` e
          WHERE e.app = s.app AND e.session_id = s.session_id AND e.user_id = s.user_id
            AND e.is_deleted = 'N') AS event_count`
      : ''
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, meta, revision, user_id${extent}
       FROM \`${SESSION_TABLE}\` s
       WHERE app = ? AND session_id = ? AND is_deleted = 'N'${owner.sql}`,
      [this.app, id, ...owner.values],
    )
    return rows[0]
  }

  /**
   * Read the complete committed prefix without semantic interruption repair.
   * @param id - Session identity visible to the requesting user.
   * @param signal - optional cancellation between database pages.
   * @returns SQL metadata and event values, or undefined when no visible row exists.
   */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<MysqlStoredSession | undefined> {
    return this.loadStoredFrom(id, 0, signal)
  }

  /**
   * Read ownership and revision without fetching the event body.
   * @param id - Session identity visible to the requesting user.
   * @param signal - optional cancellation around the metadata query.
   * @returns current logical metadata and revision, or undefined when absent.
   */
  async snapshot(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id)
    signal?.throwIfAborted()
    return row === undefined ? undefined : {
      header: toMetadata(row, id).meta,
      revision: revisionToken(this.source, row),
    }
  }

  /**
   * Read a change token that distinguishes physical row recreation.
   * @param id - Session identity visible to the requesting user.
   * @param signal - optional cancellation around the metadata query.
   * @returns the observed revision, or undefined when no visible row exists.
   */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id)
    signal?.throwIfAborted()
    return row === undefined ? undefined : revisionToken(this.source, row)
  }

  /**
   * Read a contiguous suffix bounded by the database extent observed before paging.
   * @param id - Session identity visible to the requesting user.
   * @param fromSeq - first requested position; at or beyond the extent returns no events.
   * @param signal - optional cancellation between database and Redis pages.
   * @returns the suffix and full extent, or undefined when no visible row exists.
   */
  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<MysqlStoredSession | undefined> {
    signal?.throwIfAborted()
    const row = await this.header(id, true)
    if (row === undefined) return undefined
    const metadata = toMetadata(row, id)
    return {
      ...metadata,
      events: await this.readEvents(metadata.meta, row, fromSeq, signal),
      eventCount: Number(row.next_seq),
      rowId: String(row.row_id),
      revision: revisionToken(this.source, row),
    }
  }

  /**
   * Materialize an empty Session without replacing an existing identity or owner.
   * @param meta - current logical metadata.
   * @param inheritedEventCount - exact inherited prefix; zero for an unseeded Session.
   */
  async materializeHeader(meta: SessionHeader, inheritedEventCount = SessionLogOffset(0)): Promise<void> {
    await this.transaction(async (conn) => {
      await this.execution?.assertTransaction(conn, meta.id)
      await this.insertHeader(conn, meta, 1, inheritedEventCount)
      await this.lockOwner(conn, meta)
    })
  }

  /**
   * Commit a contiguous batch while holding its owner row and optional execution reservation.
   * Redis receives copies only after SQL commits; a cache failure leaves the SQL result intact.
   * @param meta - immutable current logical metadata.
   * @param events - complete ordered batch to append.
   * @param isMaterialized - whether the header already exists; false requires exclusive creation.
   * @param inheritedEventCount - exact inherited prefix persisted with a new header.
   */
  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount = SessionLogOffset(0),
  ): Promise<void> {
    let rowId = ''
    await this.transaction(async (conn) => {
      await this.execution?.assertTransaction(conn, meta.id)
      if (!isMaterialized) await this.insertHeader(conn, meta, 0, inheritedEventCount)
      rowId = await this.lockOwner(conn, meta)
      await this.assertNextSeq(conn, meta, events)
      await this.insertEvents(conn, meta, events)
      await this.bumpRevision(conn, meta)
    })
    await this.cache?.write(meta, rowId, events)
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

  private async insertHeader(
    conn: mysql.PoolConnection,
    meta: SessionHeader,
    revision: number,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    const owner = meta.userId ?? DEFAULT_USER_ID
    if (!canAccessUser(owner)) throw new SessionPersistenceNotFoundError(meta.id)
    try {
      await conn.query(
        `INSERT INTO \`${SESSION_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, session_id, user_id, meta, revision)
         VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?, ?, ?)`,
        [...mysqlAuditValues(this.nextId, owner), this.app, meta.id, owner,
          toJsonText({ ...meta, inheritedEventCount }), revision],
      )
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error
      await this.lockOwner(conn, meta)
      throw new SessionAlreadyExistsError(meta.id)
    }
  }

  /** Lock the immutable owner before appending, including concurrent explicit-id creation. */
  private async lockOwner(conn: mysql.PoolConnection, meta: SessionHeader): Promise<string> {
    const owner = meta.userId ?? DEFAULT_USER_ID
    if (!canAccessUser(owner)) throw new SessionPersistenceNotFoundError(meta.id)
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, user_id FROM \`${SESSION_TABLE}\`
       WHERE app = ? AND session_id = ? AND is_deleted = 'N' FOR UPDATE`,
      [this.app, meta.id],
    )
    if (rows[0]?.user_id !== owner) throw new SessionPersistenceNotFoundError(meta.id)
    return String(rows[0].row_id)
  }

  private async assertNextSeq(conn: mysql.PoolConnection, meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM \`${EVENT_TABLE}\`
       WHERE app = ? AND session_id = ? AND user_id = ?`,
      [this.app, meta.id, meta.userId ?? DEFAULT_USER_ID],
    )
    const nextSeq = Number(rows[0]?.next_seq)
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
      throw new Error(`session-persistence-mysql: invalid stored event extent for session ${meta.id}`)
    }
    if (events.some((event, index) => event.seq !== nextSeq + index)) {
      throw new Error(`session-persistence-mysql: session ${meta.id} was changed by another writer or has a noncontiguous batch`)
    }
  }

  /**
   * List active Session headers in creation order without loading event bodies.
   * @param signal - optional cancellation around the query.
   * @returns current-user headers, or all application owners during unscoped maintenance.
   */
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
      header: toMetadata(row, row.session_id as SessionId).meta,
      revision: revisionToken(this.source, row),
    }))
  }

  /** Release every reservation and connection, aggregating independent shutdown failures. */
  async close(): Promise<void> {
    this.cache?.close()
    const failures: unknown[] = []
    try { await this.execution?.close() }
    catch (error) { failures.push(error) }
    try { await this.pool.end() }
    catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'session-persistence-mysql connection shutdown failed')
  }

  private async readEvents(
    meta: SessionHeader,
    row: mysql.RowDataPacket,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    const rowId = String(row.row_id)
    const nextSeq = Number(row.next_seq)
    const eventCount = Number(row.event_count)
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0
      || !Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > nextSeq) {
      throw new Error(`session-persistence-mysql: invalid stored event extent for session ${meta.id}`)
    }
    if (eventCount !== nextSeq) {
      throw new SessionPersistenceCorruptionError(
        `session-persistence-mysql: session ${meta.id} has a noncontiguous committed log`,
        { cause: new Error(`${eventCount} active events for extent ${nextSeq}`) },
      )
    }
    const cache = this.cache
    for (let cursor = fromSeq; cursor < nextSeq; cursor += MYSQL_SESSION_READ_PAGE_SIZE) {
      signal?.throwIfAborted()
      const end = Math.min(cursor + MYSQL_SESSION_READ_PAGE_SIZE, nextSeq)
      const cached = await cache?.read(meta, rowId, cursor, end, signal)
      if (cached !== undefined) {
        events.push(...cached)
        continue
      }
      const [page] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT seq, event FROM \`${EVENT_TABLE}\`
         WHERE app = ? AND session_id = ? AND user_id = ? AND is_deleted = 'N' AND seq >= ? AND seq < ?
         ORDER BY seq ASC LIMIT ?`,
        [this.app, meta.id, meta.userId ?? DEFAULT_USER_ID, cursor, end, MYSQL_SESSION_READ_PAGE_SIZE],
      )
      signal?.throwIfAborted()
      const batch = page.map(entry => entry.event as SessionEvent)
      if (batch.length !== end - cursor || batch.some((event, offset) => event.seq !== cursor + offset)) {
        throw new SessionPersistenceCorruptionError(
          `session-persistence-mysql: session ${meta.id} has an invalid event page at ${cursor}`,
          { cause: new Error('event rows must match the committed sequence extent') },
        )
      }
      events.push(...batch)
      if (batch.length === end - cursor && batch.every((event, offset) => event.seq === cursor + offset)) {
        await cache?.write(meta, rowId, batch)
      }
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
