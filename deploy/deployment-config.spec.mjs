import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { deploymentEnvironment, environmentScript, NACOS_AUTH, resolveDeploymentDocument } from './deployment-config.mjs'

const database = {
  host: 'oceanbase', port: 2881, database: 'dsh', user: 'root@test', password: 'example',
  poolSize: 10, snowflakeWorkerId: 0,
}
const redis = { host: 'redis' }

function resolve(deployment) {
  return resolveDeploymentDocument({ deployment: { redis, ...deployment } })
}

describe('Nacos deployment configuration', () => {
  it('requires a complete Nacos database declaration', () => {
    for (const document of [undefined, {}, { deployment: {} }, { deployment: { database: {} } }]) {
      assert.throws(() => resolveDeploymentDocument(document), /deployment/u)
    }
    for (const key of Object.keys(database)) {
      const partial = { ...database }
      delete partial[key]
      assert.throws(() => resolveDeploymentDocument({ deployment: { database: partial } }), /deployment.database/u)
    }
    assert.deepEqual(resolve({ database }).database, database)
    assert.equal(resolve({ database }).appName, 'dsh')
  })

  it('validates numbers, names, and mutually exclusive URL configuration', () => {
    for (const invalid of [{ port: '2881' }, { port: 65536 }, { poolSize: 0 }, { snowflakeWorkerId: 1024 }, { host: '' }, { surprise: true }]) {
      assert.throws(() => resolve({ database: { ...database, ...invalid } }))
    }
    assert.throws(() => resolve({ appName: ' ', database }))
    assert.throws(() => resolve({ database: { ...database, url: 'mysql://h/db' } }))
    const uri = { url: 'mysql://example:secret@host/db', poolSize: 5, snowflakeWorkerId: 4 }
    assert.deepEqual(resolve({ database: uri }).database, uri)
    for (const url of ['invalid', 'https://host/db', 'mysql://host/']) {
      assert.throws(() => resolve({ database: { ...uri, url } }))
    }
  })

  it('preserves password bytes without evaluating shell substitutions', () => {
    const password = " p'a$$ `id` $(printf unsafe) \\ \n "
    const resolved = resolve({ appName: 'test', database: { ...database, password }, redis: { ...redis, password } })
    const values = deploymentEnvironment(resolved)
    assert.equal(values.DSH_NACOS_USERNAME, NACOS_AUTH.username)
    assert.equal(values.DSH_NACOS_PASSWORD, NACOS_AUTH.password)
    const result = spawnSync('/bin/sh', ['-c', `${environmentScript(values)}printf '%s' "$DSH_DATABASE_SECRET"`], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).password, password)
    const cached = spawnSync('/bin/sh', ['-c', `${environmentScript(values)}printf '%s' "$DSH_REDIS_SECRET"`], { encoding: 'utf8' })
    assert.equal(cached.status, 0)
    assert.equal(JSON.parse(cached.stdout).password, password)
  })

  it('requires Redis in Nacos and resolves a two-day sliding TTL with dsh- keys', () => {
    for (const value of [undefined, null, [], {}, { host: '' }]) {
      assert.throws(() => resolve({ database, redis: value }), /deployment.redis/u)
    }
    assert.deepEqual(resolve({ database }).redis, {
      host: 'redis', port: 6379, database: 0, tls: false, keyPrefix: 'dsh-', ttlSeconds: 172800,
      maxChunkBytes: 65536, maxEventBytes: 4194304, batchSize: 128,
      connectTimeoutMs: 5000, commandTimeoutMs: 2000,
    })
    assert.equal(resolve({ database, redis: { ...redis, ttlSeconds: 60, tls: true } }).redis.ttlSeconds, 60)
  })

  it('rejects unbounded, ambiguous, and unknown Redis settings', () => {
    for (const invalid of [
      { ttlSeconds: 0 }, { ttlSeconds: '172800' }, { ttlSeconds: -1 }, { ttlSeconds: 1.5 },
      { port: 0 }, { database: -1 }, { keyPrefix: 'other-' }, { tls: 'false' },
      { maxChunkBytes: 512 }, { maxChunkBytes: 1048577 }, { maxEventBytes: 1024 },
      { batchSize: 0 }, { batchSize: 1001 }, { connectTimeoutMs: 0 }, { commandTimeoutMs: 0 },
      { username: 1 }, { password: 1 }, { host: ' redis' }, { url: 'redis://localhost' },
    ]) {
      assert.throws(() => resolve({ database, redis: { ...redis, ...invalid } }), /deployment.redis/u)
    }
  })

  it('keeps attachments in a relative temporary directory, never in either context store', () => {
    assert.deepEqual(resolve({ database }).attachments, { temporaryRoot: 'tmp/dsh-attachments' })
    assert.deepEqual(resolve({ database, attachments: { temporaryRoot: './files/screenshots' } }).attachments,
      { temporaryRoot: './files/screenshots' })
    for (const temporaryRoot of ['', '.', './', '/', '/tmp/files', '../files', 'files/../other', 'C:\\files', '\\files', 3]) {
      assert.throws(() => resolve({ database, attachments: { temporaryRoot } }), /deployment.attachments/u)
    }
    for (const attachments of [null, [], { database: true }]) {
      assert.throws(() => resolve({ database, attachments }), /deployment.attachments/u)
    }
  })
})
