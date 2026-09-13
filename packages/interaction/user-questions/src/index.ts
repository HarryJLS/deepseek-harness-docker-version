/**
 * Human questions with live waterfall answers or durable, later decisions.
 * Tool Consumers conclude their turn after recording a durable request;
 * Session Controller accepts the versioned answer and admits the continuation.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, MessageId } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { questionState, questionStateSchema, validateQuestionAnswer } from './durable.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type {
  AskUserQuestionAnswer, AskUserQuestionRequestEvent,
  UserQuestionId, UserQuestionState,
  UserQuestionDecision,
} from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption,
  DurableUserQuestion, UserQuestionDecision, UserQuestionId, UserQuestionState,
} from './types.ts'

/** Human-question delivery and retained payload limits. */
export interface Config {
  /** End the requesting turn and accept a later, independently routed decision. */
  durable?: boolean
  /** Maximum UTF-8 bytes in a durable question batch or answer. */
  maxRequestBytes?: number
}

/** Request for a human answer. */
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  return reason
}

/** `ctx.userQuestions`: validation plus the scoped answerer waterfall. */
export class UserQuestionService extends Service {
  static Config: z<Config> = z.object({
    durable: z.boolean().default(false),
    maxRequestBytes: z.number().step(1).min(1024).max(4_194_304).default(65_536),
  })

  /** Whether tool consumers submit questions without keeping a callback alive. */
  readonly durable: boolean
  private readonly maxRequestBytes: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'userQuestions')
    this.durable = config.durable ?? false
    this.maxRequestBytes = config.maxRequestBytes ?? 65_536
    if (this.durable) ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register({
        key: 'userQuestions',
        stateVersion: 1,
        stateSchema: questionStateSchema,
        init: () => ({ pending: null, decision: null }),
        apply: (state, event) => event.type === 'user-questions/state' ? event.data : state,
        wire: { viewSchema: questionStateSchema, view: state => state },
      })
    })
    if (this.durable) ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.tools.guard((exec) => {
        const pending = exec.agent === undefined ? null : this.state(exec.agent).pending
        return pending !== null && pending.callId !== exec.callId
          ? 'Wait for the user to answer the pending question before executing another tool.'
          : undefined
      })
    })
    if (this.durable) ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      const state = this.state(agent)
      if (state.pending !== null) return { kind: 'reject' }
      if (decision.kind === 'reject' || state.decision === null) return decision
      const message = this.decisionMessage(state.decision)
      if (decision.messages.some(item => item.id === message.id)
        || agent.session.events.some(event => event.type === 'user/message' && event.data.id === message.id)) return decision
      return { ...decision, messages: [message, ...decision.messages] }
    })
  }

  /**
   * Read question state from the exact agent's session log.
   * @param agent - agent whose question state is requested.
   * @returns the current pending request and most recent decision.
   */
  state(agent: Agent): UserQuestionState {
    return questionState(agent.session.events)
  }

  /**
   * Request human input for a model tool call.
   * @param request - question batch and its live caller.
   * @param callId - exact tool call requesting the answer.
   * @returns an immediate human answer in live mode, or undefined after recording a durable request.
   */
  async request(request: AskUserQuestionRequest, callId: ToolCallId): Promise<AskUserQuestionAnswer | undefined> {
    if (!this.durable) return this.ask(request)
    this.validate(request)
    const agent = request.agent
    if (agent === undefined) throw new UserQuestionError('durable questions require an agent', 'CALLER_NOT_LIVE')
    if (this.state(agent).pending !== null) {
      throw new UserQuestionError('a question is already awaiting an answer', 'QUESTION_PENDING')
    }
    this.assertSize(request.questions)
    if (new Set(request.questions.map(question => question.id)).size !== request.questions.length) {
      throw new UserQuestionError('question ids must be unique within a request', 'BAD_QUESTIONS')
    }
    const state: UserQuestionState = {
      pending: {
        id: randomUUID() as UserQuestionId,
        version: agent.session.seq,
        callId,
        questions: request.questions,
      },
      decision: this.state(agent).decision,
    }
    questionStateSchema.parse(state)
    agent.session.append('user-questions/state', state)
    await this.ctx.parallel('session/flush', agent.session)
    return undefined
  }

  /**
   * Record a version-matched answer and wake a new turn.
   * The caller must hold the shared session execution lease when deployed across replicas.
   * @param agent - freshly resumed, exclusively owned agent.
   * @param id - durable request identity shown on the card.
   * @param version - request event sequence shown on the card.
   * @param answer - complete answer, or null to dismiss the card without starting work.
   * @returns whether a new decision was recorded; identical retries return false.
   */
  decide(agent: Agent, id: UserQuestionId, version: number, answer: AskUserQuestionAnswer | null): boolean {
    this.assertSize(answer)
    const prior = agent.session.events.findLast(event =>
      event.type === 'user-questions/state' && event.data.decision?.id === id)?.data
    if (prior !== undefined) {
      const decision = (prior as UserQuestionState).decision
      if (decision?.version === version && isDeepStrictEqual(decision.answer, answer)) {
        const state = this.state(agent)
        const message = this.decisionMessage(decision)
        if (agent.status === 'idle' && answer !== null && state.pending === null && state.decision?.id === id
          && !agent.session.events.some(event => event.type === 'user/message' && event.data.id === message.id)) {
          agent.inbox.remove(message.id)
          agent.followup(message)
        }
        return false
      }
      throw new UserQuestionError('this question has already been answered differently', 'QUESTION_CONFLICT')
    }
    const pending = this.state(agent).pending
    if (pending === null || pending.id !== id || pending.version !== version) {
      throw new UserQuestionError('the question is no longer pending; refresh the conversation', 'QUESTION_STALE')
    }
    if (answer !== null) validateQuestionAnswer(pending.questions, answer)
    const review = pending.questions.length === 1 ? pending.questions[0] : undefined
    const item = answer?.answers[0]
    const approvedPlan = review?.intent?.kind === 'plan-review'
      && item?.selected.length === 1 && item.selected[0] === review.intent.approve
      && item.custom === undefined
    const decision: UserQuestionDecision = { id, version, messageId: MessageId(randomUUID()), answer, approvedPlan }
    agent.session.append('user-questions/state', {
      pending: null,
      decision,
    })
    if (answer !== null) agent.followup(this.decisionMessage(decision))
    return true
  }

  private decisionMessage(decision: UserQuestionDecision) {
    const text = decision.answer === null
      ? 'The user dismissed the pending question to discuss it. Wait for their next message.'
      : decision.approvedPlan
        ? 'The user approved the submitted plan. Carry out that plan.'
        : `The user answered the pending questions: ${JSON.stringify(decision.answer)}`
    return { ...createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'user-questions', form: 'notice', summary: text },
    }), id: decision.messageId }
  }

  private assertSize(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.maxRequestBytes) {
      throw new UserQuestionError('question or answer exceeds the configured byte limit', 'QUESTION_TOO_LARGE')
    }
  }

  /**
   * Ask the scoped answerer waterfall and wait for the user's answer.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
   *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
   *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
   *   that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    this.validate(request)
    const agent = request.agent
    const noAnswerer = () => Promise.reject(new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER',
    ))
    try {
      return await (agent === undefined
        ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
        : this.ctx.waterfall(
          scopeTarget(agent, agent),
          'user-questions/request',
          { ...request, agent },
          noAnswerer,
        ))
    } catch (error) {
      const restored = restoreUserQuestionError(error)
      if (restored instanceof UserQuestionError) throw restored
      if (request.signal?.aborted) throw abortedQuestion(error)
      throw restored
    }
  }

  private validate(request: AskUserQuestionRequest): void {
    if (request.signal?.aborted) {
      throw abortedQuestion()
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) {
      const agents = this.ctx.get('agents')
      if (agents === undefined || agents.get(agent.id) !== agent) {
        throw new UserQuestionError(
          'human interaction requires the exact live calling agent when an agent is supplied',
          'CALLER_NOT_LIVE')
      }
      if (!agents.roots().includes(agent)) {
        throw new UserQuestionError(
          'human interaction is unavailable while the calling agent is owned by another live agent; '
          + "include the unresolved question or decision in the child agent's final result",
          'DELEGATED_CALLER')
      }
    }
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
  }
}

export default UserQuestionService
