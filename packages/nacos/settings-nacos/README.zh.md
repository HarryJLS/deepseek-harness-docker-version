---
description: "在 Nacos 中存储各命名空间的用户设置，并在多个副本之间接收实时更新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-settings-nacos

[English](README.md) | 中文

## 概述

将用户设置保存在一个 Nacos 条目中，而不是本地文档中。使用方继续通过 `ctx.settings` 访问命名空间默认值、组合配置和校验能力。需要在容器替换后保留设置，或在多个副本之间共享设置时，选择此提供方。

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

通过配置方案补丁替换已有的设置提供方：

```yaml
- id: settings
  disabled: true

- insert:
    - id: settings-nacos
      name: '@deepseek-ai/dsh-settings-nacos'
      config:
        host: nacos
        dataId: dsh-settings.yaml
```

条目内容是从命名空间到用户设置分区的 YAML 映射。缺失、空白或 YAML 空值文档视为空文档；非映射文档会报错。Nacos 推送会更新提供方，不需要重启应用。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | Nacos 服务器主机 |
| `dataId` | `dsh-settings.yaml` | 保存设置文档的条目 |
| `writable` | `true` | 此提供方是否可以发布修改 |

详见[共享连接字段](../nacos-client/README.zh.md#connection-fields)和[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-settings-nacos)。如果运维人员只通过 Nacos 编辑文档，请设置 `writable: false`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[src/index.ts](src/index.ts) 在基础提供方加载设置之前连接文档，然后安装变更监听器。基础设置服务负责命名空间注册、分层解析、校验和变更通知。

写入会重新读取已存储的文档，并替换其中一个命名空间分区。操作在单个文档实例内串行执行；不同副本不共享这个队列。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Nacos 提供方](../README.zh.md)
- [用户设置服务](../../settings/settings/README.zh.md)
- [设置子系统](../../../docs/subsystems/settings.zh.md)

<a id="model-experience"></a>
## 模型体验

通过 `ctx.settings` 的使用方间接影响模型；这些使用方根据解析后的值选择模型或构造请求。

#### KV 缓存影响

请求前缀变化由使用方负责；存储命名空间分区本身不会增加模型内容。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 没有可在编辑器中打开的本地设置文档。
- 不同副本并发修改共享文档时，即使编辑不同命名空间，也可能覆盖彼此的修改。
- 所有命名空间共享一个条目及其服务端大小限制。
- 设置保存字面值；此提供方不展开环境变量引用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
