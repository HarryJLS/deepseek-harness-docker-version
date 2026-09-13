import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageMysql from '@deepseek-ai/dsh-storage-mysql'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import MysqlPersistence from '@deepseek-ai/dsh-session-persistence-mysql'
import WorkspaceRegistry from '../src/index.ts'

const url = process.env.DSH_TEST_MYSQL_URL

describe.skipIf(url === undefined)('shared workspace metadata', () => {
  const app = `workspace-test-${randomUUID()}`
  const roots: Context[] = []
  let directory: string
  let admin: mysql.Connection

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-shared-workspace-')))
    admin = await mysql.createConnection(url!)
    for (const worker of [922, 923]) {
      const ctx = new Context()
      roots.push(ctx)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageMysql, { url: url!, app, name: 'mysql', snowflakeWorkerId: worker })
      await ctx.plugin(StorageDomain, { backend: 'mysql' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(MysqlPersistence, {
        url: url!, app, snowflakeWorkerId: worker,
        execution: { leaseMs: 30000, renewIntervalMs: 5000, pollIntervalMs: 500 },
      })
      await ctx.plugin(WorkspaceRegistry)
    }
  })

  afterAll(async () => {
    await Promise.all(roots.map(ctx => ctx.fiber.dispose()))
    if (admin !== undefined) {
      for (const table of ['dsh_session_event', 'dsh_session', 'dsh_kv_record', 'dsh_kv_global', 'dsh_kv_unit']) {
        await admin.query(`DELETE FROM ${table} WHERE app = ?`, [app])
      }
      await admin.end()
    }
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('refreshes a workspace created on another node and serializes duplicate creation', async () => {
    const [left, right] = roots
    const results = await Promise.all([
      left!.workspaceRegistry.create(directory),
      right!.workspaceRegistry.create(directory),
    ])
    expect(results[0].id).toBe(results[1].id)
    await right!.workspaceRegistry.refresh()
    expect(right!.workspaceRegistry.get(results[0].id)?.path).toBe(directory)
    expect(right!.workspaceRegistry.list()).toHaveLength(1)
  })

  it('preserves simultaneous new workspaces and concurrent session attachments', async () => {
    const [left, right] = roots
    const a = join(directory, 'one')
    const b = join(directory, 'two')
    const common = await left!.workspaceRegistry.create(directory)
    await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })])
    await Promise.all([left!.workspaceRegistry.create(a), right!.workspaceRegistry.create(b)])
    await left!.workspaceRegistry.refresh()
    await right!.workspaceRegistry.refresh()
    expect(left!.workspaceRegistry.list()).toHaveLength(3)
    expect(right!.workspaceRegistry.list()).toHaveLength(3)
    const workspaceId = common.id
    const ids = await Promise.all(roots.map(async (ctx) => {
      const id = SessionId(randomUUID())
      const lease = await ctx.sessionPersistence.sharedExecution!.acquire(id)
      try {
        const session = ctx.sessions.create(id, { meta: { cwd: directory } })
        await ctx.sessionPersistence.ensureMaterialized(session)
        await ctx.workspaceRegistry.get(workspaceId)!.attachSession(id)
        return id
      } finally { await lease[Symbol.asyncDispose]() }
    }))
    await left!.workspaceRegistry.refresh()
    expect(new Set(left!.workspaceRegistry.get(workspaceId)!.sessionIds)).toEqual(new Set(ids))
  })
})
