---
description: "Web-profile deployment bundle selecting OceanBase persistence and Nacos configuration."
kind: "package-bundle"
---

# @deepseek-ai/dsh-bundle-docker

English | [中文](README.zh.md)

## Summary

The container entrypoint selects this bundle after base and web-app. Its Cordis patch selects providers and network policy; it exports no runtime service.

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

Use the root [Dockerfile](../../../Dockerfile) and the [deployment guide](../../../deploy/README.md). The entrypoint validates database settings from Nacos before profile composition. Nacos credentials are source-owned bootstrap values, not operator environment inputs.

The bundle replaces file-backed settings and credentials with Nacos providers, storage-json with storage-mysql, and session-persistence-jsonl with session-persistence-mysql using a Redis event cache. The storage domain selects the mysql backend. Attachment-local uses a Nacos-configured temporary directory; neither context store receives image bytes.

The server binds all interfaces on DSH_PORT, default 3080. Browser-token authentication and the Host fence are disabled for this deployment. A trusted platform gateway must authenticate users and inject X-User-Id on HTTP requests and WebSocket upgrades; absent user information uses `-`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

The patch disables replaced providers and inserts their database or Nacos replacements. Every named plugin is a declared bundle dependency. Database, Redis, and temporary-directory changes require restart, while supported settings and installed-plugin patches can update live. The entrypoint installs roster packages before the Loader resolves profile modules.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Bundle group](../README.md)
- [User identity](../../identity/user-context/README.md)

<a id="model-experience"></a>
## Model Experience

None, as the bundle selects plugins that own their model-visible content without registering prompts or tools itself.

#### KV Cache effect

The selected plugins own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The harness port must not be directly reachable by untrusted clients; a user header is not authentication or a shell sandbox.
- The bundle requires entrypoint-prepared database configuration and does not implement a production secret store.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
