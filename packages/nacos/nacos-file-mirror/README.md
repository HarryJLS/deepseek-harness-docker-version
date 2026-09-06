---
description: "Mirror Nacos entries to local instruction and profile files for path-based consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-nacos-file-mirror

English | [中文](README.zh.md)

## Summary

Write Nacos entries to local files and replace their contents when Nacos pushes changes. Use this plugin for consumers that read a path, such as workspace instructions and live profile patches. Mirrored paths need writable local storage, but not a persistent configuration volume.

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

Mount the plugin with absolute target paths:

```yaml
- id: nacos-file-mirror
  name: '@deepseek-ai/dsh-nacos-file-mirror'
  config:
    host: nacos
    files:
      - dataId: dsh-agents.md
        path: /var/lib/dsh/AGENTS.md
      - dataId: dsh-plugins.yml
        path: /var/lib/dsh/profiles/web/cordis.patch.yml
```

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Nacos server host |
| `files` | `[]` | Entries to mirror; empty loads without file effects |
| `files[].dataId` | required | Nacos entry id |
| `files[].path` | required | Absolute destination path |

See [shared connection fields](../nacos-client/README.md#connection-fields) and the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-nacos-file-mirror). Relative paths fail at load. An absent entry leaves the target untouched; an empty entry writes an empty file.

### When changes take effect

Instruction changes are consumed through the [instruction plugin's baseline and refresh rules](../../context/agent-instructions/README.md#use-this-package), including successful filesystem touches and resume reconciliation. A profile patch reloads only when that profile enables `patchReload: live`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[src/index.ts](src/index.ts) connects, reads each entry, writes its initial content, and registers a watcher. Connection or initial read failures reject loading. File-write failures are logged and preserve the previous target; background connection and parse failures also reach the logger.

[src/write.ts](src/write.ts) writes a private temporary sibling and renames it onto the destination. Disposal closes every registered document and its watcher.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Nacos client](../nacos-client/README.md)
- [Instruction consumer](../../context/agent-instructions/README.md)
- [Container deployment](../../../deploy/README.md)

<a id="model-experience"></a>
## Model Experience

### Mirrored instruction context

#### What the model sees

The instruction consumer includes `$DSH_HOME/AGENTS.md` through its logged baseline or refresh `user/message` events; the mirror registers no prompt or tool itself.

#### Token effect

The instruction consumer owns rendering and its `maxBytes` budget; mirroring alone adds no request tokens.

#### KV Cache effect

Cache reuse follows the instruction consumer's logged baseline and refresh messages; mirroring alone sends no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Mirroring is one-way; local edits are not published and a later Nacos update can replace them.
- The Loader reads a profile patch before plugins load; a changed mirrored patch takes effect through the subsequent live reload.
- A mirrored patch cannot install missing packages; its modules must already resolve in the profile.
- Every entry uses the plugin's configured Nacos credentials; server-side permissions control which entries those credentials can read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
