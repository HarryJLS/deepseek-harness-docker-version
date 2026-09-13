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
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { createPool } from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL

/** Distinct application per run so a repeat never inherits a previous medium. */
let counter = 0
const runId = randomUUID()

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
    const app = `dsh_contract_${runId}_${String(counter)}`
    apps.push(app)
    const config = { url, app }
    const open = (): Promise<StorageBackend> => createBackend(config)
    return { backend: await open(), reopen: open }
  })

  describe('mysql app scoping', () => {
    it('keeps two applications writing one unit apart', async () => {
      // This is the relation the app column exists for: the PostgreSQL store
      // this replaces separated applications by schema, and a shared schema
      // let two of them overwrite each other's kv_record rows.
      counter += 1
      const [left, right] = [`dsh_pair_a_${runId}_${String(counter)}`, `dsh_pair_b_${runId}_${String(counter)}`]
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

  describe('mysql unit transactions', () => {
    it('commits grouped writes, rolls back failures, and rejects nesting', async () => {
      const app = `dsh_tx_${runId}`
      apps.push(app)
      const backend = await createBackend({ url, app })
      const unit = await backend.kv!.open({ name: 'atomic', version: 1, tables: ['records'], hasGlobal: true })
      await unit.transaction!(async (tx) => {
        await tx.putRecord('records', 'key', { value: 'committed' })
        await tx.setGlobal({ ready: true })
      })
      await expect(unit.transaction!(async (tx) => {
        await tx.putRecord('records', 'key', { value: 'rolled back' })
        await tx.setGlobal({ ready: false })
        throw new Error('rollback test')
      })).rejects.toThrow('rollback test')
      expect(await unit.loadAll()).toEqual({
        tables: { records: { key: { value: 'committed' } } }, global: { ready: true },
      })
      await expect(unit.transaction!(async (tx) => {
        await tx.transaction!(async () => {})
      })).rejects.toThrow('nested')
      await unit.close()
      await expect(unit.transaction!(async () => {})).rejects.toMatchObject({ code: 'closed' })
      await backend.close()
    })
  })

  /** Build one backend over the configured medium by applying the plugin's own setup. */
  async function createBackend(config: { url: string; app: string }): Promise<StorageBackend> {
    const resolved = { url: config.url, app: config.app, snowflakeWorkerId: 924 }
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
    await apply(ctx as never, resolved)
    pools.push(createPool(resolved))
    return registered.backend as StorageBackend
  }
}
