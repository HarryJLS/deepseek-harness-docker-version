/** Async-local identity for trusted HTTP requests and their background operations. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_USER_ID, type UserId } from './identity.ts'

export { DEFAULT_USER_ID, MAX_USER_ID_LENGTH, parseUserId, type UserId } from './identity.ts'

const users = new AsyncLocalStorage<UserId | undefined>()

/**
 * Read the request identity without assigning an identity to trusted Host maintenance.
 * @returns the request owner, or undefined outside a user-scoped operation.
 */
export function requestUserId(): UserId | undefined {
  return users.getStore()
}

/**
 * Resolve the actor written into audit columns.
 * @returns the request owner, defaulting to the anonymous owner.
 */
export function currentUserId(): UserId {
  return requestUserId() ?? DEFAULT_USER_ID
}

/**
 * Run an operation and its asynchronous descendants under one immutable identity.
 * @param userId - trusted request owner, or undefined for internal Host maintenance.
 * @param operation - operation whose asynchronous work inherits the identity.
 * @returns the operation's result unchanged.
 */
export function withUser<T>(userId: UserId | undefined, operation: () => T): T {
  return users.run(userId, operation)
}

/**
 * Check session ownership for a request; unscoped Host maintenance can inspect all owners.
 * @param owner - durable owner; absent metadata belongs to the anonymous owner.
 * @param userId - request identity captured at subscription or admission time.
 * @returns whether this request may access the owner.
 */
export function canAccessUser(owner: UserId | undefined, userId = requestUserId()): boolean {
  return userId === undefined || userId === (owner ?? DEFAULT_USER_ID)
}

/**
 * Bind lazy stream iteration to its admitting request, including cancellation cleanup.
 * @param source - stream opened under the request identity.
 * @param userId - identity to retain when another asynchronous context pulls the stream.
 * @returns an iterable whose iterator operations preserve that identity.
 */
export function userScopedIterable<T>(source: AsyncIterable<T>, userId = requestUserId()): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = withUser(userId, () => source[Symbol.asyncIterator]())
      const throwIntoSource = iterator.throw?.bind(iterator)
      return {
        next: () => withUser(userId, () => iterator.next()),
        return: () => withUser(userId, () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })),
        ...(throwIntoSource === undefined ? {} : {
          throw: (error: unknown) => withUser(userId, () => throwIntoSource(error)),
        }),
      }
    },
  }
}
