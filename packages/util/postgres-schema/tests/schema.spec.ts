/**
 * The tolerant schema create and the identifier guard.
 *
 * Both exist because of a specific failure: `CREATE SCHEMA IF NOT EXISTS` is
 * not atomic against a concurrent creator, and the schema name is interpolated
 * into every statement its callers then issue.
 */

import { describe, expect, it, vi } from 'vitest'
import { assertSchemaName, ensureSchema } from '../src/index.ts'

/** One error carrying a PostgreSQL SQLSTATE, as the driver reports it. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres error ${code}`), { code })
}

describe('assertSchemaName', () => {
  it('accepts a lowercase identifier', () => {
    expect(assertSchemaName('dsh')).toBe('dsh')
    expect(assertSchemaName('dsh_contract_2')).toBe('dsh_contract_2')
  })

  it('refuses anything that would not interpolate safely', () => {
    // Each of these would otherwise reach SQL verbatim.
    for (const name of ['DSH', 'dsh-name', '2dsh', 'dsh"; DROP SCHEMA x; --', '', 'dsh name']) {
      expect(() => assertSchemaName(name)).toThrow(/must match/u)
    }
  })
})

describe('ensureSchema', () => {
  it('issues the create for the schema it was given', async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    await ensureSchema({ query }, 'dsh')
    expect(query).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "dsh"')
  })

  it('tolerates losing the race to a concurrent creator', async () => {
    // Both codes mean the same thing for this caller: the schema now exists.
    for (const code of ['42P06', '23505']) {
      const query = vi.fn().mockRejectedValue(pgError(code))
      await expect(ensureSchema({ query }, 'dsh')).resolves.toBeUndefined()
    }
  })

  it('propagates every other failure', async () => {
    // A permission failure must not be mistaken for a lost race, or the caller
    // proceeds to query tables that were never created.
    const query = vi.fn().mockRejectedValue(pgError('42501'))
    await expect(ensureSchema({ query }, 'dsh')).rejects.toThrow(/42501/u)
  })

  it('propagates a failure carrying no code', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connection terminated'))
    await expect(ensureSchema({ query }, 'dsh')).rejects.toThrow(/connection terminated/u)
  })
})
