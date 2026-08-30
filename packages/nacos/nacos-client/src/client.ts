/**
 * Nacos configuration client over the gRPC wire protocol.
 *
 * Nacos 3.x removed the v1 HTTP config API, so a client that wants change
 * PUSH (rather than polling) must speak gRPC: a unary `Request/request`
 * channel for reads and listener registration, and a `BiRequestStream` the
 * server pushes `ConfigChangeNotifyRequest` down. This module owns that
 * conversation and exposes it as a small read/watch/publish surface; the
 * harness plugins built on it never see a Payload.
 *
 * Reconnection is part of the contract: a dropped stream re-runs the handshake
 * and re-registers every live watch, then re-reads each watched key, because a
 * change that landed while the stream was down produced no push.
 *
 * @module @deepseek-ai/dsh-nacos-client/client
 */

import * as grpc from '@grpc/grpc-js'
import { fromJSON } from '@grpc/proto-loader'
import { createHash, randomUUID } from 'node:crypto'
import { NACOS_GRPC_PORT_OFFSET, NACOS_PROTO_DESCRIPTOR } from './descriptor.ts'

/** One configuration key: the Nacos coordinate triple. */
export interface NacosConfigKey {
  /** Config id, e.g. `dsh-settings.yaml`. */
  dataId: string
  /** Config group; Nacos defaults this to `DEFAULT_GROUP`. */
  group: string
  /** Namespace id (`tenant` on the wire); the empty string is the public namespace. */
  tenant: string
}

/** Connection parameters for one Nacos server. */
export interface NacosClientOptions {
  /** Server host, without scheme or port. */
  host: string
  /** The Nacos HTTP port (8848 by default); the gRPC port is derived from it. */
  port: number
  /** Namespace id applied to keys that do not carry their own. */
  namespace?: string
  /** Username for a Nacos with auth enabled. */
  username?: string
  /** Password for a Nacos with auth enabled. */
  password?: string
  /** Access token forwarded as the `accessToken` header on every request. */
  accessToken?: string
  /** Milliseconds to wait for one unary call. Default: 10000. */
  requestTimeoutMs?: number
  /** Milliseconds to wait before retrying a dropped stream. Default: 2000. */
  reconnectDelayMs?: number
  /**
   * Milliseconds to wait for the server's `SetupAckRequest` before proceeding
   * anyway, for a server that does not negotiate abilities. Default: 1000.
   */
  setupAckTimeoutMs?: number
}

/** Callback invoked with the new content each time a watched key changes. */
export type NacosConfigListener = (content: string | undefined) => void

/** Result of one configuration read. */
export interface NacosConfigValue {
  /** Config body, or undefined when the key does not exist. */
  content: string | undefined
  /** Server-reported MD5 of the content; the empty string when absent. */
  md5: string
}

/** Payload as the two gRPC services carry it. */
interface WirePayload {
  metadata?: { type?: string; clientIp?: string; headers?: Record<string, string> }
  body?: { value?: Uint8Array }
}

/** A decoded wire payload: the Java simple class name plus its JSON body. */
interface DecodedPayload {
  type: string
  body: Record<string, unknown>
}

interface UnaryClient extends grpc.Client {
  request(
    payload: WirePayload,
    callback: (error: grpc.ServiceError | null, value?: WirePayload) => void,
  ): void
}

interface StreamClient extends grpc.Client {
  requestBiStream(): grpc.ClientDuplexStream<WirePayload, WirePayload>
}

/** One registered watch: its key, its listener, and the last MD5 we reported on. */
interface Watch {
  key: NacosConfigKey
  listener: NacosConfigListener
  md5: string
}

/** Nacos config-not-found result code; every other non-200 is an error. */
const CONFIG_NOT_FOUND = 300
const OK = 200

/** Serialize the key triple into the map key that identifies a watch. */
function watchKey(key: NacosConfigKey): string {
  return `${key.tenant} ${key.group} ${key.dataId}`
}

/** MD5 of one config body, in the lowercase hex form Nacos compares against. */
function contentMd5(content: string | undefined): string {
  if (content === undefined || content === '') return ''
  return createHash('md5').update(content, 'utf8').digest('hex')
}

/** Whether a decoded response reports success. */
function isOk(body: Record<string, unknown>): boolean {
  return body.resultCode === OK
}

/** The message a failed Nacos response carries, for error text. */
function failureMessage(body: Record<string, unknown>): string {
  const message = typeof body.message === 'string' ? body.message : undefined
  return message ?? `resultCode ${String(body.resultCode)}`
}

/** Narrow one unknown wire entry to the key fields a change notice carries. */
function noticeKey(entry: unknown): Partial<NacosConfigKey> & Pick<NacosConfigKey, 'dataId'> | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  if (typeof record.dataId !== 'string') return undefined
  return {
    dataId: record.dataId,
    ...typeof record.group === 'string' && { group: record.group },
    ...typeof record.tenant === 'string' && { tenant: record.tenant },
  }
}

/**
 * Nacos configuration client: one gRPC connection, many watched keys.
 *
 * The instance owns a unary channel and one bidirectional stream. `connect()`
 * performs the server check and connection setup; after that `read`,
 * `publish`, and `watch` are usable and the stream delivers pushes until
 * `close()`.
 */
export class NacosConfigClient {
  private readonly address: string
  private readonly namespace: string
  private readonly requestTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly setupAckTimeoutMs: number
  private readonly watches = new Map<string, Watch>()

  private unary: UnaryClient | undefined
  private stream: grpc.ClientDuplexStream<WirePayload, WirePayload> | undefined
  private streamClient: StreamClient | undefined
  private closed = false
  private reconnectTimer: NodeJS.Timeout | undefined
  /**
   * Settles when the server has registered this stream. Nacos associates a
   * connection through the bi-stream's `ConnectionSetupRequest` and answers
   * with `SetupAckRequest`; a unary call issued before that arrives is refused
   * with "Connection is unregistered", so every request awaits this first.
   */
  private registered: Promise<void> = Promise.resolve()
  private settleRegistered: (() => void) | undefined
  /** Reports a background failure (reconnect, re-registration) to the owner. */
  private onError: (error: unknown) => void = () => {}

  constructor(private readonly options: NacosClientOptions) {
    this.address = `${options.host}:${String(options.port + NACOS_GRPC_PORT_OFFSET)}`
    this.namespace = options.namespace ?? ''
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2000
    this.setupAckTimeoutMs = options.setupAckTimeoutMs ?? 1000
  }

  /**
   * Install the sink for failures that happen outside a caller's await.
   * @param handler - receives reconnect and re-registration failures.
   */
  setErrorHandler(handler: (error: unknown) => void): void {
    this.onError = handler
  }

  /**
   * Report one failure through the installed sink, for a caller layered over
   * this client that has nowhere else to send a contained failure.
   * @param error - the failure to surface.
   */
  reportError(error: unknown): void {
    this.onError(error)
  }

  /** Open the connection and complete the Nacos handshake. */
  async connect(): Promise<void> {
    const definition = fromJSON(NACOS_PROTO_DESCRIPTOR as never, { keepCase: true, defaults: true })
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      Request: new (
        address: string,
        credentials: grpc.ChannelCredentials,
        options: grpc.ClientOptions,
      ) => UnaryClient
      BiRequestStream: new (
        address: string,
        credentials: grpc.ChannelCredentials,
        options: grpc.ClientOptions,
      ) => StreamClient
    }
    const credentials = grpc.credentials.createInsecure()
    // Force this client onto its own HTTP/2 connection. grpc-js pools
    // subchannels by (target, credentials, options), so two clients built with
    // identical options share one connection and therefore one source port —
    // and Nacos identifies a client connection by that source address. The
    // second `ConnectionSetupRequest` then displaces the first's registration
    // and the server delivers every push to one stream, whose client discards
    // the keys it does not watch. The failure is silent and partial: the
    // displaced client keeps serving reads while never seeing another change.
    //
    // A harness process runs several Nacos-backed plugins (settings,
    // credentials, and any mirrored entries), so this is the normal case, not
    // an edge one. A unique option per client is what keeps the pool from
    // merging them.
    const channelOptions = { 'grpc.primary_user_agent': `dsh-nacos-client/${randomUUID()}` }
    this.unary = new loaded.Request(this.address, credentials, channelOptions)
    this.streamClient = new loaded.BiRequestStream(this.address, credentials, channelOptions)
    // The server check both proves reachability and tells the server a client
    // is about to set up; skipping it leaves the stream unassociated.
    const check = await this.call('ServerCheckRequest', {})
    if (!isOk(check.body)) throw new Error(`nacos: server check failed: ${failureMessage(check.body)}`)
    this.openStream()
    await this.registered
  }

  /**
   * Read one configuration value.
   * @param key - configuration coordinate; group and tenant default to the client's.
   * @returns the content and its MD5; content is undefined when the key is absent.
   */
  async read(key: Partial<NacosConfigKey> & Pick<NacosConfigKey, 'dataId'>): Promise<NacosConfigValue> {
    const resolved = this.resolveKey(key)
    const response = await this.call('ConfigQueryRequest', {
      dataId: resolved.dataId,
      group: resolved.group,
      tenant: resolved.tenant,
    })
    const body = response.body
    if (body.errorCode === CONFIG_NOT_FOUND || body.resultCode === CONFIG_NOT_FOUND) {
      return { content: undefined, md5: '' }
    }
    if (!isOk(body)) throw new Error(`nacos: read ${resolved.dataId} failed: ${failureMessage(body)}`)
    const content = typeof body.content === 'string' ? body.content : undefined
    return { content, md5: typeof body.md5 === 'string' ? body.md5 : contentMd5(content) }
  }

  /**
   * Write one configuration value.
   * @param key - configuration coordinate; group and tenant default to the client's.
   * @param content - the complete new body.
   */
  async publish(
    key: Partial<NacosConfigKey> & Pick<NacosConfigKey, 'dataId'>,
    content: string,
  ): Promise<void> {
    const resolved = this.resolveKey(key)
    const response = await this.call('ConfigPublishRequest', {
      dataId: resolved.dataId,
      group: resolved.group,
      tenant: resolved.tenant,
      content,
      additionMap: { type: 'yaml' },
    })
    if (!isOk(response.body)) {
      throw new Error(`nacos: publish ${resolved.dataId} failed: ${failureMessage(response.body)}`)
    }
  }

  /**
   * Watch one configuration key. The listener runs on every server push and
   * after a reconnect that found the content changed, never for a no-op.
   * @param key - configuration coordinate to watch.
   * @param listener - invoked with the new content.
   * @param currentMd5 - MD5 the caller already holds, so an unchanged key does not fire immediately.
   * @returns a disposer that deregisters the watch.
   */
  async watch(
    key: Partial<NacosConfigKey> & Pick<NacosConfigKey, 'dataId'>,
    listener: NacosConfigListener,
    currentMd5 = '',
  ): Promise<() => void> {
    const resolved = this.resolveKey(key)
    const id = watchKey(resolved)
    this.watches.set(id, { key: resolved, listener, md5: currentMd5 })
    await this.registerListen([resolved], [currentMd5])
    return () => {
      this.watches.delete(id)
      void this.deregisterListen(resolved).catch(this.onError)
    }
  }

  /** Close the connection; queued pushes are dropped and watches forgotten. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.watches.clear()
    this.stream?.end()
    this.stream = undefined
    this.unary?.close()
    this.streamClient?.close()
  }

  /** Fill in the group and namespace defaults a caller omitted. */
  private resolveKey(key: Partial<NacosConfigKey> & Pick<NacosConfigKey, 'dataId'>): NacosConfigKey {
    return {
      dataId: key.dataId,
      group: key.group ?? 'DEFAULT_GROUP',
      tenant: key.tenant ?? this.namespace,
    }
  }

  /** Headers every request carries: auth when configured, nothing otherwise. */
  private headers(): Record<string, string> {
    return {
      ...this.options.accessToken !== undefined && { accessToken: this.options.accessToken },
      ...this.options.username !== undefined && { username: this.options.username },
      ...this.options.password !== undefined && { password: this.options.password },
    }
  }

  /** Wrap a request object in the wire Payload the services carry. */
  private encode(type: string, body: Record<string, unknown>): WirePayload {
    const envelope = { ...body, headers: this.headers(), requestId: randomUUID() }
    return {
      metadata: { type, clientIp: '', headers: {} },
      body: { value: Buffer.from(JSON.stringify(envelope), 'utf8') },
    }
  }

  /** Unwrap a wire Payload into its type name and parsed JSON body. */
  private decode(payload: WirePayload | undefined): DecodedPayload {
    const type = payload?.metadata?.type ?? ''
    const raw = payload?.body?.value
    const text = raw === undefined || raw.length === 0 ? '{}' : Buffer.from(raw).toString('utf8')
    const parsed: unknown = JSON.parse(text)
    return {
      type,
      body: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {},
    }
  }

  /** Issue one unary request and decode its reply. */
  private async call(type: string, body: Record<string, unknown>): Promise<DecodedPayload> {
    const client = this.unary
    if (client === undefined) throw new Error('nacos: client is not connected')
    // The server check is what precedes registration; everything else waits.
    if (type !== 'ServerCheckRequest') await this.registered
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { reject(new Error(`nacos: ${type} timed out after ${String(this.requestTimeoutMs)}ms`)) },
        this.requestTimeoutMs,
      )
      client.request(this.encode(type, body), (error, value) => {
        clearTimeout(timer)
        if (error !== null) {
          reject(error)
          return
        }
        resolve(this.decode(value))
      })
    })
  }

  /**
   * Arm the registration barrier for one stream generation.
   *
   * A server that negotiates abilities answers the setup frame with
   * `SetupAckRequest`; one that does not answers with nothing at all, so the
   * barrier also settles on a timer. That fallback matches the reference
   * client, which sleeps a fixed interval when negotiation is unavailable —
   * without it a non-negotiating server would hang every caller forever.
   */
  private armRegistration(): void {
    let settle: () => void = () => {}
    this.registered = new Promise<void>((resolve) => { settle = resolve })
    const timer = setTimeout(settle, this.setupAckTimeoutMs)
    timer.unref()
    this.settleRegistered = () => {
      clearTimeout(timer)
      settle()
    }
  }

  /** Open the bidirectional stream and send the connection setup frame. */
  private openStream(): void {
    const client = this.streamClient
    if (client === undefined || this.closed) return
    const stream = client.requestBiStream()
    this.stream = stream
    this.armRegistration()
    stream.on('data', (payload: WirePayload) => { this.onPush(payload) })
    stream.on('error', (error: Error) => { this.onStreamDown(error) })
    stream.on('end', () => { this.onStreamDown(new Error('nacos: server closed the stream')) })
    stream.write(this.encode('ConnectionSetupRequest', {
      clientVersion: '@deepseek-ai/dsh-nacos-client',
      tenant: this.namespace,
      labels: { source: 'sdk', module: 'config' },
      abilities: { remoteAbility: { supportRemoteConnection: true } },
    }))
  }

  /**
   * Handle one server frame. A `ConfigChangeNotifyRequest` must be answered on
   * the same stream — an unanswered push makes the server consider the
   * connection unhealthy and eventually drop it.
   */
  private onPush(payload: WirePayload): void {
    const { type, body } = this.decode(payload)
    if (type === 'SetupAckRequest') {
      this.settleRegistered?.()
      return
    }
    if (type !== 'ConfigChangeNotifyRequest') return
    this.ack(body)
    const key = noticeKey(body)
    if (key === undefined) return
    // The push announces the change without carrying it; the content comes
    // from a follow-up read, which is also what re-arms the MD5 comparison.
    void this.refresh(this.resolveKey(key)).catch(this.onError)
  }

  /** Answer one server push on the stream it arrived on. */
  private ack(body: Record<string, unknown>): void {
    this.stream?.write({
      metadata: { type: 'ConfigChangeNotifyResponse', clientIp: '', headers: {} },
      body: {
        value: Buffer.from(
          JSON.stringify({ requestId: body.requestId, resultCode: OK, success: true }),
          'utf8',
        ),
      },
    })
  }

  /** Re-read one watched key and fire its listener when the content moved. */
  private async refresh(key: NacosConfigKey): Promise<void> {
    const watch = this.watches.get(watchKey(key))
    if (watch === undefined) return
    const value = await this.read(key)
    const md5 = value.md5 === '' ? contentMd5(value.content) : value.md5
    if (md5 === watch.md5) return
    watch.md5 = md5
    // Re-arm the server-side listener against the MD5 just observed; without
    // this the next change compares against a stale digest.
    await this.registerListen([key], [md5])
    watch.listener(value.content)
  }

  /** Register (or refresh) the server-side listener for a set of keys. */
  private async registerListen(
    keys: readonly NacosConfigKey[],
    md5s: readonly string[],
  ): Promise<void> {
    if (keys.length === 0) return
    const response = await this.call('ConfigBatchListenRequest', {
      listen: true,
      configListenContexts: keys.map((key, index) => ({
        dataId: key.dataId,
        group: key.group,
        tenant: key.tenant,
        md5: md5s[index] ?? '',
      })),
    })
    if (!isOk(response.body)) {
      throw new Error(`nacos: listener registration failed: ${failureMessage(response.body)}`)
    }
    // The server answers with every key whose MD5 already differs, so a change
    // that landed between the read and the registration is not lost.
    const changed = response.body.changedConfigs
    if (!Array.isArray(changed)) return
    for (const entry of changed) {
      const key = noticeKey(entry)
      if (key === undefined) continue
      void this.refresh(this.resolveKey(key)).catch(this.onError)
    }
  }

  /** Drop the server-side listener for one key. */
  private async deregisterListen(key: NacosConfigKey): Promise<void> {
    if (this.closed || this.unary === undefined) return
    await this.call('ConfigBatchListenRequest', {
      listen: false,
      configListenContexts: [{ dataId: key.dataId, group: key.group, tenant: key.tenant, md5: '' }],
    })
  }

  /**
   * Recover from a dropped stream: re-handshake, then re-register every watch
   * and re-read it. A change that landed while the stream was down produced no
   * push, so re-reading is what makes reconnection lossless.
   */
  private onStreamDown(error: unknown): void {
    if (this.closed || this.stream === undefined) return
    this.stream = undefined
    this.onError(error)
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return
      this.openStream()
      const watches = [...this.watches.values()]
      if (watches.length === 0) return
      void this.registerListen(watches.map(w => w.key), watches.map(w => w.md5))
        .then(async () => {
          for (const watch of watches) await this.refresh(watch.key)
        })
        .catch(this.onError)
    }, this.reconnectDelayMs)
  }
}
