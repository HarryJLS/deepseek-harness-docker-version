/** A fresh application namespace leaves retained Session and KV rows unchanged. */

import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageMysql from '@deepseek-ai/dsh-storage-mysql'
import { resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import MysqlSessionPersistence from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL
const tables = ['dsh_session_event', 'dsh_session', 'dsh_kv_record', 'dsh_kv_global', 'dsh_kv_unit']
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() }
    catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'archive-isolation fixture cleanup failed')
})

describe.skipIf(url === undefined)('retained MySQL application data', () => {
  it('starts empty under a new app without changing old data, columns, or indexes', async () => {
    if (url === undefined) throw new Error('DSH_TEST_MYSQL_URL is required')
    const oldApp = `archive-${randomUUID()}`
    const newApp = `${oldApp}-v015`
    const pool = mysql.createPool(resolveMysqlPool({ url }))
    cleanup.push(async () => {
      try {
        for (const table of tables) await pool.query(`DELETE FROM \`${table}\` WHERE app IN (?, ?)`, [oldApp, newApp])
      } finally {
        await pool.end()
      }
    })
    const mount = async (app: string, worker: number) => {
      const ctx = new Context()
      cleanup.push(() => ctx.fiber.dispose())
      await ctx.plugin(SessionStore)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageMysql, { url, app, snowflakeWorkerId: worker })
      await ctx.plugin(MysqlSessionPersistence, { url, app, snowflakeWorkerId: worker + 1 })
      return ctx
    }
    const previous = await mount(oldApp, 930)
    const header = meta('retained-session')
    const writer = await previous.sessionPersistence.create(header)
    await writer.append(oneTurnLog())
    await writer.close()
    await pool.query(
      `UPDATE dsh_session SET meta = JSON_OBJECT(
         'type', 'session', 'version', 0, 'id', session_id, 'createdAt', 1000, 'delegationDepth', 0
       ) WHERE app = ?`,
      [oldApp],
    )
    const descriptor = { name: 'archive_check', version: 0, tables: ['workspaces'], hasGlobal: true }
    const oldUnit = await previous.storage.backend.get('mysql').kv!.open(descriptor)
    cleanup.push(() => oldUnit.close())
    await oldUnit.putRecord('workspaces', 'default', { sessionIds: [header.id] })
    await oldUnit.setGlobal({ retained: true })

    const rows = async () => {
      const result: unknown[] = []
      for (const table of tables) {
        const [values] = await pool.query(`SELECT * FROM \`${table}\` WHERE app = ? ORDER BY id`, [oldApp])
        result.push(values)
      }
      return result
    }
    const schemas = async () => {
      const result: unknown[] = []
      for (const table of tables) {
        const [values] = await pool.query(`SHOW CREATE TABLE \`${table}\``)
        result.push(values)
      }
      return result
    }
    const retained = await rows()
    const definitions = await schemas()
    expect(await previous.sessionPersistence.list()).toMatchObject([{ id: header.id, version: 3, isSeeded: false }])

    const current = await mount(newApp, 932)
    expect(await current.sessionPersistence.list()).toEqual([])
    expect(await current.sessionPersistence.stat(header.id)).toBeUndefined()
    await expect(current.sessionPersistence.open(header.id, 'read')).rejects.toThrow('not found')
    const newUnit = await current.storage.backend.get('mysql').kv!.open({ ...descriptor, version: 1 })
    cleanup.push(() => newUnit.close())
    expect(await newUnit.loadAll()).toEqual({ tables: { workspaces: {} }, global: null })
    const replacement = await current.sessionPersistence.create(header)
    await replacement.append(oneTurnLog())
    await replacement.close()
    await newUnit.putRecord('workspaces', 'default', { sessionIds: [header.id], current: true })
    await newUnit.setGlobal({ retained: false })

    const restarted = await mount(newApp, 934)
    await using reader = await restarted.sessionPersistence.open(header.id, 'read')
    expect(reader.header.version).toBe(3)
    expect((await reader.read()).events).toEqual(oneTurnLog())
    expect(await rows()).toEqual(retained)
    expect(await schemas()).toEqual(definitions)
  })
})
