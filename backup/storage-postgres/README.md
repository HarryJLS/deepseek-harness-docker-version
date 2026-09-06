# PostgreSQL Storage Reference

English | [中文](README.zh.md)

## Summary

This is the reference copy of `@deepseek-ai/dsh-storage-postgres`. It is not installed or built by the current workspace; see the [backup policy](../README.md).

## Table of Contents

- [Source](#source)
- [Supported provider](#supported-provider)
- [Dev Note](#dev-note)

<a id="source"></a>
## Source

- [Storage backend](src/index.ts)
- [Retained backend tests](tests/postgres-backend.spec.ts)
- [Retained package manifest](package.json)

The retained manifest and TypeScript references are historical inputs, not a supported mount recipe. Reusing this code requires checking its storage operations against the current storage service.

<a id="supported-provider"></a>
## Supported provider

Use [storage-mysql](../../packages/storage/storage-mysql/README.md) for supported OceanBase/MySQL storage and [mysql-schema](../../packages/util/mysql-schema/README.md) for shared database requirements.

<a id="dev-note"></a>
## Dev Note

None.
