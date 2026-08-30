/**
 * Durable single-file writes for mirrored Nacos entries.
 *
 * @module @deepseek-ai/dsh-nacos-file-mirror/write
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Bytes of randomness in a temporary name; collision-free without coordination. */
const TEMP_SUFFIX_BYTES = 8

/**
 * Write one file so no reader ever observes a partial body.
 *
 * The write lands on a temporary sibling and is renamed into place, because
 * both consumers of this package watch the file they are given: the Loader
 * reloads a profile patch the moment it changes, and instruction discovery
 * reads the user-global file at session start. A plain truncate-then-write is
 * observable in its torn state by either, and a half-written patch fails the
 * composition rather than the write.
 *
 * The sibling shares the target's directory so the rename stays within one
 * filesystem, where it is atomic; a temporary directory elsewhere would make it
 * a copy.
 * @param path - absolute path to write.
 * @param content - the complete file body.
 * @returns resolution once the content is in place under `path`.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const suffix = Array.from(
    { length: TEMP_SUFFIX_BYTES },
    () => Math.floor(Math.random() * 36).toString(36),
  ).join('')
  const temporary = join(directory, `.${suffix}.nacos-mirror`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await discard(temporary)
    throw error
  }
}

/**
 * Remove a temporary file left by a failed write.
 * @param path - the temporary path to remove.
 * @returns resolution once the path is gone or was never there.
 */
async function discard(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // The write already failed and is about to be reported; a cleanup failure
    // on the temporary sibling has no separate remedy and must not replace the
    // original error with a less specific one.
  }
}
