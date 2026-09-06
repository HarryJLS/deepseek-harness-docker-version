---
description: "OceanBase and Nacos container deployment, required database configuration, audit columns, and trusted platform user isolation."
kind: "deployment-reference"
---

# Containerized Deployment

English | [中文](README.zh.md)

## Summary

The root [Dockerfile](../Dockerfile) builds the Web application. OceanBase in MySQL mode holds session logs, shared KV state, and attachments; Nacos holds deployment settings and model credentials. The container validates its database configuration before starting the `dsh` profile. The existing database is not automatically migrated.

## Contents

- [Database Configuration](#database-configuration)
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
```

These credentials are for the supplied local development stack. Use a dedicated database account for production. All fields in this example are required when using individual connection fields. A missing entry, unreachable Nacos server, invalid field, or incomplete database configuration stops startup before the application opens a pool. Database changes take effect after a container restart.

Nacos bootstrap credentials are centralized in `NACOS_AUTH` in [deployment-config.mjs](deployment-config.mjs), with the local-development example `nacos/nacos`. They are not read from operator environment variables. Do not commit real production credentials. The supplied local Nacos service has authentication disabled; setting client credentials alone does not enable server authentication.

The bootstrap writes validated values into a mode-0600 file under `/run`. Compose mounts `/run` as temporary memory. `DSH_DATABASE_SECRET` is internal transport for the already-read Nacos document, not a second configuration source; its secret-marked name also excludes it from tool subprocess environments.

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

The build context is the repository root. [docker-compose.yml](docker-compose.yml) points to the root Dockerfile and defines the application, Nacos, and OceanBase services. Start the backing services, provision the current schema, and create the required Nacos settings before starting the application.

```sh
docker compose -f deploy/docker-compose.yml up -d oceanbase nacos
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  docker compose -f deploy/docker-compose.yml up -d --build dsh
```

The Web application listens on port 3080. The local Nacos console uses 8080, its API uses 8848, and its client gRPC endpoint uses 9848. OceanBase uses 2881. The supplied Compose configuration selects the `order-svc` Nacos namespace; create that namespace or set `DSH_NACOS_NAMESPACE` to an existing one.

The default runtime base is `node:24-bookworm-slim`. When only the full Node 24 image is cached, the build accepts `--build-arg RUNTIME_BASE_IMAGE=node:24-bookworm` without changing the application or database configuration.

Only Nacos coordinates, entry names, the application listen port, and optional plugin-install settings remain operator environment inputs. Database credentials and connection options are not Compose application environment fields. Model API keys belong in `dsh-credentials.yaml`; inherited model-key environment variables retain their existing read-only precedence.

<a id="configuration-updates"></a>
## Configuration Updates

| Nacos Entry | Purpose | Activation |
|---|---|---|
| `dsh-settings.yaml` | `deployment` plus model and application settings | Database and application name require restart; supported settings update live |
| `dsh-credentials.yaml` | Model API keys and authorization grants | Live |
| `dsh-plugin-roster.yml` | Plugin package specifications and optional registry/token | Restart installs or removes roster-owned packages |
| `dsh-plugins.yml` | Patch for installed plugins | Live profile reload |
| `dsh-agents.md` | User-global instructions | Mirrored to the Harness home |

The application owns its Nacos namespace; `appName` separates its database rows from other applications. Renaming it selects another row set, not a data migration. `DSH_PLUGINS` still contributes optional package specifications alongside the Nacos roster. Installing new plugin packages requires restart because module resolution happens at profile composition.

<a id="operational-limits"></a>
## Operational Limits

- Nacos settings and credentials contain secrets. Restrict their namespace and enable server authentication for non-development deployments.
- Source-embedded example Nacos credentials are not a secret-management mechanism. A production credential must be provided through a deployment-specific secure build or an approved secret-injection design.
- Session persistence shares durable history, but live Agents and jobs remain process-local. This change does not implement distributed session execution or an authenticated multi-tenant shell sandbox.
- The original database and configuration backups must be retained until the new deployment and rollback procedure are verified.
