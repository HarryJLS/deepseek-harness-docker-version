# PostgreSQL 表结构参考

[English](README.md) | 中文

## 概述

这是 `@deepseek-ai/dsh-postgres-schema` 的参考副本，不是当前部署可用的工作区库。源码按[备份说明](../README.zh.md)保留。

## 目录

- [源码](#source)
- [受支持的库](#supported-library)
- [开发备注](#dev-note)

<a id="source"></a>
## 源码

- [连接和表结构辅助函数](src/index.ts)
- [保留的表结构测试](tests/schema.spec.ts)
- [保留的包清单](package.json)

编译或测试此副本之前，需要恢复保留的 TypeScript 引用。其 PostgreSQL 模式标识不代表当前按行实现的应用隔离。

<a id="supported-library"></a>
## 受支持的库

OceanBase/MySQL 的连接解析、雪花标识、审计列和表校验请使用 [mysql-schema](../../packages/util/mysql-schema/README.zh.md)。

<a id="dev-note"></a>
## 开发备注

无。
