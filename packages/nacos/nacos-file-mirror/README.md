---
description: "The Nacos-to-file mirror: how a deployment edits the global prompt and the profile's plugin layer from the Nacos console, for operators running the harness in a container."
kind: "package-reference"
---

# @deepseek-ai/dsh-nacos-file-mirror

## Summary

`dsh-nacos-file-mirror` writes Nacos entries to files on the harness host and rewrites them whenever the server pushes a change. It exists because two things a deployment needs to change without a redeploy are read from a path rather than through a capability seam: the user-global `AGENTS.md` that instruction discovery injects into every session's prompt, and a profile's `cordis.patch.yml`, which the Loader re-composes from whenever it changes. Mirroring an entry onto each path puts both under the same Nacos edit that already reaches every replica, and leaves the consumers untouched — the prompt and the plugin tree keep reading a file.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition whose files must follow a Nacos entry. It registers no service and injects nothing; the effect is entirely on the filesystem.

```yaml
- id: nacos-file-mirror
  name: '@deepseek-ai/dsh-nacos-file-mirror'
  config:
    host: nacos
    files:
      - dataId: dsh-agents.md
        path: /var/lib/dsh/AGENTS.md
      - dataId: dsh-plugins.yml
        path: /var/lib/dsh/profiles/web/cordis.patch.yml
```

Every `path` must be absolute — a relative one resolves against whatever directory the harness was started in, which is not a property of the deployment.

### What each mirrored entry reaches

| Entry writes | Read by | Takes effect |
|---|---|---|
| `$DSH_HOME/AGENTS.md` | instruction discovery, as the user-global instruction file | the next session |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | the Loader, on a profile declaring `patchReload: live` | on the reload the write triggers |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **An absent entry is not an empty one.** An empty entry is a deliberate empty file; an absent entry is a target this deployment does not own, and its path is left untouched. Writing an empty file for both would let a deployment that never created the entry clobber whatever the image shipped.
- **Every write is atomic.** Both consumers watch the file they are given, so a truncate-then-write is observable in its torn state — a half-written patch fails the composition, and nothing reports the write as the cause. The body lands on a temporary sibling and is renamed, which is atomic within one filesystem.
- **A push has nowhere to throw.** A change arrives outside any caller's control flow, so a failed write is logged and the previous content stands. The load-time write goes through the same path, so a Nacos that cannot be read leaves the deployment serviceable with the file the image shipped.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, per-entry open/read/watch, disposal |
| [`src/write.ts`](src/write.ts) | The atomic single-file write |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [nacos-client](../nacos-client/README.md) — the document abstraction this plugin holds one of per entry.
- [agent-instructions](../../context/agent-instructions/README.md) — what reads the mirrored `AGENTS.md`.
- [Container deployment guide](../../../deploy/README.md) — the deployment that mounts this.

-----

<a id="model-experience"></a>
## Model Experience

Indirect. The plugin adds no tool and no prompt of its own, but the `AGENTS.md` it mirrors is injected by instruction discovery as the user-global instruction file, so an operator editing that entry changes what every later session's model reads. The model sees the file's content under its usual instruction heading and has no way to tell it came from Nacos.

#### Token effect

Whatever the mirrored instruction file costs, once per session prompt. An operator publishing a large entry pays it on every request in every session.

#### KV Cache effect

A changed `AGENTS.md` invalidates the cached request prefix for sessions started after the write; sessions already running keep the instructions they loaded.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **The mirror is one-way** — a local edit to a mirrored path is overwritten by the next push and is never published back. Nacos is the source of truth for every mirrored file.
- **A patch entry lands one reload late on a first boot** — the Loader reads the profile patch before any plugin loads, so an entry changed while the container was down is applied by the reload the mirror's write triggers, not during the initial composition.
- **A mirrored plugin layer cannot install packages** — the patch may only name modules the profile already resolves. A roster addition still needs `DSH_PLUGINS` and a restart.
- **No entry-level access control** — every mirrored entry is read with the plugin's single set of Nacos credentials, so an operator who can edit one can edit all of them. Scope the namespace, not the entry.
