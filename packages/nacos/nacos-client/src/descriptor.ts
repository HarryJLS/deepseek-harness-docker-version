/**
 * The Nacos remote wire format as a protobufjs JSON descriptor.
 *
 * Nacos serves its client protocol over gRPC only — the v1 HTTP config API
 * (and with it the long-polling listener) is gone in 3.x, leaving HTTP to the
 * admin/console surface. The wire itself is tiny: two services carrying one
 * `Payload` whose `body` is the JSON of a Java request/response object and
 * whose `metadata.type` names that object's simple class name.
 *
 * The descriptor is inline rather than a `.proto` asset so nothing has to be
 * copied next to the bundled output. Field numbers are transcribed from
 * `api/src/main/proto/nacos_grpc_service.proto` and MUST match the server.
 *
 * @module @deepseek-ai/dsh-nacos-client/descriptor
 */

/** Protobufjs JSON descriptor of `nacos_grpc_service.proto`. */
export const NACOS_PROTO_DESCRIPTOR = {
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Any: {
              fields: {
                type_url: { type: 'string', id: 1 },
                value: { type: 'bytes', id: 2 },
              },
            },
          },
        },
      },
    },
    Metadata: {
      fields: {
        type: { type: 'string', id: 3 },
        clientIp: { type: 'string', id: 8 },
        headers: { keyType: 'string', type: 'string', id: 7 },
      },
    },
    Payload: {
      fields: {
        metadata: { type: 'Metadata', id: 2 },
        body: { type: 'google.protobuf.Any', id: 3 },
      },
    },
    Request: {
      methods: {
        request: { requestType: 'Payload', responseType: 'Payload' },
      },
    },
    BiRequestStream: {
      methods: {
        requestBiStream: {
          requestType: 'Payload',
          requestStream: true,
          responseType: 'Payload',
          responseStream: true,
        },
      },
    },
  },
} as const

/**
 * Offset added to the Nacos server port to reach its gRPC listener. The server
 * derives its own gRPC port the same way, so this is protocol, not preference.
 */
export const NACOS_GRPC_PORT_OFFSET = 1000
