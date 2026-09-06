# PostgreSQL Session Persistence Reference

English | [中文](README.zh.md)

## Summary

This is the reference copy of `@deepseek-ai/dsh-session-persistence-postgres`. It is outside the supported workspace and deployment composition; see the [backup policy](../README.md).

## Table of Contents

- [Source](#source)
- [Supported provider](#supported-provider)
- [Dev Note](#dev-note)

<a id="source"></a>
## Source

- [Provider wiring](src/index.ts)
- [Session store](src/store.ts)
- [Retained package manifest](package.json)

Do not mount this copy against current session data without restoring its package registration and checking the current persistence, user ownership, and audit requirements.

<a id="supported-provider"></a>
## Supported provider

Use [session-persistence-mysql](../../packages/session/session-persistence-mysql/README.md) for OceanBase/MySQL sessions. The [persistence subsystem](../../docs/subsystems/persistence.md) owns the current shared requirements.

<a id="dev-note"></a>
## Dev Note

None.
