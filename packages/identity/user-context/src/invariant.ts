/** Package ownership for request user identity helpers. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'user-context-invariant'
/** Service required to register package ownership. */
export const inject = ['invariants']

/** No runtime invariant: request scopes have no event stream; consumers enforce durable ownership. */
const install: InvariantInstaller = () => {}

/**
 * Register the library's invariant companion.
 * @param ctx - context carrying the invariant registry.
 * @returns disposer for this package's registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-user-context', install))
