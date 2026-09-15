# Agent Note: Upgrade the Docker distribution to Session V3

Status: implemented

English | [中文](2026-09-13-docker-session-v3-upgrade.zh.md)

## Problem

The Docker distribution extends `0.1.2-alpha.1` with OceanBase storage, Redis caching, trusted user ownership, temporary attachments, Nacos configuration, and cross-replica Web confirmation. Upstream `dsh-v0.1.5-rc.2` changes Session storage to handles and V3 records, changes transient streaming and projections, and adds general file uploads. A textual merge cannot establish that these local behaviors survive or that retained data stays unchanged.

## Decision

The Docker distribution integrates upstream `dsh-v0.1.5-rc.2`, commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`, and adopts its APIs throughout the runtime. The tested pre-upgrade checkpoints remain on `codex/upgrade-0.1.5-baseline`; deployment is separate from source integration.

The MySQL provider implements handle-based persistence with ordered appends, retained failed batches, flush/close drain, read freshness, and exclusive writer ownership. Database fencing and cross-replica cancellation remain authoritative independently of Redis eviction. Shared cumulative Assistant snapshots preserve live Web progress across replicas before durable settlement.

Upload receipts use existing KV rows and bind the user, Session, and physical database row. Missing or inaccessible Sessions fail before byte intake with `session/not-found`; database failures remain errors. Receipt consumption enters the Session log to prevent reuse after process replacement. Binary attachments stay in shared temporary files. Current JSONL retains user ownership, and Host consumers share one user-context peer instance.

The operator has chosen to retain historical conversations as an archive instead of converting or continuing them. Tables, columns, and indexes remain unchanged. New replicas use one unused Nacos `deployment.appName`; old Session and KV rows stay under the original name. This also selects empty workspace and application KV state, while Nacos settings and credentials remain reusable. No startup path changes application names, rewrites old rows, or imports historical Docker events. Database backups and the previous build remain the rollback source; committed historical JSONL generations and upstream readers are unchanged.

The [ownership](2026-09-06-oceanbase-user-ownership.md), [Redis and temporary attachment](2026-09-12-redis-session-context-and-temporary-attachments.md), [durable confirmation](2026-09-13-durable-web-confirmation.md), and [Docker CI](../process/2026-09-13-docker-ci-scope.md) decisions remain active. Their security, retention, execution, and CI-selection rationale still constrains this distribution.

## Verification

The [Docker profile test](../../../../apps/cli/tests/profiles/docker/replicas.e2e.ts) passes against isolated OceanBase, Redis, and Nacos using both the full and default slim Node 24 runtime images. The application has DML-only database permissions. Upload reaches one replica and receipt consumption the other; an observer sees cumulative streaming before settlement and after reload. The test verifies owner denial, cache eviction recovery, pending plan approval after removing the original replica, and history recovery on its replacement. Archived rows and all six table definitions remain identical.

Focused MySQL/Redis tests cover handle drain, lease fencing, cache recovery, and shared workspace updates. Upload authorization has 25 passing controller cases and four SQL receipt cases. Eleven temporary-attachment cases include logged recovery for expired Assistant images without changing original events. Nine deployment tests cover configuration and launcher argument order; CI-policy tests reject failed processes even when their file-count summary reports success.

The complete keyless headless/ACP/TypeScript SDK and corpus lane passes 131 cases with two conditional skips. Built CLI, Remote, and migration-worker checks pass 29 cases. The complete Web lane passes 353 cases across 102 files with 15 conditional skips. Current V3 recordings retain user ownership; historical generations remain unchanged.

The macOS arm64 Python executable and sidecars build successfully. The Python suite passes 118 cases with one Windows-only skip, and every keyless packaged-runtime smoke scenario passes, including minimal, advanced, and restart output comparisons. Host and Client builds, lint, documentation checks, and all 16 package hygiene checks cover the combined source.

## Alternatives considered

**Copy only selected upstream features.** Session, projection, upload, and gateway changes span shared interfaces; independent copies would retain a mixed-version runtime and duplicate future integration work.

**Replace the fork with the release tree.** This drops deployment configuration, database storage, tenant data protection, and shared confirmation rather than upgrading them.

**Rewrite the live database at startup.** This makes a failed deploy mutate its rollback source and exposes an operator-controlled data conversion to every replica.

**Convert historical Docker conversations into V3.** Continuing old conversations is outside the requested scope. Retaining their original rows avoids bespoke historical question and attachment transformations; the trade-off is that the new application cannot display or continue them.

## Consequences

The archive retains database data, not a current-browser reader or expired temporary files. Changing the application name also selects empty workspace and application KV state. Old replicas must stop before the retained rows become a stable archive, and reusing an old application name selects incompatible records. File sharing and lease ownership remain independent concerns. Upgraded data has no downgrade reader; rollback uses the preserved original application name and cannot include new V3 writes.

Source integration does not deploy the build, change Nacos entries, or archive a running application's data. The isolated tests use a controlled model; external-provider behavior and the native platform matrix remain separate checks. The Docker integration suite needs enough memory for its additional OceanBase instance and captures diagnostics before removing only its own containers and volumes.
