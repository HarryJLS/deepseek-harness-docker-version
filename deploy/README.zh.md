---
description: "OceanBase 与 Nacos 容器部署、必需的数据库配置、审计列及可信平台用户隔离。"
kind: "deployment-reference"
---

# 容器部署

[English](README.md) | 中文

## 摘要

根目录 [Dockerfile](../Dockerfile) 构建 Web 应用。OceanBase 的 MySQL 模式保存会话日志、共享 KV 状态和附件；Nacos 保存部署设置与模型凭据。容器在启动 `dsh` 配置档前校验数据库配置。既有数据库不会自动迁移。

## 目录

- [数据库配置](#database-configuration)
- [用户隔离](#user-isolation)
- [表结构](#schema)
- [部署](#deployment)
- [配置更新](#configuration-updates)
- [运维限制](#operational-limits)

<a id="database-configuration"></a>
## 数据库配置

在应用的 Nacos 命名空间和 `DEFAULT_GROUP` 中创建 `dsh-settings.yaml`。数据库配置只来自 `deployment.database`，不读取 `DSH_MYSQL_*` 环境变量。填写下面的完整独立字段，或填写 `url`、`poolSize` 与 `snowflakeWorkerId`，不要混用两种连接形式。密码字节会原样保留，包括空格和 shell 标点。

```yaml
deployment:
  appName: order-svc
  database:
    host: oceanbase
    port: 2881
    database: dsh
    user: root@test
    password: dsh
    poolSize: 10
    snowflakeWorkerId: 0
```

这些凭据用于随附的本地开发栈，生产环境应使用专用数据库账号。采用独立连接字段时，示例中的数据库字段均为必填项。条目缺失、Nacos 不可达、字段无效或数据库配置不完整都会在应用打开连接池之前阻止启动。数据库变更在容器重启后生效。

Nacos 启动凭据集中在 [deployment-config.mjs](deployment-config.mjs) 的 `NACOS_AUTH` 中，开发示例为 `nacos/nacos`，不读取运维环境变量。不要提交真实生产凭据。随附的本地 Nacos 服务关闭了鉴权，仅设置客户端凭据不会开启服务器鉴权。

启动程序将校验后的值写入 `/run` 下权限为 0600 的文件，Compose 将 `/run` 挂载为临时内存。`DSH_DATABASE_SECRET` 仅用于内部传递已从 Nacos 读取的文档，不是第二个配置来源；名称中的 secret 标记也会使它从工具子进程环境中排除。

<a id="user-isolation"></a>
## 用户隔离

容器的 Connection 配置信任 `X-User-Id`。平台网关必须认证用户、替换客户端自行提供的身份请求头，并在 HTTP 请求与 WebSocket 升级时转发该请求头。不要向不可信客户端直接暴露 harness 端口：持有任意请求头不等于通过身份认证。

用户 ID 区分大小写，最多 32 个字符。缺失或空的信息使用 `-`；所有匿名客户端有意共享该所有者的会话。无效或有歧义的请求头会被拒绝。身份保存在会话头和 `user_id` 列中，并由分叉与委派子会话继承。

列表、搜索、历史、直接会话操作、附件读取、工作区会话 ID 及会话事件和控制流均检查请求用户的归属。猜到其他用户的会话 ID 不会获得访问权。WebSocket 保留升级时准入的身份，网关在切换认证账号时必须关闭已有连接。

这里隔离的是会话数据。应用设置、工作区注册、文件系统访问、shell 执行、管理员插件及无用户作用域的 Host 维护操作不是租户沙箱，这些能力需要独立的平台授权或隔离执行环境。

<a id="schema"></a>
## 表结构

[schema-mysql.sql](schema-mysql.sql) 是六张 `dsh_` 表的 DBA 建表脚本。每张表都有应用生成的有符号 `BIGINT id` 雪花主键，以及以下字段：

```sql
is_deleted   char(1)     NOT NULL DEFAULT 'N' COMMENT '是否删除，默认N',
creator      varchar(32) NOT NULL COMMENT '创建者',
gmt_created  datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
modifier     varchar(32) NOT NULL COMMENT '更新者',
gmt_modified datetime    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '修改时间'
```

每次插入都显式提供审计列。更新保留创建来源和行标识，同时记录修改者与修改时间。逻辑唯一性独立于数字主键约束。`dsh_session.session_id` 保留原有对话标识。会话与附件记录还保存 `user_id`，共享 KV 单元仍归应用所有。二进制排序规则避免大小写折叠造成应用或用户冲突。

KV 删除属于软删除，后续写入可恢复该行。会话和附件读取忽略软删除行。没有自动保留策略。雪花值以十进制字符串传递，不经过 JavaScript 数字转换。所有共用表的并发副本都需要不同的 `snowflakeWorkerId`，范围为 0 至 1023，并同步系统时钟。

提供方检查既有表不需要 DDL 权限。有权限的角色可创建缺失的表，不兼容的既有表会产生明确的启动错误。修改 Nacos 数据库名之前，先备份旧库，进行运维审核的数据转换或创建新库。重新执行 `CREATE TABLE IF NOT EXISTS` 不会升级旧表。

<a id="deployment"></a>
## 部署

构建上下文是仓库根目录。[docker-compose.yml](docker-compose.yml) 指向根目录 Dockerfile，并定义应用、Nacos 与 OceanBase 服务。启动后端服务、建立当前表结构并创建必需的 Nacos 设置后，再启动应用。

```sh
docker compose -f deploy/docker-compose.yml up -d oceanbase nacos
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  docker compose -f deploy/docker-compose.yml up -d --build dsh
```

Web 应用监听 3080。本地 Nacos 控制台使用 8080，API 使用 8848，客户端 gRPC 端点使用 9848。OceanBase 使用 2881。随附 Compose 配置选择 `order-svc` Nacos 命名空间；请创建它，或将 `DSH_NACOS_NAMESPACE` 设为已有命名空间。

默认运行时基础镜像为 `node:24-bookworm-slim`。如果本地只缓存了完整 Node 24 镜像，可使用构建参数 `--build-arg RUNTIME_BASE_IMAGE=node:24-bookworm`，不必更改应用或数据库配置。

运维环境变量只保留 Nacos 坐标、条目名、应用监听端口和可选的插件安装设置。数据库凭据与连接选项不属于 Compose 应用环境字段。模型 API key 放在 `dsh-credentials.yaml` 中，继承的模型密钥环境变量仍保留原有的只读优先级。

<a id="configuration-updates"></a>
## 配置更新

| Nacos 条目 | 用途 | 生效方式 |
|---|---|---|
| `dsh-settings.yaml` | `deployment` 与模型、应用设置 | 数据库和应用名需要重启，支持的设置实时更新 |
| `dsh-credentials.yaml` | 模型 API key 与授权凭据 | 实时 |
| `dsh-plugin-roster.yml` | 插件包规格及可选的仓库、token | 重启时安装或移除清单拥有的包 |
| `dsh-plugins.yml` | 已安装插件的补丁 | 配置档实时重载 |
| `dsh-agents.md` | 用户全局指令 | 镜像到 Harness 主目录 |

应用拥有自己的 Nacos 命名空间，`appName` 将其数据库行与其他应用分开。修改名称会选择另一组行，不会迁移数据。`DSH_PLUGINS` 仍可与 Nacos 清单共同提供可选包规格。安装新插件包需要重启，因为模块解析发生在配置档组合时。

<a id="operational-limits"></a>
## 运维限制

- Nacos 设置与凭据含有密钥。应限制其命名空间访问，并在非开发部署中开启服务器鉴权。
- 源码中的示例 Nacos 凭据不是密钥管理机制。生产凭据必须通过部署专用的安全构建或经批准的密钥注入设计提供。
- 会话持久化共享持久历史，但活跃 Agent 与任务仍属于各自进程。此变更不实现分布式会话执行或带身份认证的多租户 shell 沙箱。
- 验证新部署和回滚流程之前，必须保留原数据库与配置备份。
