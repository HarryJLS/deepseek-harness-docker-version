import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { MysqlSessionStore } from '../src/store.ts'

const url = process.env.DSH_TEST_MYSQL_URL

describe.skipIf(url === undefined)('OceanBase session rows', () => {
  const app = `audit_${randomUUID()}`
  const alice = parseUserId('alice')
  const bob = parseUserId('bob')
  let pool: mysql.Pool
  let store: MysqlSessionStore
  const meta = (userId = alice): SessionHeader => ({
    id: SessionId(randomUUID()), version: 0, createdAt: Date.now(), cwd: '/tmp', userId,
  })

  beforeAll(async () => {
    pool = mysql.createPool(resolveMysqlPool({ url: url! }))
    store = new MysqlSessionStore(pool, app, 'test', 703)
    await store.migrate()
  })

  afterAll(async () => {
    await pool.query('DELETE FROM dsh_session_event WHERE app = ?', [app])
    await pool.query('DELETE FROM dsh_session WHERE app = ?', [app])
    await store.close()
  })

  it('writes Snowflake ids and audit fields while keeping the logical session identity', async () => {
    const header = meta()
    await withUser(alice, () => store.materializeHeader(header))
    await store.appendBatch(header, [{ type: 'session/end-seed', seq: 0, time: Date.now(), data: {} }], true)
    const [sessions] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM dsh_session WHERE app = ? AND session_id = ?', [app, header.id])
    const [events] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM dsh_session_event WHERE app = ? AND session_id = ?', [app, header.id])
    for (const row of [sessions[0]!, events[0]!]) {
      expect(row.id).toMatch(/^\d+$/u)
      expect(BigInt(String(row.id))).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
      expect(row).toMatchObject({ session_id: header.id, is_deleted: 'N', user_id: 'alice', creator: 'alice', modifier: 'alice' })
      expect(row.gmt_created).toBeInstanceOf(Date)
      expect(row.gmt_modified).toBeInstanceOf(Date)
    }
    expect(sessions[0]!.id).not.toBe(events[0]!.id)
  })

  it('filters list and exact reads and prevents another owner from claiming an existing id', async () => {
    const header = meta()
    await store.materializeHeader(header)
    await withUser(bob, async () => {
      expect(await store.loadStored(header.id)).toBeUndefined()
      expect(await store.readStoredRevision(header.id)).toBeUndefined()
      expect(await store.loadStoredFrom(header.id, 0)).toBeUndefined()
      expect((await store.list()).some(item => item.id === header.id)).toBe(false)
      await expect(store.materializeHeader({ ...header, userId: bob })).rejects.toThrow('not found')
      await expect(store.appendBatch(header, [{ type: 'session/end-seed', seq: 0, time: 1, data: {} }], true)).rejects.toThrow('not found')
    })
    expect((await withUser(alice, () => store.loadStored(header.id)))?.meta.userId).toBe('alice')
  })

  it('defaults absent ownership to - and hides soft-deleted sessions', async () => {
    const anonymous: SessionHeader = { id: SessionId(randomUUID()), version: 0, createdAt: 1, cwd: '/tmp' }
    await store.materializeHeader(anonymous)
    expect((await withUser(parseUserId(undefined), () => store.list())).map(header => header.id)).toEqual([anonymous.id])
    await pool.query("UPDATE dsh_session SET is_deleted = 'Y', modifier = '-', gmt_modified = CURRENT_TIMESTAMP WHERE app = ? AND session_id = ?", [app, anonymous.id])
    expect(await store.loadStored(anonymous.id)).toBeUndefined()
  })

  it('rolls back a failed event batch without advancing the header revision', async () => {
    const header = meta()
    const event = { type: 'session/end-seed' as const, seq: 0, time: 1, data: {} }
    await store.appendBatch(header, [event], false)
    const revision = await store.readStoredRevision(header.id)
    await expect(store.appendBatch(header, [event], true)).rejects.toThrow()
    expect(await store.readStoredRevision(header.id)).toBe(revision)
    expect((await store.loadStored(header.id))?.events).toEqual([event])
  })

  it('distinguishes a recreated physical row from an earlier revision of the same session id', async () => {
    const header = meta()
    await store.materializeHeader(header)
    const previous = await store.readStoredRevision(header.id)
    await pool.query('DELETE FROM dsh_session WHERE app = ? AND session_id = ?', [app, header.id])
    await store.materializeHeader(header)
    expect(await store.readStoredRevision(header.id)).not.toBe(previous)
  })
})
