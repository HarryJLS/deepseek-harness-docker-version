import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { Context } from '@deepseek-ai/cordis'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionAssistantStreamBaseline } from '@deepseek-ai/dsh-api-session-controller'
import { mysqlIdGenerator, resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageMysql from '@deepseek-ai/dsh-storage-mysql'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MysqlSessionStore } from '../src/store.ts'
import { MysqlSessionExecution } from '../src/execution.ts'
import { MysqlAssistantState } from '../src/assistant-state.ts'

const url = process.env.DSH_TEST_MYSQL_URL
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe.skipIf(url === undefined)('shared Assistant SQL state', () => {
  it('publishes bounded chunks, authorizes another replica, and rejects a captured stale writer', async () => {
    if (url === undefined) throw new Error('DSH_TEST_MYSQL_URL is required')
    const app = `assistant-${randomUUID()}`
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    await ctx.plugin(StorageMysql, { url, app, snowflakeWorkerId: 911 })
    const pool = mysql.createPool(resolveMysqlPool({ url }))
    cleanup.push(async () => {
      await pool.query('DELETE FROM dsh_session_event WHERE app = ?', [app])
      await pool.query('DELETE FROM dsh_session WHERE app = ?', [app])
      await pool.query('DELETE FROM dsh_kv_record WHERE app = ?', [app])
      await pool.end()
    })
    const store = new MysqlSessionStore(pool, app, 'test', 912)
    await store.migrate()
    const id = SessionId(randomUUID())
    const alice = parseUserId('alice')
    await store.materializeHeader({ id, version: 3, isSeeded: false, createdAt: 1, userId: alice })
    const execution = new MysqlSessionExecution(pool, app, mysqlIdGenerator(913), {
      leaseMs: 3000, renewIntervalMs: 500, pollIntervalMs: 100,
    })
    cleanup.push(() => execution.close())
    const flush = vi.fn(async () => {})
    const shared = new MysqlAssistantState(pool, app, mysqlIdGenerator(914), execution, flush, 1024)
    const lease = await withUser(alice, () => execution.acquire(id))
    const writer = shared.createWriter(id)
    const baseline: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId: LlmAttemptId('sql-stream'), startedAfterSeq: SessionSeq(0),
        turn: 1, step: 1, nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['text '.repeat(900)] }],
      },
    }
    await withUser(alice, () => writer.publish(baseline))
    expect(flush).toHaveBeenCalledOnce()
    const other = new MysqlAssistantState(pool, app, mysqlIdGenerator(915), execution, flush, 1024)
    expect(await withUser(alice, () => other.read(id))).toEqual(baseline)
    await expect(withUser(parseUserId('bob'), () => other.read(id))).rejects.toThrow('not found')
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT key_name, LENGTH(CAST(value AS CHAR)) AS bytes FROM dsh_kv_record WHERE app = ? AND unit = 'dsh-assistant-live'", [app],
    )
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.every(row => Number(row.bytes) < 1500)).toBe(true)
    await lease[Symbol.asyncDispose]()
    expect(await other.read(id)).toBeUndefined()
    const successor = await execution.acquire(id)
    await expect(writer.publish(baseline)).rejects.toThrow('ownership was lost')
    await shared.createWriter(id).publish({ revision: 0 })
    expect(await other.read(id)).toEqual({ revision: 0 })
    await successor[Symbol.asyncDispose]()
  })
})
