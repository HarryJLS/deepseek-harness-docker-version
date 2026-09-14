import { describe, expect, it } from 'vitest'
import type { SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '../src/index.ts'

const header: SessionFormatHeader = {
  version: 3, id: 'docker-owner', createdAt: 1, isSeeded: false, delegationDepth: 0, userId: 'alice',
}
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('Docker Session ownership', () => {
  it('preserves the owner through current header classification, encoding, and restoration', () => {
    const original = structuredClone({ header, events })
    const physical = sessionFormatCatalog.encodeCurrentHeader(header, 0)
    expect(physical).toMatchObject({ type: 'session', userId: 'alice' })
    expect(sessionFormatCatalog.readHeader(physical)).toMatchObject({ status: 'current', header })
    const restore = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })
    expect(restore.header).toEqual(header)
    for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    expect(restore.finish()).toEqual({ header, events, inheritedEventCount: 0 })
    expect({ header, events }).toEqual(original)
  })

  it.each(['', ' alice', 'alice ', 'a'.repeat(33), 1, null])('refuses invalid current owners (%j)', (userId) => {
    const physical = { type: 'session', ...header, userId }
    expect(sessionFormatCatalog.readHeader(physical)).toMatchObject({ status: 'malformed' })
    expect(() => sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' })).toThrow()
    if (typeof userId === 'string') {
      expect(() => sessionFormatCatalog.encodeCurrentHeader({ ...header, userId }, 0)).toThrow()
    }
  })

  it('classifies a future format before interpreting its ownership fields', () => {
    expect(sessionFormatCatalog.readHeader({ type: 'session', ...header, version: 99, userId: '' }))
      .toMatchObject({ status: 'unsupported' })
  })
})
