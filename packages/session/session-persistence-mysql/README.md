---
description: "OceanBase/MySQL session history with bounded Redis event caching, user isolation, and database recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

English | [中文](README.zh.md)

## Summary

Recover session history from the same application database after replacing a container. Per-session handles create, read, append, flush, and close logs stored in two database tables; the provider writes the installed current format and exposes the same logical format after reading supported historical generations.

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

The [shared schema helpers](../../util/mysql-schema/README.md) define audit fields, replica worker numbers, and startup checks. Existing incompatible tables are rejected without altering data. Soft-deleted sessions are invisible; a deleted event inside a committed prefix rejects the read rather than returning a history with gaps.

`create` returns an exclusive write handle whose empty session is initially visible only to this provider. The first append or explicit flush materializes it. Closing a creation that never appended or flushed erases that pending identity. `open(id, 'read')` does not activate an Agent or repair history; `open(id, 'write')` validates the stored log and reserves its writer. Reads return detached events and honor offset and length. The logical header and exact inherited prefix survive reopen.

`writeBatchMaxDelayMs` controls the fixed live-event coalescing window, default 200 ms and range 1 through 60000. `session/flush`, a write handle's `flush`, and service-wide `flush` drain pending batches immediately. Failed automatic writes retain their events and pause the timer until an explicit retry. Handle close and provider teardown drain accepted work before releasing ownership or database connections; failures remain visible. The provider reads supported historical rows through the shared adjacent format catalog and returns only the current logical format. A later write rewrites that session atomically in the current format; unsupported future generations are refused without interpretation. [Retained data](../../../deploy/README.md#retained-data) stays under a separate application name.

MySQL commits each batch before Redis receives it. Cache misses, incomplete chunks, checksum failures, and runtime Redis failures read the affected page from MySQL without truncating history. Startup fails when a configured Redis server cannot connect. Every read still validates the database header and log extent; Redis does not grant access or make a database outage transparent.

The optional `execution` configuration supplies `sharedExecution` for request-scoped Web work. It uses the existing KV record table for renewable, database-timed reservations and fences event writes in the same transaction. [Shared confirmation](../../../deploy/README.md#shared-confirmation) documents Nacos timings, replica identity, NAS, and supported workflows.

When file uploads are mounted, completed receipts use existing KV rows without binary data. Missing, foreign, deleted, and subagent Sessions return an authorization miss; database failures remain errors. The [upload service](../../client/file-upload/README.md) rejects unauthorized transfers before storing bytes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The provider owns handle tracking and live-event routing; each handle serializes its mutations and retains its failed batches. Header materialization and the first event batch commit together. Row-per-event transactions cannot produce a torn JSONL tail. Resume owns semantic interruption repair through ordinary handle appends. Revision tokens include database, application, and physical-row identity. Recovery reads at most 1,000 events per keyset page; a read open inspects metadata without loading the body.

Redis stores separate immutable current-format event values, splitting oversized values into checksummed byte chunks. Every key has a sliding TTL, and the hashed key identity plus the current Session format version separates recreated sessions and old cache generations without changing the existing key prefix. A SQL row lock and contiguous sequence check reject competing write batches. With `execution` configured, an expired or superseded reservation also rejects the transaction.

No runtime invariant companion is published: SQL transaction outcomes, cross-connection visibility, and lease fencing require database integration tests rather than a second in-process copy of the writer's state.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Persistence service](../session-persistence/README.md)
- [Provisioning SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

The stored `SessionEvent` records restored through a handle; row identifiers, ownership, and audit fields do not enter model messages.

#### Token effect

Only the restored history contributes request tokens.

#### KV Cache effect

Unchanged logical history reconstructs the same request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no raw per-session filesystem artifact; handle reads provide the logical log.
- Paging bounds individual database results, not the complete in-memory history.
- Redis expiration does not delete database history. Shared execution requires the existing KV table. Write handles acquire a reservation unless an API operation already owns it; a borrowed reservation remains with the operation until its Agent stops. Arbitrary live plugin resources are not transferable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
