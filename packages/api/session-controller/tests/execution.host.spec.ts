import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionExecutionController } from '../src/execution.ts'

const roots: Context[] = []
const id = SessionId('execution-test')

async function bench(shared = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(id)
  const agent = {
    id, session, ctx, status: 'idle' as 'idle' | 'running',
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  ctx.agents.register(agent as unknown as Agent)
  const abort = new AbortController()
  const releaseLease = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ signal: abort.signal, [Symbol.asyncDispose]: releaseLease }))
  const assertOwned = vi.fn(async () => {})
  const ensureMaterialized = vi.fn(async () => {})
  ctx.provide('sessionPersistence', {
    ...(shared ? { sharedExecution: { acquire, assertOwned } } : {}),
    ensureMaterialized,
  } as never)
  const flush = vi.fn(async () => {})
  ctx.on('session/flush', flush)
  const release = vi.fn(async () => {})
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const controller = new SessionExecutionController(ctx, { release } as unknown as ApiSessionAgentController)
  return { ctx, controller, agent, abort, acquire, assertOwned, releaseLease, release, flush, ensureMaterialized, warn, error }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

describe('request-scoped session execution', () => {
  it('leaves process-local execution unchanged', async () => {
    const b = await bench(false)
    await expect(b.controller.run(id, async () => 'local')).resolves.toBe('local')
    expect(b.acquire).not.toHaveBeenCalled()
    expect(b.release).not.toHaveBeenCalled()
  })

  it('materializes and flushes before returning and releases idle lifecycles', async () => {
    const b = await bench()
    await expect(b.controller.run(id, async () => 'committed')).resolves.toBe('committed')
    expect(b.ensureMaterialized).toHaveBeenCalledWith(b.agent.session)
    expect(b.flush).toHaveBeenCalledTimes(2)
    expect(b.release).toHaveBeenCalledWith(id)
    expect(b.releaseLease).toHaveBeenCalledOnce()
  })

  it.each([new Error('busy'), 'offline'])('returns a stable admission failure without running work: %s', async (reason) => {
    const b = await bench()
    b.acquire.mockRejectedValueOnce(reason)
    const operation = vi.fn(async () => {})
    await expect(b.controller.run(id, operation)).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    expect(operation).not.toHaveBeenCalled()
    expect(b.releaseLease).not.toHaveBeenCalled()
  })

  it('keeps ownership until admitted background work becomes idle', async () => {
    const b = await bench()
    const idle = Promise.withResolvers<undefined>()
    b.agent.status = 'running'
    b.agent.whenIdle.mockImplementation(() => idle.promise)
    await expect(b.controller.run(id, async () => 'accepted')).resolves.toBe('accepted')
    expect(b.releaseLease).not.toHaveBeenCalled()
    b.abort.abort(new Error('cancel requested'))
    expect(b.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    idle.resolve(undefined)
    await b.ctx.fiber.dispose()
    expect(b.releaseLease).toHaveBeenCalledOnce()
  })

  it('contains a background failure and still releases its reservation', async () => {
    const b = await bench()
    b.agent.status = 'running'
    b.agent.whenIdle.mockRejectedValueOnce(new Error('driver failed'))
    await b.controller.run(id, async () => 'accepted')
    await b.ctx.fiber.dispose()
    expect(b.error).toHaveBeenCalled()
    expect(b.releaseLease).toHaveBeenCalledOnce()
  })

  it('cancels rejected work and preserves the original error when cleanup fails', async () => {
    const b = await bench()
    b.release.mockRejectedValue(new Error('teardown failed'))
    await expect(b.controller.run(id, async () => { throw new Error('operation failed') }))
      .rejects.toThrow('operation failed')
    expect(b.agent.cancel).toHaveBeenCalled()
    expect(b.warn).toHaveBeenCalled()
    expect(b.releaseLease).toHaveBeenCalledOnce()
  })

  it('does not acknowledge work after its lease aborts', async () => {
    const b = await bench()
    await expect(b.controller.run(id, async () => {
      b.abort.abort(new Error('ownership expired'))
      return 'unacknowledged'
    })).rejects.toThrow('ownership expired')
    expect(b.ensureMaterialized).not.toHaveBeenCalled()
    expect(b.releaseLease).toHaveBeenCalledOnce()
  })

  it.each([true, false])('delegates model and tool admission with shared execution %s', async (shared) => {
    const b = await bench(shared)
    const agent = b.agent as unknown as Agent
    const signal = new AbortController().signal
    const decision = { kind: 'enter' as const, messages: [] }
    await expect(b.ctx.waterfall('agent/pre-step', {
      agent, turn: 1, step: 1, signal, messages: [],
    }, async () => decision)).resolves.toEqual(decision)
    const allowed = { kind: 'allow' as const }
    await expect(b.ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('call'), name: 'read', arguments: {}, agent, signal,
      rootCallId: ToolCallId('call'),
      token: Symbol('execution') as ToolExecutionToken,
    }, async () => allowed)).resolves.toEqual(allowed)
    expect(b.assertOwned).toHaveBeenCalledTimes(shared ? 2 : 0)
    expect(b.flush).toHaveBeenCalledTimes(shared ? 1 : 0)
  })
})
