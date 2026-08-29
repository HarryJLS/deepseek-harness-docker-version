/**
 * One Nacos configuration entry as a live, serially-written document.
 *
 * Both harness providers backed by Nacos — user settings and credentials —
 * want the same four things: connect, read the entry once, apply every server
 * push, and run each write as a read-modify-write behind every earlier one.
 * Only the parsing and what a change means differ, so that machinery lives
 * here and each provider supplies its own codec.
 *
 * The write path is a read-modify-write on purpose. One entry backs every
 * namespace or credential, so rendering from a locally cached copy would drop
 * whatever another replica — or an operator editing the console — published in
 * between.
 *
 * @module @deepseek-ai/dsh-nacos-client/document
 */

import z from '@deepseek-ai/schemastery'
import { NacosConfigClient, type NacosClientOptions } from './client.ts'

/** How one document is read from and written to its stored text. */
export interface NacosDocumentCodec<T> {
  /**
   * Parse the stored entry body.
   * @param content - the raw entry, or undefined when the entry is absent.
   * @returns the parsed document.
   */
  parse(content: string | undefined): T
  /**
   * Render the document back to entry text.
   * @param document - the document to store.
   * @returns the text to publish.
   */
  render(document: T): string
}

/**
 * How one plugin reaches Nacos and which entry it owns. Every harness plugin
 * backed by Nacos declares these fields, so the shape and its defaults live
 * here rather than being restated at each site.
 */
export interface NacosEntryConfig {
  /** Nacos server host. */
  host: string
  /** Nacos HTTP port; the gRPC port is derived from it. Default: 8848. */
  port?: number
  /** Nacos namespace id; empty selects the public namespace. */
  namespace?: string
  /** Config group. Default: `DEFAULT_GROUP`. */
  group?: string
  /** Username for a Nacos with auth enabled. */
  username?: string
  /** Password for a Nacos with auth enabled. */
  password?: string
  /** Milliseconds to wait for one Nacos call. Default: 10000. */
  requestTimeoutMs?: number
}

/** Where one document lives, and how to reach the server holding it. */
export interface NacosDocumentOptions<T> extends NacosClientOptions {
  /** Config group. */
  group: string
  /** Config data id. */
  dataId: string
  /** How to read and write the entry body. */
  codec: NacosDocumentCodec<T>
}

/**
 * Open one Nacos-backed document from a plugin's connection config.
 *
 * The data id is passed separately because it is the one field each plugin
 * genuinely owns; everything else is the shared connection vocabulary.
 * @param config - the plugin's connection fields.
 * @param dataId - the entry this plugin owns.
 * @param codec - how to read and write that entry's body.
 * @returns the document, not yet opened.
 */
export function nacosDocument<T>(
  config: NacosEntryConfig,
  dataId: string,
  codec: NacosDocumentCodec<T>,
): NacosDocument<T> {
  return new NacosDocument<T>({
    host: config.host,
    port: config.port ?? 8848,
    namespace: config.namespace ?? '',
    ...config.username !== undefined && { username: config.username },
    ...config.password !== undefined && { password: config.password },
    requestTimeoutMs: config.requestTimeoutMs ?? 10000,
    group: config.group ?? 'DEFAULT_GROUP',
    dataId,
    codec,
  })
}

/**
 * A Nacos entry held open: read once, watched for pushes, written serially.
 *
 * The owner drives the lifecycle explicitly — `open` before use, `close` at
 * disposal — because both consumers are Cordis services that must connect
 * before becoming injectable and release on teardown.
 */
export class NacosDocument<T> {
  private readonly client: NacosConfigClient
  private readonly group: string
  private readonly dataId: string
  private readonly codec: NacosDocumentCodec<T>
  /** Settled tail of the exclusive operation chain. */
  private operations: Promise<unknown> = Promise.resolve()
  private disposeWatch: (() => void) | undefined
  private closed = false

  constructor(options: NacosDocumentOptions<T>) {
    this.group = options.group
    this.dataId = options.dataId
    this.codec = options.codec
    this.client = new NacosConfigClient(options)
  }

  /** Identity of the watched entry, for diagnostics. */
  get address(): string {
    return `${this.group}/${this.dataId}`
  }

  /**
   * Report background failures — reconnects, re-registration, and reload
   * parse errors — to the owner.
   * @param handler - receives each failure.
   */
  setErrorHandler(handler: (error: unknown) => void): void {
    this.client.setErrorHandler(handler)
  }

  /**
   * Open the connection. Kept separate from {@link watch} because a Cordis
   * service that delegates to a base `[Service.init]` must be connected before
   * that base reads, and must not arm its listener until after it.
   */
  connect(): Promise<void> {
    return this.client.connect()
  }

  /**
   * Read the entry as currently stored.
   * @returns the parsed document.
   */
  async read(): Promise<T> {
    return this.codec.parse(await this.readText())
  }

  /**
   * Arm the change listener.
   * @param onChange - invoked with each externally published document.
   */
  async watch(onChange: (document: T) => void): Promise<void> {
    this.disposeWatch = await this.client.watch(
      { dataId: this.dataId, group: this.group },
      (content) => { this.queueChange(content, onChange) },
    )
  }

  /** Release the watch and the connection; queued work then no-ops. */
  close(): void {
    this.closed = true
    this.disposeWatch?.()
    this.client.close()
  }

  /**
   * Apply one edit as a read-modify-write behind every earlier operation.
   * @param edit - receives the document as currently stored and returns the next one.
   * @returns the document that was published.
   */
  write(edit: (current: T) => T): Promise<T> {
    return this.enqueue(async () => {
      const next = edit(this.codec.parse(await this.readText()))
      await this.client.publish(
        { dataId: this.dataId, group: this.group },
        this.codec.render(next),
      )
      return next
    })
  }

  /**
   * Run one operation that needs the stored document and the exclusive chain,
   * for a caller whose decision depends on the current value.
   * @param operation - receives the document as currently stored.
   * @returns whatever the operation returns.
   */
  exclusive<R>(operation: (current: T) => Promise<R>): Promise<R> {
    return this.enqueue(async () => operation(this.codec.parse(await this.readText())))
  }

  /** Publish a document already decided under {@link exclusive}. */
  publish(document: T): Promise<void> {
    return this.client.publish(
      { dataId: this.dataId, group: this.group },
      this.codec.render(document),
    )
  }

  /** Read the raw entry body. */
  private async readText(): Promise<string | undefined> {
    return (await this.client.read({ dataId: this.dataId, group: this.group })).content
  }

  /** Queue one exclusive operation behind every earlier one. */
  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * Fold one server push into the chain so it cannot interleave with a write.
   * A parse failure is reported rather than thrown: a malformed entry must not
   * end hot reloading for the life of the process.
   */
  private queueChange(content: string | undefined, onChange: (document: T) => void): void {
    void this.enqueue(() => {
      if (!this.closed) onChange(this.codec.parse(content))
      return Promise.resolve()
    }).catch((error: unknown) => { this.reportChangeFailure(error) })
  }

  /** Surface a reload failure through the installed error handler. */
  private reportChangeFailure(error: unknown): void {
    this.client.reportError(error)
  }
}

/**
 * Schemastery fields for {@link NacosEntryConfig}, for a plugin to spread into
 * its own `Config` schema. Declaring them once keeps every Nacos-backed
 * plugin's accepted fields, defaults, and secret marking identical.
 */
export const nacosEntrySchema = {
  host: z.string().required(),
  port: z.natural().default(8848),
  namespace: z.string().default(''),
  group: z.string().default('DEFAULT_GROUP'),
  username: z.string(),
  password: z.string().role('secret'),
  requestTimeoutMs: z.natural().min(1).default(10000),
}
