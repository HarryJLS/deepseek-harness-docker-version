---
description: "面向容器部署的 Nacos 设置、凭据和文件镜像。"
kind: "package-group"
---

# packages/nacos

[English](README.md) | 中文

## 概述

通过 Nacos 在多个 Harness 副本之间共享设置、凭据和指定的配置文件。这些包不需要持久化的本地配置卷，但文件镜像仍需要可写的本地路径。设置和凭据的使用方继续使用已有服务。

## 目录

- [包列表](#packages)
- [配置归属](#configuration-ownership)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

由服务读取的文档使用对应提供方，由路径读取的内容使用文件镜像。

| 包 | 用途 | 服务 |
|---|---|---|
| [nacos-client](nacos-client/README.zh.md) | 通过 gRPC 读取、发布和监听配置条目 | 库 |
| [settings-nacos](settings-nacos/README.zh.md) | 存储各命名空间的用户设置 | `ctx.settings` |
| [credentials-nacos](credentials-nacos/README.zh.md) | 存储凭据引用和记录，优先级低于进程环境变量 | `ctx.credentials` |
| [nacos-file-mirror](nacos-file-mirror/README.zh.md) | 将条目写入文件，供基于路径的使用方读取 | 无服务 |

-----

<a id="configuration-ownership"></a>
## 配置归属

连接 Nacos 之前必须先取得 Nacos 的连接信息。数据库配置则不同：容器引导流程在启动数据库提供方之前，从 Nacos 读取 `deployment.database`，详见[部署指南](../../deploy/README.zh.md#database-configuration)。

设置和凭据通过对应提供方接收实时更新。镜像文件在使用方读取或重新加载时生效。数据库连接配置的变更需要重启应用；把值存入 Nacos 并不意味着它自动支持热加载。

<a id="related-documentation"></a>
## 相关文档

- [设置子系统](../../docs/subsystems/settings.zh.md)
- [凭据服务](../credentials/credentials/README.zh.md)
- [容器部署指南](../../deploy/README.zh.md)

<a id="dev-note"></a>
## 开发备注

无。
