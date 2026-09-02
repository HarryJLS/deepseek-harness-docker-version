---
description: "The shared MySQL/OceanBase connection vocabulary, `dsh_` table prefix, per-application row scoping, and DDL-free provisioning probe, for maintainers writing a harness plugin backed by a MySQL-protocol database."
kind: "package-reference"
---

# @deepseek-ai/dsh-mysql-schema

## Summary

`dsh-mysql-schema` holds the four things every harness MySQL plugin needs before it can own a table: one declaration of how to reach the database, one prefix that keeps its tables out of a shared database's namespace, one application name that separates several deployments' rows inside one table, and one probe that lets it start against a database whose role holds no DDL rights. It targets OceanBase in MySQL mode and MySQL itself; nothing here is OceanBase-specific beyond the default port.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a plugin owns tables in a MySQL-protocol database. It supplies the config fields, their defaults, the pool options, the table names, and the provisioning probe.

```ts
export const Config: z<Config> = z.object({
  ...mysqlConnectionSchema,
  name: z.string().default('mysql'),
})

const app = resolveMysqlApp(config)
const pool = mysql.createPool(resolveMysqlPool(config))
const table = mysqlTable('kv_record')          // -> dsh_kv_record
if (!await tablesPresent(pool, [table])) { /* issue the creates */ }
```

### Isolating several applications in one database

MySQL has no schema inside a database — a schema *is* a database — so applications are separated by a column rather than by a namespace. Every harness table carries `app` as the leading primary-key column, and each plugin binds `resolveMysqlApp(config)` into every statement it issues.

| `app` | Rows are written as | An operator reads them with |
|---|---|---|
| unset | `app = 'dsh'` | `WHERE app = 'dsh'` |
| `order-svc` | `app = 'order-svc'` | `WHERE app = 'order-svc'` |
| `Order Service` | `app = 'Order Service'` | `WHERE app = 'Order Service'` |

The name is stored verbatim. It reaches SQL as a bound parameter rather than as an identifier, so there is nothing to escape, and folding it would silently merge two distinct applications' rows — `order-svc` and `Order Service` stay distinct here where a folded schema identifier collapsed both onto `order_svc`. Only the length is checked, because the column is `varchar(64)` and silent truncation would cause the same merge.

### Starting against a database you cannot provision

A production role usually holds only `SELECT`/`INSERT`/`UPDATE`/`DELETE`, and `CREATE TABLE IF NOT EXISTS` is not exempt from the privilege check: it fails on a table that already exists just as it would on one that does not. Every plugin therefore calls `tablesPresent` first and issues its creates only when a table is genuinely absent — so a fully provisioned database needs no rights at all, and a half-provisioned one still fails loudly at start rather than at first write. [`deploy/schema-mysql.sql`](../../../deploy/schema-mysql.sql) is the statement set a DBA runs.

The package constructs no pool itself and does not depend on `mysql2`; `resolveMysqlPool` returns plain options the caller hands to whatever client it uses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **A value, not an identifier.** Moving application scoping from a schema name to a column removes the whole class of identifier-folding problems: no guard, no rejection of names starting with a digit, no two applications quietly sharing a medium.
- **One place declares the defaults.** Host, port, database, user, pool size, and the application default are stated once, so every MySQL plugin accepts the same fields and resolves them to the same values.
- **One place declares the prefix.** Plugins name tables through `mysqlTable`, so `dsh_` is written once and a table cannot end up half renamed.
- **Look before you leap.** The probe reads `information_schema`, which needs no privilege beyond the connection, and is scoped to `DATABASE()` so a same-named table elsewhere cannot answer it.
- **The database name is resolvable from a URL.** An identity or revision token qualified by its medium needs the database name even when the operator configured a connection string.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Table prefixing, application-name resolution, JSON serialization, provisioning probe, connection config, pool and database resolution |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [storage-mysql](../../storage/storage-mysql/README.md), [session-persistence-mysql](../../session/session-persistence-mysql/README.md), [attachment-mysql](../../attachment/attachment-mysql/README.md) — the three consumers.
- [Container deployment guide](../../../deploy/README.md) — where these plugins are mounted.

-----

<a id="model-experience"></a>
## Model Experience

None. This package is pure resolution and serialization helpers plus one `information_schema` read.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Row scoping is only as good as the predicates** — `app` isolates applications only because every statement in every consumer binds it. One missed predicate reads or overwrites another application's rows, where a per-database separation would have failed with a missing table instead. The consumers' contract suites are what hold this.
- **`app` is bounded at 64 characters** — the column is `varchar(64)` so it stays inside InnoDB's index-length limit alongside the unit, table, and key columns that follow it in the primary key.
- **No migration framework** — each consumer issues its own `CREATE TABLE IF NOT EXISTS`; there is no version table, no ordering, and no down path.
- **No connection retry** — a database that is not yet accepting connections fails the plugin load. Deployment ordering (a compose health check, an init container) owns that.
- **No DDL is ever issued for a provisioned database** — which also means a column added to a future release's DDL will not appear on a database a DBA provisioned by hand. Schema evolution is an operator task, announced in the release notes.
