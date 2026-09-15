/** Stable storage adapter around the build-static Session format catalog. */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  sessionFormatVersionRefusal,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

interface StoredHeaderResult {
  readonly rawHeader: Record<string, unknown>
  readonly meta: SessionHeader
  readonly storedVersion: number
  readonly inheritedEventCount: SessionLogOffsetType | undefined
}

/** Result of decoding one database header and its physical event rows. */
export interface DecodedStoredSession extends StoredHeaderResult {
  /** Current logical events after any supported historical migrations. */
  readonly events: SessionEvent[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function corruption(id: SessionId, message: string, cause?: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(
    `session-persistence-mysql: session ${id} ${message}`,
    { cause: cause instanceof Error ? cause : new Error(message) },
  )
}

function jsonRecord(value: unknown, id: SessionId): Record<string, unknown> {
  if (!record(value)) {
    throw corruption(id, 'has a malformed stored header')
  }
  return value
}

function currentHeader(header: SessionFormatHeader, id: SessionId, owner: string): SessionHeader {
  if (header.id !== id || (header.userId ?? '-') !== owner) {
    throw corruption(id, 'has conflicting ownership metadata')
  }
  const { delegationDepth, ...optionalHeader } = header
  return (delegationDepth === 0 ? optionalHeader : header) as unknown as SessionHeader
}

function sourceHeader(value: unknown, id: SessionId, owner: string): Record<string, unknown> {
  const stored = jsonRecord(value, id)
  const { inheritedEventCount: _inheritedEventCount, ...header } = stored
  // userId was added after the original database format. The SQL owner column
  // is authoritative for historical rows that predate that field.
  return Object.hasOwn(header, 'userId') ? header : { ...header, userId: owner }
}

function unsupported(id: SessionId, result: ReturnType<typeof sessionFormatCatalog.readHeader>): never {
  if (result.status === 'unsupported') {
    const reason = result.storedVersion > sessionFormatCatalog.currentVersion
      ? sessionFormatVersionRefusal(id, result.storedVersion)
      : result.reason
    throw new SessionFormatUnsupportedError(
      `${reason} (database session ${id})`,
    )
  }
  if (result.status === 'malformed') {
    throw corruption(id, `has a malformed format header: ${result.reason}`)
  }
  throw corruption(id, 'returned an invalid format classification')
}

/**
 * Decode a database header without coupling the store to any released format.
 * @param value - JSON value read from the session row.
 * @param id - logical Session identity from the SQL key.
 * @param owner - authoritative SQL owner value.
 * @returns the current logical header and stored-generation metadata.
 */
export function decodeStoredHeader(value: unknown, id: SessionId, owner: string): StoredHeaderResult {
  const rawHeader = sourceHeader(value, id, owner)
  const result = sessionFormatCatalog.readHeader(rawHeader)
  if (result.status === 'unsupported' || result.status === 'malformed') unsupported(id, result)
  const meta = currentHeader(result.header, id, owner)
  const stored = jsonRecord(value, id)
  const storedCut = stored['inheritedEventCount']
  let inheritedEventCount: SessionLogOffset | undefined
  if (result.storedVersion === sessionFormatCatalog.currentVersion) {
    if (storedCut !== undefined && (!Number.isSafeInteger(storedCut) || (storedCut as number) < 0)) {
      throw corruption(id, 'has an invalid inherited event count')
    }
    inheritedEventCount = SessionLogOffset(Number(storedCut ?? 0))
    if (meta.isSeeded && storedCut === undefined) {
      throw corruption(id, 'has no inherited event count')
    }
    if (!meta.isSeeded && inheritedEventCount !== 0) {
      throw corruption(id, 'has inherited metadata on an unseeded Session')
    }
  }
  return { rawHeader, meta, storedVersion: result.storedVersion, inheritedEventCount }
}

/**
 * Decode and migrate all physical rows into the current logical Session format.
 * @param value - JSON value read from the session row.
 * @param id - logical Session identity from the SQL key.
 * @param owner - authoritative SQL owner value.
 * @param rows - event JSON values in physical sequence order.
 * @returns current logical metadata and contiguous events.
 */
export function decodeStoredSession(
  value: unknown,
  id: SessionId,
  owner: string,
  rows: readonly unknown[],
): DecodedStoredSession {
  const metadata = decodeStoredHeader(value, id, owner)
  // SQL keeps the inherited cut beside the header because the event rows are
  // already the complete inherited prefix; current JSONL framing uses a marker
  // instead. Decode this one database representation as an unseeded stream and
  // restore the authoritative SQL lineage metadata after decoding.
  const restoreHeader = metadata.storedVersion === CURRENT_SESSION_FORMAT_VERSION && metadata.meta.isSeeded
    ? { ...metadata.rawHeader, isSeeded: false }
    : metadata.rawHeader
  const restore = sessionFormatCatalog.createRestore(restoreHeader, {
    recovery: 'strict',
    validation: metadata.storedVersion === CURRENT_SESSION_FORMAT_VERSION ? 'transformed' : 'current',
  })
  let artifact: SessionFormatArtifact
  try {
    for (const row of rows) restore.decodeRow(row)
    artifact = restore.finish()
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error
    if (error instanceof SessionFormatUnsupportedMigrationError) {
      throw new SessionFormatUnsupportedError(
        `${error.message} (database session ${id})`,
      )
    }
    throw corruption(id, 'has an invalid event log', error)
  }
  const currentMeta = metadata.storedVersion === CURRENT_SESSION_FORMAT_VERSION
    ? metadata.meta
    : currentHeader(artifact.header, id, owner)
  const inheritedEventCount = metadata.storedVersion === CURRENT_SESSION_FORMAT_VERSION
    ? metadata.inheritedEventCount ?? SessionLogOffset(0)
    : SessionLogOffset(artifact.inheritedEventCount)
  return {
    ...metadata,
    meta: currentMeta,
    inheritedEventCount,
    events: artifact.events as SessionEvent[],
  }
}

/**
 * Encode current logical metadata into the stable database envelope.
 * @param meta - current logical Session header.
 * @param inheritedEventCount - SQL-side inherited prefix length.
 * @returns current physical header fields plus the SQL-side lineage field.
 */
export function encodeStoredHeader(meta: SessionHeader, inheritedEventCount: SessionLogOffsetType): Record<string, unknown> {
  return {
    ...sessionFormatCatalog.encodeCurrentHeader(
      { ...meta, delegationDepth: meta.delegationDepth ?? 0 },
      inheritedEventCount,
    ),
    inheritedEventCount,
  }
}

/**
 * Encode one current logical event through the installed current codec.
 * @param event - current logical event to persist.
 * @returns current physical event fields.
 */
export function encodeStoredEvent(event: SessionEvent): Record<string, unknown> {
  return sessionFormatCatalog.encodeCurrentEvent(
    event as unknown as SessionFormatEvent,
  )
}

/** Current Session format selected by the installed catalog. */
export const CURRENT_SESSION_FORMAT_VERSION = sessionFormatCatalog.currentVersion
