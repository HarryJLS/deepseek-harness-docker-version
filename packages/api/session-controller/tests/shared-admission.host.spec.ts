import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionExecutionLease } from '@deepseek-ai/dsh-session-persistence'
import { createSessionTestRemote } from './test-remote.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const release = vi.fn(async () => {})
  const acquire = vi.fn(async (): Promise<SessionExecutionLease> => ({
    signal: new AbortController().signal,
    [Symbol.asyncDispose]: release,
  }))
  ctx.provide('sessionPersistence', { sharedExecution: { acquire } } as never)
  createSessionTestRemote(ctx, {
    cwd: '/tmp', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
  })
  return { ctx, acquire, release }
}

describe('shared Web admission', () => {
  it('reserves the generated agentId wire argument before an Agent lookup can run', async () => {
    const { ctx, acquire, release } = await bench()
    try {
      const id = SessionId('shared-command')
      const next = vi.fn(async () => {
        expect(acquire).toHaveBeenCalledExactlyOnceWith(id)
        return ['plan']
      })
      await expect(ctx.waterfall('api-gateway/invoke', {
        namespace: 'commands', method: 'list', args: { agentId: id },
      }, next)).resolves.toEqual(['plan'])
      expect(release).toHaveBeenCalledOnce()
      await ctx.waterfall('api-gateway/invoke', {
        namespace: 'session', method: 'modelCatalog', args: {},
      }, async () => null)
      expect(acquire).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('does not advertise an unpublished session before its creation request commits', async () => {
    const { ctx } = await bench()
    try {
      const added = vi.fn()
      ctx.on('api-session/added', added)
      ctx.sessions.create(SessionId('not-yet-committed'), { meta: { cwd: '/tmp' } })
      expect(added).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})
