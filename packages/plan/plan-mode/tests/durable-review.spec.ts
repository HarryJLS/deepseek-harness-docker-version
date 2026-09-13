import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestions, { type UserQuestionId } from '@deepseek-ai/dsh-user-questions'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import PlanMode, { foldPlanMode } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const roots: Context[] = []
const plan = '# Update the staged file\nReview `tmp/shared/proposal.txt` before upload.'

async function runtime(responses: ConstructorParameters<typeof MockAdapter>[0], seed?: readonly SessionEvent[]) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjections)
  await ctx.plugin(UserQuestions, { durable: true, maxRequestBytes: 4096 })
  await ctx.plugin(PlanMode, { section: 'Plan without executing changes.' })
  const model = new MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'], model)
  const handle = await ctx.agents.create({
    sessionId: SessionId('durable-review'),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...(seed === undefined ? {} : { seed: [...seed] }),
    meta: { cwd: '/tmp' },
  })
  return { ctx, agent: handle.agent, model }
}

async function pending() {
  const state = await runtime([toolCallResponse('plan-call', 'exit_plan_mode', { plan })])
  state.ctx.planMode.set(state.agent, true)
  state.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare a plan.' }], source: { kind: 'user' } }))
  await state.agent.whenIdle()
  const request = state.ctx.userQuestions.state(state.agent).pending
  expect(request).not.toBeNull()
  return { ...state, request: request! }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('durable plan review', () => {
  it('ends the requesting turn and records the original card without waiting for a browser', async () => {
    const { ctx, agent, request, model } = await pending()
    expect(agent.status).toBe('idle')
    expect(model.requests).toHaveLength(1)
    expect(request.questions[0]?.detail).toBe(plan)
    expect(agent.session.events.at(-1)?.type).toBe('turn/end')
    expect(ctx.sessionProjections.snapshot(agent.session).values.userQuestions?.pending).toEqual(request)
    expect(foldPlanMode(agent.session.events)).toBe(true)
    const write = vi.fn(async () => [{ type: 'text' as const, text: 'written' }])
    ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'Write', parameters: {}, execute: write }))
    const result = await ctx.tools.execute({
      name: 'write', callId: ToolCallId('later-call'), arguments: {}, agent, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(write).not.toHaveBeenCalled()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run before confirmation.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  })

  it('reconstructs the card on another runtime and executes an approved continuation once', async () => {
    const original = await pending()
    const { ctx, agent, model } = await runtime([textResponse('Applied the approved plan.')], original.agent.session.events)
    const { id, version } = original.request
    const answer = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
    expect(ctx.userQuestions.decide(agent, id, version, answer)).toBe(true)
    expect(ctx.userQuestions.decide(agent, id, version, answer)).toBe(false)
    await agent.whenIdle()
    expect(foldPlanMode(agent.session.events)).toBe(false)
    expect(ctx.userQuestions.state(agent).pending).toBeNull()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.system).not.toContain('Plan without executing changes.')
    expect(JSON.stringify(model.requests[0]?.messages)).toContain('The user approved the submitted plan.')
    expect(ctx.userQuestions.decide(agent, id, version, answer)).toBe(false)
    await agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(() => ctx.userQuestions.decide(agent, id, version, null)).toThrow('already been answered')
  })

  it('rejects stale versions, unrelated identities, and choices the card did not offer', async () => {
    const { ctx, agent, request } = await pending()
    expect(() => ctx.userQuestions.decide(agent, request.id, request.version + 1, null)).toThrow('no longer pending')
    expect(() => ctx.userQuestions.decide(agent, 'other' as UserQuestionId, request.version, null)).toThrow('no longer pending')
    for (const answers of [
      [],
      [{ id: 'wrong', selected: ['Approve'] }],
      [{ id: 'plan-review', selected: ['Approve', 'Keep planning'] }],
      [{ id: 'plan-review', selected: ['Unlisted choice'] }],
    ]) {
      expect(() => ctx.userQuestions.decide(agent, request.id, request.version, { answers })).toThrow()
    }
    expect(ctx.userQuestions.state(agent).pending?.id).toBe(request.id)
  })

  it('keeps planning after rejection and assigns a new identity to the revised card', async () => {
    const original = await pending()
    const { ctx, agent, model } = await runtime([
      toolCallResponse('revised-call', 'exit_plan_mode', { plan: '# Revised plan\nApply the feedback.' }),
    ], original.agent.session.events)
    const { id, version } = original.request
    ctx.userQuestions.decide(agent, id, version, {
      answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'Change the second step.' }],
    })
    await agent.whenIdle()
    expect(foldPlanMode(agent.session.events)).toBe(true)
    expect(ctx.userQuestions.state(agent).pending?.id).not.toBe(id)
    expect(JSON.stringify(model.requests[0]?.messages)).toContain('Change the second step.')
    expect(ctx.userQuestions.decide(agent, id, version, {
      answers: [{ custom: 'Change the second step.', selected: ['Keep planning'], id: 'plan-review' }],
    })).toBe(false)
  })

  it('dismisses without starting work and logs the dismissal when discussion resumes', async () => {
    const original = await pending()
    const { ctx, agent, model } = await runtime([textResponse('Discussed the change.')], original.agent.session.events)
    ctx.userQuestions.decide(agent, original.request.id, original.request.version, null)
    expect(model.requests).toHaveLength(0)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain the second step.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(JSON.stringify(model.requests[0]?.messages)).toContain('dismissed the pending question')
    expect(foldPlanMode(agent.session.events)).toBe(true)
  })

  it('rejects oversized questions before recording a pending state', async () => {
    const { ctx, agent } = await runtime([])
    await expect(ctx.userQuestions.request({
      agent, questions: [{ id: 'large', question: 'x'.repeat(5000) }],
    }, ToolCallId('large-call'))).rejects.toMatchObject({ code: 'QUESTION_TOO_LARGE' })
    expect(ctx.userQuestions.state(agent).pending).toBeNull()
  })

  it('rejects an agentless request and duplicate question ids before recording', async () => {
    const { ctx, agent } = await runtime([])
    await expect(ctx.userQuestions.request({
      questions: [{ id: 'q', question: 'Continue?' }],
    }, ToolCallId('no-agent'))).rejects.toMatchObject({ code: 'CALLER_NOT_LIVE' })
    await expect(ctx.userQuestions.request({
      agent, questions: [{ id: 'q', question: 'One?' }, { id: 'q', question: 'Two?' }],
    }, ToolCallId('duplicates'))).rejects.toMatchObject({ code: 'BAD_QUESTIONS' })
    expect(ctx.userQuestions.state(agent).pending).toBeNull()
  })

  it('keeps an unanswered request when another question or an oversized answer arrives', async () => {
    const { ctx, agent, request } = await pending()
    await expect(ctx.userQuestions.request({
      agent, questions: [{ id: 'later', question: 'Another question?' }],
    }, ToolCallId('later'))).rejects.toMatchObject({ code: 'QUESTION_PENDING' })
    expect(() => ctx.userQuestions.decide(agent, request.id, request.version, {
      answers: [{ id: 'plan-review', selected: [], custom: 'x'.repeat(5000) }],
    })).toThrow('byte limit')
    expect(ctx.userQuestions.state(agent).pending?.id).toBe(request.id)
  })

  it('resumes an acknowledged decision whose input was not admitted before a crash', async () => {
    const original = await pending()
    const first = await runtime([textResponse('First execution.')], original.agent.session.events)
    const answer = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
    first.ctx.userQuestions.decide(first.agent, original.request.id, original.request.version, answer)
    const decision = first.agent.session.events.findLast(event =>
      event.type === 'user-questions/state' && event.data.decision !== null)!
    await first.agent.whenIdle()
    const recovered = await runtime([textResponse('Recovered execution.')], first.agent.session.events.slice(0, decision.seq + 1))
    expect(recovered.ctx.userQuestions.decide(recovered.agent, original.request.id, original.request.version, answer)).toBe(false)
    await recovered.agent.whenIdle()
    expect(recovered.model.requests).toHaveLength(1)
    expect(recovered.agent.session.events.filter(event =>
      event.type === 'user-questions/state' && event.data.decision !== null)).toHaveLength(1)
  })
})
