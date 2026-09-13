/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-user-questions`.
 * @module @deepseek-ai/dsh-user-questions/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { questionStateSchema, validateQuestionAnswer } from './durable.ts'
import type { UserQuestionState } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-questions'

/** Cordis companion plugin name. */
export const name = 'user-questions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Verify that each durable decision settles the exact pending request and offered choices. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, UserQuestionState>()
  const observe = (session: Session, event: SessionEvent): void => {
    if (event.type !== 'user-questions/state') return
    const parsed = questionStateSchema.safeParse(event.data)
    if (!parsed.success) {
      fail('user-questions/state contains malformed question state')
    }
    const state = parsed.data
    const prior = states.get(session)
    if (state.pending !== null) {
      if (state.pending.version !== event.seq || (prior !== undefined && prior.pending !== null)) {
        fail('a durable question must start at its own version with no unanswered predecessor')
      }
    } else if (state.decision !== null) {
      const request = prior?.pending
      const decision = state.decision
      if (request === undefined || request === null || request.id !== decision.id || request.version !== decision.version) {
        fail('a durable decision must settle its exact pending question')
      } else {
        if (decision.answer !== null) {
          try { validateQuestionAnswer(request.questions, decision.answer) }
          catch { fail('a durable decision contains an answer not offered by its request') }
        }
        const question = request.questions.length === 1 ? request.questions[0] : undefined
        const item = decision.answer?.answers[0]
        const approved = question?.intent?.kind === 'plan-review'
          && item?.selected.length === 1 && item.selected[0] === question.intent.approve
          && item.custom === undefined
        if (decision.approvedPlan !== approved) fail('plan approval must match the offered approval choice')
      }
    }
    states.set(session, state)
  }
  const seed = (session: Session): void => {
    for (const event of session.events) observe(session, event)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', seed, { global: true })
  ctx.on('session/event', observe, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
