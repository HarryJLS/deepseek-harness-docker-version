# PostgreSQL 参考副本

[English](README.md) | 中文

## 概述

此目录保留已停用的 PostgreSQL 适配器源码，供查阅参考。它不属于工作区包匹配范围，也不属于构建、测试、发布或代码检查的源码范围。这些包不是受支持的部署选项。

## 目录

- [副本和替代实现](#copies-and-replacements)
- [恢复要求](#restoration-requirements)
- [开发备注](#dev-note)

<a id="copies-and-replacements"></a>
## 副本和替代实现

源码副本继续保留，并在下表中链接到受支持的 OceanBase/MySQL 提供方。

| 参考副本 | 受支持的包 |
|---|---|
| [postgres-schema](postgres-schema/README.zh.md) | [mysql-schema](../packages/util/mysql-schema/README.zh.md) |
| [storage-postgres](storage-postgres/README.zh.md) | [storage-mysql](../packages/storage/storage-mysql/README.zh.md) |
| [session-persistence-postgres](session-persistence-postgres/README.zh.md) | [session-persistence-mysql](../packages/session/session-persistence-mysql/README.zh.md) |
| [attachment-postgres](attachment-postgres/README.zh.md) | [attachment-mysql](../packages/attachment/attachment-mysql/README.zh.md) |

<a id="restoration-requirements"></a>
## 恢复要求

保留的包清单和 TypeScript 引用描述的是原工作区位置，并不意味着这些副本可以在当前目录中构建。恢复时需要确定当前包位置、登记依赖和构建关系，并验证当前的持久化、归属和审计要求。

PostgreSQL 与 OceanBase 的表布局不能互换。受支持的表结构请参阅[部署指南](../deploy/README.zh.md)；这些副本不提供自动数据转换。

<a id="dev-note"></a>
## 开发备注

无。
