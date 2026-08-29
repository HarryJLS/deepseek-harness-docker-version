/**
 * Conformance run for the PostgreSQL backend against a live database.
 *
 * The shared KV suite is the whole point: holding this backend to the same
 * clauses as the JSON and SQLite backends is what makes it substitutable in a
 * composition. The suite needs a real medium, so the run self-skips when
 * `DSH_TEST_POSTGRES_URL` names no database — the same stance the repository
 * takes for other real-dependency tests.
 */

import { afterAll, describe, it } from 'vitest'
import pg from 'pg'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { createPool, type Config } from '../src/index.ts'

const url = process.env.DSH_TEST_POSTGRES_URL

/** Distinct schema per run so a repeat never inherits a previous medium. */
let counter = 0

if (url === undefined) {
  describe('postgres kv backend', () => {
    it.skip('requires DSH_TEST_POSTGRES_URL to name a live database', () => {})
  })
} else {
  const pools: pg.Pool[] = []
  const schemas: string[] = []

  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: url })
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    for (const pool of pools) await pool.end().catch(() => {})
  })

  runKvBackendContract('postgres', async () => {
    counter += 1
    const schema = `dsh_contract_${String(counter)}`
    schemas.push(schema)
    const config: Config = { url, schema }
    const open = async (): Promise<Awaited<ReturnType<typeof createBackend>>> => createBackend(config)
    return { backend: await open(), reopen: open }
  })

  /** Build one backend over the configured medium by applying the plugin's own setup. */
  async function createBackend(config: Config) {
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
    return registered.backend as never
  }
}
