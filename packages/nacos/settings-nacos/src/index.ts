/**
 * Nacos-backed settings provider.
 *
 * One Nacos configuration entry holds the whole user-settings document — the
 * same namespace-keyed YAML the file provider stores under the harness home —
 * so a container that owns no writable volume still resolves live settings,
 * and an operator editing the entry in the Nacos console reaches every running
 * replica at once.
 *
 * This is the LIVE half of the deployment's configuration split. The static
 * half (which plugins are mounted, where this server binds, where Nacos itself
 * is) travels with the image in `cordis.yml`, because a value needed before
 * Nacos can be contacted cannot come from Nacos.
 *
 * @module @deepseek-ai/dsh-settings-nacos
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
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Plugin config: where the settings document lives in Nacos. */
export interface Config extends NacosEntryConfig {
  /** Config data id holding the settings document. Default: `dsh-settings.yaml`. */
  dataId?: string
  /**
   * Whether this deployment may write settings back to Nacos. A replica fleet
   * that treats Nacos as the single authoring surface sets this false, which
   * makes every configuration page read-only rather than letting one replica
   * race another. Default: true.
   */
  writable?: boolean
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  dataId: string
  group: string
  writable: boolean
}

/**
 * Parse the stored document into namespace sections. An empty or absent entry
 * is an empty document; anything that is not a YAML mapping is a malformed
 * document and fails loud rather than silently resetting every namespace.
 * @param content - the raw entry body, or undefined when the entry is absent.
 * @returns the namespace-keyed document.
 */
export function parseDocument(content: string | undefined): Record<string, unknown> {
  if (content === undefined || content.trim() === '') return {}
  const parsed: unknown = parse(content)
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings-nacos: the settings document must be a YAML mapping of namespace sections')
  }
  return parsed as Record<string, unknown>
}

/** Nacos-backed settings provider (one config entry, hot-published). */
export class NacosSettingsProvider extends SettingsProvider {
  static Config: z<Config> = z.object({
    ...nacosEntrySchema,
    dataId: z.string().default('dsh-settings.yaml'),
    writable: z.boolean().default(true),
  })

  private readonly spec: ResolvedSpec
  /** The watched Nacos entry: reads, pushes, and the serialized write chain. */
  private readonly entry: NacosDocument<Record<string, unknown>>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = {
      dataId: config.dataId ?? 'dsh-settings.yaml',
      group: config.group ?? 'DEFAULT_GROUP',
      writable: config.writable ?? true,
    }
    this.entry = nacosDocument<Record<string, unknown>>(
      config,
      this.spec.dataId,
      { parse: parseDocument, render: stringify },
    )
  }

  /** Whether configuration surfaces may write through this provider. */
  override get writable(): boolean {
    return this.spec.writable
  }

  /**
   * Connect and arm the change listener before the base class performs its
   * first load, then hand teardown back so the base drains writes after this
   * provider's own disposers have run.
   */
  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    this.entry.setErrorHandler((error: unknown) => {
      this.ctx.logger.error('settings-nacos: %s failed', this.entry.address)
      this.ctx.logger.error(error)
    })
    // The connection must exist before the base init reads through `load`, but
    // the listener must NOT be armed until after it: the base yields its own
    // teardown and only then loads, so a disposer yielded ahead of the
    // delegation would stop the generator before the load ever ran.
    await this.entry.connect()
    yield* super[Service.init]()
    await this.entry.watch((document) => { this.publish(document) })
    yield () => { this.entry.close() }
  }

  /** Nacos is not a local file, so no native-editor handoff exists. */
  override get documentPath(): string | undefined {
    return undefined
  }

  protected load(): Promise<Record<string, unknown>> {
    return this.entry.read()
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    if (!this.spec.writable) {
      throw new Error('settings-nacos: this deployment is configured read-only')
    }
    // One entry backs every namespace, so the write folds this section into
    // the document as currently stored rather than into a local copy: a
    // sibling namespace another replica just wrote must survive.
    await this.entry.write(current => ({ ...current, [ns]: section }))
  }

}

/** Stable Cordis plugin name. */
export const name = 'settings-nacos'

export default NacosSettingsProvider
