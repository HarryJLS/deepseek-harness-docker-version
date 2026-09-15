/** Request-scoped Web agent ownership over a shared persistence provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApiSessionAgentController } from './agent.ts'

/** Keeps a reservation through one agent activity and releases the local lifecycle afterward. */
export class SessionExecutionController {
  private readonly tasks = new Set<Promise<void>>()

  /**
   * @param ctx - session API context and shared persistence provider.
   * @param agents - owner of created/resumed agent handles.
   */
  constructor(private readonly ctx: Context, private readonly agents: ApiSessionAgentController) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      const execution = this.ctx.get('sessionPersistence')?.sharedExecution
      if (execution !== undefined) {
        await execution.assertOwned(agent.id)
        await this.ctx.parallel('session/flush', agent.session)
      }
      return decision
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const execution = this.ctx.get('sessionPersistence')?.sharedExecution
      if (execution !== undefined && exec.agent !== undefined) await execution.assertOwned(exec.agent.id)
      return decision
    })
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.tasks])
    }, 'session-controller.shared-execution')
  }

  /**
   * Run an API operation against the latest session, then retain ownership until execution stops.
   * @param id - session identity.
   * @param operation - create, resume, or mutate this session under exclusive ownership.
   * @returns its durably acknowledged result, without waiting for an admitted model turn.
   */
  async run<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    const persistence = this.ctx.get('sessionPersistence')
    const shared = persistence?.sharedExecution
    if (persistence === undefined || shared === undefined) return operation()
    const { SessionPersistenceNotFoundError } = await import('@deepseek-ai/dsh-session-persistence')
    let lease
    try {
      lease = await shared.acquire(id)
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: id })
      }
      throw new RemoteError(
        'session/agent-busy',
        error instanceof Error ? error.message : String(error),
        { reason: 'shared execution reservation unavailable' },
      )
    }
    const cancel = (): void => {
      this.ctx.agents.get(id)?.cancel({ kind: 'user' }, { keepInbox: true })
    }
    lease.signal.addEventListener('abort', cancel, { once: true })
    const finish = async (): Promise<void> => {
      try {
        const agent = this.ctx.agents.get(id)
        if (agent !== undefined) {
          await agent.whenIdle()
          await this.ctx.parallel('session/flush', agent.session)
        }
      } finally {
        try {
          await this.agents.release(id)
        } finally {
          lease.signal.removeEventListener('abort', cancel)
          await lease[Symbol.asyncDispose]()
        }
      }
    }
    try {
      const result = await operation()
      lease.signal.throwIfAborted()
      const session = this.ctx.sessions.get(id)
      if (session !== undefined) {
        await this.ctx.parallel('session/flush', session)
      }
      const agent = this.ctx.agents.get(id)
      if (agent?.status === 'running') {
        const task = finish().catch((error: unknown) => {
          this.ctx.logger.error('session-controller: shared execution %s failed: %s', id, String(error))
        })
        this.tasks.add(task)
        void task.then(() => { this.tasks.delete(task) })
      } else {
        await finish()
      }
      return result
    } catch (error) {
      cancel()
      await finish().catch((cleanup: unknown) => {
        this.ctx.logger.warn('session-controller: execution cleanup failed: %s', String(cleanup))
      })
      throw error
    }
  }
}
