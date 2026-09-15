/**
 * Handle-based OceanBase/MySQL session persistence. SQL commits and user
 * ownership are authoritative; optional Redis entries cache committed events.
 * Each active writer owns its live buffer, mutation ordering, and shutdown drain.
 * @module @deepseek-ai/dsh-session-persistence-mysql
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertContiguous, assertStoredId, assertVersion, materializeCreateHeader,
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
  SessionPersistence, SessionPersistenceNotFoundError, SessionPersistenceRevision,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess, SessionHandle, SessionPersistenceCreateOptions, SessionPersistenceListOptions,
  SessionPersistenceOpenOptions, SessionPersistenceSnapshot, SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import {
  mysqlConnectionSchema, resolveMysqlApp, resolveMysqlDatabase, resolveMysqlPool, mysqlIdGenerator,
} from '@deepseek-ai/dsh-mysql-schema'
import type { MysqlConnectionConfig } from '@deepseek-ai/dsh-mysql-schema'
import { canAccessUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionStore } from './store.ts'
import type { MysqlStoredSession } from './store.ts'
import { MysqlSessionHandle } from './handle.ts'
import type { MysqlHandleStorage, MysqlHandleState } from './handle.ts'
import { RedisSessionCache } from './redis-cache.ts'
import { RedisSessionCacheConfig, resolveRedisSessionCacheConfig } from './redis-config.ts'
import { MysqlSessionExecution, SharedExecutionConfig } from './execution.ts'
import { MysqlUploadReceipts } from './uploads.ts'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { MysqlAssistantState } from './assistant-state.ts'

export { MYSQL_SESSION_READ_PAGE_SIZE, MysqlSessionStore } from './store.ts'
export { RedisSessionCacheConfig, resolveRedisSessionCacheConfig } from './redis-config.ts'

/** Plugin configuration. */
export interface Config extends MysqlConnectionConfig {
  /** Optional committed-event cache; Docker deployments require its Nacos configuration. */
  redis?: RedisSessionCacheConfig
  /** Renewable, SQL-fenced execution ownership across replicas. */
  execution?: SharedExecutionConfig
  /** Fixed live-event coalescing window in milliseconds; defaults to 200. */
  writeBatchMaxDelayMs?: number
  /** Lifetime of completed shared upload receipts; defaults to two days. */
  uploadReceiptTtlMs?: number
  /** Raw bytes per shared Assistant snapshot chunk; defaults to 48 KiB before base64 encoding. */
  assistantStateChunkBytes?: number
}

interface PendingSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly revision: SessionPersistenceRevision
}

/** Durable Session handles over application- and user-scoped database rows. */
export class MysqlSessionPersistence extends SessionPersistence {
  override readonly name = 'session-persistence-mysql'
  override readonly sharedExecution: MysqlSessionExecution | undefined

  static inject = ['sessions']
  static Config: z<Config> = z.object({
    ...mysqlConnectionSchema,
    redis: z.union([RedisSessionCacheConfig]),
    execution: z.union([SharedExecutionConfig]),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(60_000).default(200),
    uploadReceiptTtlMs: z.number().step(1).min(1000).max(2_147_483_647).default(172_800_000),
    assistantStateChunkBytes: z.number().step(1).min(1024).max(786_432).default(49_152),
  })

  private readonly store: MysqlSessionStore
  private readonly cache: RedisSessionCache | undefined
  private readonly storage: MysqlHandleStorage
  private readonly handles = new Set<MysqlSessionHandle>()
  private readonly writers = new Map<SessionId, MysqlSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private readonly openings = new Set<Promise<SessionHandle>>()
  private readonly batchDelayMs: number
  private accepting = true
  private counter = 0

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const app = resolveMysqlApp(config)
    const database = resolveMysqlDatabase(config)
    this.batchDelayMs = config.writeBatchMaxDelayMs ?? 200
    if (!Number.isSafeInteger(this.batchDelayMs) || this.batchDelayMs < 1 || this.batchDelayMs > 60_000) {
      throw new TypeError('writeBatchMaxDelayMs must be an integer from 1 through 60000')
    }
    this.cache = config.redis === undefined ? undefined : new RedisSessionCache(
      resolveRedisSessionCacheConfig(config.redis), app, database,
      (message) => { this.ctx.logger.warn(message) },
    )
    const pool = mysql.createPool(resolveMysqlPool(config))
    this.sharedExecution = config.execution === undefined ? undefined : new MysqlSessionExecution(
      pool, app, mysqlIdGenerator(config.snowflakeWorkerId ?? 0), config.execution,
    )
    this.store = new MysqlSessionStore(pool, app, database, config.snowflakeWorkerId ?? 0, this.cache, this.sharedExecution)
    if (this.sharedExecution !== undefined) {
      const receipts = new MysqlUploadReceipts(
        pool, app, mysqlIdGenerator(config.snowflakeWorkerId ?? 0), config.uploadReceiptTtlMs ?? 172_800_000,
      )
      ctx.inject(['fileUploads'], (uploads) => {
        uploads.effect(() => uploads.fileUploads.registerSharedStore(receipts), 'session-persistence-mysql: upload receipts')
      })
      const assistant = new MysqlAssistantState(
        pool, app, mysqlIdGenerator(config.snowflakeWorkerId ?? 0), this.sharedExecution,
        () => this.flush(), config.assistantStateChunkBytes ?? 49_152,
      )
      ctx.inject(['sessionController'], (controller) => {
        controller.effect(() => controller.sessionController.registerSharedAssistantState(assistant), 'session-persistence-mysql: Assistant state')
      })
    }
    this.storage = {
      read: (id, offset, signal) => this.readStored(id, offset, signal),
      acquire: id => this.acquire(id),
      append: (header, events, materialized, inheritedEventCount) =>
        this.persistBatch(header, events, materialized, inheritedEventCount),
      materialize: async (header, inheritedEventCount) => {
        await this.store.materializeHeader(header, inheritedEventCount)
        this.pending.delete(header.id)
      },
      release: (handle) => {
        this.handles.delete(handle)
        if (this.writers.get(handle.id) !== handle) return
        this.writers.delete(handle.id)
        this.pending.delete(handle.id)
      },
      report: (id, error) => {
        ctx.logger.warn(`session-persistence: background write for session "${id}" failed (buffered events retained): ${String(error)}`)
      },
    }
    ctx.on('session/event', (session, event) => { this.writers.get(session.id)?.enqueueLive(event) })
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush())
    ctx.on('session/disposed', (session) => {
      void this.writers.get(session.id)?.close().catch((error: unknown) => {
        ctx.logger.warn(`session-persistence: final drain for session "${session.id}" failed: ${String(error)}`)
      })
    })
    ctx.effect(() => () => this.disposeStorage(), 'session-persistence-mysql: handles and connections')
  }

  /** Validate tables and require the configured cache before service readiness. */
  protected async [Service.init](): Promise<void> {
    await this.store.migrate()
    await this.sharedExecution?.init()
    await this.cache?.connect()
  }

  create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.trackOpening(async () => {
      options?.signal?.throwIfAborted()
      const snapshot = materializeCreateHeader(header)
      assertVersion(snapshot)
      this.assertUser(snapshot)
      const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
      if (snapshot.isSeeded ? options?.inheritedEventCount === undefined : inheritedEventCount !== 0) {
        throw new TypeError('seeded Sessions require an inheritedEventCount; unseeded Sessions require zero')
      }
      // Session validates owned header fields without constructing a seeded log.
      Session.create(snapshot.id, undefined, { ...snapshot, isSeeded: false })
      if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
      if (await this.store.snapshot(snapshot.id, options?.signal) !== undefined) throw new SessionAlreadyExistsError(snapshot.id)
      options?.signal?.throwIfAborted()
      if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
      this.writers.set(snapshot.id, null)
      this.pending.set(snapshot.id, {
        header: Object.freeze(snapshot), inheritedEventCount,
        revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      })
      return this.adopt(snapshot, 'write', { cursor: 0, materialized: false, inheritedEventCount })
    })
  }

  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.trackOpening(async () => {
      options?.signal?.throwIfAborted()
      if (access === 'write') {
        if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
        this.writers.set(id, null)
      }
      let lease: AsyncDisposable | undefined
      try {
        const pending = this.pending.get(id)
        if (pending !== undefined) {
          this.assertUser(pending.header)
          return this.adopt(pending.header, access, {
            cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount,
          })
        }
        const snapshot = await this.store.snapshot(id, options?.signal)
        if (snapshot === undefined) throw new SessionPersistenceNotFoundError(id)
        this.assertUser(snapshot.header)
        if (access === 'write') lease = await this.acquire(id)
        const stored = await this.readStored(id, access === 'read' ? Number.MAX_SAFE_INTEGER : 0, options?.signal)
        options?.signal?.throwIfAborted()
        return this.adopt(Object.freeze(stored.meta), access, {
          cursor: stored.eventCount, materialized: true,
          inheritedEventCount: stored.inheritedEventCount, rowId: stored.rowId,
        }, lease)
      } catch (error) {
        if (access === 'write') this.writers.delete(id)
        try { await lease?.[Symbol.asyncDispose]() }
        catch (cleanup) { throw new AggregateError([error, cleanup], `session "${id}": write open and release failed`) }
        throw error
      }
    })
  }

  async flush(): Promise<void> {
    const failures: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue
      try { await writer.flush() }
      catch (error) {
        if (!(error instanceof SessionHandleClosedError)) failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'session-persistence-mysql flush failed')
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const stored = await this.store.snapshot(id, options?.signal)
    if (stored !== undefined) return stored
    const pending = this.pending.get(id)
    return pending === undefined || !canAccessUser(pending.header.userId)
      ? undefined : { header: structuredClone(pending.header), revision: pending.revision, eventCount: 0 }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    const stored = await this.store.listSnapshots(options?.signal)
    const ids = new Set(stored.map(snapshot => snapshot.header.id))
    for (const [id, pending] of this.pending) {
      if (!ids.has(id) && canAccessUser(pending.header.userId)) {
        stored.push({ header: structuredClone(pending.header), revision: pending.revision, eventCount: 0 })
      }
    }
    return stored
  }

  private async readStored(id: SessionId, offset: number, signal?: AbortSignal): Promise<MysqlStoredSession> {
    signal?.throwIfAborted()
    const stored = await this.store.loadStoredFrom(id, offset, signal)
    if (stored !== undefined) {
      this.assertUser(stored.meta)
      assertStoredId(id, stored.meta)
      assertVersion(stored.meta)
      assertContiguous(id, stored.events, offset)
      validateStoredEvents(stored.meta, stored.events)
      return stored
    }
    const pending = this.pending.get(id)
    if (pending === undefined) throw new SessionPersistenceNotFoundError(id)
    this.assertUser(pending.header)
    return {
      meta: pending.header, inheritedEventCount: pending.inheritedEventCount,
      events: [], eventCount: 0, rowId: '', revision: pending.revision,
    }
  }

  private async acquire(id: SessionId): Promise<AsyncDisposable> {
    if (this.sharedExecution === undefined || this.sharedExecution.owns(id)) {
      // An API-owned reservation outlives its handle and is released by the
      // execution controller only after the Agent has stopped.
      return { [Symbol.asyncDispose]: async () => {} }
    }
    return this.sharedExecution.acquire(id)
  }

  private async persistBatch(
    header: SessionHeader, events: readonly SessionEvent[], materialized: boolean, inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    await this.store.appendBatch(header, events, materialized, inheritedEventCount)
    this.pending.delete(header.id)
  }

  private adopt(header: SessionHeader, access: SessionAccess, state: MysqlHandleState, lease?: AsyncDisposable): MysqlSessionHandle {
    const handle = new MysqlSessionHandle(this.storage, header, access, state, this.batchDelayMs, lease)
    this.handles.add(handle)
    if (access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  private trackOpening(operation: () => Promise<SessionHandle>): Promise<SessionHandle> {
    if (!this.accepting) return Promise.reject(new Error('session-persistence-mysql is closing'))
    const opening = operation().then(async (handle) => {
      if (this.accepting) return handle
      await handle.close()
      throw new Error('session-persistence-mysql closed during handle acquisition')
    })
    this.openings.add(opening)
    void opening.then(() => this.openings.delete(opening), () => this.openings.delete(opening))
    return opening
  }

  private async disposeStorage(): Promise<void> {
    this.accepting = false
    await Promise.allSettled([...this.openings])
    const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
    const failures: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    try { await this.store.close() }
    catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'session-persistence-mysql dispose failed')
  }

  private assertUser(header: SessionHeader): void {
    if (!canAccessUser(header.userId)) throw new SessionPersistenceNotFoundError(header.id)
  }
}

export default MysqlSessionPersistence
