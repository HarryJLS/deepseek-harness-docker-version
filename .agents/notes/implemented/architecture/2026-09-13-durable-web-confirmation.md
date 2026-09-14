# Agent Note: Durable Web confirmation across replicas

Status: implemented

English | [中文](2026-09-13-durable-web-confirmation.zh.md)

## Problem

Sharing a session log does not make a live question callback available on another process. A load balancer can send a user's confirmation to a different replica, and a restart removes the original callback. Sequential proposal, confirmation, file-preview, and follow-up work must resume from recorded facts without node addresses or a second approval database.

## Decision

The Docker composition enables durable delivery in the user-questions service. `exit_plan_mode` and `ask_user_question` append the complete pending question to the existing session event log and conclude their turn. The question's identity and event-sequence version name the exact card. A later unary `session.answerQuestion` request records the decision and admits the next user input. The same Web question and plan-review components render the pending projection, including after reconnect or process replacement.

The MySQL persistence provider exposes optional shared execution. Session API mutations and Agent-addressed unary gateway calls acquire a renewable reservation before activating or recovering a session. The API releases its Agent handle after the activity and buffered writes stop. Read-only history follows committed database/Redis events without publishing a local Agent or synthesizing interruption during another replica's live turn.

Reservations occupy small rows in the existing application-scoped KV table. Database time determines expiry. Every event-writing transaction locks and checks the current reservation before inserting events. A stale writer cannot commit or delete a successor's reservation. Cancellation travels through the same shared record. Timings and question payload limits come from the application's Nacos deployment document.

Workspace metadata uses short MySQL unit transactions. Each mutation refreshes an isolated domain snapshot while the application/unit row is locked; all record and order changes commit together before cache publication. Workspace lookups and streams refresh committed state across replicas, including newly created workspaces and concurrent session attachments. This avoids requiring a process restart merely to enter the confirmation workflow.

Questions retain JSON text, choices, identity, and version. Files remain in the deployment's shared temporary filesystem; the context carries references, not binary objects. Redis retains its bounded per-event cache and two-day default TTL. The [Redis decision](2026-09-12-redis-session-context-and-temporary-attachments.md) owns cache publication, authorization, chunking, and temporary attachments. The [question UI](../../../../packages/client/ui-user-questions/README.md) defines the card and answer encoding.

## Alternatives considered

**Route every confirmation to its original process.** This requires an addressable owner and keeps confirmation dependent on a process that may disappear. The deployment cannot control load-balancer affinity.

**Store a process callback in Redis.** A callback contains execution state and cannot be reconstructed from JSON. Recording the question and accepting a new command avoids retaining that execution.

**Add a separate proposal and approval schema.** The existing session event JSON already owns the history and supports domain projections. A second schema would duplicate the proposal and its recovery rules.

**Use the evictable Redis cache as the sole execution lock.** Eviction or cache loss could admit a second writer. Database reservations and write-time fencing keep cache recovery independent of execution authority.

## Consequences

Pending questions survive restarts without a waiting Agent. Concurrent mutations report busy rather than entering competing loops; repeated completed confirmations do not run again. The Web history stream adds whole projection/running-state frames derived from committed events. Local permission-approval waterfalls, delegated jobs, persistent terminals, and arbitrary plugin resources remain process-local and are not made transferable by this mode.

The reservation protects session commits, not exactly-once external side effects. A crash during an upload or API call can leave its outcome uncertain; those integrations require their own idempotency keys and reconciliation. NAS cleanup and database history retention are independent. Replica Snowflake worker numbers must remain distinct.

## Testing

Focused tests cover pending-turn completion, cold reconstruction, version and option validation, refusal, discussion, duplicate decisions, Client card restoration, and failed submission retry. Independent OceanBase connections exercise exclusion, renewable ownership, stale-writer fencing, successor-safe release, cancellation, and user isolation. TypeScript and Python SDK tests share expected pending/decided event payloads and verify lossless notification delivery.
