import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseUserId } from '@deepseek-ai/dsh-user-context'
import { RedisSessionCacheConfig, resolveRedisSessionCacheConfig } from '../src/redis-config.ts'
import { RedisSessionCache } from '../src/redis-cache.ts'
import { MysqlSessionPersistence } from '../src/index.ts'

const server = vi.hoisted(() => ({
  entries: new Map<string, { value: Buffer; expiresAt: number }>(),
  batches: [] as number[],
  disconnected: 0,
  fail: false,
  connectError: false,
  nullPipeline: false,
  handlers: new Map<string, () => void>(),
  options: [] as { tls?: object; retryStrategy: () => number }[],
}))

vi.mock('ioredis', () => ({
  Redis: class {
    constructor(options: { tls?: object; retryStrategy: () => number }) { server.options.push(options) }
    on(event: string, handler: () => void) { server.handlers.set(event, handler) }
    connect() {
      if (server.connectError) return Promise.reject(new Error('unavailable'))
      server.handlers.get('ready')?.()
      return Promise.resolve()
    }
    ping() { return Promise.resolve('PONG') }
    disconnect() { server.disconnected += 1 }
    pipeline() {
      const commands: (() => [Error | null, unknown])[] = []
      const pipeline = {
        getexBuffer(key: string, _mode: string, ttl: number) {
          commands.push(() => {
            const entry = server.entries.get(key)
            if (entry === undefined || entry.expiresAt <= Date.now()) {
              server.entries.delete(key)
              return [null, null]
            }
            entry.expiresAt = Date.now() + ttl * 1000
            return [null, Buffer.from(entry.value)]
          })
          return pipeline
        },
        set(key: string, value: Buffer, _mode: string, ttl: number) {
          commands.push(() => {
            server.entries.set(key, { value: Buffer.from(value), expiresAt: Date.now() + ttl * 1000 })
            return [null, 'OK']
          })
          return pipeline
        },
        exec() {
          server.batches.push(commands.length)
          return Promise.resolve(server.nullPipeline ? null
            : commands.map(command => server.fail ? [new Error('connection lost'), null] : command()))
        },
      }
      return pipeline
    }
  },
}))

const header = (user = 'alice', id = 'session:1'): SessionHeader => ({
  id: SessionId(id), userId: parseUserId(user), version: 0, createdAt: 1,
})
const event = (seq: number, text = 'hello'): SessionEvent => ({
  seq, time: 1, type: 'assistant/chunk',
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
})
const warnings: string[] = []
const caches: RedisSessionCache[] = []

async function cache(options: Partial<RedisSessionCacheConfig> = {}, app = 'app'): Promise<RedisSessionCache> {
  const value = new RedisSessionCache(resolveRedisSessionCacheConfig({ host: 'redis', ...options }), app, 'database', message => warnings.push(message))
  caches.push(value)
  await value.connect()
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  server.entries.clear()
  server.batches = []
  server.handlers.clear()
  server.options = []
  server.disconnected = 0
  server.fail = false
  server.connectError = false
  server.nullPipeline = false
  warnings.length = 0
})

afterEach(() => {
  for (const value of caches.splice(0)) value.close()
  vi.useRealTimers()
})

describe('Redis cache configuration', () => {
  it('keeps caching optional outside the container composition', () => {
    expect(MysqlSessionPersistence.Config({}).redis).toBeUndefined()
    expect(MysqlSessionPersistence.Config({ redis: { host: 'redis' } }).redis)
      .toMatchObject({ host: 'redis', ttlSeconds: 172800, keyPrefix: 'dsh-' })
  })

  it('resolves two days, bounded chunks, and the mandatory key prefix', () => {
    const config = resolveRedisSessionCacheConfig({ host: 'redis' })
    expect(config).toMatchObject({ ttlSeconds: 172800, maxChunkBytes: 65536, keyPrefix: 'dsh-' })
    for (const input of [
      { host: ' ' }, { host: ' redis' }, { ttlSeconds: 0 }, { keyPrefix: 'other-' },
      { maxChunkBytes: 1024, maxEventBytes: 512 }, { maxChunkBytes: 2048, maxEventBytes: 1024 },
    ]) {
      expect(() => resolveRedisSessionCacheConfig({ host: 'redis', ...input })).toThrow()
    }
  })
})

describe('Redis session event cache', () => {
  it('scopes all keys by application, user, session, and physical database row', async () => {
    const first = await cache()
    await first.write(header(), 'row-1', [event(0)])
    const keys = [...server.entries.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^dsh-app:db:database:user:alice:session:session%3A1:/u)
    expect(await first.read(header(), 'row-1', 0, 1)).toEqual([event(0)])
    expect(await first.read(header('bob'), 'row-1', 0, 1)).toBeUndefined()
    expect(await first.read(header('alice', 'session:2'), 'row-1', 0, 1)).toBeUndefined()
    expect(await first.read(header(), 'row-2', 0, 1)).toBeUndefined()
    const second = await cache({}, 'another-app')
    expect(await second.read(header(), 'row-1', 0, 1)).toBeUndefined()
    const anonymous = { id: SessionId('anonymous'), version: 0, createdAt: 1 }
    await first.write(anonymous, 'row-3', [event(0)])
    expect([...server.entries.keys()].some(key => key.includes(':user:-:'))).toBe(true)
  })

  it('splits a large UTF-8 event without an oversized Redis value or pipeline', async () => {
    const value = await cache({ maxChunkBytes: 1024, maxEventBytes: 20000, batchSize: 2 })
    const events = [event(0, '\u4e2d\u6587'.repeat(1200)), event(1), event(2)]
    await value.write(header(), 'row', events)
    expect(server.entries.size).toBeGreaterThan(4)
    for (const entry of server.entries.values()) expect(entry.value.byteLength).toBeLessThanOrEqual(1024)
    expect(await value.read(header(), 'row', 0, 3)).toEqual(events)
    expect(Math.max(...server.batches)).toBeLessThanOrEqual(2)
    const detached = await value.read(header(), 'row', 1, 2)
    detached![0]!.time = 9
    expect(await value.read(header(), 'row', 1, 2)).toEqual([event(1)])
  })

  it('refreshes all chunk TTLs and treats expiry as a cache miss', async () => {
    const value = await cache({ ttlSeconds: 2, maxChunkBytes: 1024 })
    const events = [event(0, 'x'.repeat(2500))]
    await value.write(header(), 'row', events)
    vi.advanceTimersByTime(1500)
    expect(await value.read(header(), 'row', 0, 1)).toEqual(events)
    for (const entry of server.entries.values()) expect(entry.expiresAt - Date.now()).toBe(2000)
    vi.advanceTimersByTime(2001)
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
  })

  it('treats missing chunks, corrupt chunks, and invalid cache JSON as misses', async () => {
    const value = await cache({ maxChunkBytes: 1024 })
    const events = [event(0, 'x'.repeat(2500))]
    await value.write(header(), 'row', events)
    const chunkKey = [...server.entries.keys()].find(key => key.endsWith(':part:1'))!
    server.entries.delete(chunkKey)
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    await value.write(header(), 'row', events)
    server.entries.get(chunkKey)!.value = Buffer.from('broken')
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    const mainKey = [...server.entries.keys()].find(key => key.endsWith(':event:0'))!
    server.entries.get(mainKey)!.value = Buffer.from('not JSON')
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    expect(warnings).not.toHaveLength(0)
  })

  it('rejects invalid manifests and event identities before returning cached data', async () => {
    const value = await cache({ maxChunkBytes: 1024 })
    await value.write(header(), 'row', [event(0)])
    const key = [...server.entries.keys()][0]!
    for (const invalid of [
      { format: 'dsh-event-chunks-v1', parts: 999999999, bytes: 2500, sha256: 'a'.repeat(64) },
      { format: 'dsh-event-chunks-v1', parts: 3, bytes: 2500, sha256: 'bad' },
      { ...event(1) }, { ...event(0), data: null }, null, {},
    ]) {
      server.entries.get(key)!.value = Buffer.from(JSON.stringify(invalid))
      expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    }
    for (const invalid of [event(1), { ...event(0), data: null }, { ...event(0), time: 'bad' }, { ...event(0), type: 12 }]) {
      server.entries.get(key)!.value = Buffer.from(JSON.stringify({
        format: 'dsh-event-v1',
        sha256: createHash('sha256').update(JSON.stringify(invalid)).digest('hex'),
        event: invalid,
      }))
      expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    }
    server.entries.get(key)!.value = Buffer.alloc(1025)
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
  })

  it('keeps oversized events database-only without caching a truncated value', async () => {
    const value = await cache({ maxChunkBytes: 1024, maxEventBytes: 2048 })
    await value.write(header(), 'row', [event(0, 'x'.repeat(3000))])
    expect(server.entries.size).toBe(0)
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    await value.write(header(), 'row', [])
    expect(await value.read(header(), 'row', 0, 0)).toEqual([])
  })

  it('contains transport failures, refuses unavailable startup, and closes reconnects', async () => {
    server.connectError = true
    await expect(cache()).rejects.toThrow('unavailable')
    server.connectError = false
    const value = await cache()
    server.fail = true
    await expect(value.write(header(), 'row', [event(0)])).resolves.toBeUndefined()
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    server.fail = false
    server.nullPipeline = true
    await value.write(header(), 'row', [event(0)])
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    server.nullPipeline = false
    server.handlers.get('error')?.()
    const warned = warnings.length
    server.handlers.get('error')?.()
    expect(warnings).toHaveLength(warned)
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    server.handlers.get('ready')?.()
    await value.write(header(), 'row', [event(0)])
    server.handlers.get('close')?.()
    expect(await value.read(header(), 'row', 0, 1)).toBeUndefined()
    value.close()
    await value.write(header(), 'row', [event(1)])
    expect(server.disconnected).toBe(1)
  })

  it('preserves read cancellation instead of converting it into a miss', async () => {
    const value = await cache()
    await value.write(header(), 'row', [event(0)])
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(value.read(header(), 'row', 0, 1, signal)).rejects.toThrow('cancelled')
  })

  it('uses verified TLS and the configured reconnect delay', async () => {
    await cache({ tls: true, connectTimeoutMs: 1234 })
    expect(server.options[0]!.tls).toEqual({})
    expect(server.options[0]!.retryStrategy()).toBe(1234)
  })
})
