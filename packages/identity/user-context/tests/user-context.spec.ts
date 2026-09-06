import { describe, expect, it } from 'vitest'
import {
  canAccessUser, currentUserId, DEFAULT_USER_ID, parseUserId, requestUserId,
  userScopedIterable, withUser,
} from '../src/index.ts'

describe('request user identity', () => {
  it('defaults missing user information to the shared anonymous owner', () => {
    expect(currentUserId()).toBe('-')
    expect(parseUserId(undefined)).toBe('-')
    expect(parseUserId(null)).toBe('-')
    expect(parseUserId('')).toBe('-')
    expect(withUser(DEFAULT_USER_ID, () => canAccessUser(undefined))).toBe(true)
    expect(withUser(DEFAULT_USER_ID, () => canAccessUser(parseUserId('alice')))).toBe(false)
  })

  it('rejects ambiguous and oversized external identities', () => {
    for (const value of [[], 3, ' alice', 'alice ', 'alice,bob', 'a\nb', 'a'.repeat(33)]) {
      expect(() => parseUserId(value)).toThrow('user id')
    }
    expect(parseUserId('a'.repeat(32))).toHaveLength(32)
    expect(parseUserId('Alice')).not.toBe(parseUserId('alice'))
  })

  it('isolates interleaved operations and restores their enclosing scope', async () => {
    const results = await Promise.all(['alice', 'bob'].map(name => withUser(parseUserId(name), async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(canAccessUser(parseUserId(name))).toBe(true)
      expect(canAccessUser(DEFAULT_USER_ID)).toBe(false)
      return currentUserId()
    })))
    expect(results).toEqual(['alice', 'bob'])
    expect(requestUserId()).toBeUndefined()
    expect(canAccessUser(parseUserId('alice'))).toBe(true)
  })

  it('retains identity through lazy iteration and cleanup', async () => {
    let cleanup: string | undefined
    async function* source() {
      try { yield currentUserId(); yield currentUserId() }
      finally { cleanup = currentUserId() }
    }
    const stream = withUser(parseUserId('alice'), () => userScopedIterable(source()))
    for await (const value of stream) {
      expect(value).toBe('alice')
      break
    }
    expect(cleanup).toBe('alice')
    expect(requestUserId()).toBeUndefined()
  })
})
