---
description: "Trusted platform user identities for HTTP requests, session ownership, database audit actors, and asynchronous streams."
kind: "package-library"
---

# @deepseek-ai/dsh-user-context

English | [中文](README.zh.md)

## Summary

This library carries a platform user identity through asynchronous Host operations. Connection admits the identity from a configured trusted proxy header; Session APIs and MySQL providers use it to check ownership and record audit actors. Missing user information resolves to `-`. The client-safe `./identity` entry contains identifier validation without Node dependencies.

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

`parseUserId` accepts one case-sensitive identifier of at most 32 characters. Missing, null, and empty external values resolve to `-`; padded strings, control characters, commas, and non-string values are rejected. `withUser` scopes one operation and its asynchronous descendants. `userScopedIterable` retains the admitting identity across lazy iteration and cleanup.

`requestUserId` distinguishes a request from unscoped Host maintenance. `currentUserId` supplies the audit actor, using `-` outside requests. `canAccessUser` permits a scoped request only when its identity matches the durable owner; metadata without an owner belongs to `-`. Unscoped Host maintenance can enumerate all owners, so request handlers must never clear their scope to return unrestricted data.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

Node AsyncLocalStorage isolates concurrent requests without a mutable process-wide current user. Session metadata carries ownership across restarts, forks, and delegated child sessions. Persistence writers use that metadata for delayed writes instead of the identity of whichever request is active when a batch flushes.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md) owns trusted-header admission.
- [Session Controller](../../api/session-controller/README.md) owns browser Session operations.
- [Container deployment](../../../deploy/README.md) describes Nacos and platform integration.

<a id="model-experience"></a>
## Model Experience

None, as request identity and storage ownership add no prompts, tools, or conversation events.

#### KV Cache effect

None; user ownership is storage metadata, not model-request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The header is not authentication. A trusted gateway must authenticate the user and replace client-supplied identity headers on HTTP requests and WebSocket upgrades.
- Session ownership does not isolate filesystem access, shell execution, application settings, or administrator code running in the Host process.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

The [ownership decision](../../../.agents/notes/implemented/architecture/2026-09-06-oceanbase-user-ownership.md) records the distinction between request access and Host maintenance.

</details>
