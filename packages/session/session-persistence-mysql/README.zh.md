---
description: "支持不可变用户归属、行审计和事件批次事务的 OceanBase/MySQL 会话持久化。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

[English](README.md) | 中文

## 概述

通过共享持久化协调器在两张数据库表中保存会话头和事件。替换后的容器可从同一应用数据库恢复相同的逻辑历史。

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

用此提供方替代 session-persistence-jsonl。会话保留逻辑标识 `(app, session_id)`，行主键则使用独立的雪花 ID。[部署指南](../../../deploy/README.zh.md) 说明 Nacos 连接配置。

索引列 `user_id` 必须与 SessionHeader 的归属一致，缺失信息时使用 `-`。请求只能列出和读取自己的有效行，可信的无用户作用域维护操作可枚举应用内所有用户。并发创建不能更改既有所有者。延迟事件写入使用持久化所有者作为审计操作人。

[共享 schema 辅助库](../../util/mysql-schema/README.zh.md) 定义审计字段、副本工作节点编号和启动检查。不兼容的既有表会被拒绝，不会修改数据。读取排除软删除的会话和事件行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

协调器负责缓冲、准备对象复用、活跃状态接入、修复顺序以及退出时等待写入完成。会话头落库与首批事件一同提交，修复结束事件在一个事务中追加。逐事件行事务不会产生 JSONL 的不完整尾行。修订令牌包含数据库和应用名。恢复时按键集游标每页读取 1,000 条事件，最后返回完整逻辑日志。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [持久化服务](../session-persistence/README.zh.md)
- [建表 SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到的内容

协调器恢复的 `SessionEvent[]`；行标识、归属和审计字段不进入模型消息。

#### Token 影响

只有恢复的历史贡献请求 token。

#### KV Cache 影响

未改变的逻辑历史重建相同的请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 没有逐会话原始文件：locate 不返回位置，supportsRawArtifacts 为 false。
- 分页限制单次数据库结果，不限制完整的内存历史。
- 此提供方不实现保留策略或分布式 Agent 执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
