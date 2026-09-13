/** Durable question validation, projection, and answer matching. */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, UserQuestionState,
} from './types.ts'

const questionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  detail: z.string().optional(),
  header: z.string().optional(),
  options: z.array(z.object({
    label: z.string().min(1),
    description: z.string().optional(),
  }).strict()).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.object({ kind: z.literal('plan-review'), approve: z.string() }).strict().optional(),
}).strict()

/** Validates answers received through the browser or restored from storage. */
export const questionAnswerSchema = z.object({
  answers: z.array(z.object({
    id: z.string().min(1),
    selected: z.array(z.string()),
    custom: z.string().optional(),
  }).strict()),
}).strict()

/** Complete persisted projection, including request/version identities. */
export const questionStateSchema = z.object({
  pending: z.object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    callId: z.string().min(1),
    questions: z.array(questionSchema).min(1),
  }).strict().nullable(),
  decision: z.object({
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    messageId: z.string().min(1),
    answer: questionAnswerSchema.nullable(),
    approvedPlan: z.boolean(),
  }).strict().nullable(),
}).strict() as unknown as z.ZodType<UserQuestionState>

/**
 * Restore the latest whole question state without a live question callback.
 * @param events - contiguous session event history.
 * @returns the last committed state, or the empty initial state.
 */
export function questionState(events: readonly SessionEvent[]): UserQuestionState {
  const event = events.findLast(entry => entry.type === 'user-questions/state')
  return event?.data ?? { pending: null, decision: null }
}

/**
 * Match a complete answer against exactly the offered questions and choices.
 * Empty selections represent the existing Web skip action.
 * @param questions - questions from the durable request.
 * @param answer - browser-supplied structured answer.
 * @throws when identities, multiplicity, or option labels do not match.
 */
export function validateQuestionAnswer(
  questions: readonly AskUserQuestionItem[],
  answer: AskUserQuestionAnswer,
): void {
  questionAnswerSchema.parse(answer)
  if (answer.answers.length !== questions.length
    || new Set(answer.answers.map(item => item.id)).size !== questions.length) {
    throw new Error('The answer must cover each requested question exactly once.')
  }
  for (const question of questions) {
    const item = answer.answers.find(entry => entry.id === question.id)
    if (item === undefined
      || (question.multiSelect !== true && item.selected.length > 1)
      || new Set(item.selected).size !== item.selected.length
      || item.selected.some(label => !question.options?.some(option => option.label === label))) {
      throw new Error(`The answer does not match question "${question.id}".`)
    }
  }
}
