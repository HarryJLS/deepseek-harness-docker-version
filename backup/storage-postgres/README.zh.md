# PostgreSQL 存储参考

[English](README.md) | 中文

## 概述

这是 `@deepseek-ai/dsh-storage-postgres` 的参考副本。当前工作区不安装或构建此包，详见[备份说明](../README.zh.md)。

## 目录

- [源码](#source)
- [受支持的提供方](#supported-provider)
- [开发备注](#dev-note)

<a id="source"></a>
## 源码

- [存储后端](src/index.ts)
- [保留的后端测试](tests/postgres-backend.spec.ts)
- [保留的包清单](package.json)

保留的包清单和 TypeScript 引用是历史输入，不是受支持的挂载方案。复用此代码时，需要按照当前存储服务的要求检查其存储操作。

<a id="supported-provider"></a>
## 受支持的提供方

受支持的 OceanBase/MySQL 存储请使用 [storage-mysql](../../packages/storage/storage-mysql/README.zh.md)，共享数据库要求请参阅 [mysql-schema](../../packages/util/mysql-schema/README.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
