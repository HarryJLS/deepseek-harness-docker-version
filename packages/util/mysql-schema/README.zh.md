---
description: "OceanBase/MySQL 连接解析、雪花行标识、审计字段与既有表校验。"
kind: "package-library"
---

# @deepseek-ai/dsh-mysql-schema

[English](README.md) | 中文

## 概述

MySQL 存储、会话与附件提供方共用的辅助库。此库不创建连接池，也没有插件入口；调用方将解析后的选项交给 mysql2。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

导出的连接 schema 与解析函数管理地址、端口、数据库、账号、连接池大小、应用名和雪花工作节点配置。连接 URL 优先于独立连接字段。容器部署的全部数据库选项来自 [Nacos](../../../deploy/README.zh.md#database-configuration)。

<a id="isolating-several-applications-in-one-database"></a>

每张表使用固定的 `dsh_` 前缀、有符号 BIGINT 雪花主键及五个审计字段。应用与逻辑标识另设唯一索引。二进制排序规则区分大小写不同的应用名和用户名；`app` 原样保存，必须非空且不超过 64 个字符，默认是 `dsh`。

插入显式写入全部审计字段。更新保留行 ID、创建者与创建时间，并更新修改者和修改时间。工作节点编号范围为 0 至 1023，单副本默认使用 0。所有共用表的并发进程必须使用不同编号并同步时钟。驱动以字符串返回 BIGINT 值。

提供方在执行 DDL 前探测既有表。既有表必须通过审计列与主键检查；不兼容结构会被拒绝，不会自动修改。DBA 可执行 [schema-mysql.sql](../../../deploy/schema-mysql.sql)，让应用角色只持有 DML 权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

进程内按工作节点共享雪花生成器，并在时钟回退和序列耗尽时保持逻辑时间单调。JSON 序列化通过标准 JSON 转义保留字符串值与键，包括 NUL。连接默认值与表检查位于 [src/index.ts](src/index.ts)，审计定义和 ID 生成位于 [src/audit.ts](src/audit.ts)。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [会话提供方](../../session/session-persistence-mysql/README.zh.md)
- [KV 后端](../../storage/storage-mysql/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无，因为数据库配置、审计字段和行标识不增加模型内容。

#### KV Cache 影响

这些辅助函数不改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 跨进程工作节点编号的唯一性由运维保证；此库不分配分布式租约。
- 表前缀固定，建表探测要求兼容 MySQL 的 information_schema。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
