---
description: "支持有界 Redis 事件缓存、用户隔离和数据库回源的 OceanBase/MySQL 会话历史。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-mysql

[English](README.md) | 中文

## 概述

替换容器后可从同一应用数据库恢复会话历史。逐会话句柄负责创建、读取、追加、刷新和关闭保存在两张数据库表中的日志；提供方写入已安装的当前格式，读取受支持的历史代际后仍只向上层暴露相同的逻辑格式。

可选的 `redis` 配置启用共享、可过期的上下文读取。容器部署要求从 Nacos 提供此配置；[Redis 配置与 key 结构](../../../deploy/README.zh.md#redis-cache) 是统一的运维说明。

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

[共享 schema 辅助库](../../util/mysql-schema/README.zh.md) 定义审计字段、副本工作节点编号和启动检查。不兼容的既有表会被拒绝，不会修改数据。软删除的会话不可见；已提交前缀中被删除的事件会导致读取失败，而不是返回存在缺口的历史。

`create` 返回独占写句柄，其空会话最初仅对当前提供方可见。首次追加或显式刷新会将其持久化。关闭从未追加或刷新的创建句柄会移除该待持久化标识。`open(id, 'read')` 不激活 agent（智能体）也不修复历史；`open(id, 'write')` 验证已有日志并保留写入权。读取返回独立事件，并遵循偏移量和长度。逻辑头及精确继承前缀在重新打开后保持一致。

`writeBatchMaxDelayMs` 控制固定的实时事件合并窗口，默认 200 毫秒，范围为 1 到 60000。`session/flush`、写句柄的 `flush` 和服务级 `flush` 会立即排空待写批次。自动写入失败会保留事件并暂停定时器，等待显式重试。句柄关闭及提供方退出会在释放写入权或数据库连接前排空已接受的工作，失败仍然可见。提供方通过共享的相邻格式目录读取受支持的历史行，并且只返回当前逻辑格式；后续写入会在同一事务中把该会话改写为当前格式；无法解释的未来代际会被拒绝，不会被当作当前消息解析。[保留数据](../../../deploy/README.zh.md#retained-data)使用独立的应用标识。

MySQL 提交批次后才写入 Redis。缓存缺失、分块不完整、校验和错误或运行时 Redis 故障都会从 MySQL 读取对应页，不截断历史。配置的 Redis 无法连接时启动失败。每次读取仍校验数据库会话头和日志范围；Redis 不授予访问权，也不屏蔽数据库故障。

可选的 `execution` 配置为请求级 Web 操作提供 `sharedExecution`。它使用既有 KV 记录表保存可续期、按数据库时间判断的执行占用，并在事件写入事务中校验执行权。[共享确认](../../../deploy/README.zh.md#shared-confirmation) 说明 Nacos 时间参数、副本身份、NAS 和支持的流程。

挂载文件上传服务时，已完成的凭证使用现有 KV 行保存，不含二进制数据。缺失、其他用户所属、已删除及子代理 Session 返回授权未命中；数据库故障仍作为错误报告。[上传服务](../../client/file-upload/README.zh.md)在存储字节前拒绝未授权传输。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

提供方负责句柄跟踪和实时事件路由；每个句柄串行执行修改，并保留失败的批次。会话头落库与首批事件一同提交。逐事件行事务不会产生 JSONL 的不完整尾行。恢复操作通过普通句柄追加负责中断语义修复。修订令牌包含数据库、应用和物理行标识。恢复时按键集游标每页最多读取 1,000 条事件；只读打开检查元数据而不加载正文。

Redis 独立保存当前格式的不可变事件值，较大值拆成带校验和的字节分块。每个 key 都有滑动过期时间，哈希 key 身份和当前 Session 格式版本会在不改变既有 key 前缀的前提下隔离重建会话及旧缓存代际。SQL 行锁与连续序号检查拒绝竞争写入；配置 `execution` 后，过期或被替代的执行占用也会导致事务拒绝。

本包不发布运行时不变量伴随插件：SQL 事务结果、跨连接可见性及租约写入隔离需要数据库集成测试，而不是在进程内再复制一份写入器状态。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [持久化服务](../session-persistence/README.zh.md)
- [建表 SQL](../../../deploy/schema-mysql.sql)

<a id="model-experience"></a>
## 模型体验

### 恢复的对话历史

#### 模型看到的内容

通过句柄恢复的 `SessionEvent` 记录；行标识、归属和审计字段不进入模型消息。

#### Token 影响

只有恢复的历史贡献请求 token。

#### KV Cache 影响

未改变的逻辑历史重建相同的请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 没有逐会话原始文件系统产物；句柄读取提供逻辑日志。
- 分页限制单次数据库结果，不限制完整的内存历史。
- Redis 过期不删除数据库历史。共享执行需要既有 KV 表。写句柄会获取执行占用，除非 API 操作已持有它；借用的执行占用仍由该操作保留，直到其 agent 停止。任意存活插件资源不能转移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
