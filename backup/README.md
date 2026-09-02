# backup/ — retired PostgreSQL adapters

The four packages here were the harness's PostgreSQL persistence layer. They are kept as a reference copy of a working implementation and are **not part of the build**: `backup/` is outside the `packages/*/*` workspace glob, so nothing installs, compiles, tests, or publishes them, and their `tsconfig.json` project references point at paths that no longer exist.

| Directory | Was |
|---|---|
| `postgres-schema` | `@deepseek-ai/dsh-postgres-schema` |
| `storage-postgres` | `@deepseek-ai/dsh-storage-postgres` |
| `session-persistence-postgres` | `@deepseek-ai/dsh-session-persistence-postgres` |
| `attachment-postgres` | `@deepseek-ai/dsh-attachment-postgres` |

Their replacements target the MySQL protocol (OceanBase in MySQL mode, and MySQL itself): [`dsh-mysql-schema`](../packages/util/mysql-schema/README.md), [`dsh-storage-mysql`](../packages/storage/storage-mysql/README.md), [`dsh-session-persistence-mysql`](../packages/session/session-persistence-mysql/README.md), and [`dsh-attachment-mysql`](../packages/attachment/attachment-mysql/README.md).

Two things changed in the move, and both are why these copies cannot be restored as-is:

- **Table names carry a `dsh_` prefix.** One database is often shared with tables the harness does not own.
- **Applications are separated by a column, not by a schema.** MySQL has no schema inside a database, so `app` leads every primary key and every predicate. The PostgreSQL packages folded an application name into a schema identifier instead, which collapsed `order-svc` and `Order Service` onto one medium.

There is no migration path between the two on-disk formats. A deployment moving from PostgreSQL to OceanBase starts against an empty database, in line with the repository's [pre-release stance](../AGENTS.md).

To bring one back, move its directory under `packages/<group>/`, restore its `tsconfig.json` references and the `tsconfig.host.json` entry, and re-add it to the bundle that mounts it.
