# PostgreSQL Attachment Reference

English | [中文](README.zh.md)

## Summary

This is the reference copy of `@deepseek-ai/dsh-attachment-postgres`. It is not an active attachment provider in the current workspace; see the [backup policy](../README.md).

## Table of Contents

- [Source](#source)
- [Supported provider](#supported-provider)
- [Dev Note](#dev-note)

<a id="source"></a>
## Source

- [Attachment store](src/index.ts)
- [Retained package manifest](package.json)

Its dependency and TypeScript references require restoration. Reusing the store also requires checking current image admission, user ownership, and database audit requirements.

<a id="supported-provider"></a>
## Supported provider

Use [attachment-mysql](../../packages/attachment/attachment-mysql/README.md) for OceanBase/MySQL attachments. The [attachment service](../../packages/attachment/attachment/README.md) owns shared image requirements.

<a id="dev-note"></a>
## Dev Note

None.
