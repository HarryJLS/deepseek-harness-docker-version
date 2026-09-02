/**
 * MySQL-protocol `SessionPersistence` provider (OceanBase in MySQL mode, and MySQL itself).
 *
 * Session logs are the state a container cannot afford to keep locally: a
 * replaced replica must still resume what a user was doing. The shared
 * {@link PersistenceCoordinator} owns every semantic — buffering, cursors,
 * live adoption, crash-repair sequencing, dispose quiescence — and this module
 * only binds it to a database medium, so this backend behaves exactly as the
 * JSONL and SQLite ones do.
 *
 * Several applications share one set of tables and are separated by the `app`
 * column the store binds into every statement; MySQL has no schema inside a
 * database to give each one its own namespace.
 *
 * @module @deepseek-ai/dsh-session-persistence-mysql
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'
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
  mysqlConnectionSchema,
  resolveMysqlApp,
  resolveMysqlDatabase,
  resolveMysqlPool,
} from '@deepseek-ai/dsh-mysql-schema'
import type { MysqlConnectionConfig } from '@deepseek-ai/dsh-mysql-schema'
import { MysqlSessionStore } from './store.ts'

export { MysqlSessionStore } from './store.ts'

/** Plugin configuration. */
export interface Config extends MysqlConnectionConfig {
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** MySQL `SessionPersistence` provider over the shared coordinator. */
export class MysqlSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-mysql'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    ...mysqlConnectionSchema,
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: MysqlSessionStore
  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // The application name bounds the `app` column, so a name the column
    // cannot hold fails construction rather than truncating into another
    // application's rows.
    const app = resolveMysqlApp(config)
    this.store = new MysqlSessionStore(
      mysql.createPool(resolveMysqlPool(config)),
      app,
      resolveMysqlDatabase(config),
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

export default MysqlSessionPersistence
