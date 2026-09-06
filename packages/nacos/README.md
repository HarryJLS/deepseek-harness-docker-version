---
description: "Nacos-backed settings, credentials, and file mirrors for container deployments."
kind: "package-group"
---

# packages/nacos

English | [中文](README.zh.md)

## Summary

Use Nacos to share settings, credentials, and selected configuration files across harness replicas. These packages remove the need for a persistent local configuration volume; file mirrors still need writable local paths. Settings and credential consumers keep using their existing services.

## Table of Contents

- [Packages](#packages)
- [Configuration ownership](#configuration-ownership)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose a provider for a service-backed document or a mirror for a path-based consumer.

| Package | Purpose | Service |
|---|---|---|
| [nacos-client](nacos-client/README.md) | Read, publish, and watch configuration entries over gRPC | Library |
| [settings-nacos](settings-nacos/README.md) | Store user-settings namespace sections | `ctx.settings` |
| [credentials-nacos](credentials-nacos/README.md) | Store credential references and records below the process environment | `ctx.credentials` |
| [nacos-file-mirror](nacos-file-mirror/README.md) | Materialize entries for consumers that read files | No service |

-----

<a id="configuration-ownership"></a>
## Configuration ownership

Nacos connection coordinates must be available before contacting Nacos. Database configuration is different: the container bootstrap reads `deployment.database` from Nacos before starting database providers, as described in the [deployment guide](../../deploy/README.md#database-configuration).

Settings and credentials receive live updates through their providers. Mirrored files take effect when their consumers read or reload them. Database connection changes require an application restart; storing a value in Nacos does not by itself make that value reloadable.

<a id="related-documentation"></a>
## Related documentation

- [Settings subsystem](../../docs/subsystems/settings.md)
- [Credentials service](../credentials/credentials/README.md)
- [Container deployment guide](../../deploy/README.md)

<a id="dev-note"></a>
## Dev Note

None.
