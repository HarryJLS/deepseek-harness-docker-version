/** Cross-connection upload receipt authorization without storing file bytes in SQL. */

import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import { mysqlIdGenerator, resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageMysql from '@deepseek-ai/dsh-storage-mysql'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MysqlSessionStore } from '../src/store.ts'
import { MysqlUploadReceipts } from '../src/uploads.ts'

const url = process.env.DSH_TEST_MYSQL_URL

describe.skipIf(url === undefined)('Shared SQL upload receipts', () => {
  const app = `uploads-${randomUUID()}`
  const alice = parseUserId('alice')
  const bob = parseUserId('bob')
  const ctx = new Context()
  const pools: mysql.Pool[] = []
  let store: MysqlSessionStore
  let writer: MysqlUploadReceipts
  let reader: MysqlUploadReceipts
  const file: FileAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
    bytes: 10, name: 'report.txt', temporaryPath: 'tmp/files/users/alice/report.txt',
  }
  const id = () => randomUUID() as FileUploadReceiptId
  const session = async (origin?: 'subagent') => {
    const header: SessionHeader = {
      id: SessionId(randomUUID()), version: 3, isSeeded: false, createdAt: 1, userId: alice,
      ...(origin === undefined ? {} : { origin }),
    }
    await store.materializeHeader(header)
    return header
  }

  beforeAll(async () => {
    if (url === undefined) throw new Error('DSH_TEST_MYSQL_URL is required')
    await ctx.plugin(Storage)
    await ctx.plugin(StorageMysql, { url, app, snowflakeWorkerId: 906 })
    pools.push(mysql.createPool(resolveMysqlPool({ url })), mysql.createPool(resolveMysqlPool({ url })))
    store = new MysqlSessionStore(pools[0]!, app, 'test', 907)
    await store.migrate()
    writer = new MysqlUploadReceipts(pools[0]!, app, mysqlIdGenerator(908), 1000)
    reader = new MysqlUploadReceipts(pools[1]!, app, mysqlIdGenerator(909), 1000)
  })

  afterAll(async () => {
    try {
      if (pools[0] !== undefined) {
        await pools[0].query('DELETE FROM dsh_session_event WHERE app = ?', [app])
        await pools[0].query('DELETE FROM dsh_session WHERE app = ?', [app])
        await pools[0].query('DELETE FROM dsh_kv_record WHERE app = ?', [app])
      }
    } finally {
      await ctx.fiber.dispose()
      await Promise.all(pools.map(pool => pool.end()))
    }
  })

  it('shares one immutable receipt with another connection and refuses foreign Sessions and users', async () => {
    const header = await session()
    const other = await session()
    const receiptId = id()
    const generation = await withUser(alice, () => writer.authorize(header.id))
    expect(generation).toBeDefined()
    await withUser(alice, () => writer.save(header.id, generation!, receiptId, file))
    expect(await withUser(alice, () => reader.read(header.id, receiptId))).toEqual(file)
    expect(await withUser(alice, () => reader.read(other.id, receiptId))).toBeUndefined()
    expect(await withUser(bob, () => reader.authorize(header.id))).toBeUndefined()
    expect(await withUser(bob, () => reader.read(header.id, receiptId))).toBeUndefined()
    await expect(withUser(bob, () => writer.save(header.id, generation!, id(), file))).rejects.toThrow('not found')
    const [rows] = await pools[0]!.query<mysql.RowDataPacket[]>(
      "SELECT value FROM dsh_kv_record WHERE app = ? AND unit = 'dsh-file-upload' AND key_name = ?", [app, receiptId],
    )
    expect(rows[0]?.value).toMatchObject({ file })
    expect(JSON.stringify(rows[0]?.value)).not.toContain('"data":')
    await expect(writer.save(header.id, generation!, receiptId, { ...file, name: 'replacement.txt' })).rejects.toThrow()
    expect(await reader.read(header.id, receiptId)).toEqual(file)
  })

  it('rejects a replaced Session incarnation and expired or corrupt receipts', async () => {
    const header = await session()
    const receiptId = id()
    const generation = await writer.authorize(header.id)
    expect(generation).toBeDefined()
    await writer.save(header.id, generation!, receiptId, file)
    await pools[0]!.query(
      "UPDATE dsh_kv_record SET value = JSON_SET(value, '$.expiresAt', 0) WHERE app = ? AND key_name = ?", [app, receiptId],
    )
    expect(await reader.read(header.id, receiptId)).toBeUndefined()
    await pools[0]!.query("UPDATE dsh_kv_record SET value = '{}' WHERE app = ? AND key_name = ?", [app, receiptId])
    await expect(reader.read(header.id, receiptId)).rejects.toThrow('malformed')
    await pools[0]!.query('DELETE FROM dsh_session WHERE app = ? AND session_id = ?', [app, header.id])
    await store.materializeHeader(header)
    await expect(writer.save(header.id, generation!, id(), file)).rejects.toThrow('not found')
  })

  it('returns authorization misses for absent, deleted, and subagent Sessions', async () => {
    const deleted = await session()
    const subagent = await session('subagent')
    await pools[0]!.query("UPDATE dsh_session SET is_deleted = 'Y' WHERE app = ? AND session_id = ?", [app, deleted.id])
    for (const sessionId of [SessionId(randomUUID()), deleted.id, subagent.id]) {
      expect(await writer.authorize(sessionId)).toBeUndefined()
      expect(await reader.read(sessionId, id())).toBeUndefined()
    }
  })

  it('preserves database failures during authorization', async () => {
    const pool = mysql.createPool(resolveMysqlPool({ url: url! }))
    await pool.end()
    const unavailable = new MysqlUploadReceipts(pool, app, mysqlIdGenerator(910), 1000)
    await expect(unavailable.authorize(SessionId(randomUUID()))).rejects.toThrow('Pool is closed')
  })
})
