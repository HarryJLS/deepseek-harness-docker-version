import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserQuestionState } from '@deepseek-ai/dsh-user-questions/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PendingQuestion } from '../src/client/contract/slots.ts'
import { observeDurableQuestions } from '../src/client/durable.ts'

const sid = 'shared-question' as SessionId

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function bench() {
  const ctx = new Context()
  const selection = observable<{ current: SessionId | undefined }>({ current: sid })
  const state = observable<UserQuestionState | undefined>(undefined)
  const cards = new Set<PendingQuestion>()
  const delegates = new Map<PendingQuestion, () => Promise<void>>()
  const answerQuestion = vi.fn<(_request: unknown) => Promise<RemoteResult<{ accepted: true; duplicate: boolean }>>>(
    async () => ({ ok: true, value: { accepted: true, duplicate: false } }),
  )
  const binding = vi.fn(() => ({ session: { projections: { faceOf: () => state } } }))
  ctx.provide('sessions', {
    list: selection,
    binding,
  } as never)
  ctx.provide('remote', { session: { answerQuestion } } as never)
  const stop = observeDurableQuestions(ctx, (card, delegate) => {
    cards.add(card)
    delegates.set(card, delegate)
    return () => { cards.delete(card); delegates.delete(card) }
  })
  const pending = {
    id: 'durable-id', version: 12, callId: 'tool-call',
    questions: [{
      id: 'plan-review', question: 'Approve?', detail: '# Plan',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  } as UserQuestionState['pending']
  return { ctx, selection, state, cards, delegates, binding, answerQuestion, pending, stop }
}

describe('durable question presentation', () => {
  it('restores the same card from a projection and sends its session, identity and version', async () => {
    const b = bench()
    b.state.set({ pending: b.pending, decision: null })
    const card = [...b.cards][0]!
    expect(card.kind).toBe('plan-review')
    expect(card.questions[0]?.detail).toBe('# Plan')
    b.state.set({ pending: b.pending, decision: null })
    expect([...b.cards][0]).toBe(card)
    b.selection.set({ current: sid })
    expect([...b.cards][0]).toBe(card)
    const answer = { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
    await card.answer(answer)
    expect(b.answerQuestion).toHaveBeenCalledExactlyOnceWith({
      sessionId: sid, id: 'durable-id', version: 12, answer,
    })
    expect(b.cards.size).toBe(0)
    b.stop()
  })

  it('keeps the card answerable after a failed receipt and dismisses through the same endpoint', async () => {
    const b = bench()
    b.state.set({ pending: b.pending, decision: null })
    const card = [...b.cards][0]!
    b.answerQuestion.mockRejectedValueOnce(new Error('Network unavailable'))
    await expect(card.cancel()).rejects.toThrow('Network unavailable')
    expect([...b.cards][0]).toBe(card)
    await card.cancel()
    expect(b.answerQuestion).toHaveBeenLastCalledWith({
      sessionId: sid, id: 'durable-id', version: 12, answer: null,
    })
    b.stop()
  })

  it('unsubscribes on navigation without cancelling the stored question and restores it on return', () => {
    const b = bench()
    b.state.set({ pending: b.pending, decision: null })
    const key = [...b.cards][0]!.key
    b.selection.set({ current: undefined })
    expect(b.cards.size).toBe(0)
    expect(b.answerQuestion).not.toHaveBeenCalled()
    b.selection.set({ current: sid })
    expect([...b.cards][0]!.key).toBe(key)
    b.state.set({ pending: null, decision: null })
    expect(b.cards.size).toBe(0)
    b.stop()
  })

  it('retains a newer question when an older submission finishes and surfaces rejected receipts', async () => {
    const b = bench()
    b.state.set({ pending: b.pending, decision: null })
    const card = [...b.cards][0]!
    b.answerQuestion.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/agent-busy', 'Retry later', { reason: 'busy' }),
    })
    await expect(card.cancel()).rejects.toThrow('Retry later')
    const waiting = Promise.withResolvers<RemoteResult<{ accepted: true; duplicate: boolean }>>()
    b.answerQuestion.mockReturnValueOnce(waiting.promise)
    const submitted = card.answer({ answers: [{ id: 'plan-review', selected: ['Approve'] }] })
    b.state.set({
      pending: { ...b.pending!, id: 'replacement' as NonNullable<typeof b.pending>['id'], version: 20 },
      decision: null,
    })
    const replacement = [...b.cards][0]!
    waiting.resolve({ ok: true, value: { accepted: true, duplicate: false } })
    await submitted
    expect([...b.cards][0]).toBe(replacement)
    await b.delegates.get(replacement)!()
    b.stop()
  })

  it('waits for a selected session binding before observing its projection', () => {
    const b = bench()
    b.selection.set({ current: undefined })
    b.binding.mockReturnValueOnce(undefined as never)
    b.selection.set({ current: sid })
    expect(b.cards.size).toBe(0)
    b.selection.set({ current: sid })
    b.state.set({ pending: b.pending, decision: null })
    expect(b.cards.size).toBe(1)
    b.stop()
  })
})
