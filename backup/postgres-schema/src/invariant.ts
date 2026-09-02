/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-postgres-schema`.
 * @module @deepseek-ai/dsh-postgres-schema/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-postgres-schema'

/** Cordis companion plugin name. */
export const name = 'postgres-schema-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is two pure functions and one statement
 * whose contract — the schema exists afterwards, whichever session created it —
 * is a database effect its consumers prove against a live server.
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
