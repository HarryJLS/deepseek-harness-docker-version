import { describe, expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { parseUserId } from '@deepseek-ai/dsh-user-context'
import {
  decodeStoredSession,
  encodeStoredEvent,
  encodeStoredHeader,
} from '../src/session-format.ts'

const id = SessionId('format-session')
const owner = parseUserId('alice')

describe('OceanBase stable Session format adapter', () => {
  it('translates a released V0 database row into the current logical format', () => {
    const decoded = decodeStoredSession(
      {
        type: 'session',
        version: 0,
        id,
        createdAt: 1,
        delegationDepth: 0,
      },
      id,
      owner,
      [{ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }],
    )

    expect(decoded.meta).toMatchObject({ id, userId: owner, version: 3 })
    expect(decoded.events).toEqual([{ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }])
    expect(decoded.inheritedEventCount).toBe(0)
  })

  it('converts legacy V0 message identities before the result reaches the provider', () => {
    const decoded = decodeStoredSession(
      {
        type: 'session',
        version: 0,
        id,
        createdAt: 1,
        delegationDepth: 0,
      },
      id,
      owner,
      [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        {
          type: 'user/message',
          seq: 2,
          time: 3,
          data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
          surfaceOp: 'append',
        },
        {
          type: 'assistant/message',
          seq: 3,
          time: 4,
          data: {
            turn: 1,
            step: 1,
            content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
            provenance: { provider: 'mock', model: 'mock' },
          },
          surfaceOp: 'append',
        },
        { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
        {
          type: 'tool/result',
          seq: 5,
          time: 6,
          data: { turn: 1, step: 1, callId: 'call-1', content: [{ type: 'text', text: 'full' }], isError: false },
          sourceEventSeqs: [4],
          surfaceOp: 'append',
        },
        { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    )

    expect(decoded.meta.version).toBe(3)
    expect(decoded.events.find(event => event.type === 'user/message')).toMatchObject({
      type: 'user/message',
      data: { id: `legacy-message:${id}:2`, role: 'user' },
    })
    expect(decoded.events.find(event => event.type === 'assistant/message')).toMatchObject({
      type: 'assistant/message',
      data: { message: { id: `legacy-message:${id}:3`, role: 'assistant' } },
    })
    expect(decoded.events.find(event => event.type === 'tool/result')).toMatchObject({
      type: 'tool/result',
      data: { message: { id: `legacy-message:${id}:5`, role: 'user' } },
    })
  })

  it('writes and reads only the installed current physical representation', () => {
    const header: SessionHeader = {
      id,
      userId: owner,
      version: 3,
      createdAt: 1,
      isSeeded: false,
    }
    const event = { type: 'turn/start' as const, seq: SessionSeq(0), time: 2, data: { turn: 1 } }
    const storedHeader = encodeStoredHeader(header, SessionLogOffset(0))
    const storedEvent = encodeStoredEvent(event)
    const decoded = decodeStoredSession(storedHeader, id, owner, [storedEvent])

    expect(storedHeader).toMatchObject({ type: 'session', version: 3, inheritedEventCount: 0, userId: owner })
    expect(decoded.meta).toEqual(header)
    expect(decoded.events).toEqual([event])
  })

  it('keeps SQL sidecar lineage while decoding a seeded current-format log', () => {
    const header: SessionHeader = {
      id,
      userId: owner,
      version: 3,
      createdAt: 1,
      isSeeded: true,
      parentSession: SessionId('parent'),
    }
    const events = [{ type: 'turn/start' as const, seq: SessionSeq(0), time: 2, data: { turn: 1 } }]
    const decoded = decodeStoredSession(
      encodeStoredHeader(header, SessionLogOffset(1)),
      id,
      owner,
      events.map(encodeStoredEvent),
    )

    expect(decoded.meta).toEqual(header)
    expect(decoded.inheritedEventCount).toBe(1)
    expect(decoded.events).toEqual(events)
  })

  it('refuses a future database format instead of interpreting its fields', () => {
    expect(() => decodeStoredSession(
      { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
      id,
      owner,
      [],
    )).toThrow(/reads only v3/)
  })
})
