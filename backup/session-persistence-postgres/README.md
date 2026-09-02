---
description: "The PostgreSQL session persistence provider for operators and maintainers keeping session logs in a database rather than as files."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-postgres

## Summary

`dsh-session-persistence-postgres` keeps session event logs in two database tables rather than one JSONL artifact per session under the harness home. Session logs are the state a container can least afford to lose: a replaced replica must still resume what a user was in the middle of. The provider drives the same shared persistence coordinator as the JSONL and SQLite backends, so crash repair, live adoption, and preparation reuse are unchanged; only the medium moves. It is additionally seek-capable, so a projection resuming from a watermark reads only the suffix rather than the whole log.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider in place of the JSONL one when session history must outlive the container.

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-postgres
      name: '@deepseek-ai/dsh-session-persistence-postgres'
      config:
        host: postgres
```

Sessions created by one instance are listed and resumed by any other instance pointed at the same database. There is no per-session artifact, so `locate` returns nothing and no raw-artifact export is offered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **The coordinator owns the semantics.** `PersistenceCoordinator` owns buffering, cursors, live adoption, crash-repair sequencing, and dispose quiescence. This package implements only `PersistenceBackend` — the durable primitives — which is why the plugin body is mostly delegation.
- **A row-per-event medium has no torn tail.** A JSONL backend can crash mid-line and must hand back a marker so the fragment can be truncated; an event row either commits with its transaction or does not exist. `loadStored` therefore never returns a `tornMarker`, and `commitRepair` only appends closers.
- **Materialize and first batch commit together.** The contract requires atomicity between them, which one transaction gives directly.
- **The revision is source-qualified.** The token embeds the schema-qualified database identity, so two replicas pointed at different databases cannot mint colliding tokens.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider wiring the coordinator to the store |
| [`src/store.ts`](src/store.ts) | The durable primitives: load, revision, suffix read, append, repair, list |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence service](../session-persistence/README.md) — the seam and the coordinator contract.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — how a session log is made durable.
- [postgres-schema](../../util/postgres-schema/README.md) — the shared connection config and schema create.

-----

<a id="model-experience"></a>
## Model Experience

None directly. The log this provider stores is what every model request is reconstructed from, but the provider itself registers nothing model-facing.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No raw artifact** — `supportsRawArtifacts` is false, so the verbatim-bytes export path is unavailable; a caller wanting a file gets a reconstruction from parsed events or nothing.
- **A whole-log read loads every row** — `loadStored` has no pagination. Sessions are bounded by compaction in practice, but a very long log is one large query.
- **No retention** — sessions are never pruned; a deployment wanting a retention window owns that outside this package.
- **Header validation is shallow** — a stored header that is an object is trusted as a `SessionHeader`; a corrupted one surfaces later, at the seam that reads it.
