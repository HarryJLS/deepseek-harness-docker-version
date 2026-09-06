# PostgreSQL Schema Reference

English | [中文](README.zh.md)

## Summary

This is the reference copy of `@deepseek-ai/dsh-postgres-schema`, not a workspace library available to current deployments. Its source is retained under the [backup policy](../README.md).

## Table of Contents

- [Source](#source)
- [Supported library](#supported-library)
- [Dev Note](#dev-note)

<a id="source"></a>
## Source

- [Connection and schema helpers](src/index.ts)
- [Retained schema tests](tests/schema.spec.ts)
- [Retained package manifest](package.json)

The preserved TypeScript references require restoration before this copy can be compiled or tested. Its PostgreSQL schema identifiers do not describe the current row-level application isolation.

<a id="supported-library"></a>
## Supported library

Use [mysql-schema](../../packages/util/mysql-schema/README.md) for OceanBase/MySQL connection resolution, Snowflake identifiers, audit columns, and table validation.

<a id="dev-note"></a>
## Dev Note

None.
