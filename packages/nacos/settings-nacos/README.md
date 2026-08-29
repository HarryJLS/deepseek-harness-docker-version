---
description: "The Nacos-backed settings provider for operators and maintainers serving user settings from a Nacos entry instead of a local document."
kind: "package-reference"
---

# @deepseek-ai/dsh-settings-nacos

## Summary

`dsh-settings-nacos` keeps every namespace's user settings in one Nacos configuration entry rather than a document under the harness home. A container that owns no writable volume still resolves live settings, several replicas read one authoritative copy, and an operator editing the entry in the Nacos console reaches every running instance within seconds. Because `ctx.settings` is a capability seam, swapping this provider in changes only where the document lives: the Models page, the LLM adapters, and the agent default model all keep reading the same resolved namespaces.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider in place of the file-backed one when the deployment's filesystem is not durable or not shared. The swap is a disable plus an insert, because a patch replaces a row's `config` and never its `name`.

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

### The stored document

The entry is a YAML mapping of namespace to user section — the same shape the file provider stores. An operator can edit it in the Nacos console; the change takes effect without a restart. An entry that is absent or blank is an empty document, and every namespace resolves to its defaults and composition `base`.

An entry that parses to something other than a mapping fails loud rather than being read as empty, because reading it as empty would look identical to "no settings yet" and would silently reset every namespace on the next write.

### Read-only deployments

A replica fleet that treats Nacos as the single authoring surface sets `writable: false`, which makes every configuration page read-only rather than letting one replica race another.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **The seam owns the semantics.** The base `SettingsProvider` owns namespace registration, layered resolution, validation, change detection, and the `settings/updated` commit event. This provider owns only where the raw document lives.
- **The listener is armed before the first load.** `[Service.init]` opens the watched entry before delegating to the base class, so a change published during startup is not missed.
- **Writes fold into the stored document.** A write reads the entry as currently stored and merges the section into it, so a sibling namespace another replica just wrote survives.
- **A self-write does not re-commit.** The base class's deep-equal gate drops a push that only echoes this provider's own write.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider: document codec, lifecycle, and the persist path |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Nacos group map](../README.md) — the client and the credentials provider.
- [User-settings service](../../settings/settings/README.md) — the seam this provider implements.
- [Settings subsystem reference](../../../docs/subsystems/settings.md) — namespaces, resolution order, and change commits.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers of `ctx.settings`; this provider only stores and publishes namespace sections and registers nothing model-facing itself.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No local document to open** — `documentPath` is undefined, so a configuration surface offers no "open in editor" affordance and `prepareDocument()` returns nothing.
- **Same-namespace conflicts stay last-write-wins** — the read-modify-write keeps concurrent writers from dropping each other's namespaces, but two writers editing one namespace resolve to the later write.
- **One entry holds every namespace** — a change to any namespace notifies the whole document, and Nacos entry size limits apply to the total.
- **No value indirection** — sections hold literal values; `${env:VAR}`-style references are a seam-level feature that does not exist yet.
