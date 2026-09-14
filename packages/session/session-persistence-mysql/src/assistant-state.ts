/** Reservation-fenced cumulative Assistant snapshots split across bounded SQL KV rows. */

import { createHash } from 'node:crypto'
import type mysql from 'mysql2/promise'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionAssistantStreamBaseline, SharedAssistantStateStore, SharedAssistantWriter } from '@deepseek-ai/dsh-api-session-controller'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { canAccessUser, parseUserId } from '@deepseek-ai/dsh-user-context'
import { mysqlAuditValues, mysqlTable, MYSQL_AUDIT_COLUMNS, MYSQL_AUDIT_VALUES } from '@deepseek-ai/dsh-mysql-schema'
import type { MysqlSessionExecution } from './execution.ts'

const RECORDS = mysqlTable('kv_record')
const UNIT = 'dsh-assistant-live'
const descriptorSchema = z.object({
  epoch: z.string().min(1), rowId: z.string().min(1),
  parts: z.number().int().positive(), bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const baselineSchema = z.object({
  revision: z.number().int().nonnegative(),
  activeAttempt: z.object({
    attemptId: z.string().min(1), startedAfterSeq: z.number().int().min(-1),
    turn: z.number().int().positive(), step: z.number().int().positive(),
    nextIndex: z.number().int().nonnegative(), stream: z.array(z.json()),
  }).strict().optional(),
}).strict()

function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }

/** Stores only the current live snapshot; Session settlements remain the durable history. */
export class MysqlAssistantState implements SharedAssistantStateStore {
  /**
   * @param pool - owning persistence connection pool.
   * @param app - application namespace.
   * @param nextId - replica-specific audit-row identity generator.
   * @param execution - authority for publication and reader authorization.
   * @param flush - durability barrier before transient publication.
   * @param chunkBytes - maximum raw bytes represented by one base64 SQL chunk.
   */
  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    private readonly nextId: () => string,
    private readonly execution: MysqlSessionExecution,
    private readonly flush: () => Promise<void>,
    private readonly chunkBytes: number,
  ) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 786_432) {
      throw new TypeError('assistantStateChunkBytes must be an integer from 1024 through 786432')
    }
  }

  createWriter(id: SessionId): SharedAssistantWriter {
    const fence = this.execution.captureFence(id)
    return {
      publish: async (baseline) => {
        const bytes = Buffer.from(JSON.stringify(baseline))
        await this.flush()
        const connection = await this.pool.getConnection()
        try {
          await connection.beginTransaction()
          const epoch = await fence(connection)
          const session = await this.session(connection, id)
          const parts = Math.ceil(bytes.length / this.chunkBytes)
          const group = sha256(id)
          await connection.query(`DELETE FROM \`${RECORDS}\` WHERE app = ? AND unit = ? AND tbl = ?`, [this.app, UNIT, group])
          const put = async (key: string, value: unknown) => {
            await connection.query(
              `INSERT INTO \`${RECORDS}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, tbl, key_name, value)
               VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?, ?, ?)`,
              [...mysqlAuditValues(this.nextId, session.owner), this.app, UNIT, group, key, JSON.stringify(value)],
            )
          }
          await put('header', { epoch, rowId: session.rowId, parts, bytes: bytes.length, sha256: sha256(bytes) })
          for (let part = 0; part < parts; part++) {
            await put(String(part), { data: bytes.subarray(part * this.chunkBytes, (part + 1) * this.chunkBytes).toString('base64') })
          }
          await connection.commit()
        } catch (error) {
          await connection.rollback().catch(() => undefined)
          throw error
        } finally {
          connection.release()
        }
      },
    }
  }

  async read(id: SessionId): Promise<SessionAssistantStreamBaseline | undefined> {
    const epoch = await this.execution.publicationEpoch(id)
    if (epoch === undefined) return undefined
    const session = await this.session(this.pool, id)
    // One SELECT observes the header and every chunk from one committed SQL snapshot.
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT key_name, value FROM \`${RECORDS}\` WHERE app = ? AND unit = ? AND tbl = ? AND is_deleted = 'N'`,
      [this.app, UNIT, sha256(id)],
    )
    const header = rows.find(row => row.key_name === 'header')
    if (header === undefined) return undefined
    const parsed = descriptorSchema.safeParse(header.value)
    if (!parsed.success) throw this.corrupt(parsed.error)
    const descriptor = parsed.data
    if (descriptor.epoch !== epoch || descriptor.rowId !== session.rowId) return undefined
    if (rows.length !== descriptor.parts + 1 || descriptor.parts !== Math.ceil(descriptor.bytes / this.chunkBytes)) {
      throw this.corrupt(new Error('incomplete Assistant snapshot chunks'))
    }
    const chunks: Buffer[] = []
    const values = new Map(rows.map(row => [String(row.key_name), row.value as unknown]))
    for (let part = 0; part < descriptor.parts; part++) {
      const chunk = z.object({ data: z.string() }).strict().safeParse(values.get(String(part)))
      if (!chunk.success) throw this.corrupt(chunk.error)
      const bytes = Buffer.from(chunk.data.data, 'base64')
      if (bytes.length > this.chunkBytes || bytes.toString('base64') !== chunk.data.data) {
        throw this.corrupt(new Error('invalid Assistant snapshot chunk'))
      }
      chunks.push(bytes)
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) throw this.corrupt(new Error('Assistant snapshot checksum mismatch'))
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) }
    catch (error) { throw this.corrupt(error) }
    const baseline = baselineSchema.safeParse(value)
    if (!baseline.success) throw this.corrupt(baseline.error)
    const active = baseline.data.activeAttempt
    return {
      revision: baseline.data.revision,
      ...(active === undefined ? {} : {
        activeAttempt: {
          ...active,
          attemptId: brandString<NonNullable<SessionAssistantStreamBaseline['activeAttempt']>['attemptId']>(active.attemptId),
          startedAfterSeq: active.startedAfterSeq === -1 ? -1 : SessionSeq(active.startedAfterSeq),
        },
      }),
    }
  }

  private async session(connection: mysql.Pool | mysql.PoolConnection, id: SessionId) {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS row_id, user_id FROM \`${mysqlTable('session')}\`
       WHERE app = ? AND session_id = ? AND is_deleted = 'N'`,
      [this.app, id],
    )
    const row = rows[0]
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    const owner = parseUserId(row.user_id)
    if (!canAccessUser(owner)) throw new SessionPersistenceNotFoundError(id)
    return { owner, rowId: String(row.row_id) }
  }

  private corrupt(cause: unknown): SessionPersistenceCorruptionError {
    return new SessionPersistenceCorruptionError('shared Assistant snapshot is malformed', { cause })
  }
}
