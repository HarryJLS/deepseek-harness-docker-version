import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveMysqlPool } from '@deepseek-ai/dsh-mysql-schema'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'
import MysqlAttachmentStore from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL

interface AuditRow extends mysql.RowDataPacket {
  id: string
  user_id: string
  gmt_created: Date
  gmt_modified: Date
}
const image = {
  mediaType: 'image/png' as const,
  data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMQiVogErWAAUIBABtmBDmY4DwdAAAAAElFTkSuQmCC', 'base64'),
}

describe.skipIf(url === undefined)('OceanBase attachment ownership', () => {
  const app = `attachment_${randomUUID()}`
  const ctx = new Context()
  const alice = parseUserId('alice')
  const bob = parseUserId('bob')
  let pool: mysql.Pool

  beforeAll(async () => {
    pool = mysql.createPool(resolveMysqlPool({ url: url! }))
    await ctx.plugin(MysqlAttachmentStore, { url: url!, app, snowflakeWorkerId: 704 })
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
    await pool.query('DELETE FROM dsh_attachment_object WHERE app = ?', [app])
    await pool.end()
  })

  it('deduplicates within one owner and retains creation provenance', async () => {
    const ref = await withUser(alice, () => ctx.attachments.saveImage(image))
    const [before] = await pool.query<AuditRow[]>('SELECT * FROM dsh_attachment_object WHERE app = ?', [app])
    await withUser(alice, () => ctx.attachments.saveImage(image))
    const [after] = await pool.query<AuditRow[]>('SELECT * FROM dsh_attachment_object WHERE app = ?', [app])
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: before[0]!.id, user_id: 'alice', creator: 'alice', modifier: 'alice', is_deleted: 'N' })
    expect(BigInt(after[0]!.id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    expect(after[0]!.gmt_created).toEqual(before[0]!.gmt_created)
    expect(after[0]!.gmt_modified).toBeInstanceOf(Date)
    expect((await withUser(alice, () => ctx.attachments.readImage(ref))).ref).toEqual(ref)
    await expect(withUser(bob, () => ctx.attachments.readImage(ref))).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await withUser(bob, () => ctx.attachments.saveImage(image))
    expect((await withUser(bob, () => ctx.attachments.readImage(ref))).ref).toEqual(ref)
    const [owners] = await pool.query<AuditRow[]>('SELECT * FROM dsh_attachment_object WHERE app = ? ORDER BY user_id', [app])
    expect(owners.map(row => row.user_id)).toEqual(['alice', 'bob'])
    expect(owners[0]!.id).not.toBe(owners[1]!.id)
  })

  it('hides a deleted image until its owner uploads it again', async () => {
    const owner = parseUserId('deleted-owner')
    const ref = await withUser(owner, () => ctx.attachments.saveImage(image))
    await pool.query("UPDATE dsh_attachment_object SET is_deleted = 'Y', modifier = ?, gmt_modified = CURRENT_TIMESTAMP WHERE app = ? AND user_id = ?", [owner, app, owner])
    await expect(withUser(owner, () => ctx.attachments.readImage(ref))).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    await withUser(owner, () => ctx.attachments.saveImage(image))
    expect((await withUser(owner, () => ctx.attachments.readImage(ref))).ref).toEqual(ref)
  })
})
