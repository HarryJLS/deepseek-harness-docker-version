import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SessionHistoryController } from '../src/history.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/shared-late': number
  }
  interface SessionProjectionStateMap {
    'test/shared-late': number
  }
}

afterEach(() => { vi.useRealTimers() })

describe('shared history projections', () => {
  it('rebuilds newly registered units and removes unloaded units without requiring another log event', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(SessionProjections)
    const id = SessionId('shared-history')
    const meta: SessionHeader = { id, version: 0, cwd: '/tmp', createdAt: 0 }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'plan/mode', seq: 2, time: 2, data: { active: true } },
    ]
    const readFrom = vi.fn(async (_id: SessionId, from: number) => ({ meta, events: events.slice(from) }))
    ctx.provide('sessionPersistence', {
      readFrom, sharedExecution: { pollIntervalMs: 100, active: async () => false },
    } as never)
    const history = new SessionHistoryController(ctx, () => { throw new Error('read-only history must not activate') })
    const abort = new AbortController()
    const stream = history.follow({ address: { kind: 'session', sessionId: id } }, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'snapshot', cursor: 2 })
      expect((await stream.next()).value).toMatchObject({ type: 'state', projections: { values: {} } })
      const remove = ctx.sessionProjections.register({
        key: 'test/shared-late', stateVersion: 1, stateSchema: z.number(),
        init: () => 0, apply: value => value + 1,
        wire: { viewSchema: z.number(), view: value => value },
      })
      const updated = stream.next()
      await vi.advanceTimersByTimeAsync(100)
      expect((await updated).value).toMatchObject({
        type: 'state', projections: { asOfSeq: 2, values: { 'test/shared-late': 3 } },
      })
      expect(readFrom.mock.calls.filter(([, from]) => from === 0)).toHaveLength(2)
      remove()
      const cleared = stream.next()
      await vi.advanceTimersByTimeAsync(100)
      expect((await cleared).value).toMatchObject({ type: 'state', projections: { values: {} } })
      const closing = stream.next()
      await ctx.fiber.dispose()
      expect((await closing).done).toBe(true)
    } finally {
      abort.abort()
      await stream.return?.()
      await ctx.fiber.dispose()
    }
  })
})
