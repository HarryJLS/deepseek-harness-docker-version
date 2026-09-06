/**
 * The container bundle's patch layer.
 *
 * The patch is the whole substance of this package, and its failure mode is
 * quiet: a provider swap that forgets to disable the row it replaces mounts two
 * providers of one service, and a plugin named without a matching dependency
 * entry fails module resolution only at boot on a real deployment. Both are
 * checked here against the file itself.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * The Loader evaluates `!!js` config expressions at composition time; a plain
 * parse cannot resolve the tag and would warn on every one. Declaring it as an
 * opaque string keeps the parse quiet while the assertions below read only the
 * literal fields.
 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }

const packageRoot = join(import.meta.dirname, '..')

/** Row operations as the patch file declares them. */
interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  insert?: { id: string; name: string; config?: Record<string, unknown> | string }[]
}

const patch = parse(
  readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8'),
  { customTags: [JS_TAG] },
) as PatchRow[]
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dsh: { bundle: { patch: string } }
  dependencies: Record<string, string>
}

/** Every row this patch inserts, flattened. */
const inserted = patch.flatMap(row => row.insert ?? [])
/** Every row id this patch disables. */
const disabled = new Set(patch.filter(row => row.disabled === true).map(row => row.id))

describe('container bundle manifest', () => {
  it('declares the patch the profile composer resolves', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })

  it('depends on every package its patch names', () => {
    // The Loader resolves a row's module from the profile directory, whose
    // module fallback mirrors this dependency closure. A plugin named here
    // without a dependency entry fails boot with ERR_MODULE_NOT_FOUND.
    const named = inserted
      .map(row => row.name)
      .filter(name => name.startsWith('@deepseek-ai/'))
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) {
      expect(manifest.dependencies, `${name} is inserted but not depended on`).toHaveProperty(name)
    }
  })
})

describe('provider swaps', () => {
  it.each([
    ['settings', 'settings-nacos'],
    ['credentials', 'credentials-nacos'],
    ['storage-json', 'storage-mysql'],
    ['session-persistence-jsonl', 'session-persistence-mysql'],
    ['attachment-local', 'attachment-mysql'],
  ])('replaces %s with %s', (replaced, replacement) => {
    // Two providers of one service both mount and collide; the disable is what
    // makes a swap a swap rather than a duplicate.
    expect(disabled.has(replaced), `${replaced} must be disabled`).toBe(true)
    expect(inserted.some(row => row.id === replacement)).toBe(true)
  })
})

describe('network exposure', () => {
  it('binds every interface', () => {
    const webserver = patch.find(row => row.id === 'webserver') as
      { config?: { host?: string } } | undefined
    expect(webserver?.config?.host).toBe('0.0.0.0')
  })

  it('opens both request gates, which the bind alone does not', () => {
    // The Host fence and browser authentication are independent; a container
    // reached through a published port needs both opened or /api answers 403
    // and the shell answers 401.
    const connection = patch.find(row => row.id === 'connection') as
      { config?: { allowAnyHost?: boolean; requireAuth?: boolean; userIdHeader?: string } } | undefined
    expect(connection?.config?.allowAnyHost).toBe(true)
    expect(connection?.config?.requireAuth).toBe(false)
    expect(connection?.config?.userIdHeader).toBe('x-user-id')
  })
})

describe('application scoping', () => {
  /** Every inserted row that owns tables in the database. */
  const databaseRows = inserted.filter(row => row.name.endsWith('-mysql'))

  it('scopes every database row by the application name', () => {
    // Half-scoping is the quiet failure: one plugin writing the app name into
    // its rows while another still writes `dsh` splits one deployment's state
    // across two applications in one table, and nothing reports it until a
    // session cannot find its own rows.
    expect(databaseRows.length).toBe(3)
    for (const row of databaseRows) {
      expect(row.config).toBeTypeOf('string')
      expect(row.config, `${row.id} is not scoped by DSH_APP_NAME`).toContain('app: process.env.DSH_APP_NAME')
      expect(row.config).toContain('JSON.parse(process.env.DSH_DATABASE_SECRET)')
      expect(row.config).not.toContain('DSH_MYSQL_')
    }
  })

  it('names every Nacos entry the same in every deployment', () => {
    // An application owns its Nacos, so the entries carry no application name:
    // one image must not make each deployment invent its own entry names, and
    // an application-prefixed data id would do exactly that. The database is
    // the backend applications share, so it is the only one scoped above.
    const nacosRows = inserted.filter(row => row.name.endsWith('-nacos'))
    expect(nacosRows.length).toBe(2)
    for (const row of nacosRows) {
      if (typeof row.config === 'string') throw new Error('expected Nacos connection fields')
      expect(row.config?.dataId, `${row.id} must not name the application`)
        .not.toContain('DSH_APP_NAME')
    }
  })
})
