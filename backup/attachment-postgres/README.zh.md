# PostgreSQL 附件参考

[English](README.md) | 中文

## 概述

这是 `@deepseek-ai/dsh-attachment-postgres` 的参考副本。它不是当前工作区中启用的附件提供方，详见[备份说明](../README.zh.md)。

## 目录

- [源码](#source)
- [受支持的提供方](#supported-provider)
- [开发备注](#dev-note)

<a id="source"></a>
## 源码

- [附件存储](src/index.ts)
- [保留的包清单](package.json)

其依赖和 TypeScript 引用需要恢复。复用此存储还需要核对当前的图片准入、用户归属和数据库审计要求。

<a id="supported-provider"></a>
## 受支持的提供方

OceanBase/MySQL 附件请使用 [attachment-mysql](../../packages/attachment/attachment-mysql/README.zh.md)。共享图片要求由[附件服务](../../packages/attachment/attachment/README.zh.md)定义。

<a id="dev-note"></a>
## 开发备注

无。
