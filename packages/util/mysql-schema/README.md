---
description: "OceanBase/MySQL connection resolution, Snowflake row identities, audit fields, and existing-table validation."
kind: "package-library"
---

# @deepseek-ai/dsh-mysql-schema

English | [中文](README.zh.md)

## Summary

Shared helpers used by the MySQL storage, session, and attachment providers. The library constructs no connection pool and has no plugin entry; callers use its resolved options with mysql2.

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

The exported connection schema and resolve functions own host, port, database, account, pool size, application name, and Snowflake worker configuration. A configured URL takes precedence over individual connection fields. Container deployments supply all database options from [Nacos](../../../deploy/README.md#database-configuration).

<a id="isolating-several-applications-in-one-database"></a>

Every owned table has the fixed `dsh_` prefix, a signed BIGINT Snowflake primary key, and the five audit fields. Application and logical identifiers have separate unique indexes. Binary collation distinguishes differently cased application and user names; `app` is a verbatim nonempty value of at most 64 characters, defaulting to `dsh`.

Inserts explicitly write all audit fields. Updates retain the row id, creator, and creation time while refreshing the modifier and modification time. Worker numbers range from 0 through 1023; 0 is the single-replica default. All concurrent processes sharing tables require distinct worker numbers and synchronized clocks. The driver returns BIGINT values as strings.

Providers probe existing tables before issuing DDL. Existing tables must pass audit-column and primary-key checks; incompatible layouts are rejected rather than altered. A DBA can provision [schema-mysql.sql](../../../deploy/schema-mysql.sql) for a role with only DML permissions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The Snowflake generator is shared per worker within the process and retains monotonic logical time across clock rollback and sequence exhaustion. JSON serialization replaces NUL characters in string values with U+FFFD without rewriting literal escape text. Connection defaults and schema checks live in [src/index.ts](src/index.ts); audit definitions and ID generation live in [src/audit.ts](src/audit.ts).

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Session provider](../../session/session-persistence-mysql/README.md)
- [KV backend](../../storage/storage-mysql/README.md)

<a id="model-experience"></a>
## Model Experience

None, as database configuration, audit fields, and row identifiers add no model content.

#### KV Cache effect

No request-prefix changes are introduced by these helpers.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Worker-number uniqueness across processes is an operator responsibility; the library does not allocate distributed leases.
- The table prefix is fixed, and the provisioning probes require a MySQL-compatible information_schema.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
