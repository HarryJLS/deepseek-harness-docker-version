/** Bind the existing question composer to the selected session's durable projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserQuestionState } from '@deepseek-ai/dsh-user-questions/types'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PendingQuestion } from './contract/slots.ts'

/**
 * Restore pending cards from shared state and submit decisions through unary Remote requests.
 * @param ctx - question plugin's Client context.
 * @param publish - existing pending-interaction publisher.
 * @returns subscription cleanup; leaving the page never cancels the durable question.
 */
export function observeDurableQuestions(ctx: Context, publish: PendingInteractionPublisher<PendingQuestion>): () => void {
  const sessions = ctx.sessions
  let selected: SessionId | undefined
  let unsubscribe: (() => void) | undefined
  let remove: (() => void) | undefined
  let pending: PendingQuestion | undefined
  const clear = (): void => {
    remove?.()
    remove = undefined
    pending?.abort(new Error('Question presentation closed.'))
    pending = undefined
  }
  const bind = (): void => {
    const id = sessions.list.getSnapshot().current
    if (id === selected && unsubscribe !== undefined) return
    unsubscribe?.()
    unsubscribe = undefined
    clear()
    selected = id
    if (id === undefined) return
    const binding = sessions.binding(id)
    if (binding === undefined) return
    const source = binding.session.projections.faceOf('userQuestions')
    const update = (): void => {
      const state = source.getSnapshot() as UserQuestionState | undefined
      const request = state?.pending
      if (request === undefined || request === null) {
        clear()
        return
      }
      const key = `durable-question:${request.id}:${String(request.version)}`
      if (pending?.key === key) return
      clear()
      const current = new PendingQuestion(id, request.questions, undefined, {
        key,
        submit: async (answer) => {
          const result = await ctx.remote.session.answerQuestion({
            sessionId: id, id: request.id, version: request.version, answer,
          })
          if (!result.ok) throw new Error(result.error.message)
          if (pending === current) clear()
        },
      })
      pending = current
      void current.result.catch(() => undefined)
      remove = publish(current, () => { current.delegate(); return Promise.resolve() })
    }
    unsubscribe = source.subscribe(update)
    update()
  }
  const stop = sessions.list.subscribe(bind)
  bind()
  return () => {
    stop()
    unsubscribe?.()
    clear()
  }
}
