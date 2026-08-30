---
description: "The Nacos gRPC client for maintainers building or debugging a harness plugin backed by Nacos configuration."
kind: "package-reference"
---

# @deepseek-ai/dsh-nacos-client

## Summary

`dsh-nacos-client` speaks the protocol a Nacos server actually offers its clients. Nacos 3.x removed the v1 HTTP config API, so a client that wants change PUSH rather than polling must use gRPC; this package owns that conversation and exposes it as read, publish, and watch. Above it, `NacosDocument` holds one entry open as a live document: read once, updated by every server push, and written as a read-modify-write behind every earlier write. Reconnection is part of the contract — a dropped stream re-handshakes, re-registers every watch, and re-reads each watched key, because a change that landed while the stream was down produced no push.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package to build a harness plugin whose configuration lives in Nacos. Most plugins want `NacosDocument` rather than the raw client: it already owns the connection, the watch, and the write serialization, leaving the plugin to supply a codec and decide what a change means.

```ts
const entry = nacosDocument(config, 'my-plugin.yaml', { parse, render })
const current = await entry.open(next => applyChange(next))
await entry.write(document => ({ ...document, section: value }))
```

`nacosEntrySchema` is the schemastery field set for the connection half of a plugin's config, so every Nacos-backed plugin accepts the same fields with the same defaults and the same secret marking.

The raw `NacosConfigClient` is for a caller that needs several entries on one connection, or a request the document abstraction does not expose.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **The wire proto is inline.** `descriptor.ts` carries the protobufjs JSON descriptor transcribed from the server's own `nacos_grpc_service.proto`, so no `.proto` asset has to travel next to the bundled output. Field numbers must match the server exactly; a wrong one decodes to an empty payload rather than an error, which is why they are pinned by test.
- **Registration is a barrier.** Nacos associates a connection through the bi-stream's `ConnectionSetupRequest` and answers with `SetupAckRequest`. A unary call issued before that arrives is refused with "Connection is unregistered", so `connect()` waits for the ack — with a timer fallback for a server that does not negotiate abilities, matching the reference client.
- **A push must be acknowledged.** An unanswered `ConfigChangeNotifyRequest` makes the server treat the connection as unhealthy and eventually drop it.
- **A push announces, it does not carry.** The change notice names the key; the content comes from a follow-up read, which is also what re-arms the MD5 comparison.
- **Writes are read-modify-write.** One entry backs every section its owner holds, so rendering from a locally cached copy would drop whatever another replica published in between.

### Source map

| File | Role |
|---|---|
| [`src/client.ts`](src/client.ts) | The gRPC client: handshake, read, publish, watch, push acknowledgement, reconnect |
| [`src/document.ts`](src/document.ts) | One entry as a live document, plus the shared connection config and its schema |
| [`src/descriptor.ts`](src/descriptor.ts) | The wire proto as a protobufjs JSON descriptor, and the gRPC port offset |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Nacos group map](../README.md) — the providers built on this client.
- [Container deployment guide](../../../deploy/README.md) — how a deployment configures the entries.

-----

<a id="model-experience"></a>
## Model Experience

None. This package registers nothing model-facing; it is a transport library.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

### One connection per client

Every client forces its own HTTP/2 connection by passing a unique channel option. grpc-js pools subchannels by (target, credentials, options), Nacos identifies a client connection by its source address, and a harness process runs several Nacos-backed plugins at once — so clients built with identical options share a connection, share a registration, and the one the server displaces goes silently deaf: it keeps answering reads while never seeing another change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Configuration only** — the naming and service-discovery halves of Nacos are not implemented; this client speaks the config protocol.
- **No transport security** — the connection is insecure gRPC. A deployment crossing an untrusted network needs a sidecar or a service mesh.
- **One server, no cluster failover** — the client connects to the configured address and reconnects to it. A Nacos cluster behind one address works; client-side server-list rotation does not exist.
- **MD5 comparison, not content diffing** — a listener fires on any change to the entry, so a plugin holding several sections in one entry re-reads all of them when any one changes.
