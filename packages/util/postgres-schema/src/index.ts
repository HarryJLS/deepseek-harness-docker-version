/**
 * Concurrency-safe PostgreSQL schema creation.
 *
 * `CREATE SCHEMA IF NOT EXISTS` is NOT atomic against a concurrent creator:
 * PostgreSQL checks the catalog and then inserts, so two sessions running it
 * at the same instant race and the loser fails on `pg_namespace`'s unique
 * index. Cordis applies loader entries concurrently, so every harness plugin
 * that owns tables in the same schema hits this on a database whose schema
 * does not exist yet — a fresh deployment, and only a fresh one, which is why
 * it does not appear once any earlier run has created it.
 *
 * Losing the race is not a failure: the schema exists, which is the whole
 * postcondition the caller wants.
 *
 * The pool is accepted structurally so this stays dependency-free and works
 * with any `pg` client, pool, or transaction.
 *
 * The package also owns the connection-config vocabulary every harness
 * PostgreSQL plugin declares, so that one shape — and one set of defaults —
 * describes how to reach the database across all of them.
 *
 * @module @deepseek-ai/dsh-postgres-schema
 */

import z from '@deepseek-ai/schemastery'

/** The one method this helper needs from a `pg` client, pool, or transaction. */
export interface PostgresQueryable {
  query(sql: string): Promise<unknown>
}

/** The character `jsonb` refuses, and the one that records its absence. */
const NUL = '\u0000'
const REPLACEMENT = '\ufffd'

/** Allowed schema spelling: safe as a SQL identifier without escaping. */
export const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]*$/

/** PostgreSQL error codes a concurrent schema creation can lose with. */
const DUPLICATE_SCHEMA = '42P06'
const UNIQUE_VIOLATION = '23505'

/**
 * Whether one failure means another session created the schema first.
 * @param error - the rejection from the create statement.
 * @returns true when the schema now exists because someone else won.
 */
function isLostCreateRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === DUPLICATE_SCHEMA || code === UNIQUE_VIOLATION
}

/**
 * Assert one caller-supplied schema name is a safe SQL identifier.
 *
 * The name is interpolated into every statement the caller then issues, so it
 * is checked once at the configuration boundary, where a bad value fails the
 * plugin load rather than some later query.
 * @param value - the configured schema name.
 * @returns the value, unchanged, when it is safe.
 * @throws when the name could not be interpolated safely.
 */
export function assertSchemaName(value: string): string {
  if (!SCHEMA_NAME_RE.test(value)) {
    throw new Error(`postgres schema ${JSON.stringify(value)} must match ${String(SCHEMA_NAME_RE)}`)
  }
  return value
}

/**
 * Normalize an application name into a schema identifier: lowercased, with each
 * run of characters outside `[a-z0-9]` folded to a single `_`. Folding is what
 * lets a deployment name an app the way its operators already do (`order-svc`,
 * `Order Service`) without every one of them having to know PostgreSQL's
 * identifier rules.
 *
 * A name that still cannot be an identifier after folding — one starting with a
 * digit, or empty once folded — is rejected rather than repaired, because every
 * repair would silently merge two distinct app names onto one schema.
 * @param app - the configured application name.
 * @returns the schema identifier the app's tables live in.
 * @throws when the folded name is not a legal identifier.
 */
export function appSchemaName(app: string): string {
  const folded = app.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
  if (!SCHEMA_NAME_RE.test(folded)) {
    throw new Error(
      `postgres app name ${JSON.stringify(app)} folds to ${JSON.stringify(folded)}, `
      + `which must match ${String(SCHEMA_NAME_RE)} — start it with a letter`,
    )
  }
  return folded
}

/**
 * Resolve which schema one plugin's tables live in. An explicit `schema` wins,
 * then the normalized `app` name, then the shared `dsh` default — so a single
 * image serves several applications against one database by setting `app` alone,
 * and a deployment that needs an exact schema name still names it directly.
 *
 * Every PostgreSQL plugin calls this instead of defaulting inline, so one
 * database cannot end up with the same plugin writing two different schemas
 * depending on which package resolved the value.
 * @param config - the plugin's connection fields.
 * @returns the validated schema name, safe to interpolate into a statement.
 * @throws when the configured schema or app name is not a legal identifier.
 */
export function resolvePostgresSchema(config: PostgresConnectionConfig): string {
  if (config.schema !== undefined) return assertSchemaName(config.schema)
  if (config.app !== undefined) return appSchemaName(config.app)
  return DEFAULTS.schema
}

/**
 * Serialize one value as the JSON text a `jsonb` column accepts.
 *
 * PostgreSQL refuses `\u0000` inside a `jsonb` string — the whole statement
 * fails with `unsupported Unicode escape sequence` (SQLSTATE 22P05). A NUL
 * reaches a harness document from one place: subprocess output, which is
 * decoded with `Buffer.toString('utf8')` and so carries a raw NUL byte through
 * as U+0000, unlike the filesystem reader, which rejects binary outright.
 * Without this, one `printf` of a NUL byte fails the insert and takes the whole
 * turn down.
 *
 * The character is replaced rather than removed, and rather than being handled
 * by widening the column to `text`: U+FFFD records that something
 * unrepresentable was there, `jsonb` keeps the rows queryable with `->` and
 * `->>` for an operator reading the database directly, and a `text` column
 * would not have helped the rows that motivate this — a document holding a NUL
 * is exactly the one a `::jsonb` cast then refuses.
 *
 * The substitution runs over string VALUES, through the serializer's replacer,
 * rather than over the JSON text it produces. Rewriting the text would also
 * rewrite a document that legitimately contains the six literal characters of
 * a `\u0000` escape — a pasted JSON fragment, or a note about this very
 * failure — and corrupt it silently.
 *
 * Nothing else is altered: this is not a general sanitizer, and every other
 * character a document carries reaches the database unchanged. An object KEY
 * holding a NUL is not covered; subprocess output reaches a document as a
 * value, and a key would have to be constructed deliberately.
 * @param value - the document to store.
 * @returns JSON text safe to cast to `jsonb`.
 */
export function toJsonbText(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'string' ? entry.replaceAll(NUL, REPLACEMENT) : entry)
}

/**
 * Create one schema, tolerating a concurrent creator.
 * @param pool - anything that can run a statement.
 * @param schema - schema name, already validated by {@link assertSchemaName}.
 * @returns resolution once the schema exists, whoever created it.
 */
export async function ensureSchema(pool: PostgresQueryable, schema: string): Promise<void> {
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  } catch (error) {
    if (!isLostCreateRace(error)) throw error
  }
}

/**
 * How one plugin reaches the database. Every harness PostgreSQL plugin
 * declares these fields, so they are defined once here and resolved by
 * {@link resolvePostgresPool} rather than defaulted inline at each site.
 */
export interface PostgresConnectionConfig {
  /** Full connection string; when set it wins over the discrete fields. */
  url?: string
  /** Database host. Default: `postgres`. */
  host?: string
  /** Database port. Default: 5432. */
  port?: number
  /** Database name. Default: `dsh`. */
  database?: string
  /** Role name. Default: `dsh`. */
  user?: string
  /** Role password. */
  password?: string
  /**
   * Application name isolating one deployment's tables from another's in a
   * shared database. Normalized to a schema name by
   * {@link resolvePostgresSchema}; ignored when `schema` is set explicitly.
   */
  app?: string
  /** Schema holding this plugin's tables, created when absent. Derived from `app`, else `dsh`. */
  schema?: string
  /** Maximum pooled connections. Default: 10. */
  poolSize?: number
}

/**
 * Connection options in the shape `pg.Pool` accepts. Declared structurally so
 * this package stays dependency-free; the caller constructs the pool.
 */
export interface PostgresPoolOptions {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  max: number
}

/** Defaults applied when a field is omitted; stated once, never inline. */
const DEFAULTS = { host: 'postgres', port: 5432, database: 'dsh', user: 'dsh', poolSize: 10, schema: 'dsh' }

/**
 * Resolve one connection config into pool options.
 * @param config - the plugin's connection fields.
 * @returns options ready to hand to a pool constructor.
 */
export function resolvePostgresPool(config: PostgresConnectionConfig): PostgresPoolOptions {
  const max = config.poolSize ?? DEFAULTS.poolSize
  if (config.url !== undefined) return { connectionString: config.url, max }
  return {
    host: config.host ?? DEFAULTS.host,
    port: config.port ?? DEFAULTS.port,
    database: config.database ?? DEFAULTS.database,
    user: config.user ?? DEFAULTS.user,
    ...config.password !== undefined && { password: config.password },
    max,
  }
}

/**
 * Resolve the database name a connection reaches, including from a URL. A
 * revision or identity token qualified by the medium needs this even when the
 * caller configured a connection string.
 * @param config - the plugin's connection fields.
 * @returns the database name.
 */
export function resolvePostgresDatabase(config: PostgresConnectionConfig): string {
  if (config.url === undefined) return config.database ?? DEFAULTS.database
  return new URL(config.url).pathname.replace(/^\//u, '') || DEFAULTS.database
}

/**
 * Schemastery fields for {@link PostgresConnectionConfig}, for a plugin to
 * spread into its own `Config` schema. Declaring them once keeps every
 * PostgreSQL plugin's accepted fields, defaults, and secret marking identical.
 */
export const postgresConnectionSchema = {
  url: z.string(),
  host: z.string().default(DEFAULTS.host),
  port: z.natural().default(DEFAULTS.port),
  database: z.string().default(DEFAULTS.database),
  user: z.string().default(DEFAULTS.user),
  password: z.string().role('secret'),
  app: z.string(),
  schema: z.string(),
  poolSize: z.natural().min(1).default(DEFAULTS.poolSize),
}
