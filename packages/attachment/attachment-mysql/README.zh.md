---
description: "按用户进行内容寻址并复用归一化策略的 OceanBase/MySQL 图片存储。"
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-mysql

[English](README.md) | 中文

## 概述

将归一化的源图片保存在数据库，使会话图片引用在容器替换后仍然有效。图片检查、归一化和请求变体复用 attachment-local 的实现。

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

用此提供方替代 attachment-local。图片策略字段和默认值与该提供方一致。[容器部署](../../../deploy/README.zh.md) 从 Nacos 提供完整数据库配置。

行使用雪花主键和唯一索引 `(app, user_id, sha256)`。读写与去重使用当前用户，没有身份时使用 `-`。即使图片字节相同，不同用户也拥有独立的行。

每次写入都提供[共享审计字段](../../util/mysql-schema/README.zh.md)。重复上传保留行标识和创建来源，并更新修改者与修改时间。读取忽略软删除图片，所有者可重新上传以恢复该行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

dsh_attachment_object 在 longblob 列中保存归一化字节。读取会将存储的媒体类型、尺寸与字节长度同记录的引用进行比较。确定性的模型请求变体保留在容器本地临时目录，可根据存储图片与路由策略重新生成。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [附件服务](../attachment/README.zh.md)
- [图片归一化](../attachment-local/README.zh.md)

<a id="model-experience"></a>
## 模型体验

通过返回给供应商请求适配器的图片字节间接影响模型；此存储不注册工具，也不注入提示词。

#### KV Cache 影响

未改变的图片字节与请求策略生成相同请求变体。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持图片，数据库报文限制也约束单个存储对象。
- 没有引用的对象和容器本地变体缓存都不会自动清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
