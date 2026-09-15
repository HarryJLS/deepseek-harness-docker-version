import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionAssistantStreamBaseline } from '../src/types.ts'
import { SharedAssistantFollower, SharedAssistantPublication } from '../src/shared-assistant.ts'

const attemptId = LlmAttemptId('shared-attempt')
function stream(texts: string[]): AssistantStreamRecord[] {
  return [
    { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 2, index: 0, dt: texts.slice(1).map(() => 0), texts },
  ]
}
function baseline(texts: string[]): SessionAssistantStreamBaseline {
  return {
    revision: texts.length + 1,
    activeAttempt: {
      attemptId, turn: 1, step: 1, startedAfterSeq: SessionSeq(0),
      nextIndex: texts.length + 1, stream: stream(texts) as never,
    },
  }
}
function settlement(texts: string[]): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq: SessionSeq(1), time: 3, surfaceOp: 'append',
    data: {
      turn: 1, step: 1, stream: stream(texts),
      message: createAssistantMessage({
        content: [{ type: 'text', text: texts.join('') }], source: { provider: 'test', model: 'test' },
      }),
    },
  }
}
const initial: SessionEvent = { type: 'step/start', seq: SessionSeq(0), time: 0, data: { turn: 1, step: 1 } }

afterEach(() => { vi.useRealTimers() })

describe('cross-replica Assistant follow', () => {
  it('reconnects at a compact baseline and sends only the unseen live suffix', () => {
    const follow = new SharedAssistantFollower()
    expect(follow.opening([initial], baseline(['first']))).toMatchObject({
      revision: 0, activeAttempt: { nextIndex: 2 },
    })
    expect([...follow.update(baseline(['first', ' second']), SessionSeq(0))]).toMatchObject([
      { type: 'assistant-stream', frame: { type: 'chunk', index: 2, revision: 1, chunk: { text: ' second' } } },
    ])
    expect([...follow.update(baseline(['first', ' second']), SessionSeq(0))]).toEqual([])
  })

  it('fills missed chunks before the durable settlement and ends its transient attempt afterward', () => {
    const follow = new SharedAssistantFollower()
    follow.opening([initial], baseline(['first']))
    const committed = settlement(['first', ' second', ' third'])
    const frames = [...follow.acceptEvent(committed)]
    expect(frames).toMatchObject([
      { type: 'assistant-stream', frame: { type: 'chunk', revision: 1, index: 2, chunk: { text: ' second' } } },
      { type: 'assistant-stream', frame: { type: 'chunk', revision: 2, index: 3, chunk: { text: ' third' } } },
      { type: 'event', event: committed },
      { type: 'assistant-stream', frame: { type: 'end', revision: 3, index: 4, outcome: { kind: 'committed', seq: 1 } } },
    ])
    expect([...follow.update(baseline(['first']), SessionSeq(1))]).toEqual([])
  })

  it('waits for the durable start and abandons only a missing or replaced transient attempt', () => {
    const follow = new SharedAssistantFollower()
    expect(follow.opening([], baseline(['hello']))).toEqual({ revision: 0 })
    expect([...follow.update(baseline(['hello']), -1)]).toEqual([])
    expect([...follow.acceptEvent(initial)]).toMatchObject([{ type: 'event', event: initial }])
    expect([...follow.update(baseline(['hello']), SessionSeq(0))]).toMatchObject([
      { type: 'assistant-stream', frame: { type: 'start', revision: 1 } },
      { type: 'assistant-stream', frame: { type: 'chunk', revision: 2, index: 0 } },
      { type: 'assistant-stream', frame: { type: 'chunk', revision: 3, index: 1 } },
    ])
    expect([...follow.update(undefined, SessionSeq(0))]).toMatchObject([
      { type: 'assistant-stream', frame: { type: 'end', revision: 4, outcome: { kind: 'abandoned' } } },
    ])
    expect([...follow.acceptEvent(settlement(['hello']))]).toHaveLength(1)
  })

  it('does not replay a transient snapshot already included in the opening durable log', () => {
    const follow = new SharedAssistantFollower()
    expect(follow.opening([initial, settlement(['done'])], baseline(['done']))).toEqual({ revision: 0 })
  })

  it('coalesces publications and joins updates accepted during a write before closing', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<undefined>()
    const publish = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    const report = vi.fn()
    let current = baseline(['one'])
    const publication = new SharedAssistantPublication({ publish }, () => current, 100, report)
    publication.update()
    publication.update()
    await vi.advanceTimersByTimeAsync(100)
    expect(publish).toHaveBeenCalledTimes(1)
    current = baseline(['one', 'two'])
    publication.update()
    const closed = publication.close()
    pending.resolve(undefined)
    await closed
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith(current)
    expect(report).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
