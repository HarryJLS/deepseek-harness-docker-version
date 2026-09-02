/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mysql-schema`.
 * @module @deepseek-ai/dsh-mysql-schema/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mysql-schema'

/** Cordis companion plugin name. */
export const name = 'mysql-schema-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is pure resolution and serialization
 * helpers plus one `information_schema` read, whose answer is a property of the
 * live database its consumers prove against, not an in-process relation.
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
