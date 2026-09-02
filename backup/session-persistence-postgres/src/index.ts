/**
 * PostgreSQL `SessionPersistence` provider.
 *
 * Session logs are the state a container cannot afford to keep locally: a
 * replaced replica must still resume what a user was doing. The shared
 * {@link PersistenceCoordinator} owns every semantic — buffering, cursors,
 * live adoption, crash-repair sequencing, dispose quiescence — and this module
 * only binds it to a database medium, so the Postgres backend behaves exactly
 * as the JSONL and SQLite ones do.
 *
 * @module @deepseek-ai/dsh-session-persistence-postgres
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  type BorrowedSessionSource,
  PersistenceCoordinator,
  SessionPersistence,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import {
  postgresConnectionSchema,
  resolvePostgresDatabase,
  resolvePostgresPool,
  resolvePostgresSchema,
} from '@deepseek-ai/dsh-postgres-schema'
import type { PostgresConnectionConfig } from '@deepseek-ai/dsh-postgres-schema'
import { PostgresSessionStore } from './store.ts'

export { PostgresSessionStore } from './store.ts'

/** Plugin configuration. */
export interface Config extends PostgresConnectionConfig {
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** PostgreSQL `SessionPersistence` provider over the shared coordinator. */
export class PostgresSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-postgres'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    ...postgresConnectionSchema,
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: PostgresSessionStore
  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // The schema name reaches SQL as an interpolated identifier, so a bad value
    // fails construction rather than some later query.
    const schema = resolvePostgresSchema(config)
    this.store = new PostgresSessionStore(
      new pg.Pool(resolvePostgresPool(config)),
      schema,
      resolvePostgresDatabase(config),
    )
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  /** Create the tables before the service becomes injectable. */
  protected async [Service.init](): Promise<void> {
    await this.store.migrate()
  }

  /** A database holds every session; there is no per-session artifact. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  override ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  override borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

export default PostgresSessionPersistence
