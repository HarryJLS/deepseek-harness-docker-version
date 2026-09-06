---
description: "OceanBase/MySQL image storage with per-user content addressing and shared normalization policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-mysql

English | [中文](README.zh.md)

## Summary

Keeps normalized source images in the database so session image references survive container replacement. Image inspection, normalization, and request variants reuse the attachment-local implementation.

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

Mount this provider instead of attachment-local. Its image policy fields and defaults match that provider. The [container deployment](../../../deploy/README.md) supplies complete database configuration from Nacos.

Rows have a Snowflake primary key and a unique `(app, user_id, sha256)` index. Reads, writes, and deduplication use the current user, with `-` when identity is absent. Different users own separate rows even for identical image bytes.

Every write supplies the [shared audit fields](../../util/mysql-schema/README.md). A duplicate upload retains row identity and creation provenance while refreshing the modifier and modification time. Reads omit soft-deleted images, and the owner can restore one by uploading it again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

dsh_attachment_object holds normalized bytes in a longblob column. Reads compare stored media type, dimensions, and byte length with the recorded reference. Deterministic model-request variants remain in a container-local temporary directory and can be regenerated from the stored image and route policy.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Attachment service](../attachment/README.md)
- [Image normalization](../attachment-local/README.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through the image bytes returned to provider request adapters; the store registers no tools and injects no prompts.

#### KV Cache effect

Unchanged image bytes and request policy produce the same request variant.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only images are supported, and database packet limits also bound individual stored objects.
- Neither unreferenced objects nor the container-local variant cache are automatically pruned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
