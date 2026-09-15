import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseUserId } from '@deepseek-ai/dsh-user-context/identity'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import JsonlSessionPersistence from '../src/index.ts'

describe('Docker ownership in current JSONL', () => {
  it('preserves the platform owner through header encoding, listing, and a fresh read open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v3-owner-'))
    const first = new Context()
    const second = new Context()
    const id = SessionId('owned-jsonl')
    const userId = parseUserId('alice')
    try {
      await first.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await using writer = await first.sessionPersistence.create({
        id, userId, version: 3, createdAt: 1, isSeeded: false, cwd: root,
      })
      await writer.append([
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ])
      await writer.close()
      await first.fiber.dispose()
      await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      expect((await second.sessionPersistence.stat(id))?.header.userId).toBe(userId)
      expect((await second.sessionPersistence.list())[0]?.header.userId).toBe(userId)
      await using reader = await second.sessionPersistence.open(id, 'read')
      expect(reader.header.userId).toBe(userId)
      expect((await reader.read()).events).toHaveLength(2)
    } finally {
      await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
      await rm(root, { recursive: true, force: true })
    }
  })
})
