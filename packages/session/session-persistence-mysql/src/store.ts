/**
 * MySQL session store: the durable primitives the shared persistence
 * coordinator drives.
 *
 * The coordinator owns buffering, cursors, adoption, crash-repair sequencing,
 * and dispose quiescence; this module owns only the medium. Two tables carry
 * everything — one header row per session and one row per event — so a
 * container that keeps no filesystem still resumes a session, and several
 * replicas read the same log.
 *
 * Applications share both tables and are separated by the `app` column, which
 * leads every primary key and every predicate below. That is what lets one
 * database serve several deployments where the PostgreSQL store this replaces
 * gave each one its own schema.
 *
 * One consequence of the medium is worth stating plainly: a torn tail is
 * impossible here. A JSONL backend can crash mid-line and must hand the
 * coordinator a marker so the fragment can be truncated; an event row either
 * commits with its transaction or does not exist. `loadStored` therefore never
 * returns a `tornMarker`, and `commitRepair` only has to append closers.
 *
 * @module @deepseek-ai/dsh-session-persistence-mysql/store
 */

import mysql from 'mysql2/promise'
import { mysqlTable, tablesPresent, toJsonText } from '@deepseek-ai/dsh-mysql-schema'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

/** Tables owned by this store. */
const SESSION_TABLE = mysqlTable('session')
const EVENT_TABLE = mysqlTable('session_event')

/** Maximum number of event rows returned by one recovery query. */
export const MYSQL_SESSION_READ_PAGE_SIZE = 1_000

/**
 * Compose the source-qualified revision token. It must identify one storage
 * source AND one revision of the log, so the database and application identity
 * travel with the counter: two replicas pointed at different databases, or at
 * different applications in one database, must never mint colliding tokens.
 * @param source - stable identity of this store's medium.
 * @param revision - the session row's monotonic counter.
 * @returns the branded revision token.
 */
function revisionToken(source: string, revision: string | number): SessionPersistenceRevision {
  return SessionPersistenceRevision(`${source}:revision:${String(revision)}`)
}

/**
 * Read a stored header, failing loud rather than publishing an unusable one.
 *
 * `mysql2` decodes a `json` column into a fresh JS value per row, so the
 * column arrives already parsed; re-parsing it would double-decode any
 * document that is itself a JSON string.
 */
function toHeader(value: unknown, id: SessionId): SessionHeader {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session-persistence-mysql: session ${id} has a malformed header`)
  }
  return value as SessionHeader
}

/** MySQL implementation of the coordinator's storage contract. */
export class MysqlSessionStore implements PersistenceBackend<never> {
  readonly name = 'session-persistence-mysql'

  /** Stable identity of this medium, embedded in every revision token. */
  private readonly source: string

  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    database: string,
  ) {
    this.source = `mysql:${database}:${app}`
  }

  /**
   * Create the two tables this store owns, unless a DBA already did.
   *
   * A production role often holds no DDL rights, and `CREATE TABLE IF NOT
   * EXISTS` does not exempt a statement from the privilege check, so issuing
   * the creates unconditionally makes such a database unusable. Both tables
   * present means there is nothing to create; anything missing still runs the
   * creates, so a half-provisioned database fails at start rather than at
   * first write.
   */
  async migrate(): Promise<void> {
    if (await tablesPresent(this.pool, [SESSION_TABLE, EVENT_TABLE])) return
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS \`${SESSION_TABLE}\` (
         app        varchar(64)  NOT NULL,
         id         varchar(128) NOT NULL,
         meta       json         NOT NULL,
         revision   bigint       NOT NULL DEFAULT 0,
         created_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
         PRIMARY KEY (app, id),
         KEY \`${SESSION_TABLE}_created_at_idx\` (app, created_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS \`${EVENT_TABLE}\` (
         app        varchar(64)  NOT NULL,
         session_id varchar(128) NOT NULL,
         seq        int          NOT NULL,
         event      json         NOT NULL,
         PRIMARY KEY (app, session_id, seq),
         CONSTRAINT \`${EVENT_TABLE}_session_fk\` FOREIGN KEY (app, session_id)
           REFERENCES \`${SESSION_TABLE}\` (app, id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const [header] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT meta, revision FROM \`${SESSION_TABLE}\` WHERE app = ? AND id = ?`,
      [this.app, id],
    )
    const row = header[0]
    if (row === undefined) return undefined
    signal?.throwIfAborted()
    const events = await this.readEvents(id, 0, signal)
    // The coordinator freezes and publishes these graphs in place, so they must
    // be fresh and unaliased. The driver decodes each `json` column into a new
    // value per read, which already satisfies that.
    return {
      meta: toHeader(row.meta, id),
      events,
      revision: revisionToken(this.source, row.revision as string),
    }
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const [result] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT revision FROM \`${SESSION_TABLE}\` WHERE app = ? AND id = ?`,
      [this.app, id],
    )
    const row = result[0]
    return row === undefined ? undefined : revisionToken(this.source, row.revision as string)
  }

  /**
   * Seek-capable suffix read: the medium addresses events by seq, so a read
   * model resuming from a watermark never pays for the whole log.
   */
  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    const [header] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT meta FROM \`${SESSION_TABLE}\` WHERE app = ? AND id = ?`,
      [this.app, id],
    )
    const row = header[0]
    if (row === undefined) return undefined
    signal?.throwIfAborted()
    const events = await this.readEvents(id, fromSeq, signal)
    return {
      meta: toHeader(row.meta, id),
      events,
    }
  }

  /** Durably create an empty header-only session. */
  async materializeHeader(meta: SessionHeader): Promise<void> {
    await this.pool.query(
      `INSERT INTO \`${SESSION_TABLE}\` (app, id, meta, revision)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [this.app, meta.id, toJsonText(meta)],
    )
  }

  /**
   * Append a contiguous batch, materializing the header first when needed. The
   * contract requires the materialize-write and the first batch to commit
   * atomically, which one transaction gives directly.
   */
  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      if (!isMaterialized) {
        await conn.query(
          `INSERT INTO \`${SESSION_TABLE}\` (app, id, meta, revision)
           VALUES (?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE id = id`,
          [this.app, meta.id, toJsonText(meta)],
        )
      }
      await this.insertEvents(conn, meta.id, events)
      await this.bumpRevision(conn, meta.id)
      await conn.commit()
    } catch (error) {
      await conn.rollback().catch(() => undefined)
      throw error
    } finally {
      conn.release()
    }
  }

  /**
   * Make a crash repair durable. A row-per-event medium cannot produce a torn
   * tail, so `tornMarker` is never present and only the synthetic closers are
   * appended — in one transaction, so a reader never observes a partial repair.
   */
  async commitRepair(
    meta: SessionHeader,
    _tornMarker: undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (closers.length === 0) return
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      await this.insertEvents(conn, meta.id, closers)
      await this.bumpRevision(conn, meta.id)
      await conn.commit()
    } catch (error) {
      await conn.rollback().catch(() => undefined)
      throw error
    } finally {
      conn.release()
    }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const [result] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT id, meta FROM \`${SESSION_TABLE}\` WHERE app = ? ORDER BY created_at ASC`,
      [this.app],
    )
    return result.map(row => toHeader(row.meta, row.id as SessionId))
  }

  /**
   * Every materialized session with its current revision, for the listing
   * surface that renders staleness without loading any log.
   * @param signal - optional cancellation for the read.
   * @returns one snapshot per stored session, in creation order.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const [result] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT id, meta, revision FROM \`${SESSION_TABLE}\` WHERE app = ? ORDER BY created_at ASC`,
      [this.app],
    )
    return result.map(row => ({
      header: toHeader(row.meta, row.id as SessionId),
      revision: revisionToken(this.source, row.revision as string),
    }))
  }

  /** No per-session artifact exists in a database medium. */
  locate(): undefined {
    return undefined
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** Read event rows with a keyset cursor so recovery never returns one huge result set. */
  private async readEvents(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    let afterSeq = fromSeq - 1
    for (;;) {
      signal?.throwIfAborted()
      const [page] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT seq, event FROM \`${EVENT_TABLE}\`
         WHERE app = ? AND session_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
        [this.app, id, afterSeq, MYSQL_SESSION_READ_PAGE_SIZE],
      )
      for (const entry of page) events.push(entry.event as SessionEvent)
      if (page.length < MYSQL_SESSION_READ_PAGE_SIZE) break
      const nextSeq = page.at(-1)?.seq
      if (typeof nextSeq !== 'number' || !Number.isSafeInteger(nextSeq) || nextSeq <= afterSeq) {
        throw new Error(`session-persistence-mysql: invalid event page cursor for session ${id}`)
      }
      afterSeq = nextSeq
    }
    return events
  }

  /** Insert one contiguous batch of events, keyed by their own seq. */
  private async insertEvents(
    conn: mysql.PoolConnection,
    id: SessionId,
    events: readonly SessionEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    // One multi-row statement rather than a statement per event: the batch is
    // already contiguous and the whole transaction commits together anyway.
    const values: unknown[] = []
    const tuples = events.map((event) => {
      values.push(this.app, id, event.seq, toJsonText(event))
      return '(?, ?, ?, ?)'
    })
    await conn.query(
      `INSERT INTO \`${EVENT_TABLE}\` (app, session_id, seq, event)
       VALUES ${tuples.join(', ')}`,
      values,
    )
  }

  /** Advance the session's revision inside the caller's transaction. */
  private async bumpRevision(conn: mysql.PoolConnection, id: SessionId): Promise<void> {
    await conn.query(
      `UPDATE \`${SESSION_TABLE}\` SET revision = revision + 1 WHERE app = ? AND id = ?`,
      [this.app, id],
    )
  }
}
