# Agent Note: OceanBase audit rows and request user ownership

Status: implemented

English | [中文](2026-09-06-oceanbase-user-ownership.zh.md)

## Problem

A shared platform must keep session ownership independent of application identity and database row identity. Filtering only a sidebar leaves direct reads, explicit-id adoption, cached observations, attachments, and live notifications able to expose another user's session. Database credentials split between deployment environment and remote settings also make a missing configuration capable of connecting to an unintended database.

## Decision

Every OceanBase table has a signed BIGINT Snowflake `id` and the five required audit fields. Logical identities retain unique indexes; the session's existing identifier is `session_id`, not the numeric primary key. Identifiers use binary comparison. A process shares one generator per configured worker number, retains monotonic time across clock rollback, and advances its logical millisecond on sequence exhaustion. Replicas sharing tables require distinct worker numbers and synchronized clocks.

Connection scopes authenticated gateway requests by the configured user header, with `-` for absent information. Session headers persist `userId`; forks and delegated children inherit it. Session readers enforce ownership on live and cold observations, and streams capture the admitting user. MySQL session and attachment queries include the owner; shared KV units remain application-owned. Creation provenance and row ids survive updates, while KV deletion marks a row deleted and an upsert revives it.

The container reads and validates all database connection fields from Nacos before profile preparation. Missing configuration stops startup. Bootstrap passes the validated document through a secret-named internal environment variable and a mode-0600 file under `/run`; neither is an operator configuration fallback. The source-owned Nacos credentials are local-development examples, not production secrets. Existing incompatible table layouts are rejected; data conversion is an explicit operator action against a backup, not a runtime compatibility path.

The [Redis context and temporary-attachment decision](2026-09-12-redis-session-context-and-temporary-attachments.md) extends this deployment configuration while preserving SQL ownership and audit rules.

## Alternatives considered

**List-only filtering.** Direct session addresses, search results, cached preparations, and shared event streams remain reachable without enforcement at their owning readers and writers.

**Replacing conversation identifiers with Snowflakes.** Conversation identifiers appear in durable events and both SDKs. A separate numeric row primary key satisfies the database requirement without conflating physical rows with logical sessions.

**Environment fallback for database settings.** An unavailable or incomplete Nacos entry can silently select another medium. Required startup validation makes the operator resolve the missing configuration before service readiness.

## Consequences

Session ownership protects the platform Session APIs, not the filesystem, shell, global settings, or administrator plugins. The gateway must replace user headers on HTTP and WebSocket traffic and prevent direct public access to the harness port. Unscoped Host maintenance retains access to all owners; it must not become a caller-selectable scope. Anonymous requests deliberately share the `-` owner's sessions.

Focused tests cover concurrent user scopes, live and cold denials, stream filtering, invalid Nacos fields, shell-safe secret transport, Snowflake exhaustion, and OceanBase audit writes, ownership checks, soft deletion, and transaction rollback. JSONL headers and SQLite schema 20 preserve the same optional ownership metadata; incompatible SQLite layouts are rejected.
