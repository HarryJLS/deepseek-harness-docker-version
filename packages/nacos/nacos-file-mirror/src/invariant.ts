/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-nacos-file-mirror`.
 * @module @deepseek-ai/dsh-nacos-file-mirror/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-nacos-file-mirror'

/** Cordis companion plugin name. */
export const name = 'nacos-file-mirror-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no event stream and no mutable data.
 * Its one relation — entry body in, identical file body out — is filesystem
 * effect, proven by package tests; what then reads the file is owned by the
 * Loader and by `@deepseek-ai/dsh-agent-instructions`.
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
