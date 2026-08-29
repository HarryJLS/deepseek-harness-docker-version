---
description: "The Nacos-backed credentials provider for operators and maintainers serving API keys and authorization grants from a Nacos entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-nacos

## Summary

`dsh-credentials-nacos` keeps API keys and authorization grants in one Nacos configuration entry rather than `$DSH_HOME/.credentials.yaml`. A container that owns no writable volume still resolves credentials, and rotating a key in Nacos reaches every replica without a redeploy. The layering rule is unchanged and is the part that matters: the inherited process environment still wins and stays read-only, so a key supplied through the container's environment remains authoritative and a write beneath it is refused rather than silently ignored.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider in place of the local one when credentials must be shared across replicas or survive a container replacement. The swap is a disable plus an insert.

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

### The stored document

The entry is a YAML mapping with two sections: `refs` maps an environment-variable name to its value, and `records` maps a `scope/id` address to one stored credential record.

```yaml
refs:
  DEEPSEEK_API_KEY: sk-...
records:
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: ... }
```

A malformed half does not discard the other: a `records` section that is not a mapping is read as empty while `refs` still resolves, because failing the whole document would drop every credential it holds. An entry that is not a mapping at all fails loud.

### Layering

    inherited process environment   (read-only, wins)
    Nacos entry                     (writable, this provider)

`set` and `unset` reject while the process environment supplies the reference, because the write would appear to succeed while resolution kept returning the environment value.

### Security

The entry holds secrets. Scope its Nacos namespace to this deployment, and prefer a Nacos with authentication enabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Presence is the whole fact for records.** No layer ranks above the entry for records, so nothing can shadow a record write.
- **`modifyRecord` is read-decide-replace under one lock.** Two processes rotating one refresh token concurrently would otherwise lose whichever wrote first; the shared document's exclusive chain provides that serialization.
- **An empty stored value is absent everywhere.** `resolve` skips it and `describe` reports it unconfigured, so a blank never masquerades as a configured secret.
- **A reload announces what changed.** Consumers re-resolve per operation, but a reference that changed while its owner was idle still needs to reach the observers of `credentials/reference-updated`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider: document codec, layering, reference and record operations |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Nacos group map](../README.md) — the client and the settings provider.
- [Credentials service](../../credentials/credentials/README.md) — the seam this provider implements.

-----

<a id="model-experience"></a>
## Model Experience

None directly. Resolved values reach model requests only through the adapters that consume `ctx.credentials`.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Secrets sit in a configuration entry** — Nacos stores the value; this provider adds no encryption of its own. Namespace-scoped read permission is the control.
- **One entry holds every credential** — a change to any credential notifies the whole document, and entry size limits apply to the total.
- **No `.env` fallback layers** — the local provider also reads project and user `.env` files; this one layers only the process environment over the entry.
- **Same-key conflicts stay last-write-wins across replicas** — `modifyRecord` serializes within one process and re-reads before writing, but two replicas racing on one record resolve to the later write.
