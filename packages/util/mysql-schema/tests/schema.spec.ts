/**
 * The shared MySQL vocabulary: table prefixing, application-name resolution,
 * JSON serialization, and the provisioning probe.
 *
 * Each of these exists for one deployment fact. The prefix keeps a shared
 * database unambiguous, the application name separates several deployments'
 * rows in one table, the probe is what lets the plugins start against a
 * database whose role holds no DDL rights, and the serializer keeps subprocess
 * output from failing an insert.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  MAX_APP_NAME_LENGTH,
  mysqlTable,
  resolveMysqlApp,
  resolveMysqlDatabase,
  resolveMysqlPool,
  tablesPresent,
  toJsonText,
} from '../src/index.ts'

describe('mysqlTable', () => {
  it('prefixes every harness-owned table', () => {
    expect(mysqlTable('session')).toBe('dsh_session')
    expect(mysqlTable('session_event')).toBe('dsh_session_event')
    expect(mysqlTable('kv_record')).toBe('dsh_kv_record')
  })
})

describe('resolveMysqlApp', () => {
  it('stores the name operators already use, verbatim', () => {
    // The value reaches SQL as a bound parameter, not as an identifier, so
    // there is nothing to fold and no reason to reshape it.
    expect(resolveMysqlApp({ app: 'order-svc' })).toBe('order-svc')
    expect(resolveMysqlApp({ app: 'Order Service' })).toBe('Order Service')
  })

  it('keeps names distinct that an identifier folding would have merged', () => {
    // The PostgreSQL schema this replaces folded both of these onto
    // `order_svc`, silently pointing two applications at one medium.
    expect(resolveMysqlApp({ app: 'order-svc' })).not.toBe(resolveMysqlApp({ app: 'order svc' }))
  })

  it('falls back to the shared default when unset', () => {
    expect(resolveMysqlApp({})).toBe('dsh')
  })

  it('refuses a name the column cannot hold', () => {
    // Silent truncation would merge two applications' rows, which is the whole
    // failure the app column exists to prevent.
    expect(() => resolveMysqlApp({ app: '' })).toThrow(/must be 1\.\./u)
    expect(() => resolveMysqlApp({ app: 'a'.repeat(MAX_APP_NAME_LENGTH + 1) }))
      .toThrow(/must be 1\.\./u)
    expect(resolveMysqlApp({ app: 'a'.repeat(MAX_APP_NAME_LENGTH) }))
      .toHaveLength(MAX_APP_NAME_LENGTH)
  })
})

describe('resolveMysqlPool', () => {
  it('lets a URI win over the discrete fields', () => {
    expect(resolveMysqlPool({ url: 'mysql://u:p@h:2881/db', host: 'ignored' }))
      .toEqual({ uri: 'mysql://u:p@h:2881/db', connectionLimit: 10, supportBigNumbers: true })
  })

  it('applies the OceanBase MySQL-protocol defaults', () => {
    expect(resolveMysqlPool({})).toEqual({
      host: 'oceanbase',
      port: 2881,
      database: 'dsh',
      user: 'root',
      connectionLimit: 10,
      supportBigNumbers: true,
    })
  })

  it('omits the password key entirely when none is configured', () => {
    // An explicit `undefined` password is not the same as an absent one to
    // every driver, so the key is added only when a value exists.
    expect('password' in resolveMysqlPool({})).toBe(false)
    expect(resolveMysqlPool({ password: 'secret' })).toMatchObject({ password: 'secret' })
  })
})

describe('resolveMysqlDatabase', () => {
  it('reads the database out of a configured URI', () => {
    expect(resolveMysqlDatabase({ url: 'mysql://u:p@h:2881/appdb' })).toBe('appdb')
  })

  it('falls back to the default for a URI naming no database', () => {
    expect(resolveMysqlDatabase({ url: 'mysql://u:p@h:2881/' })).toBe('dsh')
  })

  it('reads the discrete field when no URI is configured', () => {
    expect(resolveMysqlDatabase({ database: 'appdb' })).toBe('appdb')
    expect(resolveMysqlDatabase({})).toBe('dsh')
  })
})

describe('tablesPresent', () => {
  /** One `mysql2` result: the driver returns `[rows, fields]`. */
  function rows(present: number | string): [{ present: number | string }[], undefined] {
    return [[{ present }], undefined]
  }

  it('scopes the probe to the connected database', async () => {
    // A same-named table in another database must not answer this, or a
    // half-provisioned target reads as fully provisioned.
    const query = vi.fn().mockResolvedValue(rows(2))
    await tablesPresent({ query }, ['dsh_session', 'dsh_session_event'])
    expect(query.mock.calls[0]?.[0]).toContain('table_schema = DATABASE()')
    expect(query.mock.calls[0]?.[1]).toEqual(['dsh_session', 'dsh_session_event'])
  })

  it('is true only when every named table exists', async () => {
    await expect(tablesPresent({ query: vi.fn().mockResolvedValue(rows(2)) }, ['a', 'b']))
      .resolves.toBe(true)
    await expect(tablesPresent({ query: vi.fn().mockResolvedValue(rows(1)) }, ['a', 'b']))
      .resolves.toBe(false)
    await expect(tablesPresent({ query: vi.fn().mockResolvedValue(rows(0)) }, ['a', 'b']))
      .resolves.toBe(false)
  })

  it('accepts the count as the string some drivers report', async () => {
    await expect(tablesPresent({ query: vi.fn().mockResolvedValue(rows('2')) }, ['a', 'b']))
      .resolves.toBe(true)
  })

  it('reads an empty result as absent rather than as present', async () => {
    // Zero named tables is not a case any caller passes, and an unreadable
    // answer must send the caller down the create path, not past it.
    await expect(tablesPresent({ query: vi.fn().mockResolvedValue([[], undefined]) }, ['a']))
      .resolves.toBe(false)
  })
})

describe('toJsonText', () => {
  /** One NUL, built without writing a control character into this file. */
  const NUL = String.fromCharCode(0)

  it('replaces the character subprocess output smuggles into a document', () => {
    const encoded = toJsonText({ out: `a${NUL}b` })
    expect(encoded).not.toContain(String.raw`\u0000`)
    expect(JSON.parse(encoded)).toEqual({ out: 'a\ufffdb' })
  })

  it('replaces every occurrence, not just the first', () => {
    expect(JSON.parse(toJsonText({ s: `${NUL}a${NUL}b${NUL}` })))
      .toEqual({ s: '\ufffda\ufffdb\ufffd' })
  })

  it('leaves every other document identical to JSON.stringify', () => {
    // Not a general sanitizer: tabs, newlines, non-ASCII text, and the six
    // literal characters of an escape a document may legitimately contain all
    // reach the database unchanged.
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
      expect(toJsonText(value)).toBe(JSON.stringify(value))
    }
  })
})
