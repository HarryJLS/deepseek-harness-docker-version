/**
 * Negative-path tests for the config catalog generator (`scripts/gen-config-catalog.ts`).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConfigCatalog, render } from '../../../../scripts/gen-config-catalog.ts'

/** Write one fixture package (package.json + src files) under a scan root. */
function writePkg(root: string, dir: string, name: string, files: Record<string, string>): void {
  const pkgDir = join(root, 'packages', dir)
  mkdirSync(join(pkgDir, 'src'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name }))
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(pkgDir, rel), text)
}

const roots: string[] = []
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'config-catalog-'))
  roots.push(root)
  return root
}
/** One-package fixture: the common case. */
const make = (files: Record<string, string>, name = '@fix/one'): string => {
  const root = makeRoot()
  writePkg(root, 'group/one', name, files)
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

const DOCUMENTED_CONFIG = `/** Fixture config. */
export interface Config {
  /** A knob. */
  knob?: string
}
`

describe('gen-config-catalog classification', () => {
  it('classifies an apply plugin with a config parameter and extracts the paste', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
export const inject = ['tools']
${DOCUMENTED_CONFIG}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ pkg: '@fix/one', kind: 'config', configTypeName: 'Config', inject: ['tools'] })
    expect(entries[0]?.pastes?.[0]?.text).toContain('/** A knob. */')
  })

  it('classifies a default service class, reading its constructor and static inject', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
/** Fixture service. */
export default class Fix {
  static inject = ['llm']
  static Config = z.object({ knob: z.string() }) as unknown as z<Config>
  constructor(ctx: Context, config: Config) {}
}
`,
    }))
    expect(entries[0]).toMatchObject({ kind: 'config', className: 'Fix', inject: ['llm'], schemaKeys: ['knob'] })
  })

  it('classifies an abstract default class as a seam', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': 'export default abstract class FixSeam { abstract run(): void }\n',
    }))
    expect(entries[0]).toMatchObject({ kind: 'seam', className: 'FixSeam' })
  })

  it('classifies a plugin whose apply takes no config as no-config', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': 'import type { Context } from \'cordis\'\n/** Load. */\nexport function apply(ctx: Context): void {}\n',
    }))
    expect(entries[0]?.kind).toBe('no-config')
  })

  it('classifies a module with neither default export nor apply as a library', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': 'export const helper = 1\n',
    }))
    expect(entries[0]?.kind).toBe('library')
  })

  it('hard-errors on a package with no entry file', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'packages', 'group', 'one'), { recursive: true })
    writeFileSync(join(root, 'packages', 'group', 'one', 'package.json'), JSON.stringify({ name: '@fix/one' }))
    expect(() => collectConfigCatalog(root)).toThrow(/entry .* is missing or unreadable/)
  })

  it('hard-errors on a package.json without a name', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'packages', 'group', 'one', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'group', 'one', 'package.json'), '{}')
    expect(() => collectConfigCatalog(root)).toThrow(/has no "name"/)
  })
})

describe('gen-config-catalog config extraction guards', () => {
  it('hard-errors on a config field with no JSDoc prose', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
export interface Config {
  knob?: string
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/config field 'Config\.knob' .* has no JSDoc prose/)
  })

  it('hard-errors on an undocumented field nested in a type literal', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
/** Fixture config. */
export interface Config {
  /** Entries. */
  entries: {
    id: string
  }[]
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/config field 'Config\.entries\.id' .* has no JSDoc prose/)
  })

  it('pastes a package-local type transitively and records external refs', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import type { Mode } from './types.ts'
import type { Remote } from '@fix/dep'
/** Fixture config. */
export interface Config {
  /** The mode. */
  mode?: Mode
  /** The remote. */
  remote?: Remote
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
      'src/types.ts': '/** Fixture mode. */\nexport type Mode = \'a\' | \'b\'\n',
    }))
    expect(entries[0]?.pastes?.map(p => p.source)).toEqual([
      'packages/group/one/src/index.ts:5',
      'packages/group/one/src/types.ts:2',
    ])
    expect(entries[0]?.refs).toEqual([{ alias: 'Remote', imported: 'Remote', specifier: '@fix/dep' }])
  })

  it('pastes an enum referenced by the config type', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
/** Fixture mode. */
export enum Mode {
  A = 'a',
  B = 'b',
}
/** Fixture config. */
export interface Config {
  /** The mode. */
  mode?: Mode
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))
    expect(entries[0]?.pastes?.map(p => p.text)).toEqual([
      '/** Fixture config. */\nexport interface Config {\n  /** The mode. */\n  mode?: Mode\n}',
      "/** Fixture mode. */\nexport enum Mode {\n  A = 'a',\n  B = 'b',\n}",
    ])
  })

  it('hard-errors on a referenced type name that resolves nowhere', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
/** Fixture config. */
export interface Config {
  /** The ghost. */
  ghost?: Ghost
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/references 'Ghost' .* neither declared in the package, imported, nor a known global/)
  })

  it('hard-errors on a config type imported from another package', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '@fix/dep'
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/config type 'Config' is imported from '@fix\/dep'/)
  })

  it('hard-errors when one name resolves to two different declarations across the closure', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import type { A } from './a.ts'
import type { B } from './b.ts'
/** Fixture config. */
export interface Config {
  /** A. */
  a?: A
  /** B. */
  b?: B
}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
      'src/a.ts': '/** First Option. */\nexport interface Option {\n  /** X. */\n  x?: string\n}\n/** A. */\nexport interface A {\n  /** O. */\n  o?: Option\n}\n',
      'src/b.ts': '/** Second Option. */\nexport interface Option {\n  /** Y. */\n  y?: string\n}\n/** B. */\nexport interface B {\n  /** O. */\n  o?: Option\n}\n',
    }))).toThrow(/type name 'Option' resolves to two different declarations/)
  })
})

describe('gen-config-catalog schema cross-check', () => {
  it('accepts a chained schema whose keys all appear on the config type', () => {
    const entries = collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
export const Config: z<Config> = z.object({ knob: z.string() }).default({})
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))
    expect(entries[0]?.schemaKeys).toEqual(['knob'])
  })

  it('hard-errors on a schema key the config type does not declare', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
export const Config: z<Config> = z.object({ knob: z.string(), hidden: z.number() })
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/schema validates key 'hidden' but config type 'Config' declares no such member/)
  })

  it('hard-errors on a NESTED schema key the config type does not declare', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
/** Fixture config. */
export interface Config {
  /** Entries. */
  entries: {
    /** Id. */
    id: string
  }[]
}
export const Config: z<Config> = z.object({ entries: z.array(z.object({ id: z.string(), ghost: z.string() })) })
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).toThrow(/schema validates key 'entries\[\]\.ghost'/)
  })

  it('resolves nested keys through a workspace-imported intersection part (re-export chains included)', () => {
    const root = makeRoot()
    writePkg(root, 'group/dep', '@fix/dep', {
      'src/index.ts': 'export * from \'./types.ts\'\n',
      'src/types.ts': '/** Shared options. */\nexport interface Opts {\n  /** Model. */\n  model?: string\n}\n',
    })
    writePkg(root, 'group/one', '@fix/one', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Opts } from '@fix/dep'
/** Fixture config. */
export interface Config {
  /** Entries. */
  entries: (Opts & {
    /** Id. */
    id: string
  })[]
}
export const Config: z<Config> = z.object({ entries: z.array(z.object({ id: z.string(), model: z.string() })) })
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).not.toThrow()
  })

  it('resolves nested keys through a Partial<> wrapper', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
/** Caps. */
export interface Caps {
  /** X. */
  x?: boolean
}
/** Fixture config. */
export interface Config {
  /** Capabilities. */
  capabilities?: Partial<Caps>
}
export const Config: z<Config> = z.object({ capabilities: z.object({ x: z.boolean() }) })
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).not.toThrow()
  })

  it('leaves a nested key under an external (unresolvable) type unreported', () => {
    expect(() => collectConfigCatalog(make({
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { External } from 'some-external-pkg'
/** Fixture config. */
export interface Config {
  /** Options. */
  options?: External
}
export const Config: z<Config> = z.object({ options: z.object({ whatever: z.string() }) })
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    }))).not.toThrow()
  })

  it('folds an intersected workspace schema into the subset check', () => {
    const root = makeRoot()
    writePkg(root, 'group/leaf', '@fix/leaf', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
/** Leaf config. */
export interface Config {
  /** Leaf knob. */
  leaf?: string
}
/** Leaf service. */
export default class Leaf {
  static Config = z.object({ leaf: z.string() }) as unknown as z<Config>
  constructor(ctx: Context, config: Config) {}
}
`,
    })
    writePkg(root, 'group/bundle', '@fix/bundle', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Leaf from '@fix/leaf'
/** Bundle config. */
export interface Config {
  /** Forwarded leaf knob. */
  leaf?: string
}
export const Config = z.intersect([Leaf.Config]) as unknown as z<Config>
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    })
    const entries = collectConfigCatalog(root)
    expect(entries.find(e => e.pkg === '@fix/bundle')?.schemaComposes).toEqual(['@fix/leaf'])
  })

  it('resolves composed nested keys through an indexed-access forwarder', () => {
    const root = makeRoot()
    writePkg(root, 'group/leaf', '@fix/leaf', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
/** Leaf config. */
export interface Config {
  /** Agents. */
  agents: {
    /** Id. */
    id: string
  }[]
}
/** Leaf service. */
export default class Leaf {
  static Config = z.object({ agents: z.array(z.object({ id: z.string() })) }) as unknown as z<Config>
  constructor(ctx: Context, config: Config) {}
}
`,
    })
    writePkg(root, 'group/bundle', '@fix/bundle', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Leaf, { type Config as LeafConfig } from '@fix/leaf'
/** Bundle config forwarding the leaf's agents list. */
export interface Config {
  /** Forwarded agents list. */
  agents?: LeafConfig['agents']
}
export const Config = z.intersect([Leaf.Config]) as unknown as z<Config>
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).not.toThrow()
  })

  it('hard-errors when an intersected schema key is missing from the bundle config type', () => {
    const root = makeRoot()
    writePkg(root, 'group/leaf', '@fix/leaf', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
/** Leaf config. */
export interface Config {
  /** Leaf knob. */
  leaf?: string
}
/** Leaf service. */
export default class Leaf {
  static Config = z.object({ leaf: z.string() }) as unknown as z<Config>
  constructor(ctx: Context, config: Config) {}
}
`,
    })
    writePkg(root, 'group/bundle', '@fix/bundle', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Leaf from '@fix/leaf'
/** Bundle config that forgot to declare the forwarded field. */
export interface Config {
  /** Unrelated. */
  other?: string
}
export const Config = z.intersect([Leaf.Config]) as unknown as z<Config>
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).toThrow(/schema validates key 'leaf' but config type 'Config' declares no such member/)
  })
})

describe('gen-config-catalog shared schema fields', () => {
  it('follows aliased workspace re-exports and nested package-local spreads without executing modules', () => {
    const root = makeRoot()
    writePkg(root, 'group/shared', '@fix/shared', {
      'src/index.ts': "export { fields as connectionFields, type Connection } from './fields.ts'\n",
      'src/fields.ts': `import z from '@deepseek-ai/schemastery'
import { endpointFields } from './endpoint.ts'
export interface Connection {
  /** Server host. */
  host?: string
  /** Endpoints. */
  endpoints?: {
    /** Server port. */
    port?: number
  }[]
}
export const fields = {
  host: z.string(),
  endpoints: z.array(z.object({ ...endpointFields })),
}
throw new Error('The catalog must never execute this module')
`,
      'src/endpoint.ts': "import z from '@deepseek-ai/schemastery'\nexport const endpointFields = { port: z.number() }\n",
    })
    writePkg(root, 'group/one', '@fix/one', {
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
import { connectionFields as shared, type Connection } from '@fix/shared'
/** Fixture config. */
export interface Config extends Connection {
  /** A knob. */
  knob?: string
}
const alias = (shared satisfies Record<string, unknown>)
export const Config = z.object({ ...alias, ...({ knob: z.string() } as const) })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(collectConfigCatalog(root).find(entry => entry.pkg === '@fix/one')?.schemaKeys)
      .toEqual(['host', 'endpoints', 'endpoints[].port', 'knob'])
  })

  it.each([
    ['a top-level field', '{ hidden: z.string() }', 'hidden'],
    ['a nested field', '{ entries: z.array(z.object({ ...nested })) }', 'entries[].hidden'],
  ])('rejects %s hidden in an imported spread', (_label, fields, path) => {
    const root = makeRoot()
    writePkg(root, 'group/shared', '@fix/shared', {
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
const nested = { hidden: z.string() }
export const fields = ${fields}
`,
    })
    writePkg(root, 'group/one', '@fix/one', {
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
import { fields } from '@fix/shared'
export interface Config {
  /** Entries. */
  entries?: {
    /** Visible value. */
    value?: string
  }[]
}
export const Config = z.object({ ...fields })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).toThrow(`schema validates key '${path}'`)
  })

  it('checks constant object arguments as well as spread operands', () => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
const fields = { knob: z.string() }
const alias = fields
export const Config = z.object(alias)
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(collectConfigCatalog(root)[0]?.schemaKeys).toEqual(['knob'])
  })

  it.each([
    ['...fields, knob: z.object({ value: z.string() })', false],
    ['knob: z.object({ value: z.string() }), ...fields', true],
  ])('uses the final property value in {%s}', (properties, hidden) => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
export interface Config {
  /** A knob. */
  knob?: {
    /** Visible value. */
    value?: string
  }
}
const fields = { knob: z.object({ hidden: z.string() }) }
export const Config = z.object({ ${properties} })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    if (hidden) expect(() => collectConfigCatalog(root)).toThrow("schema validates key 'knob.hidden'")
    else expect(collectConfigCatalog(root)[0]?.schemaKeys).toEqual(['knob', 'knob.value'])
  })

  it.each([
    ['a function result', 'function fields() { return { knob: z.string() } }', 'fields()'],
    ['a mutable binding', 'let fields = { knob: z.string() }', 'fields'],
    ['an external import', "import { fields } from 'external-config'", 'fields'],
    ['an unresolved name', '', 'fields'],
    ['cyclic constant aliases', 'const fields = other\nconst other = fields', 'fields'],
  ])('rejects %s instead of omitting its fields', (_label, declaration, expression) => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
${declaration}
export const Config = z.object({ ...${expression} })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).toThrow('must resolve to a constant object literal')
  })

  it('rejects an unresolvable nested object argument', () => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
export const Config = z.object({ knob: z.object(makeFields()) })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).toThrow("schema object 'makeFields()' must resolve")
  })

  it.each([
    ['spread', '{ ...fields }', 'cyclic schema object spread'],
    ['nested object', '{ knob: z.object(fields) }', 'cyclic nested schema object'],
  ])('rejects a cyclic %s', (_label, value, message) => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
const fields = ${value}
export const Config = z.object({ ...fields })
export function apply(ctx: unknown, config: Config): void {}
`,
    })
    expect(() => collectConfigCatalog(root)).toThrow(message)
  })

  it('rejects a cyclic re-export chain', () => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
import { fields } from './first.ts'
${DOCUMENTED_CONFIG}
export const Config = z.object({ ...fields })
export function apply(ctx: unknown, config: Config): void {}
`,
      'src/first.ts': "export * from './second.ts'\n",
      'src/second.ts': "export * from './first.ts'\n",
    })
    expect(() => collectConfigCatalog(root)).toThrow('must resolve to a constant object literal')
  })

  it('rejects an import of a private constant', () => {
    const root = make({
      'src/index.ts': `import z from '@deepseek-ai/schemastery'
import { fields } from './private.ts'
${DOCUMENTED_CONFIG}
export const Config = z.object({ ...fields })
export function apply(ctx: unknown, config: Config): void {}
`,
      'src/private.ts': "import z from '@deepseek-ai/schemastery'\nconst fields = { knob: z.string() }\n",
    })
    expect(() => collectConfigCatalog(root)).toThrow('must resolve to a constant object literal')
  })

  it.each(['{ [key]: z.string() }', '{ get knob() { return z.string() } }'])(
    'rejects non-plain properties in a shared field set: %s',
    (value) => {
      const root = make({
        'src/index.ts': `import z from '@deepseek-ai/schemastery'
${DOCUMENTED_CONFIG}
const fields = ${value}
export const Config = z.object({ ...fields })
export function apply(ctx: unknown, config: Config): void {}
`,
      })
      expect(() => collectConfigCatalog(root)).toThrow('is not a plain key')
    },
  )
})

describe('gen-config-catalog render', () => {
  it('renders sections, fences, and the terse classification lists', () => {
    const root = makeRoot()
    writePkg(root, 'group/one', '@fix/one', {
      'src/index.ts': `import type { Context } from '@deepseek-ai/cordis'
${DOCUMENTED_CONFIG}
/** Load. */
export function apply(ctx: Context, config: Config): void {}
`,
    })
    writePkg(root, 'group/lib', '@fix/lib', { 'src/index.ts': 'export const helper = 1\n' })
    writePkg(root, 'group/seam', '@fix/seam', {
      'src/index.ts': 'export default abstract class Seam { abstract run(): void }\n',
    })
    const page = render(collectConfigCatalog(root))
    expect(page).toContain('## `@fix/one`')
    expect(page).toContain('```ts config-catalog')
    expect(page).toContain('/** A knob. */')
    expect(page).toContain('- `@fix/lib` ([`packages/group/lib/src/index.ts`](../packages/group/lib/src/index.ts))')
    expect(page).toContain('- `@fix/seam` — abstract `Seam`')
  })
})
