import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import { currentUserId } from '@deepseek-ai/dsh-user-context'

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {} as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('Connection exact Fetch routes', () => {
  it('isolates concurrent trusted-header requests and rejects ambiguous identities', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((pluginCtx) => {
      new HostConnectionService(pluginCtx, [], {} as BrowserAuth, {
        allowAnyHost: true, requireAuth: false, userIdHeader: 'x-user-id',
      })
    })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionService
    connection.fetch.register({
      path: '/api/user', methods: ['GET'],
      fetch: async () => {
        await new Promise(resolve => setImmediate(resolve))
        return Response.json({ userId: currentUserId() })
      },
    })
    try {
      const shared = connection.createSharedFetchHandler('/api')
      const results = await Promise.all(['alice', 'bob', undefined].map(async (user) => {
        const response = await shared.fetch(new Request('http://host/api/user', {
          headers: user === undefined ? {} : { 'x-user-id': user },
        }))
        const body: unknown = await response.json()
        return body
      }))
      expect(results).toEqual([{ userId: 'alice' }, { userId: 'bob' }, { userId: '-' }])
      expect(connection.requestRejection({ headers: { host: 'host', 'x-user-id': ['alice', 'bob'] } })).toBe(403)
      expect(connection.requestRejection({ headers: { host: 'host', 'x-user-id': 'a'.repeat(33) } })).toBe(403)
    } finally { await fiber.dispose() }
  })

  it('dispatches owned methods and returns 404 for unclaimed requests', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const route = vi.fn(async (request: Request) =>
      Response.json({ query: new URL(request.url).searchParams.get('sessionId') }))
    const dispose = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET', 'HEAD'],
      fetch: route,
    })
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      'http://host/api/session.export?sessionId=session-1',
    ))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ query: 'session-1' })
    expect(route).toHaveBeenCalledOnce()
    const post = await shared.fetch(new Request('http://host/api/session.export', { method: 'POST' }))
    expect(post.status).toBe(404)

    await dispose()
    const withdrawn = await shared.fetch(new Request('http://host/api/session.export'))
    expect(withdrawn.status).toBe(404)
    await disposeFiber()
  })

  it('rejects invalid and duplicate registrations', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const fetch = async (): Promise<Response> => new Response()

    expect(() => connection.fetch.register({ path: '/outside', methods: ['GET'], fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: [], fetch }))
      .toThrow('declares no methods')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['GET', 'GET'], fetch,
    })).toThrow('repeats a method')
    const dispose = connection.fetch.register({
      path: '/api/session.export', methods: ['GET'], fetch,
    })
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
    })).toThrow('already registered')
    await dispose()
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
    })).not.toThrow()
    await disposeFiber()
  })
})
