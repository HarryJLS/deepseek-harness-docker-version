import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionStore } from '../src/store.ts'
import { RedisSessionCache } from '../src/redis-cache.ts'
import { resolveRedisSessionCacheConfig } from '../src/redis-config.ts'

const mysqlUrl = process.env.DSH_TEST_MYSQL_URL
const redisUrl = process.env.DSH_TEST_REDIS_URL

describe.skipIf(mysqlUrl === undefined || redisUrl === undefined)('Redis and OceanBase session recovery', () => {
  const app = `redis-test-${randomUUID()}`
  const alice = parseUserId('alice')
  const bob = parseUserId('bob')
  const warnings: string[] = []
  let admin: Redis
  let writerPool: mysql.Pool
  let readerPool: mysql.Pool
  let writer: MysqlSessionStore
  let reader: MysqlSessionStore

  const header = (): SessionHeader => ({
    id: SessionId(randomUUID()), userId: alice, version: 0, createdAt: Date.now(), cwd: '/tmp',
  })
  const event = (seq: number, text = 'recorded text'): SessionEvent => ({
    type: 'assistant/chunk', seq, time: Date.now(),
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  })

  async function keys(): Promise<string[]> {
    const found: string[] = []
    let cursor = '0'
    do {
      const page = await admin.scan(cursor, 'MATCH', `dsh-${app}:*`, 'COUNT', 100)
      cursor = page[0]
      found.push(...page[1])
    } while (cursor !== '0')
    return found
  }

  beforeAll(async () => {
    const address = new URL(redisUrl!)
    const database = decodeURIComponent(new URL(mysqlUrl!).pathname.slice(1))
    const config = resolveRedisSessionCacheConfig({
      host: address.hostname, port: Number(address.port || 6379),
      username: address.username === '' ? undefined : decodeURIComponent(address.username),
      password: address.password === '' ? undefined : decodeURIComponent(address.password),
      database: Number(address.pathname.slice(1) || 0), tls: address.protocol === 'rediss:',
      maxChunkBytes: 1024, maxEventBytes: 8192, ttlSeconds: 172800, batchSize: 16,
    })
    admin = new Redis(redisUrl!, { lazyConnect: true })
    await admin.connect()
    writerPool = mysql.createPool(resolveMysqlPool({ url: mysqlUrl! }))
    readerPool = mysql.createPool(resolveMysqlPool({ url: mysqlUrl! }))
    const writerCache = new RedisSessionCache(config, app, database, message => warnings.push(message))
    const readerCache = new RedisSessionCache(config, app, database, message => warnings.push(message))
    writer = new MysqlSessionStore(writerPool, app, database, 928, writerCache)
    reader = new MysqlSessionStore(readerPool, app, database, 929, readerCache)
    await writer.migrate()
    await writerCache.connect()
    await readerCache.connect()
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    if (writerPool !== undefined) {
      await writerPool.query('DELETE FROM dsh_session_event WHERE app = ?', [app])
      await writerPool.query('DELETE FROM dsh_session WHERE app = ?', [app])
    }
    if (admin !== undefined) {
      for (const key of await keys()) await admin.unlink(key)
      admin.disconnect()
    }
    await writer?.close()
    await reader?.close()
  })

  it('shares committed context with an independent reader without reading database event bodies', async () => {
    const meta = header()
    const events = [event(0), event(1, '\u4e2d\u6587'.repeat(900))]
    await writer.appendBatch(meta, events, false)
    const reads = vi.spyOn(readerPool, 'query')
    expect((await withUser(alice, () => reader.loadStored(meta.id)))?.events).toEqual(events)
    expect(reads.mock.calls.some(([sql]) => typeof sql === 'string' && /SELECT seq, event/u.test(sql))).toBe(false)
    reads.mockRestore()
    for (const key of await keys()) {
      expect(key.startsWith(`dsh-${app}:`)).toBe(true)
      expect(await admin.strlen(key)).toBeLessThanOrEqual(1024)
      expect(await admin.ttl(key)).toBeGreaterThan(172790)
    }
    expect(await withUser(bob, () => reader.loadStored(meta.id))).toBeUndefined()
    expect((await withUser(bob, () => reader.list())).some(item => item.id === meta.id)).toBe(false)
  })

  it('reads an expired cold session from MySQL and repopulates Redis', async () => {
    const meta = header()
    const events = [event(0, 'user-global\u0000AGENTS.md'), event(1, String.raw`literal \u0000`)]
    await writer.appendBatch(meta, events, false)
    const sessionKeys = (await keys()).filter(key => key.includes(`:session:${meta.id}:`))
    for (const key of sessionKeys) await admin.expire(key, 1)
    await delay(1100)
    const reads = vi.spyOn(readerPool, 'query')
    expect((await reader.loadStored(meta.id))?.events).toEqual(events)
    expect(reads.mock.calls.some(([sql]) => typeof sql === 'string' && /SELECT seq, event/u.test(sql))).toBe(true)
    reads.mockRestore()
    for (const key of sessionKeys) expect(await admin.ttl(key)).toBeGreaterThan(172790)
  })

  it('recovers from partial eviction and corrupt Redis data without losing history', async () => {
    const meta = header()
    const events = [event(0, 'x'.repeat(4000))]
    await writer.appendBatch(meta, events, false)
    const chunk = (await keys()).find(key => key.includes(`:session:${meta.id}:`) && key.endsWith(':part:1'))!
    await admin.unlink(chunk)
    expect((await reader.loadStored(meta.id))?.events).toEqual(events)
    expect(await admin.exists(chunk)).toBe(1)
    await admin.set(chunk, 'corrupted', 'EX', 172800)
    expect((await reader.loadStored(meta.id))?.events).toEqual(events)
    expect(await admin.get(chunk)).not.toBe('corrupted')
  })

  it('does not publish a rejected batch and never overwrites a concurrent writer', async () => {
    const meta = header()
    const original = event(0)
    await writer.appendBatch(meta, [original], false)
    const attempts = await Promise.allSettled([
      writer.appendBatch(meta, [event(1, 'writer')], true),
      reader.appendBatch(meta, [event(1, 'reader')], true),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
    const stored = await reader.loadStored(meta.id)
    expect(stored?.events).toHaveLength(2)
    expect(stored?.events[0]).toEqual(original)
    await expect(writer.appendBatch(meta, [event(4)], true)).rejects.toThrow('noncontiguous')
    expect((await reader.loadStored(meta.id))?.events).toEqual(stored?.events)
  })

  it('does not resurrect a soft-deleted event or session from a warm cache', async () => {
    const meta = header()
    const events = [event(0), event(1), event(2)]
    await writer.appendBatch(meta, events, false)
    await writerPool.query(
      "UPDATE dsh_session_event SET is_deleted = 'Y' WHERE app = ? AND session_id = ? AND seq = 1",
      [app, meta.id],
    )
    expect((await reader.loadStored(meta.id))?.events).toEqual([events[0], events[2]])
    await writerPool.query("UPDATE dsh_session SET is_deleted = 'Y' WHERE app = ? AND session_id = ?", [app, meta.id])
    expect(await reader.loadStored(meta.id)).toBeUndefined()
  })

  it('keeps an oversized event complete in the database and seeks a cached suffix', async () => {
    const meta = header()
    const events = [event(0, 'large text '.repeat(1000)), event(1)]
    await writer.appendBatch(meta, events, false)
    expect((await reader.loadStored(meta.id))?.events).toEqual(events)
    expect((await keys()).some(key => key.includes(`:session:${meta.id}:`) && key.endsWith(':event:0'))).toBe(false)
    const reads = vi.spyOn(readerPool, 'query')
    expect((await reader.loadStoredFrom(meta.id, 1))?.events).toEqual([events[1]])
    expect(reads.mock.calls.some(([sql]) => typeof sql === 'string' && /SELECT seq, event/u.test(sql))).toBe(false)
    reads.mockRestore()
    expect((await reader.loadStoredFrom(meta.id, 50))?.events).toEqual([])
  })
})
