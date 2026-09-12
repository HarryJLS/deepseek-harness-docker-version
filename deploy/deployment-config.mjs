/** Container bootstrap values and validation of the Nacos deployment document. */

// Local-development credentials only. Production credentials must not be committed.
export const NACOS_AUTH = Object.freeze({ username: 'nacos', password: 'nacos' })

/**
 * Resolve storage options exclusively from the parsed Nacos settings entry.
 * @param document - decoded YAML document.
 * @returns application name and validated database, Redis, and temporary-file configuration.
 */
export function resolveDeploymentDocument(document) {
  const deployment = document?.deployment
  if (deployment === null || typeof deployment !== 'object' || Array.isArray(deployment)) {
    throw new Error('entrypoint: Nacos settings must declare deployment.database')
  }
  const appName = deployment.appName === undefined ? 'dsh' : deployment.appName
  if (typeof appName !== 'string' || appName.length === 0 || appName.length > 64 || appName !== appName.trim()) {
    throw new Error('entrypoint: deployment.appName must contain 1..64 characters without whitespace padding')
  }
  const source = deployment.database
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('entrypoint: deployment.database must be a mapping in Nacos')
  }
  const allowed = ['url', 'host', 'port', 'database', 'user', 'password', 'poolSize', 'snowflakeWorkerId']
  for (const field of Object.keys(source)) {
    if (!allowed.includes(field)) throw new Error(`entrypoint: unknown deployment.database field ${field}`)
  }
  const integer = (field, minimum, maximum) => {
    const value = source[field]
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`entrypoint: deployment.database.${field} must be an integer from ${minimum} through ${maximum}`)
    }
    return value
  }
  const text = (field, empty = false) => {
    const value = source[field]
    if (typeof value !== 'string' || (!empty && (value.trim() === '' || value !== value.trim()))) {
      throw new Error(`entrypoint: deployment.database.${field} must be ${empty ? 'a' : 'a nonempty'} string`)
    }
    return value
  }
  const shared = {
    poolSize: integer('poolSize', 1, Number.MAX_SAFE_INTEGER),
    snowflakeWorkerId: integer('snowflakeWorkerId', 0, 1023),
  }
  let database
  if (source.url !== undefined) {
    const url = text('url')
    let parsed
    try { parsed = new URL(url) }
    catch { throw new Error('entrypoint: deployment.database.url must be a MySQL connection URL') }
    if (parsed.protocol !== 'mysql:' || parsed.hostname === '' || parsed.pathname.length < 2) {
      throw new Error('entrypoint: deployment.database.url must name a MySQL host and database')
    }
    if (['host', 'port', 'database', 'user', 'password'].some(field => source[field] !== undefined)) {
      throw new Error('entrypoint: deployment.database.url cannot be combined with individual connection fields')
    }
    database = { url, ...shared }
  } else {
    database = {
      host: text('host'), port: integer('port', 1, 65535), database: text('database'),
      user: text('user'), password: text('password', true), ...shared,
    }
  }
  return {
    appName,
    database,
    redis: resolveRedis(deployment.redis),
    attachments: resolveAttachments(deployment.attachments),
  }
}

/** Validate all Redis options without accepting a second environment configuration source. */
function resolveRedis(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('entrypoint: deployment.redis must be a mapping in Nacos')
  }
  const defaults = {
    port: 6379, database: 0, tls: false, keyPrefix: 'dsh-', ttlSeconds: 172800,
    maxChunkBytes: 65536, maxEventBytes: 4194304, batchSize: 128,
    connectTimeoutMs: 5000, commandTimeoutMs: 2000,
  }
  const allowed = new Set(['host', 'username', 'password', ...Object.keys(defaults)])
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) throw new Error(`entrypoint: unknown deployment.redis field ${field}`)
  }
  const config = { ...defaults, ...source }
  if (typeof config.host !== 'string' || config.host.trim() === '' || config.host !== config.host.trim()) {
    throw new Error('entrypoint: deployment.redis.host must be a nonempty hostname without whitespace padding')
  }
  for (const field of ['username', 'password']) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new Error(`entrypoint: deployment.redis.${field} must be a string`)
    }
  }
  if (typeof config.tls !== 'boolean' || config.keyPrefix !== 'dsh-') {
    throw new Error('entrypoint: deployment.redis requires boolean tls and keyPrefix dsh-')
  }
  for (const [field, minimum, maximum] of [
    ['port', 1, 65535], ['database', 0, 2147483647], ['ttlSeconds', 1, 2147483647],
    ['maxChunkBytes', 1024, 1048576], ['maxEventBytes', 1024, 67108864], ['batchSize', 1, 1000],
    ['connectTimeoutMs', 1, 2147483647], ['commandTimeoutMs', 1, 2147483647],
  ]) {
    if (!Number.isSafeInteger(config[field]) || config[field] < minimum || config[field] > maximum) {
      throw new Error(`entrypoint: deployment.redis.${field} must be an integer from ${minimum} through ${maximum}`)
    }
  }
  if (config.maxEventBytes < config.maxChunkBytes) {
    throw new Error('entrypoint: deployment.redis.maxEventBytes must be at least maxChunkBytes')
  }
  return config
}

/** Keep temporary files in an operator-selected relative directory, outside all context stores. */
function resolveAttachments(source = {}) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('entrypoint: deployment.attachments must be a mapping in Nacos')
  }
  if (Object.keys(source).some(field => field !== 'temporaryRoot')) {
    throw new Error('entrypoint: deployment.attachments only accepts temporaryRoot')
  }
  const temporaryRoot = source.temporaryRoot ?? 'tmp/dsh-attachments'
  if (typeof temporaryRoot !== 'string' || temporaryRoot.trim() === ''
    || temporaryRoot !== temporaryRoot.trim() || /^[/\\]|^[A-Za-z]:/u.test(temporaryRoot)
    || temporaryRoot.split(/[/\\]/u).some(part => part === '..')
    || temporaryRoot.split(/[/\\]/u).every(part => part === '' || part === '.')) {
    throw new Error('entrypoint: deployment.attachments.temporaryRoot must be a process-relative subdirectory without parent traversal')
  }
  return { temporaryRoot }
}

/**
 * Encode resolved bootstrap values without allowing shell interpolation of passwords.
 * @param resolved - validated Nacos deployment values.
 * @returns environment exports consumed only by the entrypoint shell.
 */
export function deploymentEnvironment(resolved) {
  return {
    DSH_APP_NAME: resolved.appName,
    DSH_DATABASE_SECRET: JSON.stringify(resolved.database),
    DSH_REDIS_SECRET: JSON.stringify(resolved.redis),
    DSH_ATTACHMENTS_CONFIG: JSON.stringify(resolved.attachments),
    DSH_NACOS_USERNAME: NACOS_AUTH.username,
    DSH_NACOS_PASSWORD: NACOS_AUTH.password,
  }
}

/**
 * Serialize environment values as literal POSIX shell strings.
 * @param values - resolved string-valued bootstrap environment.
 * @returns shell source containing no executable substitutions from configuration values.
 */
export function environmentScript(values) {
  return `${Object.entries(values).map(([key, value]) =>
    `export ${key}='${value.replaceAll("'", "'\\''")}'`).join('\n')}\n`
}
