---
description: "为 HTTP 请求、会话归属、数据库审计操作人及异步流提供可信的平台用户标识。"
kind: "package-library"
---

# @deepseek-ai/dsh-user-context

[English](README.md) | 中文

## 概述

此库在异步 Host 操作中传递平台用户标识。Connection 从配置的可信代理请求头读取标识；会话 API 与 MySQL 提供方据此校验归属并记录审计操作人。没有用户信息时使用 `-`。可在客户端使用的 `./identity` 入口提供不依赖 Node 的标识校验。

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

`parseUserId` 接受单个区分大小写、最多 32 个字符的标识。缺失、null 和空的外部值统一解析为 `-`；两端带空白、含控制字符或逗号的字符串以及非字符串值会被拒绝。`withUser` 为一次操作及其后续异步工作设置用户作用域。`userScopedIterable` 在惰性迭代和清理期间保留准入时的身份。

`requestUserId` 区分用户请求与无用户作用域的 Host 维护操作。`currentUserId` 提供审计操作人，在请求之外使用 `-`。`canAccessUser` 仅允许用户身份与持久化所有者匹配的请求访问；未记录所有者的元数据属于 `-`。无用户作用域的 Host 维护操作可以枚举所有用户，因此请求处理器不能清除作用域后向调用方返回不受限的数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

Node AsyncLocalStorage 隔离并发请求，不使用进程级可变的当前用户变量。会话元数据在重启、分叉和委派子会话之间保存归属。持久化写入方从该元数据确定延迟写入的所有者，不依赖批次刷入时恰好活跃的请求身份。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Connection](../../client/connection/README.zh.md) 负责可信请求头准入。
- [Session Controller](../../api/session-controller/README.zh.md) 负责浏览器会话操作。
- [容器部署](../../../deploy/README.zh.md) 说明 Nacos 与平台集成方式。

<a id="model-experience"></a>
## 模型体验

无，因为请求标识和存储归属不添加提示词、工具或对话事件。

#### KV Cache 影响

无；用户归属属于存储元数据，不属于模型请求内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 请求头不是身份认证。可信网关必须认证用户，并在 HTTP 请求和 WebSocket 升级时替换客户端提供的身份请求头。
- 会话归属不隔离文件系统访问、shell 执行、应用设置或 Host 进程内运行的管理员代码。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

[归属决策](../../../.agents/notes/implemented/architecture/2026-09-06-oceanbase-user-ownership.zh.md) 记录请求访问与 Host 维护操作的区别。

</details>
