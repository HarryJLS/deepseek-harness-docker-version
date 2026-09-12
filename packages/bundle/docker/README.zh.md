---
description: "为 Web 配置档选择 OceanBase 持久化与 Nacos 配置的部署包。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-bundle-docker

[English](README.md) | 中文

## 概述

容器入口在 base 和 web-app 之后选择此部署包。其 Cordis 补丁选择提供方及网络策略，本包不导出运行时服务。

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

使用根目录 [Dockerfile](../../../Dockerfile) 并遵循[部署指南](../../../deploy/README.zh.md)。入口程序在组合配置档前校验 Nacos 中的数据库设置。Nacos 凭据属于源码中的启动配置，不是运维环境变量输入。

本包用 Nacos 提供方替代文件设置和凭据，用 storage-mysql 替代 storage-json，并用带 Redis 事件缓存的 session-persistence-mysql 替代 session-persistence-jsonl。存储域选择 mysql 后端。attachment-local 使用 Nacos 配置的临时目录；两个上下文存储都不接收图片字节。

服务器在全部网卡上监听 DSH_PORT，默认 3080。此部署关闭浏览器令牌认证与 Host 检查。可信平台网关必须认证用户，并在 HTTP 请求和 WebSocket 升级中注入 X-User-Id；缺失用户信息时使用 `-`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

补丁禁用被替代的提供方，并插入数据库或 Nacos 实现。每个具名插件都声明为部署包依赖。数据库、Redis 与临时目录变更需要重启，支持的设置和已安装插件的补丁可实时更新。入口程序在 Loader 解析配置档模块前安装清单中的包。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [部署包组](../README.zh.md)
- [用户标识](../../identity/user-context/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无，因为部署包选择拥有模型可见内容的插件，自身不注册提示词或工具。

#### KV Cache 影响

所选择的插件负责请求前缀变化。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 不可信客户端不能直接访问 harness 端口；用户请求头不是身份认证，也不是 shell 沙箱。
- 此部署包依赖入口程序准备的数据库配置，不实现生产密钥存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
