---
description: "OceanBase/MySQL backend for durable application KV units with audit fields and soft deletion."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-mysql

English | [中文](README.zh.md)

## Summary

Registers the mysql storage backend over three shared database tables. Values are opaque JSON, and each storage call commits atomically and durably before resolving.

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

Mount this provider instead of storage-json and select `backend: mysql` on the storage domain. The backend name defaults to `mysql`, and the application name defaults to `dsh`. The [container deployment](../../../deploy/README.md) supplies connection settings from Nacos.

Units remain application-owned, not user-owned. Logical unique indexes include the application name, so identical unit/table/key values in different applications remain separate. Every row has the [shared Snowflake and audit fields](../../util/mysql-schema/README.md#isolating-several-applications-in-one-database); an absent actor is `-`.

A unit version mismatch rejects opening. Reads include every declared logical table, omit leftover tables outside the descriptor, and return fresh driver-decoded JSON values. Closing a unit rejects further operations without closing sibling units or their shared pool.

Deleting a record sets `is_deleted` to `Y`. Reads omit it, and a later upsert restores it while retaining its id, creator, and creation time. Incompatible physical tables fail startup without automatic migration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

dsh_kv_unit records unit versions, dsh_kv_record stores logical table records, and dsh_kv_global stores the global slot. MySQL reserved key names use the key_name column. The provider owns the pool; disposal unregisters the backend before closing it. [src/index.ts](src/index.ts) owns registration and SQL operations.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Storage hub](../storage/README.md)
- [Provisioning SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## Model Experience

None, as the backend stores opaque application state without adding tools or session events.

#### KV Cache effect

Consumers own any model-request changes caused by their stored values.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The per-record layout hint does not change the SQL representation.
- Soft-deleted rows are not automatically collected, and one call cannot transact across multiple storage operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
