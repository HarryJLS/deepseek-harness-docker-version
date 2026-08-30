/**
 * PostgreSQL-backed storage backend.
 *
 * The medium is one database schema rather than a directory or a database
 * file, which is what makes it usable from a container that owns no writable
 * volume and no stable host: several replicas share one medium, and a replica
 * that is replaced loses nothing.
 *
 * Values are opaque JSON to this layer, so records live in `jsonb` columns and
 * every operation is a single statement — the contract requires each call to
 * be atomic on the medium and durable once resolved, which a committed
 * statement already gives.
 *
 * @module @deepseek-ai/dsh-storage-postgres
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import {
  ensureSchema,
  postgresConnectionSchema,
  resolvePostgresPool,
  resolvePostgresSchema,
  toJsonbText,
} from '@deepseek-ai/dsh-postgres-schema'
import type { PostgresConnectionConfig } from '@deepseek-ai/dsh-postgres-schema'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

/** Cordis plugin name. */
export const name = 'storage-postgres'
/** The hub must exist before the backend can register. */
export const inject = ['storage']

/** Plugin config: how to reach the database and what to call this backend. */
export interface Config extends PostgresConnectionConfig {
  /** Backend name other plugins mount against. Default: `postgres`. */
  name?: string
}

/** Table names owned by this backend, unqualified. */
const UNIT_TABLE = 'kv_unit'
const RECORD_TABLE = 'kv_record'
const GLOBAL_TABLE = 'kv_global'

/** One unit open over the shared pool. */
class PostgresKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
    private readonly descriptor: KvUnitDescriptor,
  ) {}

  /** Refuse every operation once released, as the contract requires. */
  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `storage-postgres: unit ${this.descriptor.name} is closed`)
    }
  }

  /** Reject a table the descriptor never declared. */
  private assertTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) {
      throw new StorageError(
        'malformed-medium',
        `storage-postgres: unit ${this.descriptor.name} did not declare table ${JSON.stringify(table)}`,
      )
    }
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    // Every declared table appears in the snapshot even when it holds no
    // records, so a caller reads the unit's shape rather than only its data.
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) tables[table] = {}
    const records = await this.pool.query<{ tbl: string; key: string; value: unknown }>(
      `SELECT tbl, key, value FROM "${this.schema}"."${RECORD_TABLE}" WHERE unit = $1`,
      [this.descriptor.name],
    )
    for (const row of records.rows) {
      // A table dropped from the descriptor between runs leaves rows behind;
      // they are not part of this unit's declared shape.
      const bucket = tables[row.tbl]
      if (bucket === undefined) continue
      bucket[row.key] = row.value
    }
    if (!this.descriptor.hasGlobal) return { tables, global: null }
    const global = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM "${this.schema}"."${GLOBAL_TABLE}" WHERE unit = $1`,
      [this.descriptor.name],
    )
    return { tables, global: global.rows[0]?.value ?? null }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    await this.pool.query(
      `INSERT INTO "${this.schema}"."${RECORD_TABLE}" (unit, tbl, key, value)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (unit, tbl, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.descriptor.name, table, key, toJsonbText(value ?? null)],
    )
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    await this.pool.query(
      `DELETE FROM "${this.schema}"."${RECORD_TABLE}" WHERE unit = $1 AND tbl = $2 AND key = $3`,
      [this.descriptor.name, table, key],
    )
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new StorageError(
        'malformed-medium',
        `storage-postgres: unit ${this.descriptor.name} did not declare a global slot`,
      )
    }
    await this.pool.query(
      `INSERT INTO "${this.schema}"."${GLOBAL_TABLE}" (unit, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (unit) DO UPDATE SET value = EXCLUDED.value`,
      [this.descriptor.name, toJsonbText(value ?? null)],
    )
  }

  close(): Promise<void> {
    // The pool belongs to the backend, not to one unit: releasing a unit must
    // not disturb its siblings, so only the open flag flips here.
    this.closed = true
    return Promise.resolve()
  }
}

/** PostgreSQL KV backend over one pooled connection set. */
class PostgresBackend implements StorageBackend {
  private readonly open = new Set<string>()
  private closed = false

  constructor(private readonly pool: pg.Pool, private readonly schema: string) {}

  readonly kv: KvFacet = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'storage-postgres: backend is closed')
      if (!UNIT_NAME_RE.test(descriptor.name)) {
        throw new StorageError(
          'malformed-medium',
          `storage-postgres: unit name ${JSON.stringify(descriptor.name)} must match ${String(UNIT_NAME_RE)}`,
        )
      }
      if (this.open.has(descriptor.name)) {
        throw new StorageError(
          'malformed-medium',
          `storage-postgres: unit ${descriptor.name} is already open`,
        )
      }
      // Stamp the version on first materialization; a later open under a
      // different version is a format change the caller must handle, not
      // something to silently migrate.
      const stamped = await this.pool.query<{ version: number }>(
        `INSERT INTO "${this.schema}"."${UNIT_TABLE}" (unit, version)
         VALUES ($1, $2)
         ON CONFLICT (unit) DO UPDATE SET unit = EXCLUDED.unit
         RETURNING version`,
        [descriptor.name, descriptor.version],
      )
      const version = stamped.rows[0]?.version
      if (version !== descriptor.version) {
        throw new StorageError(
          'version-mismatch',
          `storage-postgres: unit ${descriptor.name} is stamped version ${String(version)}, `
          + `but was opened as version ${String(descriptor.version)}`,
        )
      }
      this.open.add(descriptor.name)
      const unit = new PostgresKvUnit(this.pool, this.schema, descriptor)
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
 * Create the schema and tables this backend owns.
 * @param pool - the connection pool to run DDL through.
 * @param schema - the validated schema name.
 */
async function migrate(pool: pg.Pool, schema: string): Promise<void> {
  await ensureSchema(pool, schema)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${UNIT_TABLE}" (
       unit    text PRIMARY KEY,
       version integer NOT NULL
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${RECORD_TABLE}" (
       unit  text  NOT NULL,
       tbl   text  NOT NULL,
       key   text  NOT NULL,
       value jsonb NOT NULL,
       PRIMARY KEY (unit, tbl, key)
     )`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${GLOBAL_TABLE}" (
       unit  text PRIMARY KEY,
       value jsonb NOT NULL
     )`,
  )
}

/**
 * Build this backend's pool from its resolved connection config.
 * @param config - resolved plugin config.
 * @returns a pool that has not yet connected.
 */
export function createPool(config: Config): pg.Pool {
  return new pg.Pool(resolvePostgresPool(config))
}

/** Config schema. */
export const Config: z<Config> = z.object({
  ...postgresConnectionSchema,
  name: z.string().default('postgres'),
})

/**
 * Connect, migrate, and register the backend on the storage hub.
 * @param ctx - Host plugin context carrying the hub.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backendName = config.name ?? 'postgres'
  const schema = resolvePostgresSchema(config)
  const pool = createPool(config)
  // Migration precedes registration: a consumer that resolves the backend must
  // never reach a medium whose tables do not exist yet.
  await migrate(pool, schema)
  const backend = new PostgresBackend(pool, schema)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register(backendName, backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey(backendName), backend)
}
