/**
 * PostgreSQL session store: the durable primitives the shared persistence
 * coordinator drives.
 *
 * The coordinator owns buffering, cursors, adoption, crash-repair sequencing,
 * and dispose quiescence; this module owns only the medium. Two tables carry
 * everything — one header row per session and one row per event — so a
 * container that keeps no filesystem still resumes a session, and several
 * replicas read the same log.
 *
 * One consequence of the medium is worth stating plainly: a torn tail is
 * impossible here. A JSONL backend can crash mid-line and must hand the
 * coordinator a marker so the fragment can be truncated; an event row either
 * commits with its transaction or does not exist. `loadStored` therefore never
 * returns a `tornMarker`, and `commitRepair` only has to append closers.
 *
 * @module @deepseek-ai/dsh-session-persistence-postgres/store
 */

import pg from 'pg'
import { ensureSchema, tablesPresent, toJsonbText } from '@deepseek-ai/dsh-postgres-schema'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'

/** Table names owned by this store, unqualified. */
const SESSION_TABLE = 'session'
const EVENT_TABLE = 'session_event'

/**
 * Compose the source-qualified revision token. It must identify one storage
 * source AND one revision of the log, so the schema-qualified database
 * identity travels with the counter: two replicas pointed at different
 * databases must never mint colliding tokens.
 * @param source - stable identity of this store's medium.
 * @param revision - the session row's monotonic counter.
 * @returns the branded revision token.
 */
function revisionToken(source: string, revision: string | number): SessionPersistenceRevision {
  return SessionPersistenceRevision(`${source}:revision:${String(revision)}`)
}

/** Parse a stored header, failing loud rather than publishing an unusable one. */
function toHeader(value: unknown, id: SessionId): SessionHeader {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`session-persistence-postgres: session ${id} has a malformed header`)
  }
  return value as SessionHeader
}

/** PostgreSQL implementation of the coordinator's storage contract. */
export class PostgresSessionStore implements PersistenceBackend<never> {
  readonly name = 'session-persistence-postgres'

  /** Stable identity of this medium, embedded in every revision token. */
  private readonly source: string

  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
    database: string,
  ) {
    this.source = `postgres:${database}:${schema}`
  }

  /**
   * Create the two tables this store owns, unless a DBA already did.
   *
   * A production role often holds no DDL rights, and `IF NOT EXISTS` does not
   * exempt a statement from the privilege check, so issuing the creates
   * unconditionally makes such a database unusable. Both tables present means
   * there is nothing to create; anything missing still runs the creates, so a
   * half-provisioned database fails at start rather than at first write.
   */
  async migrate(): Promise<void> {
    if (await tablesPresent(this.pool, this.schema, [SESSION_TABLE, EVENT_TABLE])) return
    await ensureSchema(this.pool, this.schema)
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS "${this.schema}"."${SESSION_TABLE}" (
         id         text   PRIMARY KEY,
         meta       jsonb  NOT NULL,
         revision   bigint NOT NULL DEFAULT 0,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS "${this.schema}"."${EVENT_TABLE}" (
         session_id text    NOT NULL
           REFERENCES "${this.schema}"."${SESSION_TABLE}" (id) ON DELETE CASCADE,
         seq        integer NOT NULL,
         event      jsonb   NOT NULL,
         PRIMARY KEY (session_id, seq)
       )`,
    )
    // The suffix read orders by seq within one session; the primary key already
    // serves it, and listing wants creation order.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS "${SESSION_TABLE}_created_at_idx"
       ON "${this.schema}"."${SESSION_TABLE}" (created_at)`,
    )
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    const header = await this.pool.query<{ meta: unknown; revision: string }>(
      `SELECT meta, revision FROM "${this.schema}"."${SESSION_TABLE}" WHERE id = $1`,
      [id],
    )
    const row = header.rows[0]
    if (row === undefined) return undefined
    signal?.throwIfAborted()
    const events = await this.pool.query<{ event: SessionEvent }>(
      `SELECT event FROM "${this.schema}"."${EVENT_TABLE}" WHERE session_id = $1 ORDER BY seq ASC`,
      [id],
    )
    // The coordinator freezes and publishes these graphs in place, so they must
    // be fresh and unaliased. Each row is decoded from jsonb into a new object
    // by the driver, which already satisfies that.
    return {
      meta: toHeader(row.meta, id),
      events: events.rows.map(entry => entry.event),
      revision: revisionToken(this.source, row.revision),
    }
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const result = await this.pool.query<{ revision: string }>(
      `SELECT revision FROM "${this.schema}"."${SESSION_TABLE}" WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : revisionToken(this.source, row.revision)
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
    const header = await this.pool.query<{ meta: unknown }>(
      `SELECT meta FROM "${this.schema}"."${SESSION_TABLE}" WHERE id = $1`,
      [id],
    )
    const row = header.rows[0]
    if (row === undefined) return undefined
    signal?.throwIfAborted()
    const events = await this.pool.query<{ event: SessionEvent }>(
      `SELECT event FROM "${this.schema}"."${EVENT_TABLE}"
       WHERE session_id = $1 AND seq >= $2 ORDER BY seq ASC`,
      [id, fromSeq],
    )
    return { meta: toHeader(row.meta, id), events: events.rows.map(entry => entry.event) }
  }

  /** Durably create an empty header-only session. */
  async materializeHeader(meta: SessionHeader): Promise<void> {
    await this.pool.query(
      `INSERT INTO "${this.schema}"."${SESSION_TABLE}" (id, meta, revision)
       VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (id) DO NOTHING`,
      [meta.id, toJsonbText(meta)],
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
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (!isMaterialized) {
        await client.query(
          `INSERT INTO "${this.schema}"."${SESSION_TABLE}" (id, meta, revision)
           VALUES ($1, $2::jsonb, 0)
           ON CONFLICT (id) DO NOTHING`,
          [meta.id, toJsonbText(meta)],
        )
      }
      await this.insertEvents(client, meta.id, events)
      await this.bumpRevision(client, meta.id)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
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
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.insertEvents(client, meta.id, closers)
      await this.bumpRevision(client, meta.id)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const result = await this.pool.query<{ id: string; meta: unknown }>(
      `SELECT id, meta FROM "${this.schema}"."${SESSION_TABLE}" ORDER BY created_at ASC`,
    )
    return result.rows.map(row => toHeader(row.meta, row.id as SessionId))
  }

  /**
   * Every materialized session with its current revision, for the listing
   * surface that renders staleness without loading any log.
   * @param signal - optional cancellation for the read.
   * @returns one snapshot per stored session, in creation order.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const result = await this.pool.query<{ id: string; meta: unknown; revision: string }>(
      `SELECT id, meta, revision FROM "${this.schema}"."${SESSION_TABLE}" ORDER BY created_at ASC`,
    )
    return result.rows.map(row => ({
      header: toHeader(row.meta, row.id as SessionId),
      revision: revisionToken(this.source, row.revision),
    }))
  }

  /** No per-session artifact exists in a database medium. */
  locate(): undefined {
    return undefined
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** Insert one contiguous batch of events, keyed by their own seq. */
  private async insertEvents(
    client: pg.PoolClient,
    id: SessionId,
    events: readonly SessionEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    // One multi-row statement rather than a statement per event: the batch is
    // already contiguous and the whole transaction commits together anyway.
    const values: unknown[] = [id]
    const tuples = events.map((event, index) => {
      values.push(event.seq, toJsonbText(event))
      return `($1, $${String(index * 2 + 2)}, $${String(index * 2 + 3)}::jsonb)`
    })
    await client.query(
      `INSERT INTO "${this.schema}"."${EVENT_TABLE}" (session_id, seq, event)
       VALUES ${tuples.join(', ')}`,
      values,
    )
  }

  /** Advance the session's revision inside the caller's transaction. */
  private async bumpRevision(client: pg.PoolClient, id: SessionId): Promise<void> {
    await client.query(
      `UPDATE "${this.schema}"."${SESSION_TABLE}" SET revision = revision + 1 WHERE id = $1`,
      [id],
    )
  }
}
