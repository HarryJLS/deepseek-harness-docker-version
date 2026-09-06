# PostgreSQL Reference Copies

English | [中文](README.zh.md)

## Summary

This directory preserves retired PostgreSQL adapters for source reference. It is outside the workspace package globs and the build, test, publish, and lint source sets. These packages are not supported deployment options.

## Table of Contents

- [Copies and replacements](#copies-and-replacements)
- [Restoration requirements](#restoration-requirements)
- [Dev Note](#dev-note)

<a id="copies-and-replacements"></a>
## Copies and replacements

The source copies remain available alongside links to the supported OceanBase/MySQL providers.

| Reference copy | Supported package |
|---|---|
| [postgres-schema](postgres-schema/README.md) | [mysql-schema](../packages/util/mysql-schema/README.md) |
| [storage-postgres](storage-postgres/README.md) | [storage-mysql](../packages/storage/storage-mysql/README.md) |
| [session-persistence-postgres](session-persistence-postgres/README.md) | [session-persistence-mysql](../packages/session/session-persistence-mysql/README.md) |
| [attachment-postgres](attachment-postgres/README.md) | [attachment-mysql](../packages/attachment/attachment-mysql/README.md) |

<a id="restoration-requirements"></a>
## Restoration requirements

The retained manifests and TypeScript references describe their original workspace locations. They do not make the copies buildable in this directory. Restoration requires a current package location, dependency and build registration, and verification against current persistence, ownership, and audit requirements.

PostgreSQL and OceanBase table layouts are not interchangeable. Follow the [deployment guide](../deploy/README.md) for the supported schema; these copies provide no automatic data conversion.

<a id="dev-note"></a>
## Dev Note

None.
