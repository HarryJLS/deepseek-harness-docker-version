---
description: "Store user-settings namespace sections in Nacos and receive live updates across replicas."
kind: "package-reference"
---

# @deepseek-ai/dsh-settings-nacos

English | [中文](README.zh.md)

## Summary

Keep user settings in one Nacos entry instead of a local document. Consumers continue using `ctx.settings`, including namespace defaults, composition values, and validation. Choose this provider when settings must survive container replacement or be shared across replicas.

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

Replace the existing settings provider through a profile patch:

```yaml
- id: settings
  disabled: true

- insert:
    - id: settings-nacos
      name: '@deepseek-ai/dsh-settings-nacos'
      config:
        host: nacos
        dataId: dsh-settings.yaml
```

The entry is a YAML mapping from namespace to user section. An absent, blank, or YAML-null document is empty; a non-mapping document fails. Nacos pushes update the provider without restarting the application.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Nacos server host |
| `dataId` | `dsh-settings.yaml` | Entry holding the settings document |
| `writable` | `true` | Whether this provider may publish edits |

See [shared connection fields](../nacos-client/README.md#connection-fields) and the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-settings-nacos). Set `writable: false` when operators author the document only through Nacos.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[src/index.ts](src/index.ts) connects the document before the base provider loads settings, then installs the change listener. The base settings service owns namespace registration, layered resolution, validation, and change notifications.

Writes re-read the stored document and replace one namespace section. Operations serialize within one document instance; concurrent replicas do not share that queue.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Nacos providers](../README.md)
- [User-settings service](../../settings/settings/README.md)
- [Settings subsystem](../../../docs/subsystems/settings.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through consumers of `ctx.settings` that select models or construct requests from resolved values.

#### KV Cache effect

Consumers own any request-prefix changes; storing a namespace section adds no model content by itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no local settings document to open in an editor.
- Concurrent replicas can overwrite each other's edits to the shared document, even when editing different namespaces.
- All namespaces share one entry and its server-side size limit.
- Settings hold literal values; this provider does not expand environment-variable references.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
