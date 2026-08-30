/**
 * Demonstration plugin for the container deployment.
 *
 * It exists to prove one path end to end: a package installed from outside the
 * image, mounted by a patch layer that Nacos mirrors onto the profile, writing
 * durable state into the application's own PostgreSQL schema. Every visible
 * effect below is a checkpoint on that path — the load line proves the mount,
 * the stored record proves the storage route, and the disposal line proves an
 * unmount reaches the plugin rather than merely hiding it.
 *
 * It is not a template for a real plugin: a shipped one lives in `packages/`,
 * declares its config, and owns tests.
 */

import { z } from 'zod'

/** Cordis plugin name. */
export const name = 'dsh-demo-plugin'

/**
 * The domain layer, which routes this plugin's writes to the configured backend.
 * `storageDomain` is the lifecycle service the domain plugin provides once it has
 * mounted the form — injecting the `storage` hub alone would activate this plugin
 * before any form is on it.
 */
export const inject = ['storageDomain']

/**
 * Domain the plugin stores its record in. The name doubles as the backend unit
 * name, so it must match `^[a-z][a-z0-9_]*$` — this is the value that appears
 * in `kv_record.unit`, inside the schema `DSH_APP_NAME` selected.
 */
const DOMAIN = {
  name: 'demo_plugin',
  version: 1,
  tables: {
    loads: {
      valueSchema: z.object({
        at: z.string(),
        app: z.string(),
      }),
    },
  },
}

/**
 * Open the domain and record this load.
 * @param ctx - Cordis context carrying the storage service and the logger.
 * @returns resolution once the load has been recorded.
 */
export async function apply(ctx) {
  ctx.logger.info('[dsh-demo-plugin] mounted from the Nacos-mirrored patch layer')

  const domain = await ctx.storageDomain.open(DOMAIN)
  ctx.effect(() => async () => {
    ctx.logger.info('[dsh-demo-plugin] unmounted; the stored rows stay in the database')
    await domain.close()
  }, 'dsh-demo-plugin domain')

  const at = new Date().toISOString()
  await domain.table('loads').put(at, { at, app: process.env.DSH_APP_NAME ?? 'dsh' })
  ctx.logger.info(`[dsh-demo-plugin] wrote demo_plugin/loads/${at}`)
}
