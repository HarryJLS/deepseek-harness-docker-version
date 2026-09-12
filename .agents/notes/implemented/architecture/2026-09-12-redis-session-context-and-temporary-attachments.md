# Agent Note: Redis session context and temporary attachment references

Status: implemented

English | [中文](2026-09-12-redis-session-context-and-temporary-attachments.zh.md)

## Problem

Deployment replicas need a shared context cache without making a whole conversation or all of one user's sessions a growing Redis value. Temporary screenshots must not consume database or Redis capacity, and deleting a file must not silently change the model history reconstructed from the session log.

## Decision

The MySQL provider caches committed events in Redis after the SQL transaction succeeds. Reads authorize against the database header and obtain a fixed log extent before using cached event pages. A missing, corrupt, expired, or partially evicted page is read from MySQL and repopulated. Redis failures during operation do not invalidate durable writes; a configured but unreachable Redis server fails startup.

SQL serialization preserves JSON string values and keys, including NUL used in instruction identities. Replacing control characters during persistence makes a warm Redis read differ from a cold database read, so both stores retain the same logical event values.

Keys begin with `dsh-` and contain application, database, user, session, and physical-row identity. Each event has its own checksummed value; large values use bounded byte chunks, and every key expires. Nacos owns the connection, TLS, credentials, per-value limits, pipeline size, timeouts, and default two-day TTL. There is no whole-session Redis list, global user document, or binary attachment value. Events beyond the configured cache limit remain complete in MySQL.

The Docker bundle selects the local attachment provider's explicit temporary mode. Files live below a configured relative directory and are separated by user. Session references contain paths, filenames, and verified metadata. Missing files become path-only content before an Agent step; existing model history changes through ordinary source-attributed surface replacements recorded in the session log. Durable local attachment storage remains the default outside this deployment.

The [user-ownership decision](2026-09-06-oceanbase-user-ownership.md) continues to own request identity and SQL audit fields. The [durable-image decision](../feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md) continues to own normal image admission and durable defaults; temporary deployment retention is an explicit exception, not an implicit weakening of those defaults.

## Alternatives considered

**One Redis JSON value per conversation.** Long logs create large values and rewrite the complete prefix on each update. Independent bounded event values preserve incremental publication and allow partial cache recovery.

**Redis as the durable authority or authorization source.** Eviction, outages, stale keys, and row recreation cannot be allowed to grant access or lose committed history. Database ownership and log extent remain authoritative.

**Remove image payloads only during cache serialization.** This makes Redis history differ from the committed log and live model history. Attachment admission already separates bytes; file disappearance is represented by a logged replacement instead.

**Store temporary image originals in MySQL.** This defeats the deployment's file-retention policy. The selected provider writes temporary files and retains only their references in the log.

## Consequences

Redis stores rebuildable context, not live Agent ownership. Active Agents, inboxes, jobs, and streams remain process-local, so gateway session affinity and stopping the former owner are required before cross-node execution resumes. SQL locks reject overlapping event sequences but are not distributed execution leases. Cold recovery still allocates the complete logical session in the executing process.

Temporary image previews can become unavailable, and cleanup during an already-started request can fail that request. Redis TTL does not delete SQL history or clean files. Redis policy and connection changes apply on process restart. Existing SQL attachment rows are left untouched.

## Testing

Focused tests exercise cache checksums, UTF-8 chunk limits, pipeline bounds, per-key TTL, identity isolation, corrupt and missing chunks, cancellation, and transport failures. Temporary-file tests exercise relative-path validation, user isolation, recorded replacements, nested tool images, replay, and listener disposal. The keyless `temporary-image-expiry` scenario boots the shipped headless profile and continues after a recorded image file is deleted. The Redis/MySQL integration suite uses independent connections and covers warm reads, expiry refill, concurrent append rejection, soft deletion, and database-only oversized events.
