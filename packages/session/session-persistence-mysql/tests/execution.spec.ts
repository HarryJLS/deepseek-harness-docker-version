import type mysql from 'mysql2/promise'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionExecution } from '../src/execution.ts'

vi.mock('@deepseek-ai/dsh-mysql-schema', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-mysql-schema')>(),
  assertMysqlTable: vi.fn(async () => {}),
}))

const id = SessionId('session-lease')
const config = { leaseMs: 3000, renewIntervalMs: 500, pollIntervalMs: 100 }
const owners: MysqlSessionExecution[] = []

function database() {
  const headers = new Map<string, string>([[id, 'alice']])
  const records = new Map<string, unknown>()
  const now = vi.fn(() => Date.now())
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<[Record<string, unknown>[], unknown[]]> => {
    if (sql.startsWith('SELECT user_id')) {
      const user = headers.get(String(values[1]))
      return [user === undefined ? [] : [{ user_id: user }], []]
    }
    if (sql.startsWith('SELECT value')) {
      const key = String(values[2])
      return [records.has(key) ? [{ value: records.get(key), now_ms: now() }] : [], []]
    }
    if (sql.includes('INSERT INTO')) {
      const key = String(values[5])
      if (!records.has(key)) records.set(key, JSON.parse(String(values[6])) as unknown)
      return [[], []]
    }
    if (sql.startsWith('UPDATE')) {
      records.set(String(values[4]), JSON.parse(String(values[0])) as unknown)
      return [[], []]
    }
    if (sql.startsWith('DELETE')) {
      records.delete(String(values[2]))
      return [[], []]
    }
    throw new Error(`Unexpected test query: ${sql}`)
  })
  const connection = {
    query,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  }
  const getConnection = vi.fn(async () => connection)
  const pool = { query, getConnection } as unknown as mysql.Pool
  const create = () => {
    const owner = new MysqlSessionExecution(pool, 'test', () => '1', config)
    owners.push(owner)
    return owner
  }
  return { create, records, headers, now, query, connection, getConnection, pool }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'], now: 1789257600000 })
})
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    // Fault-injection cases can leave a deliberately malformed backend row.
    await owner.close().catch(() => undefined)
  }
  vi.useRealTimers()
})

describe('shared execution reservations', () => {
  it('validates timing, initializes storage, and rejects access without ownership', async () => {
    const db = database()
    expect(() => new MysqlSessionExecution(db.pool, 'test', () => '1', { ...config, renewIntervalMs: 2000 }))
      .toThrow('three renewIntervalMs')
    const owner = db.create()
    await owner.init()
    expect(owner.pollIntervalMs).toBe(100)
    expect(owner.owns(id)).toBe(false)
    await expect(owner.assertOwned(id)).rejects.toThrow('exclusive reservation')
    expect(await owner.active(id)).toBe(false)
    await owner.cancel(id)
  })

  it('excludes both local and remote competitors and releases a reservation once', async () => {
    const db = database()
    const a = db.create()
    const b = db.create()
    const lease = await a.acquire(id)
    expect(a.owns(id)).toBe(true)
    expect(await b.active(id)).toBe(true)
    await a.assertOwned(id)
    await expect(a.acquire(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await expect(b.acquire(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(b.owns(id)).toBe(false)
    await lease[Symbol.asyncDispose]()
    await lease[Symbol.asyncDispose]()
    expect(a.owns(id)).toBe(false)
    expect(await b.active(id)).toBe(false)
    expect(db.connection.release).toHaveBeenCalled()
  })

  it('renews ownership, observes cancellation, and aborts further work', async () => {
    const db = database()
    const owner = db.create()
    const lease = await owner.acquire(id)
    const before = (db.records.get(id) as { expiresAt: number }).expiresAt
    await vi.advanceTimersByTimeAsync(600)
    expect((db.records.get(id) as { expiresAt: number }).expiresAt).toBeGreaterThan(before)
    await owner.cancel(id)
    await vi.advanceTimersByTimeAsync(100)
    expect(lease.signal.aborted).toBe(true)
    await expect(owner.assertOwned(id)).rejects.toThrow('cancelled')
  })

  it('does not delete a successor or allow an expired writer to proceed', async () => {
    const db = database()
    const owner = db.create()
    const lease = await owner.acquire(id)
    const original = db.records.get(id) as { token: string; expiresAt: number; cancelled: boolean }
    db.records.set(id, { ...original, expiresAt: Date.now() })
    await expect(owner.assertOwned(id)).rejects.toThrow('ownership was lost')
    db.records.set(id, { ...original, token: 'successor', expiresAt: Date.now() + 3000 })
    await lease[Symbol.asyncDispose]()
    expect((db.records.get(id) as { token: string }).token).toBe('successor')
  })

  it('authorizes before disclosing active ownership and permits new session creation', async () => {
    const db = database()
    const owner = db.create()
    await owner.acquire(id)
    await expect(withUser(parseUserId('bob'), () => owner.acquire(id))).rejects.toThrow('not found')
    await expect(withUser(parseUserId('bob'), () => owner.cancel(id))).rejects.toThrow('not found')
    await expect(owner.active(SessionId('missing'))).rejects.toThrow('not found')
    const fresh = SessionId('new-session')
    const lease = await owner.acquire(fresh)
    expect(owner.owns(fresh)).toBe(true)
    await lease[Symbol.asyncDispose]()
  })

  it('preserves the write failure if rollback also fails and frees failed admission', async () => {
    const db = database()
    const owner = db.create()
    db.connection.beginTransaction.mockRejectedValueOnce(new Error('write failed'))
    db.connection.rollback.mockRejectedValueOnce(new Error('connection lost'))
    await expect(owner.acquire(id)).rejects.toThrow('write failed')
    expect(owner.owns(id)).toBe(false)
    expect(db.connection.release).toHaveBeenCalledOnce()
    await owner.acquire(id)
    db.getConnection.mockRejectedValueOnce(new Error('renewal failed'))
    await vi.advanceTimersByTimeAsync(100)
    await expect(owner.assertOwned(id)).rejects.toThrow('renewal failed')
  })

  it.each([null, 4, { token: 3 }, { token: 'x', expiresAt: 1.5, cancelled: false },
    { token: 'x', expiresAt: 1, cancelled: 'yes' }])('rejects malformed stored reservations %#', async (value) => {
    const db = database()
    db.records.set(id, value)
    await expect(db.create().active(id)).rejects.toThrow('Malformed')
  })

  it('rejects an invalid database clock', async () => {
    const db = database()
    const owner = db.create()
    await owner.acquire(id)
    db.now.mockReturnValueOnce(0)
    await expect(owner.active(id)).rejects.toThrow('Malformed')
  })

  it('expires locally while a renewal is stalled and joins it before releasing', async () => {
    const db = database()
    const owner = db.create()
    const lease = await owner.acquire(id)
    const waiting = Promise.withResolvers<typeof db.connection>()
    db.getConnection.mockImplementationOnce(() => waiting.promise)
    await vi.advanceTimersByTimeAsync(3100)
    expect(lease.signal.aborted).toBe(true)
    expect(String(lease.signal.reason)).toContain('expired')
    const released = lease[Symbol.asyncDispose]()
    waiting.resolve(db.connection)
    await released
    expect(owner.owns(id)).toBe(false)
  })

  it('does not schedule another renewal when release races a successful renewal', async () => {
    const db = database()
    const owner = db.create()
    const lease = await owner.acquire(id)
    await vi.advanceTimersByTimeAsync(400)
    const waiting = Promise.withResolvers<undefined>()
    db.connection.commit.mockImplementationOnce(() => waiting.promise)
    await vi.advanceTimersByTimeAsync(100)
    const released = lease[Symbol.asyncDispose]()
    waiting.resolve(undefined)
    await released
    expect(vi.getTimerCount()).toBe(0)
  })
})
