---
description: "Store credential references and authorization records in Nacos below the read-only process environment."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-nacos

English | [中文](README.zh.md)

## Summary

Keep API keys and authorization records in one Nacos entry instead of a local credential file. Inherited process environment values take precedence and remain read-only. Use this provider when credentials must be shared across replicas or survive container replacement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Replace the local provider through a profile patch:

```yaml
- id: credentials
  disabled: true

- insert:
    - id: credentials-nacos
      name: '@deepseek-ai/dsh-credentials-nacos'
      config:
        host: nacos
        dataId: dsh-credentials.yaml
```

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Nacos server host |
| `dataId` | `dsh-credentials.yaml` | Entry holding references and records |

See [shared connection fields](../nacos-client/README.md#connection-fields) and the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-credentials-nacos). Restrict Nacos read and write access to trusted deployment operators; the entry contains secrets.

### Stored document

`refs` maps environment-variable names to credential values. `records` maps `scope/id` addresses to credential records.

```yaml
refs:
  DEEPSEEK_API_KEY: <provider-api-key>
records:
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: <session-secret> }
```

An absent, blank, or YAML-null document is empty. A non-mapping document fails; a malformed `refs` or `records` section is treated as empty without discarding the other section.

Reference writes reject when a nonempty process environment value would shadow them. Empty values are absent during resolution, and `set` rejects an empty string.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[src/index.ts](src/index.ts) connects, reads the document, and installs a listener before the provider becomes available. External changes replace its cached document and notify observers of changed credential references.

`modifyRecord` re-reads the document and runs the decision and publication under the document instance's exclusive queue. The queue does not coordinate other processes.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Nacos providers](../README.md)
- [Credentials service](../../credentials/credentials/README.md)
- [Container deployment](../../../deploy/README.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers of `ctx.credentials` that authorize provider requests without placing stored secrets in model content.

#### KV Cache effect

Credential storage introduces no model content; request changes remain the consuming adapter's responsibility.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider adds no encryption at rest; protect the Nacos entry and its transport.
- All credentials share one entry and its server-side size limit.
- The provider reads only the process environment above Nacos, not project or user `.env` files.
- Concurrent replicas can overwrite each other's document changes; record mutation is serialized only within one document instance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
