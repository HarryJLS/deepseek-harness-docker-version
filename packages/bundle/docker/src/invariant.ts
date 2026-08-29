/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bundle-docker`.
 * @module @deepseek-ai/dsh-bundle-docker/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bundle-docker'

/** Cordis companion plugin name. */
export const name = 'bundle-docker-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package contributes a configuration layer and no
 * runtime code. What it asserts — that every plugin its patch names resolves —
 * is a module-resolution fact the Loader proves at boot.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
