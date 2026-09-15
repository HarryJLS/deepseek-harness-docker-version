/** Small, expiring upload receipts shared across replicas; file bytes remain in attachment storage. */

import type mysql from 'mysql2/promise'
import { z } from 'zod'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadGeneration, FileUploadReceiptId, SharedFileUploadStore } from '@deepseek-ai/dsh-client-file-upload'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { canAccessUser, currentUserId, parseUserId } from '@deepseek-ai/dsh-user-context'
import { mysqlAuditValues, mysqlTable, MYSQL_AUDIT_COLUMNS, MYSQL_AUDIT_VALUES } from '@deepseek-ai/dsh-mysql-schema'

const SESSION = mysqlTable('session')
const RECORDS = mysqlTable('kv_record')
const UNIT = 'dsh-file-upload'
const receiptSchema = z.object({
  sessionId: z.string(),
  generation: z.string(),
  expiresAt: z.number().int().nonnegative(),
  file: z.object({
    attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    name: z.string().min(1).max(255),
    bytes: z.number().int().nonnegative(),
    temporaryPath: z.string().min(1).optional(),
  }).strict(),
}).strict()

/** SQL receipt storage bound to the same physical Session row admitted before byte intake. */
export class MysqlUploadReceipts implements SharedFileUploadStore {
  /**
   * @param pool - Session provider's database pool.
   * @param app - application namespace.
   * @param nextId - replica-specific SQL row identity generator.
   * @param ttlMs - deployment-configured receipt lifetime after upload.
   */
  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    private readonly nextId: () => string,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 2_147_483_647) {
      throw new TypeError('uploadReceiptTtlMs must be an integer from 1000 through 2147483647')
    }
  }

  async authorize(sessionId: SessionId): Promise<FileUploadGeneration | undefined> {
    return (await this.session(this.pool, sessionId))?.generation
  }

  async save(
    sessionId: SessionId,
    generation: FileUploadGeneration,
    receiptId: FileUploadReceiptId,
    file: FileAttachmentRef,
  ): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const current = await this.session(connection, sessionId, true)
      if (current === undefined || generation !== current.generation) throw new SessionPersistenceNotFoundError(sessionId)
      const value = JSON.stringify({ sessionId, generation, expiresAt: current.now + this.ttlMs, file })
      await connection.query(
        `INSERT INTO \`${RECORDS}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, tbl, key_name, value)
         VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, 'receipts', ?, ?)`,
        [...mysqlAuditValues(this.nextId, currentUserId()), this.app, UNIT, receiptId, value],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally {
      connection.release()
    }
  }

  async read(sessionId: SessionId, receiptId: FileUploadReceiptId): Promise<FileAttachmentRef | undefined> {
    const current = await this.session(this.pool, sessionId)
    if (current === undefined) return undefined
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT value FROM \`${RECORDS}\` WHERE app = ? AND unit = ? AND tbl = 'receipts' AND key_name = ? AND is_deleted = 'N'`,
      [this.app, UNIT, receiptId],
    )
    if (rows[0] === undefined) return undefined
    const parsed = receiptSchema.safeParse(rows[0].value)
    if (!parsed.success) {
      throw new SessionPersistenceCorruptionError('file upload receipt is malformed', { cause: parsed.error })
    }
    const value = parsed.data
    if (value.sessionId !== sessionId || value.generation !== current.generation || value.expiresAt <= current.now) return undefined
    return value.file as FileAttachmentRef
  }

  private async session(connection: mysql.Pool | mysql.PoolConnection, id: SessionId, lock = false):
  Promise<{ generation: FileUploadGeneration; now: number } | undefined> {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, user_id, meta,
         ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms
       FROM \`${SESSION}\` WHERE app = ? AND session_id = ? AND is_deleted = 'N'${lock ? ' FOR UPDATE' : ''}`,
      [this.app, id],
    )
    const row = rows[0]
    if (row === undefined || !canAccessUser(parseUserId(row.user_id))) return undefined
    const meta = row.meta as { origin?: unknown } | null
    if (meta?.origin === 'subagent') return undefined
    const now = Number(row.now_ms)
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('file upload receipt requires a valid database clock')
    return { generation: String(row.row_id) as FileUploadGeneration, now }
  }
}
