/** Client-safe platform user identifiers, including the anonymous owner. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Platform identity stored with a session, independent of its application name. */
export type UserId = Branded<'UserId'>

/** Shared owner for requests without platform user information. */
export const DEFAULT_USER_ID = '-' as UserId

/** Audit actor columns and user identifiers accept at most 32 characters. */
export const MAX_USER_ID_LENGTH = 32

/**
 * Validate an identity at an HTTP, durable-data, or configuration input.
 * @param value - untrusted identity; absent or blank values select the anonymous owner.
 * @returns the exact nonblank identity, or the anonymous owner.
 * @throws when the value is not one string, exceeds the column limit, or contains control characters.
 */
export function parseUserId(value: unknown): UserId {
  if (value === undefined || value === null || value === '') return DEFAULT_USER_ID
  if (typeof value !== 'string' || value.length > MAX_USER_ID_LENGTH
    || /[\u0000-\u001f\u007f,]/u.test(value) || value !== value.trim()) {
    throw new Error('user id must be a single 1..32 character value without whitespace padding or control characters')
  }
  return value as UserId
}
