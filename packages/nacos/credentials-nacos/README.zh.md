---
description: "在 Nacos 中存储凭据引用和授权记录，优先级低于只读的进程环境变量。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-nacos

[English](README.md) | 中文

## 概述

将 API 密钥和授权记录保存在一个 Nacos 条目中，而不是本地凭据文件中。继承的进程环境变量优先，并保持只读。需要跨副本共享凭据，或在容器替换后保留凭据时，使用此提供方。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过配置方案补丁替换本地提供方：

```yaml
- id: credentials
  disabled: true

- insert:
    - id: credentials-nacos
      name: '@deepseek-ai/dsh-credentials-nacos'
      config:
        host: nacos
        dataId: dsh-credentials.yaml
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | Nacos 服务器主机 |
| `dataId` | `dsh-credentials.yaml` | 保存引用和记录的条目 |

详见[共享连接字段](../nacos-client/README.zh.md#connection-fields)和[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-credentials-nacos)。条目包含秘密信息，请只向可信的部署运维人员开放 Nacos 读写权限。

### 存储文档

`refs` 将环境变量名称映射到凭据值。`records` 将 `scope/id` 地址映射到凭据记录。

```yaml
refs:
  DEEPSEEK_API_KEY: <provider-api-key>
records:
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: <session-secret> }
```

缺失、空白或 YAML 空值文档视为空文档。非映射文档会报错；格式不正确的 `refs` 或 `records` 分区视为空，但不会丢弃另一个分区。

如果非空的进程环境变量值会遮蔽引用写入，写入会被拒绝。解析时空值视为不存在，`set` 拒绝空字符串。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[src/index.ts](src/index.ts) 在提供方可用之前完成连接、读取文档和安装监听器。外部变更会替换缓存文档，并向观察者通知发生变化的凭据引用。

`modifyRecord` 重新读取文档，并在文档实例的独占队列中完成决策和发布。此队列不协调其他进程。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Nacos 提供方](../README.zh.md)
- [凭据服务](../../credentials/credentials/README.zh.md)
- [容器部署](../../../deploy/README.zh.md)

<a id="model-experience"></a>
## 模型体验

通过 `ctx.credentials` 的使用方间接影响模型；这些使用方授权提供方请求，但不把存储的秘密值放入模型内容。

#### KV 缓存影响

凭据存储不会增加模型内容；请求变化仍由使用凭据的适配器负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 此提供方不增加静态加密；需要保护 Nacos 条目及其传输。
- 所有凭据共享一个条目及其服务端大小限制。
- Nacos 之上的来源只有进程环境变量，不包含项目或用户的 `.env` 文件。
- 不同副本可能覆盖彼此的文档修改；记录修改只在单个文档实例内串行执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
