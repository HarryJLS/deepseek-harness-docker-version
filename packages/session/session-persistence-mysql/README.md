---
description: "OceanBase/MySQL session history with bounded Redis event caching, user isolation, and database recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

English | [中文](README.zh.md)

## Summary

Stores session headers and events in two database tables through the shared persistence coordinator. A replaced container can recover the same logical history from the same application database.

The optional `redis` configuration enables shared, expiring context reads. Container deployments require this configuration from Nacos; [Redis configuration and key layout](../../../deploy/README.md#redis-cache) have one operational reference.

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

Mount this provider instead of session-persistence-jsonl. Sessions retain their logical `(app, session_id)` identity and use separate Snowflake row primary keys. The [deployment guide](../../../deploy/README.md) supplies the Nacos connection configuration.

The indexed `user_id` must match SessionHeader ownership, with `-` for absent information. Requests list and read only their own active rows; trusted unscoped maintenance can enumerate all application owners. Concurrent creation cannot change an existing owner. Delayed event writes use the durable owner as their audit actor.

The [shared schema helpers](../../util/mysql-schema/README.md) define audit fields, replica worker numbers, and startup checks. Existing incompatible tables are rejected without altering data. Soft-deleted session and event rows are excluded from reads.

MySQL commits each batch before Redis receives it. Cache misses, incomplete chunks, checksum failures, and runtime Redis failures read the affected page from MySQL without truncating history. Startup fails when a configured Redis server cannot connect. Every read still validates the database header and log extent; Redis does not grant access or make a database outage transparent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The coordinator owns buffering, preparation reuse, live adoption, repair sequencing, and shutdown quiescence. Header materialization and the first event batch commit together; a repair appends its closers in one transaction. Row-per-event transactions cannot produce a torn JSONL tail. Revision tokens include the database and application names. Recovery reads 1,000 events per keyset page, then returns the complete logical log.

Redis stores separate immutable event values, splitting oversized values into checksummed byte chunks. Every key has a sliding TTL, and physical database row identity separates recreated sessions from old cache entries. A SQL row lock and contiguous sequence check reject competing write batches. Existing live Agents still need one execution owner.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Persistence service](../session-persistence/README.md)
- [Provisioning SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

The `SessionEvent[]` restored by the coordinator; row identifiers, ownership, and audit fields do not enter model messages.

#### Token effect

Only the restored history contributes request tokens.

#### KV Cache effect

Unchanged logical history reconstructs the same request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no raw per-session artifact: locate returns nothing and supportsRawArtifacts is false.
- Paging bounds individual database results, not the complete in-memory history.
- Redis expiration does not delete database history. Distributed Agent execution and routing are not implemented by this provider; route a live session to its owning process.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
