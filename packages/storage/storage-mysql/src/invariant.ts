/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-storage-mysql`.
 * @module @deepseek-ai/dsh-storage-mysql/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-storage-mysql'

/** Cordis companion plugin name. */
export const name = 'storage-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this backend's contracts are medium effects — atomic
 * single-statement writes, durability across a reopen, and version stamping —
 * proven against a live database by the shared KV conformance suite. The
 * in-process registry relation is owned by `@deepseek-ai/dsh-storage`.
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
