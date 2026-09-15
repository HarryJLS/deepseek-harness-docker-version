# Agent Note: OceanBase and Redis use the shared Session format catalog

Status: implemented

English | [中文](2026-09-15-oceanbase-redis-stable-format-adapter.zh.md)

## Problem

The OceanBase provider stores Session headers and events as JSON, while Redis stores disposable event copies. If either provider reads those values as the current TypeScript types, every Session format release requires provider-specific field changes and an old Redis entry can be mistaken for a current event.

## Decision

OceanBase uses the build-static `dsh-session-format-catalog` for every database read and write. Database rows from a supported historical generation are decoded and migrated through the complete adjacent chain before the provider returns a logical Session. New rows use the catalog's current encoder. A historical Session is rewritten atomically in the current physical format before its next append; a read-only recovery does not mutate the database. A future or malformed generation is refused without interpreting its message fields.

Redis caches only current logical events. The cache key identity hash and envelope carry the installed Session format version, so entries from an earlier generation become misses rather than inputs to the current Session code while the existing key prefix remains stable. OceanBase remains authoritative for ownership, event extent, and historical recovery; Redis never performs format migration or authorization.

The provider therefore depends on the stable catalog API rather than naming V0, V1, V2, or V3 message fields in its storage logic. A future format release updates the catalog and its migration chain; the OceanBase and Redis provider code remains unchanged unless the storage policy itself changes.

## Alternatives considered

**Cast database JSON to `SessionEvent`.** This keeps the provider short but bypasses historical conversion and silently exposes physical encoding details to every storage read.

**Let Redis cache every physical database representation.** A cache entry can outlive the writer generation and cannot safely migrate a partial page. Versioned current logical entries make old values disposable and recoverable from OceanBase.

**Rewrite every historical Session during startup.** Startup would become an unbounded data migration and could make a deployment unavailable because of one unrelated old row. Lazy rewrite on the next write preserves read availability and transaction ownership.

## Consequences

Historical reads allocate the complete logical event list when the database row is not current, because adjacent migration stages can expand or renumber events. Current-format cache misses use the same catalog decoder before republishing logical pages. Existing old Redis keys are intentionally abandoned by the versioned key identity hash and expire under their previous TTL; the visible key prefix remains unchanged.

Focused adapter tests cover V0 restoration, current-format round trips, future-version refusal, and cross-generation Redis cache misses. OceanBase integration tests remain the authority for transaction-level rewrite behavior.
