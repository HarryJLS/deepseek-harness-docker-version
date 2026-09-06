---
description: "Read, publish, and watch Nacos configuration through a shared gRPC client and document library."
kind: "package-library"
---

# @deepseek-ai/dsh-nacos-client

English | [中文](README.zh.md)

## Summary

Read, publish, and watch Nacos configuration entries from a harness provider. `NacosDocument` adds a codec and serializes operations within one document instance. The package is a library, not a plugin to mount in `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Connection fields](#connection-fields)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use `NacosDocument` for one entry, or `NacosConfigClient` for several entries on one connection. This example reads and updates a text entry, then releases its listener and connection.

```ts
import { nacosDocument } from '@deepseek-ai/dsh-nacos-client'

const entry = nacosDocument({ host: '127.0.0.1' }, 'my-plugin.txt', {
  parse: content => content ?? '',
  render: document => document,
})
entry.setErrorHandler(console.error)
try {
  await entry.connect()
  console.log(await entry.read())
  await entry.watch(console.log)
  await entry.write(current => `${current}\nReady.`)
} finally {
  entry.close()
}
```

A long-lived provider keeps the document open until disposal. Writes re-read the entry before applying the edit; `exclusive` also allows an asynchronous decision followed by `publish`. Neither operation is a distributed lock or compare-and-swap across replicas.

<a id="connection-fields"></a>
## Connection fields

`nacosEntrySchema` supplies the connection fields that Nacos-backed plugins spread into their own schemas. Each plugin owns its data id separately.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Server host without a scheme or port |
| `port` | `8848` | HTTP port; the gRPC port is this value plus `1000` |
| `namespace` | `''` | Namespace id; empty selects public |
| `group` | `DEFAULT_GROUP` | Configuration group |
| `username`, `password` | unset | Optional Nacos authentication |
| `requestTimeoutMs` | `10000` | Timeout for one request |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[client.ts](src/client.ts) owns the handshake, reads, publishing, push acknowledgements, and reconnection. Each client uses distinct gRPC channel options so connection pooling cannot merge separate Nacos registrations. Reconnection registers watches again and re-reads their entries.

[document.ts](src/document.ts) owns parsing and the per-document operation queue. Background failures reach the installed error handler. [descriptor.ts](src/descriptor.ts) owns the inline wire descriptor and port offset.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Nacos providers](../README.md)
- [Container deployment](../../../deploy/README.md)

<a id="model-experience"></a>
## Model Experience

None, as this transport library registers no model-facing content.

#### KV Cache effect

Consumers own any request changes caused by configuration updates.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Configuration only: naming and service discovery are not implemented.
- The gRPC connection is insecure; crossing an untrusted network requires protected transport outside this client.
- Reconnection targets one configured server address; client-side server rotation is not implemented.
- Concurrent document writers in different instances can overwrite each other's changes, including changes to different sections.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
