/** Validated connection and per-value limits for the disposable Redis session cache. */

import z from '@deepseek-ai/schemastery'

/** Redis connection and cache policy, supplied by the deployment's Nacos document. */
export interface RedisSessionCacheConfig {
  /** Redis hostname; TLS is controlled separately. */
  host: string
  /** Redis TCP port. */
  port?: number
  /** Redis ACL username; omit for password-only authentication. */
  username?: string
  /** Redis password; omit only for a server without authentication. */
  password?: string
  /** Redis logical database number. */
  database?: number
  /** Enable certificate-verified TLS. */
  tls?: boolean
  /** Fixed namespace shared by all Harness cache keys. */
  keyPrefix?: 'dsh-'
  /** Sliding expiration in seconds for every cached event and chunk. */
  ttlSeconds?: number
  /** Largest Redis string value, measured after UTF-8 encoding. */
  maxChunkBytes?: number
  /** Events larger than this byte limit remain database-only, without truncation. */
  maxEventBytes?: number
  /** Maximum commands in one Redis pipeline. */
  batchSize?: number
  /** Connection establishment deadline in milliseconds. */
  connectTimeoutMs?: number
  /** Per-command response deadline in milliseconds. */
  commandTimeoutMs?: number
}

/** Complete cache policy after default resolution; authentication remains optional. */
export type ResolvedRedisSessionCacheConfig =
  Required<Omit<RedisSessionCacheConfig, 'username' | 'password'>>
  & Pick<RedisSessionCacheConfig, 'username' | 'password'>

/** Schema defaults used by non-container compositions as well as the Nacos bootstrap. */
export const RedisSessionCacheConfig: z<RedisSessionCacheConfig> = z.object({
  host: z.string().required(),
  port: z.natural().min(1).max(65535).default(6379),
  username: z.string(),
  password: z.string().role('secret'),
  database: z.natural().max(2_147_483_647).default(0),
  tls: z.boolean().default(false),
  keyPrefix: z.const('dsh-').default('dsh-'),
  ttlSeconds: z.natural().min(1).max(2_147_483_647).default(172800),
  maxChunkBytes: z.natural().min(1024).max(1_048_576).default(65536),
  maxEventBytes: z.natural().min(1024).max(67_108_864).default(4_194_304),
  batchSize: z.natural().min(1).max(1000).default(128),
  connectTimeoutMs: z.natural().min(1).max(2_147_483_647).default(5000),
  commandTimeoutMs: z.natural().min(1).max(2_147_483_647).default(2000),
})

/**
 * Resolve optional schema defaults and reject conflicting cache limits before opening sockets.
 * @param input - deployment-provided Redis options.
 * @returns complete connection and cache policy.
 */
export function resolveRedisSessionCacheConfig(input: unknown): ResolvedRedisSessionCacheConfig {
  const config = z.resolve(input, RedisSessionCacheConfig, {})[0] as ResolvedRedisSessionCacheConfig
  if (config.host.trim() === '' || config.host !== config.host.trim()) {
    throw new Error('session-persistence-mysql: redis.host must be a nonempty hostname without whitespace padding')
  }
  if (config.maxEventBytes < config.maxChunkBytes) {
    throw new Error('session-persistence-mysql: redis.maxEventBytes must be at least redis.maxChunkBytes')
  }
  return config
}
