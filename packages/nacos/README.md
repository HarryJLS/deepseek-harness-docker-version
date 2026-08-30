---
description: "The Nacos group map: live configuration and credentials served from a Nacos server, for operators and maintainers deploying the harness without a writable volume."
kind: "package-group"
---

# packages/nacos

## Summary

The Nacos group lets a deployment serve the harness's live configuration from a Nacos server instead of documents under the harness home. With it, a container that owns no writable volume still resolves user settings and credentials, several replicas read one authoritative copy, and an operator editing a value in the Nacos console reaches every running instance within seconds without a restart or a redeploy. The group is optional and host-side only: it registers no tools, injects no prompts, and writes no session events, so the model never sees it. Use it when the deployment's filesystem is not durable or not shared; a single-machine composition is better served by the file-backed providers.

## Table of Contents

- [Packages](#packages)
- [What belongs here](#what-belongs-here)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`nacos-client`](nacos-client/README.md) | Speaks the Nacos gRPC client protocol and holds one entry open as a live document | none (library) |
| [`settings-nacos`](settings-nacos/README.md) | Serves the user-settings document from one Nacos entry | `ctx.settings` |
| [`credentials-nacos`](credentials-nacos/README.md) | Serves credentials from one Nacos entry, under the process environment | `ctx.credentials` |
| [`nacos-file-mirror`](nacos-file-mirror/README.md) | Writes Nacos entries to files whose consumers read a path, not a seam | none (effect only) |

-----

<a id="what-belongs-here"></a>
## What belongs here

A value belongs in Nacos when it can change while the deployment runs and the change should reach every replica. A value does NOT belong here when it must be readable before the Nacos connection exists — the bind address, the Nacos coordinates themselves, and the database URL are all in that class, and reading them from Nacos would be circular. Those stay in the composition that ships with the image.

The two providers replace the file-backed ones through their capability seams, so every consumer is unchanged: the Models page, the LLM adapters, and the agent default model all keep reading the same resolved namespaces.

Not every live value has a seam to replace. The user-global `AGENTS.md` and a profile's user patch layer are read from a path, so `nacos-file-mirror` puts them under the same Nacos edit by writing the file instead of serving the value.

-----

<a id="related-documentation"></a>
## Related documentation

- [Settings subsystem](../../docs/subsystems/settings.md) — namespaces, resolution order, and change commits.
- [User-settings service](../settings/settings/README.md) — the seam these providers implement.
- [Credentials service](../credentials/credentials/README.md) — the reference and record key spaces.
- [Container deployment guide](../../deploy/README.md) — the configuration split these packages serve.
