---
description: "The MySQL/OceanBase storage backend for operators and maintainers keeping storage units in a database rather than under the harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-mysql

## Summary

`dsh-storage-mysql` registers a storage backend whose medium is three `dsh_`-prefixed tables in a MySQL-protocol database (OceanBase in MySQL mode, or MySQL) rather than a directory or a database file. Several replicas share one medium and a replaced container loses nothing, which is what makes it usable where no writable volume exists. Values are opaque JSON to this layer, so records live in `json` columns and every operation is a single statement — the contract requires each call to be atomic on the medium and durable once resolved, which a committed statement already gives.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend in place of the JSON one and point the domain layer at it. The swap is a disable, an insert, and one changed key.

```yaml
- id: storage-json
  disabled: true

- insert:
    - id: storage-mysql
      name: '@deepseek-ai/dsh-storage-mysql'
      config:
        name: mysql
        host: oceanbase
        app: order-svc

- id: storage-domain
  config:
    backend: mysql
```

Every domain owner above the hub is untouched: `ctx.storage` resolves backends by name, so the change is which name the domain layer mounts against.

`app` is what separates several deployments sharing one database. It is written into the `app` column that leads every table's primary key, and every statement this backend issues binds it — two applications writing the same unit, table, and key do not collide. Leaving it unset puts the rows under `dsh`.

The backend serves the same shared KV conformance suite as the JSON and SQLite backends, so it is substitutable in a composition. That suite runs against a live database when `DSH_TEST_MYSQL_URL` names one, alongside a case that proves two applications writing one unit stay apart.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Three tables, one medium.** `dsh_kv_unit` stamps each unit's format version, `dsh_kv_record` holds one row per record keyed by application, unit, table, and key, and `dsh_kv_global` holds the singleton slot. `key` is a MySQL reserved word, so the column is `key_name`.
- **The version stamp is the open-time check.** A unit opened under a version different from the one stamped rejects with `version-mismatch`, because a format change is something the caller must handle rather than something to migrate silently. MySQL has no `RETURNING`, so the stamp is a no-op upsert followed by a read of whatever version now stands — the row's own, whether this open or a concurrent one wrote it.
- **Every declared table appears in a snapshot.** `loadAll` seeds each declared table before reading rows, so a caller reads the unit's shape and not only its data; rows left by a table dropped from the descriptor are skipped.
- **Closing a unit does not disturb the pool.** The pool belongs to the backend, so a unit release only flips its own open flag.
- **The driver owns JSON decoding.** `mysql2` decodes a `json` column into a fresh value per row, so a stored document is never re-parsed on read — doing so would double-decode any record that is itself a JSON string.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Unit and backend implementation, table creation, and the plugin registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Storage group map](../README.md) — the hub, the data form, and the sibling backends.
- [Storage hub](../storage/README.md) — the backend contract this implements.
- [mysql-schema](../../util/mysql-schema/README.md) — the shared connection config, table prefix, and provisioning probe.
- [`deploy/schema-mysql.sql`](../../../deploy/schema-mysql.sql) — the DDL a DBA runs for a database the application may not provision.

-----

<a id="model-experience"></a>
## Model Experience

None. Storage is host-side application state; it registers no tools and writes no session events.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Both layouts store identically** — the `per-record` layout hint changes nothing here, because a row-per-record medium already has the property that layout exists to provide in a file tree.
- **No retention or vacuum** — rows for a unit whose owner is gone are never collected.
- **Isolation is only as good as the predicates** — `app` separates applications because every statement binds it. One missed predicate would read or overwrite another application's rows, where a per-database separation would have failed with a missing table instead.
- **One application per backend instance** — a deployment wanting several isolated stores mounts several rows with different `app` names.
- **No cross-unit transaction** — each call is atomic on its own; a caller needing two units to move together has no primitive for it.
