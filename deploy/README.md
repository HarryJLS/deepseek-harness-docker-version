---
description: "Nacos-managed Redis and OceanBase session storage, temporary attachments, and trusted platform user isolation."
kind: "deployment-reference"
---

# Containerized Deployment

English | [中文](README.zh.md)

## Summary

The root [Dockerfile](../Dockerfile) builds the Web application. OceanBase in MySQL mode holds session logs and shared KV state, Redis caches committed session events, and Nacos holds deployment settings and model credentials. Attachment bytes stay in temporary files, not either context store. The container validates storage configuration before starting the `dsh` profile.

## Contents

- [Database Configuration](#database-configuration)
- [Redis Cache](#redis-cache)
- [Temporary Files](#temporary-files)
- [User Isolation](#user-isolation)
- [Schema](#schema)
- [Deployment](#deployment)
- [Configuration Updates](#configuration-updates)
- [Operational Limits](#operational-limits)

<a id="database-configuration"></a>
## Database Configuration

Create `dsh-settings.yaml` in the application's Nacos namespace and `DEFAULT_GROUP`. Database configuration comes exclusively from `deployment.database`; `DSH_MYSQL_*` variables are not read. Supply either the complete individual fields below or `url` with `poolSize` and `snowflakeWorkerId`, never both connection forms. Password bytes are preserved, including spaces and shell punctuation.

```yaml
deployment:
  appName: order-svc
  database:
    host: oceanbase
    port: 2881
    database: dsh
    user: root@test
    password: dsh
    poolSize: 10
    snowflakeWorkerId: 0
  redis:
    host: redis
    port: 6379
    database: 0
    tls: false
    keyPrefix: dsh-
    ttlSeconds: 172800
    maxChunkBytes: 65536
    maxEventBytes: 4194304
    batchSize: 128
    connectTimeoutMs: 5000
    commandTimeoutMs: 2000
  attachments:
    temporaryRoot: tmp/dsh-attachments
```

These credentials are for the supplied local development stack. Use a dedicated database account for production. All fields in this example are required when using individual connection fields. A missing entry, unreachable Nacos server, invalid field, or incomplete database configuration stops startup before the application opens a pool. Database changes take effect after a container restart.

Nacos bootstrap credentials are centralized in `NACOS_AUTH` in [deployment-config.mjs](deployment-config.mjs), with the local-development example `nacos/nacos`. They are not read from operator environment variables. Do not commit real production credentials. The supplied local Nacos service has authentication disabled; setting client credentials alone does not enable server authentication.

The bootstrap writes validated values into a mode-0600 file under `/run`. Compose mounts `/run` as temporary memory. `DSH_DATABASE_SECRET` and `DSH_REDIS_SECRET` internally transport the already-read Nacos document; neither is an operator configuration fallback, and both are excluded from tool subprocess environments.

<a id="redis-cache"></a>
## Redis Cache

`deployment.redis` is required in the same Nacos entry as the database settings. `host` is mandatory; the example shows the defaults for the remaining connection and cache fields. Optional `username` and `password` configure Redis ACL authentication. `tls: true` enables certificate-verified TLS. Unknown fields, another key prefix, nonpositive TTLs, and inconsistent byte limits reject startup. Connection and cache-policy changes take effect after restarting the application.

All keys begin with `dsh-` and separate application, database, user, session, and physical database row. Components are percent-encoded; the row hash prevents an old cache entry from being reused after the same session ID is recreated.

```text
dsh-<app>:db:<database>:user:<user>:session:<session>:{<row-hash>}:event:<seq>
dsh-<app>:db:<database>:user:<user>:session:<session>:{<row-hash>}:event:<seq>:part:<n>
```

Each Redis string is at most `maxChunkBytes`, including its JSON wrapper. Large events are split into checksummed byte chunks; pipeline size is bounded by `batchSize`. Events larger than `maxEventBytes` remain complete in MySQL and bypass Redis. There is no growing per-user or per-session list, hash, or whole-conversation value. Each accessed or written key receives `ttlSeconds`, default 172800 seconds (2 days); expiration does not delete database history.

MySQL commits before cache publication. Every read checks the database's user ownership and log extent, then reads the event pages from Redis. Expired, missing, malformed, or partially evicted pages reload from MySQL and refill Redis. Runtime Redis failures also use MySQL; startup still requires the configured Redis server. The supplied development Redis disables snapshots and AOF, limits memory to 256 MiB, and uses `allkeys-lru`; losing the complete cache is recoverable.

<a id="temporary-files"></a>
## Temporary Files

`deployment.attachments.temporaryRoot` chooses a subdirectory relative to the service's working directory (`/app` in the container), default `tmp/dsh-attachments`. Absolute paths, parent traversal, and the working directory itself are rejected. Compose mounts the default `/app/tmp/dsh-attachments` path as temporary memory; deployments choosing another directory own its cleanup and mount policy.

Image references contain the relative path, filename, and small verified metadata needed for rendering and integrity checks. Image bytes, base64 uploads, and generated request-image files do not enter Redis or MySQL. Ordinary file mentions already record paths; tool-produced text remains in the session log because it is model-visible output, not a stored file object.

Before an Agent step, a missing temporary image becomes a recorded path-only replacement. The model can continue without the file; inspecting the image again requires reattachment or a shared temporary filesystem that still contains it. Historical image preview may report the file missing. A cleanup during an already-started image request can still fail that request. Existing database attachment rows are not deleted or migrated.

<a id="user-isolation"></a>
## User Isolation

The container's Connection configuration trusts `X-User-Id`. A platform gateway must authenticate users, replace incoming client-supplied identity headers, and forward the resulting header on both HTTP requests and WebSocket upgrades. Do not expose the harness port directly to untrusted clients: possession of an arbitrary header is not authentication.

User IDs are case-sensitive and limited to 32 characters. Missing or empty information uses `-`; all anonymous clients intentionally share that owner's sessions. Invalid or ambiguous headers are rejected. The identity is persisted in the session header and `user_id` columns, and inherited by forks and delegated child sessions.

Lists, search, history, direct session actions, attachment reads, workspace session IDs, and session event/control streams enforce the requesting user's ownership. Guessing another user's session ID does not grant access. A WebSocket retains the identity admitted during its upgrade; the gateway must close existing connections when changing the authenticated account.

This is session-data isolation. Application settings, workspace registrations, filesystem access, shell execution, administrator plugins, and unscoped Host maintenance are not tenant sandboxes. Those capabilities require separate platform authorization or isolated execution environments.

<a id="schema"></a>
## Schema

[schema-mysql.sql](schema-mysql.sql) is the DBA provisioning script for the six `dsh_` tables. Every table has a signed `BIGINT id` generated as a Snowflake and these fields:

```sql
is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
creator      varchar(32) NOT NULL COMMENT '创建者',
gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
modifier     varchar(32) NOT NULL COMMENT '更新者',
gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间'
```

Every insert explicitly supplies the audit columns. Updates preserve creation provenance and row identity while recording the modifier and modification time. Logical uniqueness remains enforced independently of the numeric primary key. `dsh_session.session_id` retains the existing conversation identifier. Session and attachment records also store `user_id`; shared KV units remain application-owned. Binary collation prevents case-folded application or user collisions.

KV deletion is a soft delete; a later upsert restores the row. Session and attachment reads ignore soft-deleted rows. There is no automatic retention policy. Snowflake values are passed as decimal strings, without conversion through JavaScript numbers. Each concurrently running replica sharing tables needs a distinct `snowflakeWorkerId` from 0 through 1023 and a synchronized system clock.

Providers inspect existing tables without requiring DDL permissions. Missing tables can be created by a privileged role; incompatible existing tables cause an explicit startup error. Back up the old database and perform an operator-reviewed conversion or provision a new database before changing the Nacos database name. Re-running `CREATE TABLE IF NOT EXISTS` does not upgrade an old table.

<a id="deployment"></a>
## Deployment

The build context is the repository root. [docker-compose.yml](docker-compose.yml) defines the application, Redis, Nacos, and OceanBase services. Start the backing services, provision the current schema, and create the required Nacos settings before starting the application.

```sh
docker compose -f deploy/docker-compose.yml up -d oceanbase nacos redis
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  docker compose -f deploy/docker-compose.yml up -d --build dsh
```

The Web application listens on port 3080. The local Nacos console uses 8080, its API uses 8848, and its client gRPC endpoint uses 9848. OceanBase uses 2881. The supplied Compose configuration selects the `order-svc` Nacos namespace; create that namespace or set `DSH_NACOS_NAMESPACE` to an existing one.

The default runtime base is `node:24-bookworm-slim`. When only the full Node 24 image is cached, the build accepts `--build-arg RUNTIME_BASE_IMAGE=node:24-bookworm` without changing the application or database configuration.

Only Nacos coordinates, entry names, the application listen port, and optional plugin-install settings remain operator environment inputs. Database and Redis credentials and connection options are not Compose application environment fields. Model API keys belong in `dsh-credentials.yaml`; inherited model-key environment variables retain their existing read-only precedence.

<a id="configuration-updates"></a>
## Configuration Updates

| Nacos Entry | Purpose | Activation |
|---|---|---|
| `dsh-settings.yaml` | `deployment` plus model and application settings | Database, Redis, temporary files, and application name require restart; supported settings update live |
| `dsh-credentials.yaml` | Model API keys and authorization grants | Live |
| `dsh-plugin-roster.yml` | Plugin package specifications and optional registry/token | Restart installs or removes roster-owned packages |
| `dsh-plugins.yml` | Patch for installed plugins | Live profile reload |
| `dsh-agents.md` | User-global instructions | Mirrored to the Harness home |

The application owns its Nacos namespace; `appName` separates its database rows from other applications. Renaming it selects another row set, not a data migration. `DSH_PLUGINS` still contributes optional package specifications alongside the Nacos roster. Installing new plugin packages requires restart because module resolution happens at profile composition.

<a id="operational-limits"></a>
## Operational Limits

- Nacos settings and credentials contain secrets. Restrict their namespace and enable server authentication for non-development deployments.
- Source-embedded example Nacos credentials are not a secret-management mechanism. A production credential must be provided through a deployment-specific secure build or an approved secret-injection design.
- Session context is shared through Redis and MySQL, but live Agents, inboxes, streams, and jobs remain process-local. The gateway must keep an active session on its owning process; this cache is not distributed execution, a writer lease, or a multi-tenant shell sandbox. Stop the old owner before resuming on another node.
- The original database and configuration backups must be retained until the new deployment and rollback procedure are verified.
