/**
 * The tolerant schema create and the identifier guard.
 *
 * Both exist because of a specific failure: `CREATE SCHEMA IF NOT EXISTS` is
 * not atomic against a concurrent creator, and the schema name is interpolated
 * into every statement its callers then issue.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  appSchemaName,
  assertSchemaName,
  ensureSchema,
  resolvePostgresSchema,
  toJsonbText,
} from '../src/index.ts'

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

describe('appSchemaName', () => {
  it('folds the spellings operators actually name applications with', () => {
    expect(appSchemaName('order-svc')).toBe('order_svc')
    expect(appSchemaName('Order Service')).toBe('order_service')
    expect(appSchemaName('billing')).toBe('billing')
    // Runs collapse and edges are trimmed, so neighbouring separators cannot
    // produce a doubled or leading underscore.
    expect(appSchemaName('-a--b-')).toBe('a_b')
  })

  it('keeps distinct names distinct', () => {
    expect(appSchemaName('a-b')).not.toBe(appSchemaName('a-b-c'))
  })

  it('refuses a name no folding can make an identifier', () => {
    // Repairing either of these would silently merge two apps onto one schema.
    for (const app of ['2fa', '---', '', '9']) {
      expect(() => appSchemaName(app)).toThrow(/folds to/u)
    }
  })
})

describe('resolvePostgresSchema', () => {
  it('prefers an explicit schema over the app name', () => {
    expect(resolvePostgresSchema({ schema: 'exact', app: 'ignored' })).toBe('exact')
  })

  it('derives the schema from the app name', () => {
    expect(resolvePostgresSchema({ app: 'order-svc' })).toBe('order_svc')
  })

  it('falls back to the shared default when neither is set', () => {
    expect(resolvePostgresSchema({})).toBe('dsh')
  })

  it('rejects an explicit schema that would not interpolate safely', () => {
    expect(() => resolvePostgresSchema({ schema: 'DSH' })).toThrow(/must match/u)
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

describe('toJsonbText', () => {
  /** One NUL, built without writing a control character into this file. */
  const NUL = String.fromCharCode(0)

  it('replaces the one character jsonb refuses', () => {
    // PostgreSQL rejects a NUL inside a jsonb string with SQLSTATE 22P05, so a
    // single NUL in subprocess output would otherwise fail the whole insert and
    // take the turn down with it.
    const encoded = toJsonbText({ out: `a${NUL}b` })
    expect(encoded).not.toContain(String.raw`\u0000`)
    expect(JSON.parse(encoded)).toEqual({ out: 'a\ufffdb' })
  })

  it('replaces every occurrence, not just the first', () => {
    expect(JSON.parse(toJsonbText({ s: `${NUL}a${NUL}b${NUL}` })))
      .toEqual({ s: '\ufffda\ufffdb\ufffd' })
  })

  it('leaves every other document identical to JSON.stringify', () => {
    // Not a general sanitizer: tabs, newlines, escapes, non-ASCII text, and the
    // six literal characters of an escape a document may legitimately contain
    // all reach the database unchanged.
    for (const value of [
      { plain: 'hello' },
      { nested: { deep: [1, 2, { s: 'ok' }] } },
      { control: '\t\n\r' },
      { unicode: 'zhongwen and emoji' },
      { literal: String.raw`not a real \\u0000 escape` },
      null,
      [],
      'bare string',
    ]) {
      expect(toJsonbText(value)).toBe(JSON.stringify(value))
    }
  })
})
