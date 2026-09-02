/**
 * Shared vocabulary for the harness MySQL-protocol plugins (OceanBase in MySQL
 * mode, and MySQL itself).
 *
 * Two things differ from the PostgreSQL packages this replaces, and both come
 * from the same fact: in MySQL a schema IS a database, so there is no
 * lightweight namespace to give each application inside one database.
 *
 * 1. **Applications are separated by a column, not by a schema.** Every table
 *    carries `app` as the leading primary-key column, so several applications
 *    write one set of tables in one database without overwriting each other,
 *    and an operator reads one application's rows with an ordinary `WHERE`.
 *    The name is stored verbatim rather than folded into an identifier — it is
 *    a value now, so `order-svc` and `Order Service` stay distinct instead of
 *    both collapsing onto `order_svc`.
 * 2. **Table names are globally prefixed `dsh_`.** One database is often shared
 *    with tables the harness does not own, and the prefix is what keeps
 *    `session` or `kv_record` from colliding with them.
 *
 * A production role rarely holds DDL rights, so every plugin looks before it
 * leaps with {@link tablesPresent} and only issues its creates when a table is
 * genuinely absent. `deploy/schema-mysql.sql` is the statement set a DBA runs
 * for a database the application may not provision itself.
 *
 * The connection is accepted structurally so this package stays free of a
 * driver dependency; the caller constructs the pool.
 *
 * @module @deepseek-ai/dsh-mysql-schema
 */

import z from '@deepseek-ai/schemastery'

/**
 * The one method this package needs from a `mysql2/promise` pool or connection.
 * The parameter list is narrowed to strings because {@link tablesPresent} is
 * the only caller and binds only table names; a wider element type would not
 * be assignable from the driver's own overloads.
 */
export interface MysqlQueryable {
  query(sql: string, values?: string[]): Promise<unknown>
}

/** The character JSON text carries badly across tools, and the one recording its absence. */
const NUL = '\u0000'
const REPLACEMENT = '\ufffd'

/** Prefix every harness-owned table carries, so a shared database stays unambiguous. */
export const TABLE_PREFIX = 'dsh_'

/** Largest application name the `app` column holds; matches `varchar(64)` in the DDL. */
export const MAX_APP_NAME_LENGTH = 64

/**
 * Qualify one unprefixed table name.
 *
 * Every plugin names its tables through this rather than writing the prefix
 * into a literal, so the prefix is stated once and a table cannot be half
 * renamed.
 * @param base - the table's unprefixed name, e.g. `session_event`.
 * @returns the physical table name, e.g. `dsh_session_event`.
 */
export function mysqlTable(base: string): string {
  return `${TABLE_PREFIX}${base}`
}

/**
 * Resolve the application name this plugin's rows are tagged with.
 *
 * Unlike the PostgreSQL schema it replaces, the value is not an identifier and
 * so is not folded: it reaches SQL as a bound parameter, and folding would
 * silently merge two distinct application names onto one set of rows. Only the
 * length is constrained, because the column is bounded.
 * @param config - the plugin's connection fields.
 * @returns the application name to write into every row's `app` column.
 * @throws when the name is empty or longer than the column holds.
 */
export function resolveMysqlApp(config: MysqlConnectionConfig): string {
  const app = config.app ?? DEFAULTS.app
  if (app.length === 0 || app.length > MAX_APP_NAME_LENGTH) {
    throw new Error(
      `mysql app name ${JSON.stringify(app)} must be 1..${String(MAX_APP_NAME_LENGTH)} characters`,
    )
  }
  return app
}

/**
 * Serialize one value as the JSON text a `json` column accepts.
 *
 * A NUL reaches a harness document from one place: subprocess output, decoded
 * with `Buffer.toString('utf8')`, which carries a raw NUL byte through as
 * U+0000. It is replaced rather than removed so U+FFFD records that something
 * unrepresentable was there, and the rows stay queryable with `->` and `->>`
 * for an operator reading the database directly.
 *
 * The substitution runs over string VALUES, through the serializer's replacer,
 * rather than over the JSON text it produces: rewriting the text would also
 * corrupt a document that legitimately contains the six literal characters of
 * a `\u0000` escape.
 * @param value - the document to store.
 * @returns JSON text safe to insert into a `json` column.
 */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'string' ? entry.replaceAll(NUL, REPLACEMENT) : entry)
}

/**
 * Whether every named table already exists in the connected database.
 *
 * A production role usually holds only SELECT/INSERT/UPDATE/DELETE, and
 * `CREATE TABLE IF NOT EXISTS` is NOT exempt from the privilege check — it
 * fails on a table that already exists just as it would on one that does not.
 * A plugin that issues its DDL unconditionally therefore cannot start against
 * such a database at all.
 *
 * Callers use this to look before they leap: every table present means the DDL
 * has nothing to do and is skipped, and anything missing still runs the
 * creates, so a half-provisioned database fails loudly rather than serving
 * against tables that do not exist.
 *
 * The query reads `information_schema`, which needs no privilege beyond the
 * connection itself, and is scoped to `DATABASE()` so it cannot be answered by
 * a same-named table in another database.
 * @param pool - anything that can run a statement.
 * @param tables - every table the caller is about to create.
 * @returns true when all of them already exist.
 */
export async function tablesPresent(
  pool: MysqlQueryable,
  tables: readonly string[],
): Promise<boolean> {
  const placeholders = tables.map(() => '?').join(', ')
  const result = await pool.query(
    `SELECT COUNT(*) AS present FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    [...tables],
  ) as [{ present?: number | string }[], unknown]
  return Number(result[0]?.[0]?.present ?? -1) === tables.length
}

/**
 * How one plugin reaches the database. Every harness MySQL plugin declares
 * these fields, so they are defined once here and resolved by
 * {@link resolveMysqlPool} rather than defaulted inline at each site.
 */
export interface MysqlConnectionConfig {
  /** Full connection URI; when set it wins over the discrete fields. */
  url?: string
  /** Database host. Default: `oceanbase`. */
  host?: string
  /** Database port. Default: 2881, OceanBase's MySQL-protocol port. */
  port?: number
  /** Database name. Default: `dsh`. */
  database?: string
  /** User name; OceanBase spells it `user@tenant`. Default: `root`. */
  user?: string
  /** Password. */
  password?: string
  /**
   * Application name written into every row's `app` column, isolating one
   * deployment's rows from another's in a shared database. Default: `dsh`.
   */
  app?: string
  /** Maximum pooled connections. Default: 10. */
  poolSize?: number
}

/**
 * Connection options in the shape `mysql2` accepts. Declared structurally so
 * this package stays driver-free; the caller constructs the pool.
 */
export interface MysqlPoolOptions {
  uri?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  connectionLimit: number
  /** `bigint` revisions must survive the driver rather than lose precision. */
  supportBigNumbers: boolean
}

/** Defaults applied when a field is omitted; stated once, never inline. */
const DEFAULTS = {
  host: 'oceanbase',
  port: 2881,
  database: 'dsh',
  user: 'root',
  poolSize: 10,
  app: 'dsh',
}

/**
 * Resolve one connection config into pool options.
 * @param config - the plugin's connection fields.
 * @returns options ready to hand to a pool constructor.
 */
export function resolveMysqlPool(config: MysqlConnectionConfig): MysqlPoolOptions {
  const connectionLimit = config.poolSize ?? DEFAULTS.poolSize
  const shared = { connectionLimit, supportBigNumbers: true }
  if (config.url !== undefined) return { uri: config.url, ...shared }
  return {
    host: config.host ?? DEFAULTS.host,
    port: config.port ?? DEFAULTS.port,
    database: config.database ?? DEFAULTS.database,
    user: config.user ?? DEFAULTS.user,
    ...config.password !== undefined && { password: config.password },
    ...shared,
  }
}

/**
 * Resolve the database name a connection reaches, including from a URL. A
 * revision or identity token qualified by the medium needs this even when the
 * caller configured a connection string.
 * @param config - the plugin's connection fields.
 * @returns the database name.
 */
export function resolveMysqlDatabase(config: MysqlConnectionConfig): string {
  if (config.url === undefined) return config.database ?? DEFAULTS.database
  return new URL(config.url).pathname.replace(/^\//u, '') || DEFAULTS.database
}

/**
 * Schemastery fields for {@link MysqlConnectionConfig}, for a plugin to spread
 * into its own `Config` schema. Declaring them once keeps every MySQL plugin's
 * accepted fields, defaults, and secret marking identical.
 */
export const mysqlConnectionSchema = {
  url: z.string(),
  host: z.string().default(DEFAULTS.host),
  port: z.natural().default(DEFAULTS.port),
  database: z.string().default(DEFAULTS.database),
  user: z.string().default(DEFAULTS.user),
  password: z.string().role('secret'),
  app: z.string().default(DEFAULTS.app),
  poolSize: z.natural().min(1).default(DEFAULTS.poolSize),
}
