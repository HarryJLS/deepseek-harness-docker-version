# PostgreSQL 会话持久化参考

[English](README.md) | 中文

## 概述

这是 `@deepseek-ai/dsh-session-persistence-postgres` 的参考副本。它不属于受支持的工作区和部署组合，详见[备份说明](../README.zh.md)。

## 目录

- [源码](#source)
- [受支持的提供方](#supported-provider)
- [开发备注](#dev-note)

<a id="source"></a>
## 源码

- [提供方装配](src/index.ts)
- [会话存储](src/store.ts)
- [保留的包清单](package.json)

在恢复包注册并核对当前持久化、用户归属和审计要求之前，不要挂载此副本来处理当前会话数据。

<a id="supported-provider"></a>
## 受支持的提供方

OceanBase/MySQL 会话请使用 [session-persistence-mysql](../../packages/session/session-persistence-mysql/README.zh.md)。当前共享要求由[持久化子系统](../../docs/subsystems/persistence.zh.md)定义。

<a id="dev-note"></a>
## 开发备注

无。
