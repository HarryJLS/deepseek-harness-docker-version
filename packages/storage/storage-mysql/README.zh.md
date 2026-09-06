---
description: "为应用 KV 单元提供持久化、审计字段和软删除的 OceanBase/MySQL 后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-mysql

[English](README.md) | 中文

## 概述

通过三张共享数据库表注册 mysql 存储后端。值为不透明 JSON，每次存储调用都在原子、持久地提交后才成功返回。

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

用此提供方替代 storage-json，并将存储域设为 `backend: mysql`。后端名默认为 `mysql`，应用名默认为 `dsh`。[容器部署](../../../deploy/README.zh.md) 从 Nacos 提供连接设置。

单元归应用所有，不按用户分拆。逻辑唯一索引包含应用名，因此不同应用的相同单元、表和键不会合并。每行都有[共享的雪花主键和审计字段](../../util/mysql-schema/README.zh.md#isolating-several-applications-in-one-database)，缺失操作人时使用 `-`。

单元版本不匹配时拒绝打开。读取包含全部已声明的逻辑表，忽略描述符之外遗留的表，并返回驱动新解码的 JSON 值。关闭单元后拒绝继续操作，但不关闭其他单元或共享连接池。

删除记录将 `is_deleted` 设为 `Y`。读取会忽略该行，后续写入会恢复它并保留 ID、创建者和创建时间。不兼容的物理表会阻止启动，不会自动迁移。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

dsh_kv_unit 记录单元版本，dsh_kv_record 保存逻辑表记录，dsh_kv_global 保存全局槽。MySQL 保留字 key 对应的列名是 key_name。提供方拥有连接池，卸载时先撤销后端注册再关闭连接池。[src/index.ts](src/index.ts) 负责注册与 SQL 操作。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [存储中心](../storage/README.zh.md)
- [建表 SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## 模型体验

无，因为后端仅保存不透明的应用状态，不增加工具或会话事件。

#### KV Cache 影响

由消费方负责其存储值引起的模型请求变化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- per-record 布局提示不改变 SQL 表示方式。
- 软删除行不会自动回收，单次调用也不提供跨多个存储操作的事务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
