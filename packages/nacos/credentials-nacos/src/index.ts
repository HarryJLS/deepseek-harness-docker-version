/**
 * Nacos-backed credentials provider.
 *
 * One Nacos configuration entry replaces `$DSH_HOME/.credentials.yaml` as the
 * provider-managed writable source, so a container that owns no writable
 * volume still resolves API keys and authorization grants, and rotating a key
 * in Nacos reaches every replica without a redeploy.
 *
 * The layering rule is unchanged from the local provider, and it is the part
 * that matters: the inherited process environment still wins and stays
 * read-only. An operator who set a key through the container's environment
 * keeps that key authoritative, and a write that would be shadowed by it is
 * refused rather than silently ignored.
 *
 *   inherited process environment   (read-only, wins)
 *   Nacos entry                     (writable, this provider)
 *
 * The entry holds secrets, so it belongs in a Nacos namespace whose read
 * permission is scoped to this deployment.
 *
 * @module @deepseek-ai/dsh-credentials-nacos
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parse, stringify } from 'yaml'
import {
  nacosDocument,
  nacosEntrySchema,
  type NacosDocument,
  type NacosEntryConfig,
} from '@deepseek-ai/dsh-nacos-client'
import {
  CredentialProvider,
  credentialRef,
  parseCredentialKey,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** Plugin config: where the credentials document lives in Nacos. */
export interface Config extends NacosEntryConfig {
  /** Config data id holding the credentials document. Default: `dsh-credentials.yaml`. */
  dataId?: string
}

/** The stored document: environment-named references plus keyed records. */
interface CredentialDocument {
  /** Reference name to secret value. */
  refs: Record<string, string>
  /** Record address to its stored record. */
  records: Record<string, CredentialRecord>
}

/** Source layer id this provider reports for a value it stores. */
const NACOS_SOURCE = 'nacos'
/** Source layer id for a value the process environment supplied. */
const ENV_SOURCE = 'env'

/**
 * One mapping without a given key. Rebuilding rather than deleting keeps the
 * object out of dictionary mode and expresses the removal as a value.
 * @param source - the mapping to copy.
 * @param key - the entry to drop; absent keys copy unchanged.
 * @returns a new mapping without that entry.
 */
function without<T>(source: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [name, value] of Object.entries(source)) {
    if (name !== key) next[name] = value
  }
  return next
}

/** An empty stored value is absent everywhere; this is the seam-wide rule. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Parse the stored document, tolerating an absent entry and rejecting one that
 * is not a mapping rather than silently discarding every credential.
 * @param content - the raw entry body, or undefined when the entry is absent.
 * @returns the parsed document with both sections present.
 */
export function parseDocument(content: string | undefined): CredentialDocument {
  if (content === undefined || content.trim() === '') return { refs: {}, records: {} }
  const parsed: unknown = parse(content)
  if (parsed === null || parsed === undefined) return { refs: {}, records: {} }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credentials-nacos: the credentials document must be a YAML mapping')
  }
  const document = parsed as Record<string, unknown>
  return { refs: section<string>(document.refs), records: section<CredentialRecord>(document.records) }
}

/**
 * Narrow one stored section to a plain mapping, treating anything else — an
 * absent key, a list, a scalar — as empty rather than failing the whole
 * document over one malformed half.
 * @param value - the raw parsed section.
 * @returns the mapping, or an empty one.
 */
function section<T>(value: unknown): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, T>
}

/** Nacos-backed credentials provider (one config entry over the environment). */
export class NacosCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    ...nacosEntrySchema,
    dataId: z.string().default('dsh-credentials.yaml'),
  })

  /** The watched Nacos entry: reads, pushes, and the serialized write chain. */
  private readonly entry: NacosDocument<CredentialDocument>
  /** Last observed document; refreshed by the change listener and by each write. */
  private document: CredentialDocument = { refs: {}, records: {} }

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.entry = nacosDocument<CredentialDocument>(
      config,
      config.dataId ?? 'dsh-credentials.yaml',
      { parse: parseDocument, render: stringify },
    )
  }

  /** Connect, read the document once, and watch it before becoming injectable. */
  protected async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    this.entry.setErrorHandler((error: unknown) => {
      this.ctx.logger.error('credentials-nacos: %s failed', this.entry.address)
      this.ctx.logger.error(error)
    })
    await this.entry.connect()
    this.document = await this.entry.read()
    await this.entry.watch((document) => { this.adopt(document) })
    yield () => { this.entry.close() }
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    // The inherited environment ranks above the stored entry, so a key the
    // container was started with is what every operation actually uses.
    const inherited = present(process.env[ref])
    if (inherited !== undefined) return Promise.resolve({ value: inherited, source: ENV_SOURCE })
    const stored = present(this.document.refs[ref])
    if (stored !== undefined) return Promise.resolve({ value: stored, source: NACOS_SOURCE })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    // Only the inherited environment is unwritable: it is the one layer this
    // provider cannot change, so a write under it would not take effect.
    if (present(process.env[ref]) !== undefined) {
      return Promise.resolve({ configured: true, source: ENV_SOURCE, writable: false })
    }
    if (present(this.document.refs[ref]) !== undefined) {
      return Promise.resolve({ configured: true, source: NACOS_SOURCE, writable: true })
    }
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (value === '') {
      return Promise.reject(new Error(`credentials-nacos: ${ref} cannot be set to an empty value; use unset`))
    }
    if (present(process.env[ref]) !== undefined) {
      return Promise.reject(new Error(
        `credentials-nacos: ${ref} is supplied by the process environment, which this provider cannot change`,
      ))
    }
    return this.write((document) => {
      document.refs[ref] = value
      return document
    }).then(() => { this.notifyUpdated(ref) })
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (present(process.env[ref]) !== undefined) {
      return Promise.reject(new Error(
        `credentials-nacos: ${ref} is supplied by the process environment, which this provider cannot change`,
      ))
    }
    return this.write(document => ({
      // Removing an absent reference is a no-op, not an error.
      ...document,
      refs: without(document.refs, ref),
    })).then(() => { this.notifyUpdated(ref) })
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.document.records[key])
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.document.records[key]
    // Presence is the whole fact here: no layer ranks above this entry for
    // records, so there is nothing that could shadow a write.
    if (record === undefined) return Promise.resolve({ configured: false, writable: true })
    return Promise.resolve({ configured: true, kind: record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve(Object.entries(this.document.records).map(([key, record]) => ({
      key: parseCredentialKey(key),
      kind: record.kind,
    })))
  }

  /**
   * Read-decide-replace under this provider's exclusive chain. The mutate
   * callback sees the document as it stands when the write becomes exclusive,
   * which is what makes a token refresh safe against a concurrent one.
   */
  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.entry.exclusive(async (latest) => {
      const current = latest.records[key]
      const next = await mutate(current)
      if (next === undefined) {
        // Declining leaves the entry untouched, but the read still refreshed
        // what this provider believes is stored.
        this.document = latest
        return current
      }
      const published = { ...latest, records: { ...latest.records, [key]: next } }
      await this.entry.publish(published)
      this.document = published
      return next
    })
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    return this.write(document => ({ ...document, records: without(document.records, key) }))
  }

  /** Read-modify-write the whole entry under the shared exclusive chain. */
  private async write(edit: (document: CredentialDocument) => CredentialDocument): Promise<void> {
    this.document = await this.entry.write(edit)
  }

  /** Adopt an externally published document and announce every changed reference. */
  private adopt(next: CredentialDocument): void {
    const previous = this.document
    this.document = next
    // Consumers re-resolve per operation, but a reference that changed while
    // an owner was idle still needs to reach its observers.
    const names = new Set([...Object.keys(previous.refs), ...Object.keys(next.refs)])
    for (const name of names) {
      if (previous.refs[name] !== next.refs[name]) this.notifyUpdated(credentialRef(name))
    }
  }
}

/** Stable Cordis plugin name. */
export const name = 'credentials-nacos'

export default NacosCredentialProvider
