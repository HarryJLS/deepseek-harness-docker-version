---
description: "The shared PostgreSQL connection vocabulary and concurrency-safe schema creation, for maintainers writing a harness plugin backed by PostgreSQL."
kind: "package-reference"
---

# @deepseek-ai/dsh-postgres-schema

## Summary

`dsh-postgres-schema` holds the two things every harness PostgreSQL plugin needs before it can own a table: one declaration of how to reach the database, and a schema create that tolerates a concurrent creator. The second exists because of a specific failure — `CREATE SCHEMA IF NOT EXISTS` is not atomic in PostgreSQL, so plugins that Cordis applies concurrently collide on the catalog's unique index the first time a deployment runs against a database whose schema does not exist yet.

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

const schema = assertSchemaName(config.schema ?? 'dsh')
const pool = new pg.Pool(resolvePostgresPool(config))
await ensureSchema(pool, schema)
```

`assertSchemaName` belongs at the configuration boundary: the name is interpolated into every statement the caller then issues, so a bad value must fail the plugin load rather than some later query.

The package constructs no pool itself and does not depend on `pg`; `resolvePostgresPool` returns plain options the caller hands to whatever client it uses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Losing the create race is not a failure.** The schema exists afterwards, which is the whole postcondition the caller wants. Both `42P06` (duplicate_schema) and `23505` (unique_violation) mean that; every other code propagates, so a permission failure is never mistaken for a lost race.
- **One place declares the defaults.** Host, port, database, user, and pool size are stated once, so every PostgreSQL plugin accepts the same fields with the same values.
- **The database name is resolvable from a URL.** An identity or revision token qualified by its medium needs the database name even when the operator configured a connection string.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Identifier guard, tolerant create, connection config, pool and database resolution |

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
- **No migration framework** — each consumer issues its own `CREATE TABLE IF NOT EXISTS`; there is no version table, no ordering, and no down path.
- **No connection retry** — a database that is not yet accepting connections fails the plugin load. Deployment ordering (a compose health check, an init container) owns that.
