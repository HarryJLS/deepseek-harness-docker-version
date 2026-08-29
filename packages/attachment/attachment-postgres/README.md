---
description: "The PostgreSQL attachment store for operators and maintainers keeping image bytes in a database rather than under the harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-postgres

## Summary

`dsh-attachment-postgres` keeps normalized image bytes in a database table, content-addressed by the same `sha256:` reference the session log records. A message that references an attachment the store cannot produce is a broken conversation rather than a degraded one, so these bytes belong wherever the deployment's durable state lives. The derived model-request variants deliberately stay on the container's own filesystem: each is a deterministic function of reference and route policy, so a replaced container regenerates identical bytes and persisting them would spend database space on a cache that costs nothing to rebuild.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this store in place of the local one when attachments must survive a container replacement.

```yaml
- id: attachment-local
  disabled: true

- insert:
    - id: attachment-postgres
      name: '@deepseek-ai/dsh-attachment-postgres'
      config:
        host: postgres
```

The image policy fields — byte, count, pixel, and dimension limits, and the normalized-image budget — accept the same values as the local store and default identically.

Image inspection, normalization, and the request ladder are reused verbatim from `dsh-attachment-local`; only the object medium differs, so admission behavior and the bytes a model sees are unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Content addressing makes deduplication a primary-key conflict.** The reference is the digest of the normalized bytes, so an identical image committed twice conflicts and the existing row stands; no logic in this package owns that.
- **Reads verify against the reference.** A stored row whose media type, byte length, or dimensions disagree with the reference the session log carries surfaces as corruption rather than silently reaching a model.
- **Only what cannot be recomputed is durable.** The variant cache root is a temporary directory created at init; losing it costs regeneration, not correctness.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Store implementation: table creation, save, verified read, and the request variant path |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Attachment service](../attachment/README.md) — the seam this store implements.
- [attachment-local](../attachment-local/README.md) — the normalization and request-ladder implementation this reuses.
- [postgres-schema](../../util/postgres-schema/README.md) — the shared connection config and schema create.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly. The bytes this store returns are what a provider request carries for an image; the store registers no tools and injects no prompts.

#### KV Cache effect

No direct invalidation; the consuming plugin owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Bytes live in a `bytea` column** — a deployment with very large images or high attachment volume should expect the database, not an object store, to carry that load. An object-store backend does not exist yet.
- **The variant cache is per-container and unbounded** — it is never pruned within a container's life; a long-lived container accumulates derived images until it is replaced.
- **No retention** — objects whose referencing sessions are gone are never collected.
- **Images only** — the seam itself is image-shaped today, so no other attachment kind is stored.
