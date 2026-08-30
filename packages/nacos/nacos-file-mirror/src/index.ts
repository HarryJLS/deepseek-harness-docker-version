/**
 * Materializes Nacos entries as files on the harness host, and keeps them in
 * step with the server for as long as the plugin is loaded.
 *
 * Two things a deployment needs to change without a redeploy are read from a
 * path rather than through a capability seam, so neither can be served by a
 * Nacos provider the way settings and credentials are:
 *
 * - the user-global `AGENTS.md`, which instruction discovery stats under the
 *   harness home and injects into every session's prompt;
 * - a profile's `cordis.patch.yml`, which the Loader re-composes from whenever
 *   the file changes on a profile declaring `patchReload: live`.
 *
 * Mirroring an entry onto each path puts both under the same Nacos edit that
 * already reaches every replica, and leaves the consumers untouched — the
 * prompt and the plugin tree keep reading a file.
 *
 * @module @deepseek-ai/dsh-nacos-file-mirror
 */

import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { nacosDocument, nacosEntrySchema } from '@deepseek-ai/dsh-nacos-client'
import type { NacosDocumentCodec, NacosEntryConfig } from '@deepseek-ai/dsh-nacos-client'
import { writeFileAtomic } from './write.ts'

export { writeFileAtomic } from './write.ts'

/** Cordis plugin name. */
export const name = 'nacos-file-mirror'

/** One Nacos entry and the path it is written to. */
export interface MirroredFile {
  /** The Nacos data id holding the file body. */
  dataId: string
  /** Absolute path the body is written to. */
  path: string
}

/** Plugin config: how to reach Nacos, and which entries to mirror. */
export interface Config extends NacosEntryConfig {
  /** The entries to mirror; an empty list loads the plugin as a no-op. */
  files: MirroredFile[]
}

export const Config: z<Config> = z.object({
  ...nacosEntrySchema,
  files: z.array(z.object({
    dataId: z.string().required(),
    path: z.string().required(),
  })).default([]),
})

/**
 * The entry body, used verbatim. An absent entry is distinguished from an empty
 * one because the two mean different things to a mirror: an empty entry is a
 * deliberate empty file, while an absent entry is a target this deployment does
 * not own and must not overwrite.
 */
const rawTextCodec: NacosDocumentCodec<string | undefined> = {
  parse: content => content,
  render: document => document ?? '',
}

/**
 * Mirror every configured entry, then keep each in step with the server.
 *
 * Each entry is read once at load and written before the plugin becomes
 * available, so a consumer that reads its path during the same composition
 * observes the Nacos content rather than whatever the image shipped. Later
 * pushes rewrite the file in place.
 * @param ctx - Cordis context supplying the logger and the disposal scope.
 * @param config - the Nacos connection and the entries to mirror.
 * @returns resolution once every entry has been read and written once.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  for (const file of config.files) {
    if (!isAbsolute(file.path)) {
      // The path is resolved against whatever directory the harness happens to
      // have been started in otherwise, which is not a property of the
      // deployment and would put the file somewhere no consumer reads.
      throw new Error(`nacos-file-mirror: ${JSON.stringify(file.path)} must be an absolute path`)
    }
  }
  for (const file of config.files) {
    await mirrorOne(ctx, config, file)
  }
}

/**
 * Open one entry, write its current body, and rewrite it on every push.
 * @param ctx - Cordis context supplying the logger and the disposal scope.
 * @param config - the Nacos connection fields.
 * @param file - the entry and its target path.
 * @returns resolution once the entry has been read and written once.
 */
async function mirrorOne(ctx: Context, config: Config, file: MirroredFile): Promise<void> {
  const document = nacosDocument(config, file.dataId, rawTextCodec)
  document.setErrorHandler((error: unknown) => {
    ctx.logger.warn(`nacos-file-mirror: ${document.address} failed: ${String(error)}`)
  })
  await document.connect()
  ctx.effect(() => () => { document.close() }, `nacos-file-mirror ${file.dataId}`)

  await write(ctx, file, await document.read())
  await document.watch((content) => {
    void write(ctx, file, content)
  })
}

/**
 * Write one mirrored body, reporting rather than throwing on failure.
 *
 * A push arrives outside any caller's control flow, so a rejection here has
 * nowhere to surface; it is logged and the previous file content stands. The
 * initial write goes through the same path so a load-time failure is reported
 * identically rather than failing the composition — the deployment is still
 * serviceable with the file the image shipped.
 * @param ctx - Cordis context supplying the logger.
 * @param file - the entry and its target path.
 * @param content - the entry body, or undefined when the entry is absent.
 * @returns resolution once the write settled, successfully or not.
 */
async function write(ctx: Context, file: MirroredFile, content: string | undefined): Promise<void> {
  if (content === undefined) {
    ctx.logger.info(`nacos-file-mirror: ${file.dataId} is absent; leaving ${file.path} as it is`)
    return
  }
  try {
    await writeFileAtomic(file.path, content)
    ctx.logger.info(`nacos-file-mirror: wrote ${String(content.length)} chars to ${file.path}`)
  } catch (error) {
    ctx.logger.warn(`nacos-file-mirror: cannot write ${file.path}: ${String(error)}`)
  }
}
