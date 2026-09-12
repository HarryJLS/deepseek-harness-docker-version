/** Bounded, immutable event-cache entries; MySQL remains the authority for ownership and log extent. */

import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { DEFAULT_USER_ID } from '@deepseek-ai/dsh-user-context'
import type { ResolvedRedisSessionCacheConfig } from './redis-config.ts'

interface ChunkManifest {
  format: 'dsh-event-chunks-v1'
  parts: number
  bytes: number
  sha256: string
}

interface CachedEvent {
  format: 'dsh-event-v1'
  sha256: string
  event: SessionEvent
}

function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Redis strings are disposable copies of committed, row-identified session events. */
export class RedisSessionCache {
  private readonly redis: Redis
  private readonly config: ResolvedRedisSessionCacheConfig
  private available = false
  private closed = false
  private readonly scope: string

  /**
   * @param config - resolved connection and cache limits.
   * @param app - database application's case-sensitive namespace.
   * @param database - durable database name.
   * @param report - warning sink; receives no credentials or event contents.
   */
  constructor(
    config: ResolvedRedisSessionCacheConfig,
    app: string,
    database: string,
    private readonly report: (message: string) => void,
  ) {
    this.config = config
    this.scope = `${config.keyPrefix}${encodeURIComponent(app)}:db:${encodeURIComponent(database)}`
    this.redis = new Redis({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      db: config.database,
      ...(config.tls ? { tls: {} } : {}),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: config.connectTimeoutMs,
      commandTimeout: config.commandTimeoutMs,
      retryStrategy: () => config.connectTimeoutMs,
    })
    this.redis.on('ready', () => { this.available = true })
    this.redis.on('close', () => { this.available = false })
    this.redis.on('error', () => {
      if (this.available) this.report('session Redis cache unavailable; reads continue from MySQL')
      this.available = false
    })
  }

  /** Require a working connection at startup; later transport failures use database reads. */
  async connect(): Promise<void> {
    await this.redis.connect()
    await this.redis.ping()
  }

  private key(meta: SessionHeader, rowId: string, seq: number): string {
    const owner = meta.userId ?? DEFAULT_USER_ID
    const identity = hash(JSON.stringify([this.scope, owner, meta.id, rowId]))
    return `${this.scope}:user:${encodeURIComponent(owner)}:session:${encodeURIComponent(meta.id)}:{${identity}}:event:${seq}`
  }

  /**
   * Read one complete sequence window, refreshing every touched entry's TTL.
   * @param meta - ownership metadata read from MySQL for this request.
   * @param rowId - immutable database row identity, distinct after recreation.
   * @param start - inclusive event sequence.
   * @param end - exclusive event sequence, bounded by the database log extent.
   * @param signal - optional read cancellation.
   * @returns detached events, or undefined when any entry is missing or malformed.
   */
  async read(
    meta: SessionHeader,
    rowId: string,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<SessionEvent[] | undefined> {
    signal?.throwIfAborted()
    if (!this.available || this.closed) return undefined
    try {
      const keys = Array.from({ length: end - start }, (_, offset) => this.key(meta, rowId, start + offset))
      const values = await this.get(keys, signal)
      const events: SessionEvent[] = []
      for (const [offset, value] of values.entries()) {
        signal?.throwIfAborted()
        if (value === null) return undefined
        let record: unknown = JSON.parse(value.toString('utf8'))
        if (isRecord(record) && record['format'] === 'dsh-event-chunks-v1') {
          record = await this.readChunks(this.key(meta, rowId, start + offset), record, signal)
        }
        if (!isRecord(record) || record['format'] !== 'dsh-event-v1'
          || !isRecord(record['event']) || record['sha256'] !== hash(JSON.stringify(record['event']))) return undefined
        const decoded = record['event']
        if (!isRecord(decoded) || decoded['seq'] !== start + offset
          || typeof decoded['type'] !== 'string' || typeof decoded['time'] !== 'number'
          || !isRecord(decoded['data'])) return undefined
        events.push(decoded as unknown as SessionEvent)
      }
      return events
    } catch {
      signal?.throwIfAborted()
      // Redis transport errors and invalid disposable JSON cannot invalidate the database log.
      this.report('session Redis cache read failed; reading the affected page from MySQL')
      return undefined
    }
  }

  private async readChunks(
    key: string,
    manifest: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { parts, bytes, sha256 } = manifest
    if (typeof parts !== 'number' || !Number.isSafeInteger(parts) || parts < 2
      || typeof bytes !== 'number' || !Number.isSafeInteger(bytes)
      || bytes <= this.config.maxChunkBytes || bytes > this.config.maxEventBytes
      || parts !== Math.ceil(bytes / this.config.maxChunkBytes)
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) return undefined
    const chunks = await this.get(Array.from({ length: parts }, (_, part) => `${key}:part:${part}`), signal)
    if (chunks.some(chunk => chunk === null)) return undefined
    const data = Buffer.concat(chunks as Buffer[])
    if (data.byteLength !== bytes || hash(data) !== sha256) return undefined
    return JSON.parse(data.toString('utf8')) as unknown
  }

  private async get(keys: readonly string[], signal?: AbortSignal): Promise<(Buffer | null)[]> {
    const values: (Buffer | null)[] = []
    for (let offset = 0; offset < keys.length; offset += this.config.batchSize) {
      signal?.throwIfAborted()
      const pipeline = this.redis.pipeline()
      for (const key of keys.slice(offset, offset + this.config.batchSize)) {
        pipeline.getexBuffer(key, 'EX', this.config.ttlSeconds)
      }
      const results = await pipeline.exec()
      if (results === null) throw new Error('Redis pipeline did not complete')
      for (const [error, value] of results) {
        if (error !== null) throw error
        if (value !== null && (!Buffer.isBuffer(value) || value.byteLength > this.config.maxChunkBytes)) {
          throw new Error('Redis event value exceeds its configured bound')
        }
        values.push(value)
      }
    }
    signal?.throwIfAborted()
    return values
  }

  /**
   * Cache committed events without changing them or making Redis a durability requirement.
   * @param meta - durable session ownership.
   * @param rowId - immutable database row identity.
   * @param events - already committed event page or write batch.
   */
  async write(meta: SessionHeader, rowId: string, events: readonly SessionEvent[]): Promise<void> {
    if (!this.available || this.closed) return
    try {
      let pending: [string, Buffer][] = []
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return
        const pipeline = this.redis.pipeline()
        for (const [key, value] of pending) pipeline.set(key, value, 'EX', this.config.ttlSeconds)
        const results = await pipeline.exec()
        if (results === null) throw new Error('Redis pipeline did not complete')
        for (const [error] of results) if (error !== null) throw error
        pending = []
      }
      const put = async (key: string, value: Buffer): Promise<void> => {
        pending.push([key, value])
        if (pending.length >= this.config.batchSize) await flush()
      }
      for (const event of events) {
        const record: CachedEvent = { format: 'dsh-event-v1', sha256: hash(JSON.stringify(event)), event }
        const data = Buffer.from(JSON.stringify(record))
        if (data.byteLength > this.config.maxEventBytes) continue
        const key = this.key(meta, rowId, event.seq)
        if (data.byteLength <= this.config.maxChunkBytes) {
          await put(key, data)
          continue
        }
        const parts = Math.ceil(data.byteLength / this.config.maxChunkBytes)
        for (let part = 0; part < parts; part += 1) {
          await put(`${key}:part:${part}`, data.subarray(
            part * this.config.maxChunkBytes, (part + 1) * this.config.maxChunkBytes,
          ))
        }
        // Publish the descriptor only after every referenced chunk has reached Redis.
        await flush()
        const manifest: ChunkManifest = { format: 'dsh-event-chunks-v1', parts, bytes: data.byteLength, sha256: hash(data) }
        await put(key, Buffer.from(JSON.stringify(manifest)))
      }
      await flush()
    } catch {
      // Only disposable cache publication is inside this try; the caller's SQL commit already succeeded.
      this.report('session Redis cache write failed; committed history remains in MySQL')
    }
  }

  /** Stop reconnecting and release the socket after the persistence coordinator drains its writes. */
  close(): void {
    this.closed = true
    this.available = false
    this.redis.disconnect()
  }
}
