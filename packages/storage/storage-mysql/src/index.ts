/**
 * MySQL-protocol storage backend (OceanBase in MySQL mode, and MySQL itself).
 *
 * The medium is one set of tables in a database rather than a directory or a
 * database file, which is what makes it usable from a container that owns no
 * writable volume and no stable host: several replicas share one medium, and a
 * replica that is replaced loses nothing.
 *
 * Values are opaque JSON to this layer, so records live in `json` columns and
 * every operation is a single statement — the contract requires each call to be
 * atomic on the medium and durable once resolved, which a committed statement
 * already gives.
 *
 * Applications share the tables and are separated by the `app` column, which
 * leads every logical unique index. MySQL has no schema inside a database, so there is
 * no namespace to give each application; the column is the separation, and
 * every statement below binds it.
 *
 * @module @deepseek-ai/dsh-storage-mysql
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import mysql from 'mysql2/promise'
import { currentUserId } from '@deepseek-ai/dsh-user-context'
import {
  mysqlTable,
  mysqlConnectionSchema,
  resolveMysqlApp,
  resolveMysqlPool,
  tablesPresent,
  toJsonText,
  assertMysqlTable,
  mysqlIdGenerator,
  mysqlAuditValues,
  MYSQL_AUDIT_DDL,
  MYSQL_AUDIT_COLUMNS,
  MYSQL_AUDIT_VALUES,
  MYSQL_AUDIT_UPDATE,
} from '@deepseek-ai/dsh-mysql-schema'
import type { MysqlConnectionConfig } from '@deepseek-ai/dsh-mysql-schema'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

/** Cordis plugin name. */
export const name = 'storage-mysql'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/** Plugin config: how to reach the database and what to call this backend. */
export interface Config extends MysqlConnectionConfig {
  /** Backend name other plugins mount against. Default: `mysql`. */
  name?: string
}

/** Tables owned by this backend. */
const UNIT_TABLE = mysqlTable('kv_unit')
const RECORD_TABLE = mysqlTable('kv_record')
const GLOBAL_TABLE = mysqlTable('kv_global')

/** One unit open over the shared pool. */
class MysqlKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    private readonly descriptor: KvUnitDescriptor,
    private readonly nextId: () => string,
  ) {}

  /** Refuse every operation once released, as the contract requires. */
  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `storage-mysql: unit ${this.descriptor.name} is closed`)
    }
  }

  /** Reject a table the descriptor never declared. */
  private assertTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) {
      throw new StorageError(
        'malformed-medium',
        `storage-mysql: unit ${this.descriptor.name} did not declare table ${JSON.stringify(table)}`,
      )
    }
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    // Every declared table appears in the snapshot even when it holds no
    // records, so a caller reads the unit's shape rather than only its data.
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) tables[table] = {}
    // `mysql2` decodes a `json` column into a fresh JS value per row, so the
    // documents below are already parsed and unaliased. Re-parsing a value the
    // driver handed back would double-decode any record that is itself a JSON
    // string.
    const [records] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT tbl, key_name, value FROM \`${RECORD_TABLE}\` WHERE app = ? AND unit = ? AND is_deleted = 'N'`,
      [this.app, this.descriptor.name],
    )
    for (const row of records) {
      // A table dropped from the descriptor between runs leaves rows behind;
      // they are not part of this unit's declared shape.
      const bucket = tables[row.tbl as string]
      if (bucket === undefined) continue
      bucket[row.key_name as string] = row.value
    }
    if (!this.descriptor.hasGlobal) return { tables, global: null }
    const [global] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT value FROM \`${GLOBAL_TABLE}\` WHERE app = ? AND unit = ? AND is_deleted = 'N'`,
      [this.app, this.descriptor.name],
    )
    const row = global[0]
    return { tables, global: row === undefined ? null : row.value }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    const json = toJsonText(value ?? null)
    await this.pool.query(
      `INSERT INTO \`${RECORD_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, tbl, key_name, value)
       VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), ${MYSQL_AUDIT_UPDATE}`,
      [...mysqlAuditValues(this.nextId), this.app, this.descriptor.name, table, key, json],
    )
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    await this.pool.query(
      `UPDATE \`${RECORD_TABLE}\` SET is_deleted = 'Y', modifier = ?, gmt_modified = CURRENT_TIMESTAMP
       WHERE app = ? AND unit = ? AND tbl = ? AND key_name = ? AND is_deleted = 'N'`,
      [currentUserId(), this.app, this.descriptor.name, table, key],
    )
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new StorageError(
        'malformed-medium',
        `storage-mysql: unit ${this.descriptor.name} did not declare a global slot`,
      )
    }
    const json = toJsonText(value ?? null)
    await this.pool.query(
      `INSERT INTO \`${GLOBAL_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, value)
       VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), ${MYSQL_AUDIT_UPDATE}`,
      [...mysqlAuditValues(this.nextId), this.app, this.descriptor.name, json],
    )
  }

  close(): Promise<void> {
    // The pool belongs to the backend, not to one unit: releasing a unit must
    // not disturb its siblings, so only the open flag flips here.
    this.closed = true
    return Promise.resolve()
  }
}

/** MySQL KV backend over one pooled connection set. */
class MysqlBackend implements StorageBackend {
  private readonly open = new Set<string>()
  private closed = false

  constructor(
    private readonly pool: mysql.Pool,
    private readonly app: string,
    private readonly nextId: () => string,
  ) {}

  readonly kv: KvFacet = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'storage-mysql: backend is closed')
      if (!UNIT_NAME_RE.test(descriptor.name)) {
        throw new StorageError(
          'malformed-medium',
          `storage-mysql: unit name ${JSON.stringify(descriptor.name)} must match ${String(UNIT_NAME_RE)}`,
        )
      }
      if (this.open.has(descriptor.name)) {
        throw new StorageError(
          'malformed-medium',
          `storage-mysql: unit ${descriptor.name} is already open`,
        )
      }
      // Stamp the version on first materialization; a later open under a
      // different version is a format change the caller must handle, not
      // something to silently migrate. MySQL has no `RETURNING`, so the stamp
      // is a no-op upsert followed by a read of whatever version now stands —
      // the row's own, whether this call or a concurrent one wrote it.
      await this.pool.query(
        `INSERT INTO \`${UNIT_TABLE}\` (${MYSQL_AUDIT_COLUMNS}, app, unit, version)
         VALUES (${MYSQL_AUDIT_VALUES}, ?, ?, ?)
         ON DUPLICATE KEY UPDATE unit = unit`,
        [...mysqlAuditValues(this.nextId), this.app, descriptor.name, descriptor.version],
      )
      const [stamped] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT version FROM \`${UNIT_TABLE}\` WHERE app = ? AND unit = ? AND is_deleted = 'N'`,
        [this.app, descriptor.name],
      )
      const version: unknown = stamped[0]?.version
      if (version !== descriptor.version) {
        throw new StorageError(
          'version-mismatch',
          `storage-mysql: unit ${descriptor.name} is stamped version ${String(version)}, `
          + `but was opened as version ${String(descriptor.version)}`,
        )
      }
      this.open.add(descriptor.name)
      const unit = new MysqlKvUnit(this.pool, this.app, descriptor, this.nextId)
      return {
        loadAll: () => unit.loadAll(),
        putRecord: (table, key, value) => unit.putRecord(table, key, value),
        deleteRecord: (table, key) => unit.deleteRecord(table, key),
        setGlobal: value => unit.setGlobal(value),
        close: async () => {
          await unit.close()
          this.open.delete(descriptor.name)
        },
      }
    },
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.open.clear()
    await this.pool.end()
  }
}

/**
 * Create the tables this backend owns, unless a DBA already did.
 *
 * A production role often holds no DDL rights, and `CREATE TABLE IF NOT
 * EXISTS` is not exempt from the privilege check, so issuing the creates
 * unconditionally makes such a database unusable. Every table present means
 * there is nothing to create; anything missing still runs the creates, so a
 * half-provisioned database fails at start rather than at first write.
 * @param pool - the connection pool to run DDL through.
 */
async function migrate(pool: mysql.Pool): Promise<void> {
  if (await tablesPresent(pool, [UNIT_TABLE, RECORD_TABLE, GLOBAL_TABLE])) {
    for (const table of [UNIT_TABLE, RECORD_TABLE, GLOBAL_TABLE]) await assertMysqlTable(pool, table)
    return
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`${UNIT_TABLE}\` (
       ${MYSQL_AUDIT_DDL},
       app     varchar(64)  NOT NULL,
       unit    varchar(128) NOT NULL,
       version int          NOT NULL,
       PRIMARY KEY (id),
       UNIQUE KEY dsh_kv_unit_identity_uk (app, unit)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`${RECORD_TABLE}\` (
       ${MYSQL_AUDIT_DDL},
       app      varchar(64)  NOT NULL,
       unit     varchar(128) NOT NULL,
       tbl      varchar(128) NOT NULL,
       key_name varchar(255) NOT NULL,
       value    json         NOT NULL,
       PRIMARY KEY (id),
       UNIQUE KEY dsh_kv_record_identity_uk (app, unit, tbl, key_name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS \`${GLOBAL_TABLE}\` (
       ${MYSQL_AUDIT_DDL},
       app   varchar(64)  NOT NULL,
       unit  varchar(128) NOT NULL,
       value json         NOT NULL,
       PRIMARY KEY (id),
       UNIQUE KEY dsh_kv_global_identity_uk (app, unit)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  )
  for (const table of [UNIT_TABLE, RECORD_TABLE, GLOBAL_TABLE]) await assertMysqlTable(pool, table)
}

/**
 * Build this backend's pool from its resolved connection config.
 * @param config - resolved plugin config.
 * @returns a pool that has not yet connected.
 */
export function createPool(config: Config): mysql.Pool {
  return mysql.createPool(resolveMysqlPool(config))
}

/** Config schema. */
export const Config: z<Config> = z.object({
  ...mysqlConnectionSchema,
  name: z.string().default('mysql'),
})

/**
 * Connect, migrate, and register the backend on the storage hub.
 * @param ctx - Host plugin context carrying the hub.
 * @param config - resolved plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backendName = config.name ?? 'mysql'
  const app = resolveMysqlApp(config)
  const pool = createPool(config)
  // Migration precedes registration: a consumer that resolves the backend must
  // never reach a medium whose tables do not exist yet.
  try {
    await migrate(pool)
  } catch (error) {
    await pool.end()
    throw error
  }
  const backend = new MysqlBackend(pool, app, mysqlIdGenerator(config.snowflakeWorkerId ?? 0))
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register(backendName, backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey(backendName), backend)
}
