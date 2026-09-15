import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const entrypoint = fileURLToPath(new URL('./deploy-entrypoint.sh', import.meta.url))

describe('container entrypoint', { skip: process.platform === 'win32' }, () => {
  it('keeps launcher overlays before app arguments and sources the prepared environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-entrypoint-'))
    try {
      const capture = join(directory, 'arguments')
      const environment = join(directory, 'resolved.env')
      await writeFile(join(directory, 'node'), [
        '#!/bin/sh',
        'if [ "$1" = /usr/local/bin/prepare-profile.mjs ]; then',
        '  printf "export DSH_TEST_BOOTSTRAP=ready\\n" > "$DSH_RESOLVED_ENV"',
        '  exit 0',
        'fi',
        'printf "%s\\0" "$DSH_TEST_BOOTSTRAP" "$@" > "$DSH_TEST_CAPTURE"',
        '',
      ].join('\n'), { mode: 0o700 })
      const patch = join(directory, "layer with spaces and '$.yml")
      const result = spawnSync('/bin/sh', [entrypoint, '--patch', patch], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
          DSH_BIN: '/app/apps/cli/lib/bin.js',
          DSH_PROFILE: 'web',
          DSH_RESOLVED_ENV: environment,
          DSH_TEST_CAPTURE: capture,
        },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual((await readFile(capture, 'utf8')).split('\0').slice(0, -1), [
        'ready', '/app/apps/cli/lib/bin.js', '--profile', 'web', '--patch', patch, '--no-open',
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
