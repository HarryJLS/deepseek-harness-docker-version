---
description: "通过共享 gRPC 客户端和文档库读取、发布和监听 Nacos 配置。"
kind: "package-library"
---

# @deepseek-ai/dsh-nacos-client

[English](README.md) | 中文

## 概述

在 Harness 提供方中读取、发布和监听 Nacos 配置条目。`NacosDocument` 提供编解码能力，并在单个文档实例内串行执行操作。此包是库，不是可以挂载到 `cordis.yml` 的插件。

## 目录

- [使用此包](#use-this-package)
- [连接字段](#connection-fields)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

单个条目使用 `NacosDocument`，同一连接上的多个条目使用 `NacosConfigClient`。以下示例读取并更新一个文本条目，然后释放监听器和连接。

```ts
import { nacosDocument } from '@deepseek-ai/dsh-nacos-client'

const entry = nacosDocument({ host: '127.0.0.1' }, 'my-plugin.txt', {
  parse: content => content ?? '',
  render: document => document,
})
entry.setErrorHandler(console.error)
try {
  await entry.connect()
  console.log(await entry.read())
  await entry.watch(console.log)
  await entry.write(current => `${current}\nReady.`)
} finally {
  entry.close()
}
```

长时间运行的提供方应保持文档打开，直到释放时再关闭。写入会先重新读取条目，再应用修改；`exclusive` 还支持异步决策后调用 `publish`。这两种操作都不提供跨副本的分布式锁或比较并交换。

<a id="connection-fields"></a>
## 连接字段

`nacosEntrySchema` 提供 Nacos 插件在自身配置模式中展开的连接字段。每个插件单独定义自己的数据标识。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | 不含协议和端口的服务器主机 |
| `port` | `8848` | HTTP 端口；gRPC 端口为该值加 `1000` |
| `namespace` | `''` | 命名空间 ID；空值选择公共命名空间 |
| `group` | `DEFAULT_GROUP` | 配置分组 |
| `username`, `password` | 未设置 | 可选的 Nacos 身份验证信息 |
| `requestTimeoutMs` | `10000` | 单次请求的超时时间 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[client.ts](src/client.ts) 负责握手、读取、发布、推送确认和重连。每个客户端使用不同的 gRPC 通道选项，避免连接池合并独立的 Nacos 注册。重连会重新注册监听器并重新读取对应条目。

[document.ts](src/document.ts) 负责解析和单个文档的操作队列。后台错误交给已安装的错误处理器。[descriptor.ts](src/descriptor.ts) 定义内联通信描述符和端口偏移量。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Nacos 提供方](../README.zh.md)
- [容器部署](../../../deploy/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无直接影响，因为此传输库不注册任何面向模型的内容。

#### KV 缓存影响

配置更新引起的请求变化由使用方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持配置；没有实现命名和服务发现。
- gRPC 连接不加密；跨不可信网络通信时，需要在客户端之外保护传输。
- 重连只使用一个配置的服务器地址；没有实现客户端服务器轮换。
- 不同实例并发写入同一文档时，可能覆盖彼此的修改，包括对不同分区的修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
