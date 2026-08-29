/**
 * The wire descriptor and the port derivation.
 *
 * Both are protocol facts transcribed from the Nacos server's own definitions,
 * and both fail in a way that is hard to read at runtime if they drift: a
 * wrong field number decodes to an empty payload rather than an error, and a
 * wrong offset connects to the HTTP port and hangs the handshake. Pinning them
 * here makes a drift a test failure instead of a debugging session.
 */

import { describe, expect, it } from 'vitest'
import { NACOS_GRPC_PORT_OFFSET, NACOS_PROTO_DESCRIPTOR } from '../src/index.ts'

/** The descriptor as a plain readable object; the export is deeply `as const`. */
const descriptor = NACOS_PROTO_DESCRIPTOR as unknown as {
  nested: Record<string, { fields?: Record<string, { id: number; type?: string; keyType?: string }>
    methods?: Record<string, { requestStream?: boolean; responseStream?: boolean }> }>
}

describe('nacos wire descriptor', () => {
  it('pins the Payload field numbers the server expects', () => {
    // From api/src/main/proto/nacos_grpc_service.proto: metadata = 2, body = 3.
    expect(descriptor.nested.Payload?.fields?.metadata?.id).toBe(2)
    expect(descriptor.nested.Payload?.fields?.body?.id).toBe(3)
  })

  it('pins the Metadata field numbers, which are deliberately not 1..3', () => {
    // type = 3, headers = 7, clientIp = 8 — the gaps are in the upstream proto.
    expect(descriptor.nested.Metadata?.fields?.type?.id).toBe(3)
    expect(descriptor.nested.Metadata?.fields?.headers?.id).toBe(7)
    expect(descriptor.nested.Metadata?.fields?.clientIp?.id).toBe(8)
  })

  it('carries headers as a string map', () => {
    expect(descriptor.nested.Metadata?.fields?.headers?.keyType).toBe('string')
    expect(descriptor.nested.Metadata?.fields?.headers?.type).toBe('string')
  })

  it('declares google.protobuf.Any locally so no well-known import is needed', () => {
    const any = (descriptor.nested.google as unknown as {
      nested: { protobuf: { nested: { Any: { fields: Record<string, { id: number }> } } } }
    }).nested.protobuf.nested.Any
    expect(any.fields.type_url?.id).toBe(1)
    expect(any.fields.value?.id).toBe(2)
  })

  it('declares the unary channel and the bidirectional stream', () => {
    const unary = descriptor.nested.Request?.methods?.request
    expect(unary?.requestStream).toBeUndefined()
    expect(unary?.responseStream).toBeUndefined()

    // The bidirectional stream is what carries server pushes; if either
    // direction lost its stream flag the subscription would silently become a
    // single request/response.
    const stream = descriptor.nested.BiRequestStream?.methods?.requestBiStream
    expect(stream?.requestStream).toBe(true)
    expect(stream?.responseStream).toBe(true)
  })
})

describe('NACOS_GRPC_PORT_OFFSET', () => {
  it('is the offset the server derives its own gRPC port with', () => {
    // Protocol, not preference: 8848 + 1000 = 9848.
    expect(NACOS_GRPC_PORT_OFFSET).toBe(1000)
    expect(8848 + NACOS_GRPC_PORT_OFFSET).toBe(9848)
  })
})
