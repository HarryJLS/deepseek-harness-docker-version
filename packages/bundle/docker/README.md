---
description: "The container-deployment bundle for operators composing the harness against Nacos and PostgreSQL without a writable volume."
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-docker

## Summary

`dsh-bundle-docker` is the configuration layer a containerized deployment selects. It binds every interface, opens both request gates, and replaces each filesystem-backed provider with one backed by Nacos or PostgreSQL, so a container that owns no writable volume keeps nothing locally that it cannot afford to lose. The package ships no runtime code: its substance is `cordis.patch.yml`, and its `dependencies` are load-bearing because the Loader resolves each row's plugin module by package name.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

List the bundle last in a profile's `dsh.profile.bundles`, after `@deepseek-ai/dsh-base` and the mode bundle, so its rows override the ones they restate.

```json
{ "dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-bundle-docker"
] } } }
```

Connection details come from the environment, so one image serves every environment. The [deployment guide](../../../deploy/README.md) lists every variable.

### What it changes

| Row | Change |
|---|---|
| `webserver` | binds `0.0.0.0` on `DSH_PORT` |
| `connection` | accepts every Host and requires no browser session |
| `settings` | replaced by `settings-nacos` |
| `credentials` | replaced by `credentials-nacos` |
| `storage-json` | replaced by `storage-postgres`, with `storage-domain` remounted |
| `session-persistence-jsonl` | replaced by `session-persistence-postgres` |
| `attachment-local` | replaced by `attachment-postgres` |

### Access

Both request gates are open: any client that can reach the published port drives an agent with shell access, with no authentication in front of it. Publish that port only onto a network that already answers for access. Setting `requireAuth: true` and dropping `allowAnyHost` on the `connection` row restores the browser-session token and the Host fence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Static and live are split by one rule.** A value needed before a remote configuration source can be contacted — the bind, the Nacos coordinates, the database URL — must ship with the image, because reading it from Nacos would be circular. Everything else belongs in Nacos.
- **Dependencies are load-bearing.** The Loader resolves a row's module from the profile directory, whose module fallback mirrors the installation's dependency closure. A plugin named in the patch without a dependency entry fails boot with a module-resolution error, which is what the package test asserts.
- **A swap is a disable plus an insert.** A patch replaces a row's `config` and never its `name`, and two providers of one service would both mount and collide.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The layer: bind, access gates, and the five provider swaps |
| [`src/index.ts`](src/index.ts) | Module doc only; the package carries no runtime API |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Container deployment guide](../../../deploy/README.md) — running the stack and changing it without a redeploy.
- [Nacos group map](../../nacos/README.md) — the live-configuration providers this bundle selects.
- [Bundle group map](../README.md) — the other profile bundles.

-----

<a id="model-experience"></a>
## Model Experience

None. The bundle is a configuration layer; it registers no tools and injects no prompts. What the model sees is decided by the rows it selects, which are unchanged from the base composition.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the bundle is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Access is open by construction** — the bundle exists to serve a container behind its own network boundary, so it cannot be used as-is where the port is reachable by untrusted clients.
- **One database and one Nacos for everything** — every swapped provider points at the same server; splitting them across servers means overriding the inserted rows in a later layer.
- **No secret indirection** — credentials reach the Nacos entry as literal values, and the database password reaches this layer from the environment.
- **The plugin roster applies at start** — changing `DSH_PLUGINS` requires a restart, unlike the settings and credentials entries which apply live.
