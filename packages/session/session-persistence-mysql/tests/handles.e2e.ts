/** The shared Session-handle and live-write suites against isolated MySQL application rows. */

import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { meta, oneTurnLog, runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'
import MysqlSessionPersistence from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL
const contexts = new Set<Context>()
const apps = new Set<string>()

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  if (url !== undefined && apps.size > 0) {
    const pool = mysql.createPool(resolveMysqlPool({ url }))
    try {
      for (const app of apps) {
        await pool.query('DELETE FROM dsh_session_event WHERE app = ?', [app])
        await pool.query('DELETE FROM dsh_session WHERE app = ?', [app])
      }
    } finally {
      await pool.end()
      apps.clear()
    }
  }
})

async function fixture() {
  if (url === undefined) throw new Error('DSH_TEST_MYSQL_URL is required')
  const app = `handles-${randomUUID()}`
  apps.add(app)
  const mount = async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(MysqlSessionPersistence, { url, app, snowflakeWorkerId: 711, writeBatchMaxDelayMs: 20 })
    return ctx
  }
  const instance = async () => {
    const ctx = await mount()
    return { persistence: ctx.sessionPersistence, dispose: () => ctx.fiber.dispose() }
  }
  return { ...(await instance()), reopen: instance, mount }
}

describe.skipIf(url === undefined)('MySQL Session handles', () => {
  runPersistenceContract('mysql', fixture)
  runLiveWritePathContract('mysql', 20, async () => {
    const prepared = await fixture()
    return { ctx: await prepared.mount(), remount: prepared.mount }
  })

  it('retains the owner and exact inherited prefix across a cold reopen', async () => {
    const backend = await fixture()
    const owner = parseUserId('owner')
    const header = { ...meta('forked'), userId: owner, isSeeded: true, parentSession: SessionId('parent') }
    const inheritedEventCount = SessionLogOffset(oneTurnLog().length)
    const writer = await withUser(owner, () => backend.persistence.create(header, { inheritedEventCount }))
    await writer.append(oneTurnLog())
    await writer.close()
    const reopened = await backend.reopen()
    await withUser(owner, async () => {
      await using reader = await reopened.persistence.open(header.id, 'read')
      expect(reader.header).toEqual(header)
      expect(reader.inheritedEventCount).toBe(inheritedEventCount)
      expect((await reader.read()).events).toEqual(oneTurnLog())
    })
    await withUser(parseUserId('other'), async () => {
      expect(await reopened.persistence.stat(header.id)).toBeUndefined()
      expect(await reopened.persistence.list()).toEqual([])
      await expect(reopened.persistence.open(header.id, 'read')).rejects.toThrow('not found')
      await expect(reopened.persistence.open(header.id, 'write')).rejects.toThrow('not found')
    })
  })

  it('reads V0 headers and rewrites the session on its next write', async () => {
    const backend = await fixture()
    const app = [...apps][0]!
    if (url === undefined) throw new Error('DSH_TEST_MYSQL_URL is required')
    const pool = mysql.createPool(resolveMysqlPool({ url }))
    const header = meta('old-format')
    try {
      const initial = await backend.persistence.create(header)
      await initial.flush()
      await initial.close()
      await pool.query(
        `UPDATE dsh_session SET meta = JSON_OBJECT(
           'type', 'session', 'version', 0, 'id', ?, 'createdAt', ?, 'delegationDepth', 0
         ) WHERE app = ? AND session_id = ?`,
        [header.id, header.createdAt, app, header.id],
      )
      await using reader = await backend.persistence.open(header.id, 'read')
      expect(reader.header).toMatchObject({ id: header.id, version: 3, isSeeded: false })
      expect((await reader.read()).events).toEqual([])
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT meta FROM dsh_session WHERE app = ? AND session_id = ?', [app, header.id])
      expect(rows[0]!.meta).toMatchObject({ version: 0 })

      const rewritten = await backend.persistence.open(header.id, 'write')
      await rewritten.append(oneTurnLog())
      await rewritten.close()
      const [current] = await pool.query<mysql.RowDataPacket[]>('SELECT meta FROM dsh_session WHERE app = ? AND session_id = ?', [app, header.id])
      expect(current[0]!.meta).toMatchObject({ version: 3, inheritedEventCount: 0 })
    } finally {
      await pool.end()
    }
  })
})
