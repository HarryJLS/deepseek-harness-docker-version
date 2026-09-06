/**
 * The atomic write behind every mirrored entry.
 *
 * It exists because both consumers watch the file they are given: a reader that
 * observes a truncated body composes a broken plugin tree or injects half a
 * prompt, and neither reports the write as the cause.
 */

import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, writeFileAtomic } from '../src/index.ts'

describe('mirror configuration', () => {
  it('resolves an empty file list and validates each file entry', () => {
    expect(z.resolve({ host: 'nacos' }, Config, {})[0]).toMatchObject({ host: 'nacos', files: [] })
    expect(Config({ host: 'nacos', files: [{ dataId: 'dsh-agents.md', path: '/var/lib/dsh/AGENTS.md' }] }).files)
      .toEqual([{ dataId: 'dsh-agents.md', path: '/var/lib/dsh/AGENTS.md' }])
    expect(() => z.resolve({ host: 'nacos', files: [{ dataId: 'dsh-agents.md' }] }, Config, {})).toThrow()
  })
})

/** One empty directory to write into, removed with the run's temp root. */
async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nacos-mirror-test-'))
}

describe('writeFileAtomic', () => {
  it('writes the body verbatim', async () => {
    const dir = await scratch()
    const path = join(dir, 'AGENTS.md')
    await writeFileAtomic(path, '# Soul\n\nBe brief.\n')
    expect(await readFile(path, 'utf8')).toBe('# Soul\n\nBe brief.\n')
  })

  it('creates the parent directory when it does not exist', async () => {
    // A profile directory is created by the harness after this plugin loads, so
    // the mirror cannot assume the path's parent is already there.
    const dir = await scratch()
    const path = join(dir, 'profiles', 'web', 'cordis.patch.yml')
    await writeFileAtomic(path, '- id: demo\n')
    expect(await readFile(path, 'utf8')).toBe('- id: demo\n')
  })

  it('replaces earlier content rather than appending to it', async () => {
    const dir = await scratch()
    const path = join(dir, 'entry.yml')
    await writeFileAtomic(path, 'first: 1\n')
    await writeFileAtomic(path, 'second: 2\n')
    expect(await readFile(path, 'utf8')).toBe('second: 2\n')
  })

  it('leaves no temporary sibling behind', async () => {
    // A temporary left in the profile directory is itself watched, so a leak
    // would retrigger the reload it was written to avoid.
    const dir = await scratch()
    await writeFileAtomic(join(dir, 'entry.yml'), 'a: 1\n')
    expect(await readdir(dir)).toEqual(['entry.yml'])
  })

  it('writes an empty entry as an empty file', async () => {
    // An empty entry is a deliberate "no user patch", distinct from an absent
    // one, which the caller never passes here.
    const dir = await scratch()
    const path = join(dir, 'entry.yml')
    await writeFileAtomic(path, '')
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('keeps the file private to the harness user', async () => {
    // A mirrored entry can carry deployment configuration; the file inherits
    // the entry's sensitivity, not the directory's default mode.
    const dir = await scratch()
    const path = join(dir, 'entry.yml')
    await writeFileAtomic(path, 'a: 1\n')
    expect((await stat(path)).mode & 0o077).toBe(0)
  })

  it('reports a write it cannot perform', async () => {
    // The parent exists as a FILE here, so mkdir fails; the caller logs and
    // keeps the previous content rather than failing a composition.
    const dir = await scratch()
    await writeFileAtomic(join(dir, 'blocker'), 'x')
    await expect(writeFileAtomic(join(dir, 'blocker', 'child.yml'), 'a: 1\n')).rejects.toThrow()
  })
})
