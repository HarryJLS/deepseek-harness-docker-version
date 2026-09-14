/** Current-format log-only assistant attempts for SQL and Redis storage tests. */

import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Build a settled text stream without requiring a model or a live Agent.
 * @param seq - contiguous stored position.
 * @param text - exact UTF-8 payload.
 * @param time - deterministic stream and event time.
 * @returns one V3 assistant attempt.
 */
export function storedAttempt(seq: number, text = 'hello', time = 1): SessionEvent {
  return {
    type: 'assistant/attempt', seq: SessionSeq(seq), time,
    data: { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: time, index: 0, dt: [], texts: [text] }] },
  }
}
