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
  assertMysqlTable,
  mysqlIdGenerator,
  mysqlAuditValues,
} from '../src/index.ts'
import { parseUserId, withUser } from '@deepseek-ai/dsh-user-context'

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
      .toEqual({ uri: 'mysql://u:p@h:2881/db', connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: true })
  })

  it('applies the OceanBase MySQL-protocol defaults', () => {
    expect(resolveMysqlPool({})).toEqual({
      host: 'oceanbase',
      port: 2881,
      database: 'dsh',
      user: 'root',
      connectionLimit: 10,
      supportBigNumbers: true,
      bigNumberStrings: true,
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

describe('audit rows', () => {
  it('generates distinct monotonic bigint strings across same-worker consumers and clock rollback', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_788_600_000_000)
    try {
      const left = mysqlIdGenerator(701)
      const right = mysqlIdGenerator(701)
      const other = mysqlIdGenerator(702)
      const ids = Array.from({ length: 10000 }, (_, index) => index % 2 === 0 ? left() : right())
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.every(id => /^\d+$/u.test(id) && BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true)
      expect(BigInt(other())).not.toBe(BigInt(ids[0]!))
      clock.mockReturnValue(1_788_599_000_000)
      expect(BigInt(left())).toBeGreaterThan(BigInt(ids.at(-1)!))
    } finally { clock.mockRestore() }
  })

  it('rejects worker identifiers outside the ten-bit allocation', () => {
    for (const value of [-1, 1024, 0.5, NaN]) expect(() => mysqlIdGenerator(value)).toThrow('snowflakeWorkerId')
  })

  it('records the request actor or an explicit durable owner', () => {
    expect(mysqlAuditValues(() => '123')).toEqual(['123', '-', '-'])
    expect(withUser(parseUserId('alice'), () => mysqlAuditValues(() => '124'))).toEqual(['124', 'alice', 'alice'])
    expect(withUser(parseUserId('bob'), () => mysqlAuditValues(() => '125', parseUserId('alice'))))
      .toEqual(['125', 'alice', 'alice'])
  })

  it('rejects old composite primary keys and missing audit columns', async () => {
    const columns = ['id', 'is_deleted', 'creator', 'gmt_created', 'modifier', 'gmt_modified', 'user_id']
      .map(name => ({ name, type: name === 'id' ? 'bigint' : 'varchar', key_type: name === 'id' ? 'PRI' : '' }))
    await expect(assertMysqlTable({ query: vi.fn().mockResolvedValue([columns]) }, 'dsh_session', ['user_id']))
      .resolves.toBeUndefined()
    for (const invalid of [columns.slice(1), columns.slice(0, -1), columns.map(row => ({ ...row, key_type: 'PRI' })), columns.map(row => row.name === 'id' ? { ...row, type: 'varchar' } : row)]) {
      await expect(assertMysqlTable({ query: vi.fn().mockResolvedValue([invalid]) }, 'dsh_session', ['user_id']))
        .rejects.toThrow('unsupported layout')
    }
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
