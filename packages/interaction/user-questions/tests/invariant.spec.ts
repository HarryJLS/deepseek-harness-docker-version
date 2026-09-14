import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import Invariants from '@deepseek-ai/dsh-invariants'
import type { UserQuestionId, UserQuestionState } from '../src/types.ts'
import * as companion from '../src/invariant.ts'

const roots: Context[] = []
const requestId = 'question' as UserQuestionId

function pending(review = true): UserQuestionState {
  return {
    pending: {
      id: requestId, version: 0, callId: ToolCallId('plan-call'),
      questions: [{
        id: 'review', question: 'Approve?', detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Reject' }],
        ...(review ? { intent: { kind: 'plan-review' as const, approve: 'Approve' } } : {}),
      }],
    },
    decision: null,
  }
}

function decided(answer: 'Approve' | 'Reject' | null = 'Approve', approvedPlan = answer === 'Approve'): UserQuestionState {
  return {
    pending: null,
    decision: {
      id: requestId, version: 0, messageId: MessageId('decision-input'), approvedPlan,
      answer: answer === null ? null : { answers: [{ id: 'review', selected: [answer] }] },
    },
  }
}

function event(seq: number, data: UserQuestionState): SessionEvent {
  return { type: 'user-questions/state', seq: SessionSeq(seq), time: seq, data }
}

async function setup(mount = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Invariants, { enabled: true })
  if (mount) await ctx.plugin(companion)
  return ctx
}

afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('durable question invariants', () => {
  it.each(['Approve', 'Reject', null] as const)('pairs a request with the offered outcome %s', async (answer) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      ctx.emit('session/event', session, event(0, pending()))
      ctx.emit('session/event', session, event(1, decided(answer)))
    }).not.toThrow()
  })

  it('validates existing and newly published logs and ignores unrelated events', async () => {
    const ctx = await setup(false)
    const existing = ctx.sessions.create()
    existing.append('user-questions/state', pending())
    existing.append('user-questions/state', decided())
    await ctx.plugin(companion)
    const seed = Session.create(SessionId('seeded'), existing.snapshotEvents())
    expect(() =>{  ctx.emit('session/created', seed) }).not.toThrow()
    expect(() =>{  ctx.emit('session/event', seed, {
      type: 'plan/mode', seq: SessionSeq(2), time: 2, data: { active: false },
    }) }).not.toThrow()
    expect(() =>{  ctx.emit('session/event', seed, event(3, { pending: null, decision: null })) }).not.toThrow()
  })

  it('rejects malformed stored state, incorrect versions and overlapping requests', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('invalid'))
    expect(() =>{  ctx.emit('session/event', session, event(0, {} as UserQuestionState)) }).toThrow('malformed')
    expect(() =>{  ctx.emit('session/event', session, event(1, pending())) }).toThrow('own version')
    ctx.emit('session/event', session, event(0, pending()))
    const overlap = pending()
    overlap.pending!.version = 1
    expect(() =>{  ctx.emit('session/event', session, event(1, overlap)) }).toThrow('unanswered predecessor')
  })

  it('rejects a decision without its matching request or with a changed request identity', async () => {
    const ctx = await setup()
    const missing = Session.create(SessionId('missing-request'))
    expect(() =>{  ctx.emit('session/event', missing, event(1, decided())) }).toThrow('exact pending')
    for (const mismatch of ['id', 'version'] as const) {
      const session = Session.create(SessionId(mismatch))
      ctx.emit('session/event', session, event(0, pending()))
      const value = decided()
      if (mismatch === 'id') value.decision!.id = 'other' as UserQuestionId
      else value.decision!.version = 2
      expect(() =>{  ctx.emit('session/event', session, event(1, value)) }).toThrow('exact pending')
    }
  })

  it('rejects unoffered choices and an approval bit that disagrees with the actual answer', async () => {
    const ctx = await setup()
    const first = Session.create(SessionId('unoffered'))
    ctx.emit('session/event', first, event(0, pending()))
    const invalid = decided('Reject', false)
    invalid.decision!.answer!.answers[0]!.selected = ['Unknown']
    expect(() =>{  ctx.emit('session/event', first, event(1, invalid)) }).toThrow('not offered')
    const second = Session.create(SessionId('wrong-approval'))
    ctx.emit('session/event', second, event(0, pending()))
    expect(() =>{  ctx.emit('session/event', second, event(1, decided('Reject', true))) }).toThrow('approval choice')
  })

  it('does not interpret generic or multi-question answers as plan approval', async () => {
    const ctx = await setup()
    for (const multiple of [false, true]) {
      const session = Session.create(SessionId(String(multiple)))
      const state = pending(false)
      if (multiple) state.pending!.questions.push({ id: 'second', question: 'Anything else?' })
      ctx.emit('session/event', session, event(0, state))
      const value = decided('Approve', false)
      if (multiple) value.decision!.answer!.answers.push({ id: 'second', selected: [] })
      expect(() =>{  ctx.emit('session/event', session, event(1, value)) }).not.toThrow()
    }
  })
})
