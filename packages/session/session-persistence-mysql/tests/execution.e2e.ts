import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mysqlIdGenerator, resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { SessionId, SessionSeq, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionExecution } from '../src/execution.ts'
import { MysqlSessionStore } from '../src/store.ts'

const url = process.env.DSH_TEST_MYSQL_URL

describe.skipIf(url === undefined)('OceanBase shared execution', () => {
  const app = `execution-test-${randomUUID()}`
  const alice = parseUserId('execution-alice')
  const bob = parseUserId('execution-bob')
  const config = { leaseMs: 3000, renewIntervalMs: 500, pollIntervalMs: 100 }
  let pools: mysql.Pool[]
  let owners: MysqlSessionExecution[]
  let stores: MysqlSessionStore[]
  const meta = (): SessionHeader => ({
    id: SessionId(randomUUID()), version: 3, isSeeded: false, userId: alice, cwd: '/tmp', createdAt: Date.now(),
  })
  const event = (seq: number): SessionEvent => ({
    type: 'plan/mode', seq: SessionSeq(seq), time: Date.now(), data: { active: true },
  })

  beforeAll(async () => {
    const database = decodeURIComponent(new URL(url!).pathname.slice(1))
    pools = [mysql.createPool(resolveMysqlPool({ url: url! })), mysql.createPool(resolveMysqlPool({ url: url! }))]
    owners = pools.map((pool, index) => new MysqlSessionExecution(pool, app, mysqlIdGenerator(920 + index), config))
    stores = pools.map((pool, index) => new MysqlSessionStore(pool, app, database, 920 + index, undefined, owners[index]))
    await stores[0]!.migrate()
    await Promise.all(owners.map(owner => owner.init()))
  })

  afterAll(async () => {
    if (owners !== undefined) await Promise.all(owners.map(owner => owner.close()))
    if (pools !== undefined) {
      await pools[0]!.query('DELETE FROM dsh_session_event WHERE app = ?', [app])
      await pools[0]!.query('DELETE FROM dsh_session WHERE app = ?', [app])
      await pools[0]!.query('DELETE FROM dsh_kv_record WHERE app = ?', [app])
      await Promise.all(pools.map(pool => pool.end()))
    }
  })

  it('excludes a second node, releases idle ownership, and fences every event write', async () => {
    const header = meta()
    const first = await withUser(alice, () => owners[0]!.acquire(header.id))
    await withUser(alice, () => stores[0]!.appendBatch(header, [event(0)], false))
    await expect(withUser(alice, () => owners[1]!.acquire(header.id))).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await expect(withUser(alice, () => stores[1]!.appendBatch(header, [event(1)], true))).rejects.toThrow('ownership')
    expect((await withUser(alice, () => stores[1]!.loadStored(header.id)))?.events).toHaveLength(1)
    await first[Symbol.asyncDispose]()
    const second = await withUser(alice, () => owners[1]!.acquire(header.id))
    await withUser(alice, () => stores[1]!.appendBatch(header, [event(1)], true))
    expect((await withUser(alice, () => stores[0]!.loadStored(header.id)))?.events).toHaveLength(2)
    await second[Symbol.asyncDispose]()
    expect(await withUser(alice, () => owners[0]!.active(header.id))).toBe(false)
  })

  it('does not let an expired writer commit or release a successor reservation', async () => {
    const header = meta()
    const stale = await owners[0]!.acquire(header.id)
    await stores[0]!.appendBatch(header, [event(0)], false)
    await pools[0]!.query(
      "UPDATE dsh_kv_record SET value = JSON_SET(value, '$.expiresAt', 0) WHERE app = ? AND unit = 'dsh-session-execution' AND key_name = ?",
      [app, header.id],
    )
    const successor = await owners[1]!.acquire(header.id)
    await expect(stores[0]!.appendBatch(header, [event(1)], true)).rejects.toThrow('ownership')
    await stale[Symbol.asyncDispose]()
    expect(await owners[1]!.active(header.id)).toBe(true)
    await stores[1]!.appendBatch(header, [event(1)], true)
    await successor[Symbol.asyncDispose]()
  })

  it('renews while work is active and propagates an authorized cross-node cancellation', async () => {
    const header = meta()
    const first = await withUser(alice, () => owners[0]!.acquire(header.id))
    await stores[0]!.appendBatch(header, [event(0)], false)
    await delay(3200)
    expect(first.signal.aborted).toBe(false)
    await expect(owners[1]!.acquire(header.id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await expect(withUser(bob, () => owners[1]!.cancel(header.id))).rejects.toThrow('not found')
    await withUser(alice, () => owners[1]!.cancel(header.id))
    await vi.waitFor(() => { expect(first.signal.aborted).toBe(true) })
    await first[Symbol.asyncDispose]()
    await expect(withUser(bob, () => owners[1]!.acquire(header.id))).rejects.toThrow('not found')
    expect(owners[1]!.owns(header.id)).toBe(false)
  })
})
