/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-nacos`.
 * @module @deepseek-ai/dsh-credentials-nacos/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-nacos'

/** Cordis companion plugin name. */
export const name = 'credentials-nacos-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider's contracts are Nacos round-trip, push
 * timing, and the environment-over-store precedence — remote and process
 * effects proven by package tests. The seam-wide rules they serve are owned
 * and asserted by `@deepseek-ai/dsh-credentials`.
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
