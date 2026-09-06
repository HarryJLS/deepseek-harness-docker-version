---
description: "将 Nacos 条目镜像为本地指令文件和配置方案文件，供基于路径的使用方读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-nacos-file-mirror

[English](README.md) | 中文

## 概述

将 Nacos 条目写入本地文件，并在 Nacos 推送变更时替换文件内容。工作区指令、实时配置方案补丁等基于路径的使用方可使用此插件。镜像路径需要可写的本地存储，但不需要持久化配置卷。

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

挂载插件时指定绝对目标路径：

```yaml
- id: nacos-file-mirror
  name: '@deepseek-ai/dsh-nacos-file-mirror'
  config:
    host: nacos
    files:
      - dataId: dsh-agents.md
        path: /var/lib/dsh/AGENTS.md
      - dataId: dsh-plugins.yml
        path: /var/lib/dsh/profiles/web/cordis.patch.yml
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | Nacos 服务器主机 |
| `files` | `[]` | 要镜像的条目；空列表加载时不影响文件 |
| `files[].dataId` | 必填 | Nacos 条目 ID |
| `files[].path` | 必填 | 绝对目标路径 |

详见[共享连接字段](../nacos-client/README.zh.md#connection-fields)和[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-nacos-file-mirror)。相对路径会在加载时报错。条目缺失时不修改目标；空条目会写入空文件。

### 变更生效时机

指令变更按[指令插件的基线和刷新规则](../../context/agent-instructions/README.zh.md#use-this-package)生效，包括成功的文件系统访问和恢复会话时的核对。配置方案只有启用 `patchReload: live` 时才重新加载补丁。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[src/index.ts](src/index.ts) 完成连接，读取每个条目，写入初始内容，并注册监听器。连接失败或首次读取失败会阻止加载。文件写入失败会记录日志并保留原目标；后台连接和解析错误也交给日志记录器。

[src/write.ts](src/write.ts) 写入仅当前用户可访问的同目录临时文件，再将其重命名为目标文件。释放时关闭所有已注册的文档及其监听器。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Nacos 客户端](../nacos-client/README.zh.md)
- [指令使用方](../../context/agent-instructions/README.zh.md)
- [容器部署](../../../deploy/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 镜像指令上下文

#### 模型看到什么

指令使用方通过已记录的基线或刷新 `user/message` 事件包含 `$DSH_HOME/AGENTS.md`；镜像本身不注册提示词或工具。

#### Token 影响

渲染和 `maxBytes` 预算由指令使用方负责；镜像本身不会增加请求 Token。

#### KV 缓存影响

缓存复用遵循指令使用方记录的基线和刷新消息；镜像本身不发送模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 镜像是单向的；本地修改不会发布，后续 Nacos 更新可能替换这些修改。
- Loader 在插件加载之前读取配置方案补丁；变更后的镜像补丁通过随后的实时重载生效。
- 镜像补丁不能安装缺失的包；配置方案必须已经能够解析这些模块。
- 所有条目都使用插件配置的 Nacos 凭据；服务端权限决定这些凭据可读取哪些条目。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
