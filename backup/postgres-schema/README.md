---
description: "The shared PostgreSQL connection vocabulary and concurrency-safe schema creation, for maintainers writing a harness plugin backed by PostgreSQL."
kind: "package-reference"
---

# @deepseek-ai/dsh-postgres-schema

## Summary

`dsh-postgres-schema` holds the three things every harness PostgreSQL plugin needs before it can own a table: one declaration of how to reach the database, one rule for which schema its tables live in, and a schema create that tolerates a concurrent creator. The second exists because of a specific failure — `CREATE SCHEMA IF NOT EXISTS` is not atomic in PostgreSQL, so plugins that Cordis applies concurrently collide on the catalog's unique index the first time a deployment runs against a database whose schema does not exist yet.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when a plugin owns tables in a PostgreSQL schema. It supplies the config fields, their defaults, the pool options, and the create.

```ts
export const Config: z<Config> = z.object({
  ...postgresConnectionSchema,
  name: z.string().default('postgres'),
})

const schema = resolvePostgresSchema(config)
const pool = new pg.Pool(resolvePostgresPool(config))
await ensureSchema(pool, schema)
```

`resolvePostgresSchema` belongs at the configuration boundary: the name is interpolated into every statement the caller then issues, so a bad value must fail the plugin load rather than some later query. Call it rather than defaulting inline — a plugin that resolves the value its own way can put the same deployment's tables in two different schemas.

### Isolating several applications in one database

An explicit `schema` wins; otherwise `app` names the application and is folded into the schema identifier; otherwise the tables land in the shared `dsh` schema.

| `app` | `schema` | Tables live in |
|---|---|---|
| unset | unset | `dsh` |
| `order-svc` | unset | `order_svc` |
| `Order Service` | unset | `order_service` |
| anything | `exact` | `exact` |

Set `app` when several applications built on one image share a database. They must not share a schema: `kv_record`'s primary key is `(unit, tbl, key)` and carries no application column, so two applications writing the same unit in one schema overwrite each other. A name that cannot be folded into an identifier — one starting with a digit, or empty once folded — is rejected rather than repaired, because every repair would silently merge two distinct applications onto one schema.

The package constructs no pool itself and does not depend on `pg`; `resolvePostgresPool` returns plain options the caller hands to whatever client it uses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Losing the create race is not a failure.** The schema exists afterwards, which is the whole postcondition the caller wants. Both `42P06` (duplicate_schema) and `23505` (unique_violation) mean that; every other code propagates, so a permission failure is never mistaken for a lost race.
- **One place declares the defaults.** Host, port, database, user, pool size, and the schema rule are stated once, so every PostgreSQL plugin accepts the same fields and resolves them to the same values.
- **Folding is for the operator, rejection is for correctness.** An application name is folded so operators can spell it the way they already do, but a name that survives folding still unusable is refused — quietly repairing it would merge two applications' rows.
- **The database name is resolvable from a URL.** An identity or revision token qualified by its medium needs the database name even when the operator configured a connection string.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Identifier guard, application-name folding, schema resolution, tolerant create, connection config, pool and database resolution |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [storage-postgres](../../storage/storage-postgres/README.md), [session-persistence-postgres](../../session/session-persistence-postgres/README.md), [attachment-postgres](../../attachment/attachment-postgres/README.md) — the three consumers.
- [Container deployment guide](../../../deploy/README.md) — where these plugins are mounted.

-----

<a id="model-experience"></a>
## Model Experience

None. This package is two pure functions, one statement, and a config vocabulary.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Schema names are lowercase identifiers only** — the guard accepts `[a-z][a-z0-9_]*`, so a quoted or mixed-case schema cannot be configured. This is deliberate: the name is interpolated, not parameterized.
- **Application isolation is per-schema, not per-row** — `app` selects a schema, so cross-application queries and a shared connection pool are not available, and an operator must grant the role rights in each schema. A row-level `app` column was not chosen: it would have to enter every primary key and every statement, where one missed predicate reads another application's data.
- **No migration framework** — each consumer issues its own `CREATE TABLE IF NOT EXISTS`; there is no version table, no ordering, and no down path.
- **No connection retry** — a database that is not yet accepting connections fails the plugin load. Deployment ordering (a compose health check, an init container) owns that.
