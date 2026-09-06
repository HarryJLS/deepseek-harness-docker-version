import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseUserId, userScopedIterable, withUser } from '@deepseek-ai/dsh-user-context'
import { describe, expect, it } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const alice = parseUserId('alice')
const bob = parseUserId('bob')

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: '/tmp',
  })
  return { ctx, controller }
}

describe('platform session ownership', () => {
  it('filters live lists and control baselines, with missing user information assigned to -', async () => {
    const { ctx, controller } = await harness()
    try {
      ctx.sessions.create(SessionId('alice-live'), { meta: { cwd: '/tmp', userId: alice } })
      ctx.sessions.create(SessionId('bob-live'), { meta: { cwd: '/tmp', userId: bob } })
      ctx.sessions.create(SessionId('anonymous-live'), { meta: { cwd: '/tmp' } })
      const actual: Record<string, string[]> = {}
      for (const user of [alice, bob, parseUserId(undefined)]) {
        actual[user] = await withUser(user, async () => {
          const result = await controller.list({}, new AbortController().signal)
          return result.items.map(item => item.sessionId)
        })
        await withUser(user, async () => {
          const abort = new AbortController()
          const iterator = controller.control(abort.signal)[Symbol.asyncIterator]()
          const first = await iterator.next()
          if (first.done || first.value.type !== 'baseline') throw new Error('expected control baseline')
          expect(Object.keys(first.value.value.queues)).toEqual(actual[user])
          abort.abort()
          await iterator.return?.()
        })
      }
      expect(actual).toMatchInlineSnapshot(`
        {
          "-": [
            "anonymous-live",
          ],
          "alice": [
            "alice-live",
          ],
          "bob": [
            "bob-live",
          ],
        }
      `)
    } finally { await ctx.fiber.dispose() }
  })

  it('denies direct reads, history streams, mutation and explicit-id adoption of another live user session', async () => {
    const { ctx, controller } = await harness()
    try {
      const id = SessionId('private-live')
      ctx.sessions.create(id, { meta: { cwd: '/tmp', userId: alice } })
      await withUser(bob, async () => {
        expect(() => controller.inspect(id)).toThrow('not found')
        await expect(controller.page({ address: { kind: 'session', sessionId: id }, throughSeq: -1 }, new AbortController().signal))
          .rejects.toMatchObject({ failure: { code: 'session-not-found' } })
        const iterator = controller.follow({ address: { kind: 'session', sessionId: id } }, new AbortController().signal)[Symbol.asyncIterator]()
        await expect(iterator.next()).rejects.toMatchObject({ failure: { code: 'session-not-found' } })
        await expect(controller.create({ sessionId: id, cwd: '/tmp' })).rejects.toMatchObject({ failure: { code: 'session-not-found' } })
        await expect(controller.resolveAgent(id)).resolves.toMatchObject({ error: { code: 'session-not-found' } })
        expect(() => controller.cancel({ sessionId: id })).toThrow('not found')
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a cold ownership mismatch even when persistence returns a cached inspection', async () => {
    const { ctx, controller } = await harness()
    const header: SessionHeader = { id: SessionId('private-cold'), version: 0, createdAt: 1, cwd: '/tmp', userId: alice }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header],
      inspect: async () => ({ meta: header, events: [] }),
    }) as never)
    try {
      await withUser(bob, async () => {
        expect((await controller.list({}, new AbortController().signal)).items).toEqual([])
        await expect(controller.inspect(header.id)).rejects.toThrow('not found')
        await expect(controller.create({ sessionId: header.id, cwd: '/tmp' }))
          .rejects.toMatchObject({ failure: { code: 'session-not-found' } })
      })
      await withUser(alice, async () => {
        expect((await controller.inspect(header.id)).meta.userId).toBe(alice)
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('retains a follower user while other users append concurrently', async () => {
    const { ctx, controller } = await harness()
    const a = ctx.sessions.create(SessionId('alice-events'), { meta: { cwd: '/tmp', userId: alice } })
    const b = ctx.sessions.create(SessionId('bob-events'), { meta: { cwd: '/tmp', userId: bob } })
    const abort = new AbortController()
    const stream = withUser(alice, () => userScopedIterable(controller.control(abort.signal)))
    const iterator = stream[Symbol.asyncIterator]()
    try {
      await iterator.next()
      b.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'private bob content' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      a.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'alice content' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const frame = await iterator.next()
      expect(frame.value).toMatchObject({ type: 'projection', sessionId: a.id })
      expect(JSON.stringify(frame.value)).not.toContain('private bob content')
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })
})
