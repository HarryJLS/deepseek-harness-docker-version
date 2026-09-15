/** Docker Session ownership around the unmodified first-party format catalog. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact, SessionFormatCatalog, SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { parseUserId } from '@deepseek-ai/dsh-user-context/identity'
import { validateInstalledCurrentSessionArtifact } from './current.ts'

type RecordValue = Record<string, unknown>
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ownedHeader(value: unknown): { header: unknown; owner?: string } {
  if (!record(value) || !Object.hasOwn(value, 'userId')) return { header: value }
  const { userId, ...header } = value
  if (typeof userId !== 'string' || userId.length === 0 || parseUserId(userId) !== userId) {
    throw new SessionFormatError('Docker Session header contains an invalid userId')
  }
  return { header, owner: userId }
}

function withOwner(header: SessionFormatHeader, owner: string | undefined): SessionFormatHeader {
  return owner === undefined ? header : { ...header, userId: owner }
}

/**
 * Preserve validated Docker user headers without changing first-party codecs.
 * @param base - first-party catalog generated for this release.
 * @returns a catalog with the same current version and explicit downstream metadata admission.
 */
export function withDockerSessionMetadata(base: SessionFormatCatalog): SessionFormatCatalog {
  return {
    currentVersion: base.currentVersion,
    readHeader(value) {
      if (record(value) && typeof value.version === 'number' && value.version > base.currentVersion) return base.readHeader(value)
      try {
        const { header, owner } = ownedHeader(value)
        const result = base.readHeader(header)
        return result.status === 'current' || result.status === 'migration-required'
          ? { ...result, header: withOwner(result.header, owner) } : result
      } catch (error) {
        return { status: 'malformed', targetVersion: base.currentVersion, reason: String(error) }
      }
    },
    createRestore(value, options) {
      const { header, owner } = ownedHeader(value)
      const restore = base.createRestore(header, options)
      return {
        header: withOwner(restore.header, owner),
        decodeRow(row) { restore.decodeRow(row) },
        finish() {
          const artifact = restore.finish()
          const result: SessionFormatArtifact = {
            ...artifact,
            header: withOwner(artifact.header, owner),
          }
          if (options.validation === 'current') validateInstalledCurrentSessionArtifact(result)
          return result
        },
      }
    },
    encodeCurrentHeader(value, cut) {
      const { header, owner } = ownedHeader(value)
      const encoded = base.encodeCurrentHeader(header as SessionFormatHeader, cut)
      return owner === undefined ? encoded : { ...encoded, userId: owner }
    },
    encodeCurrentEvent: event => base.encodeCurrentEvent(event),
  }
}
