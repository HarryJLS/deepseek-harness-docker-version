/** Client-safe question, answer, and event types. @module @deepseek-ai/dsh-user-questions/types */

import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Durable identity of one question batch, independent of any browser connection. */
export type UserQuestionId = Branded<'UserQuestionId'>

/** One unanswered question batch recorded in the session log. */
export interface DurableUserQuestion {
  /** Unique identity submitted with the user's decision. */
  id: UserQuestionId
  /** Event sequence of this request; prevents an old card deciding a replacement. */
  version: number
  /** Model tool call that requested the answer. */
  callId: ToolCallId
  /** Complete question text and choices; file contents are not accepted separately. */
  questions: AskUserQuestionItem[]
}

/** Committed outcome of one durable question batch. */
export interface UserQuestionDecision {
  /** Identity of the answered request. */
  id: UserQuestionId
  /** Request version the user answered. */
  version: number
  /** Logged continuation message identity, also used to detect an unconsumed decision after recovery. */
  messageId: MessageId
  /** Null means the user dismissed the card to discuss the request. */
  answer: AskUserQuestionAnswer | null
  /** Whether this decision explicitly approves a plan-review intent. */
  approvedPlan: boolean
}

/** Whole question state at one point in a session's history. */
export interface UserQuestionState {
  /** The batch awaiting a decision, or null after settlement. */
  pending: DurableUserQuestion | null
  /** Most recently committed decision, or null before the first one. */
  decision: UserQuestionDecision | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete durable question state; a pending request does not retain a running turn. */
    'user-questions/state': UserQuestionState
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Question state reconstructed from the session log. */
    userQuestions: UserQuestionState
  }
  interface SessionProjectionStateMap {
    /** Question state shared by live and cold projections. */
    userQuestions: UserQuestionState
  }
}

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
export type AskUserQuestionIntent = {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires, and the decision approves or declines it. */
  kind: 'plan-review'
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   * An `approve` naming no option of its own question is rejected at `ask()`.
   */
  approve: string
}

/** One question in a user-questions request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
  /** Optional presentation intent for capable UIs; absent asks for the generic option list. */
  intent?: AskUserQuestionIntent
}

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}

/** Client-safe payload declared for the user-question answerer waterfall. */
export interface AskUserQuestionRequestEvent {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Agent identity projected to the corresponding Client Context in transit. */
  agent?: Agent
  /** Cancellation lifetime of the pending request. */
  signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for structured user input. Return an answer to
     * claim the request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - pending user-question request.
     * @mode waterfall
     */
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}
