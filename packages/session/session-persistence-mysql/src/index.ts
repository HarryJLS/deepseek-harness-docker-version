/**
 * MySQL-protocol `SessionPersistence` provider (OceanBase in MySQL mode, and MySQL itself).
 *
 * MySQL owns committed session history and request authorization. Optional
 * Redis entries cache immutable events under application, user, session, and
 * physical-row identities. The shared {@link PersistenceCoordinator} owns
 * buffering, preparation, crash repair, and quiescent shutdown.
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
  SessionPersistenceNotFoundError,
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
import { canAccessUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionStore } from './store.ts'
import { RedisSessionCache } from './redis-cache.ts'
import { RedisSessionCacheConfig, resolveRedisSessionCacheConfig } from './redis-config.ts'

export { MYSQL_SESSION_READ_PAGE_SIZE, MysqlSessionStore } from './store.ts'
export { RedisSessionCacheConfig, resolveRedisSessionCacheConfig } from './redis-config.ts'

/** Plugin configuration. */
export interface Config extends MysqlConnectionConfig {
  /** Optional shared event cache; container deployments require this configuration from Nacos. */
  redis?: RedisSessionCacheConfig
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
    // Unlike object schemas, a union does not implicitly construct an omitted Redis config.
    redis: z.union([RedisSessionCacheConfig]),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: MysqlSessionStore
  private readonly cache: RedisSessionCache | undefined
  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // The application name bounds the `app` column, so a name the column
    // cannot hold fails construction rather than truncating into another
    // application's rows.
    const app = resolveMysqlApp(config)
    const database = resolveMysqlDatabase(config)
    this.cache = config.redis === undefined ? undefined : new RedisSessionCache(
      resolveRedisSessionCacheConfig(config.redis),
      app,
      database,
      (message) => { this.ctx.logger.warn(message) },
    )
    this.store = new MysqlSessionStore(
      mysql.createPool(resolveMysqlPool(config)),
      app,
      database,
      config.snowflakeWorkerId ?? 0,
      this.cache,
    )
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  /** Validate database tables and require the configured Redis connection before readiness. */
  protected async [Service.init](): Promise<void> {
    await this.store.migrate()
    await this.cache?.connect()
  }

  /** A database holds every session; there is no per-session artifact. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    this.assertUser(meta)
    return this.coordinator.create(meta)
  }

  override ensureMaterialized(session: Session): Promise<void> {
    this.assertUser(session.header)
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    const prepared = await this.coordinator.prepare(id, signal)
    try { this.assertUser(prepared.session.header) }
    catch (error) { prepared[Symbol.dispose](); throw error }
    return prepared
  }

  async load(id: SessionId): Promise<SessionInspection> {
    const inspection = await this.coordinator.load(id)
    this.assertUser(inspection.meta)
    return inspection
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    const inspection = await this.coordinator.inspect(id, signal)
    this.assertUser(inspection.meta)
    return inspection
  }

  override async borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    const borrowed = await this.coordinator.borrowSession(id, signal)
    try { this.assertUser(borrowed.inspection.meta) }
    catch (error) { borrowed[Symbol.dispose](); throw error }
    return borrowed
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const inspection = await this.coordinator.readFrom(id, fromSeq, signal)
    this.assertUser(inspection.meta)
    return inspection
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }

  private assertUser(meta: SessionHeader): void {
    if (!canAccessUser(meta.userId)) throw new SessionPersistenceNotFoundError(meta.id)
  }
}

export default MysqlSessionPersistence
