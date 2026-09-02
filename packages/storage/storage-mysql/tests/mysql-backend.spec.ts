/**
 * Conformance run for the MySQL backend against a live database.
 *
 * The shared KV suite is the whole point: holding this backend to the same
 * clauses as the JSON and SQLite backends is what makes it substitutable in a
 * composition. The suite needs a real medium, so the run self-skips when
 * `DSH_TEST_MYSQL_URL` names no database — the same stance the repository
 * takes for other real-dependency tests.
 *
 * Isolation here is by `app`, not by schema: this backend's whole premise is
 * that several applications share one set of tables, so each contract run gets
 * its own application name and the suite proves that a run never observes a
 * sibling's rows.
 */

import { afterAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { createPool, type Config } from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL

/** Distinct application per run so a repeat never inherits a previous medium. */
let counter = 0

if (url === undefined) {
  describe('mysql kv backend', () => {
    it.skip('requires DSH_TEST_MYSQL_URL to name a live database', () => {})
  })
} else {
  const pools: mysql.Pool[] = []
  const apps: string[] = []

  afterAll(async () => {
    const admin = mysql.createPool({ uri: url })
    for (const app of apps) {
      for (const table of ['dsh_kv_record', 'dsh_kv_global', 'dsh_kv_unit']) {
        await admin.query(`DELETE FROM \`${table}\` WHERE app = ?`, [app])
      }
    }
    await admin.end()
    for (const pool of pools) await pool.end().catch(() => {})
  })

  runKvBackendContract('mysql', async () => {
    counter += 1
    const app = `dsh_contract_${String(counter)}`
    apps.push(app)
    const config: Config = { url, app }
    const open = (): Promise<StorageBackend> => createBackend(config)
    return { backend: await open(), reopen: open }
  })

  describe('mysql app scoping', () => {
    it('keeps two applications writing one unit apart', async () => {
      // This is the relation the app column exists for: the PostgreSQL store
      // this replaces separated applications by schema, and a shared schema
      // let two of them overwrite each other's kv_record rows.
      counter += 1
      const [left, right] = [`dsh_pair_a_${String(counter)}`, `dsh_pair_b_${String(counter)}`]
      apps.push(left, right)
      const descriptor = { name: 'shared', version: 1, tables: ['t'], hasGlobal: false }
      const backends = await Promise.all([
        createBackend({ url, app: left }),
        createBackend({ url, app: right }),
      ])
      const units = await Promise.all(backends.map((backend) => {
        // Every backend this plugin registers carries the KV facet; the field
        // is optional only because the hub also serves backends that do not.
        if (backend.kv === undefined) throw new Error('storage-mysql registered no kv facet')
        return backend.kv.open(descriptor)
      }))
      const [leftUnit, rightUnit] = units
      await leftUnit?.putRecord('t', 'k', 'from-left')
      await rightUnit?.putRecord('t', 'k', 'from-right')
      expect((await leftUnit?.loadAll())?.tables.t).toEqual({ k: 'from-left' })
      expect((await rightUnit?.loadAll())?.tables.t).toEqual({ k: 'from-right' })
      for (const unit of units) await unit.close()
      for (const backend of backends) await backend.close()
    })
  })

  /** Build one backend over the configured medium by applying the plugin's own setup. */
  async function createBackend(config: Config): Promise<StorageBackend> {
    const { apply } = await import('../src/index.ts')
    const registered: { backend?: unknown } = {}
    const ctx = {
      storage: { backend: { register: (_name: string, backend: unknown) => {
        registered.backend = backend
        return () => {}
      } } },
      effect: (run: () => unknown) => { run() },
      provide: () => {},
    }
    await apply(ctx as never, config)
    pools.push(createPool(config))
    return registered.backend as StorageBackend
  }
}
