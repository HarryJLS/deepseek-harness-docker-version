/**
 * Nacos configuration client for the DeepSeek Harness.
 *
 * The package exposes one surface: the gRPC client that speaks Nacos's
 * client protocol, and the document abstraction the harness providers are
 * built on. Both are re-exported here rather than through subpaths, because
 * the workspace build emits one bundle per package and a subpath export would
 * name a file it never produces.
 *
 * @module @deepseek-ai/dsh-nacos-client
 */

export {
  NacosConfigClient,
  type NacosClientOptions,
  type NacosConfigKey,
  type NacosConfigListener,
  type NacosConfigValue,
} from './client.ts'

export {
  NacosDocument,
  nacosDocument,
  nacosEntrySchema,
  type NacosDocumentCodec,
  type NacosDocumentOptions,
  type NacosEntryConfig,
} from './document.ts'

export { NACOS_GRPC_PORT_OFFSET, NACOS_PROTO_DESCRIPTOR } from './descriptor.ts'
