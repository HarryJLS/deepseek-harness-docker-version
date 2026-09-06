import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { deploymentEnvironment, environmentScript, NACOS_AUTH, resolveDeploymentDocument } from './deployment-config.mjs'

const database = {
  host: 'oceanbase', port: 2881, database: 'dsh', user: 'root@test', password: 'example',
  poolSize: 10, snowflakeWorkerId: 0,
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
    assert.deepEqual(resolveDeploymentDocument({ deployment: { database } }), { appName: 'dsh', database })
  })

  it('validates numbers, names, and mutually exclusive URL configuration', () => {
    for (const invalid of [{ port: '2881' }, { port: 65536 }, { poolSize: 0 }, { snowflakeWorkerId: 1024 }, { host: '' }, { surprise: true }]) {
      assert.throws(() => resolveDeploymentDocument({ deployment: { database: { ...database, ...invalid } } }))
    }
    assert.throws(() => resolveDeploymentDocument({ deployment: { appName: ' ', database } }))
    assert.throws(() => resolveDeploymentDocument({ deployment: { database: { ...database, url: 'mysql://h/db' } } }))
    const uri = { url: 'mysql://example:secret@host/db', poolSize: 5, snowflakeWorkerId: 4 }
    assert.deepEqual(resolveDeploymentDocument({ deployment: { database: uri } }).database, uri)
    for (const url of ['invalid', 'https://host/db', 'mysql://host/']) {
      assert.throws(() => resolveDeploymentDocument({ deployment: { database: { ...uri, url } } }))
    }
  })

  it('preserves password bytes without evaluating shell substitutions', () => {
    const password = " p'a$$ `id` $(printf unsafe) \\ \n "
    const resolved = resolveDeploymentDocument({ deployment: { appName: 'test', database: { ...database, password } } })
    const values = deploymentEnvironment(resolved)
    assert.equal(values.DSH_NACOS_USERNAME, NACOS_AUTH.username)
    assert.equal(values.DSH_NACOS_PASSWORD, NACOS_AUTH.password)
    const result = spawnSync('/bin/sh', ['-c', `${environmentScript(values)}printf '%s' "$DSH_DATABASE_SECRET"`], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).password, password)
  })
})
