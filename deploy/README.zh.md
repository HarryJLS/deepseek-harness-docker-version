---
description: "由 Nacos 管理的 Redis 与 OceanBase 会话存储、临时附件和可信平台用户隔离。"
kind: "deployment-reference"
---

# 容器部署

[English](README.md) | 中文

## 摘要

根目录 [Dockerfile](../Dockerfile) 构建 Web 应用。OceanBase 的 MySQL 模式保存会话日志和共享 KV 状态，Redis 缓存已提交的会话事件，Nacos 保存部署设置与模型凭据。附件字节只保存在临时文件中，不进入两个上下文存储。容器在启动 `dsh` 配置档前校验存储配置。

## 目录

- [数据库配置](#database-configuration)
- [Redis 缓存](#redis-cache)
- [临时文件](#temporary-files)
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
  redis:
    host: redis
    port: 6379
    database: 0
    tls: false
    keyPrefix: dsh-
    ttlSeconds: 172800
    maxChunkBytes: 65536
    maxEventBytes: 4194304
    batchSize: 128
    connectTimeoutMs: 5000
    commandTimeoutMs: 2000
  attachments:
    temporaryRoot: tmp/dsh-attachments
```

这些凭据用于随附的本地开发栈，生产环境应使用专用数据库账号。采用独立连接字段时，示例中的数据库字段均为必填项。条目缺失、Nacos 不可达、字段无效或数据库配置不完整都会在应用打开连接池之前阻止启动。数据库变更在容器重启后生效。

Nacos 启动凭据集中在 [deployment-config.mjs](deployment-config.mjs) 的 `NACOS_AUTH` 中，开发示例为 `nacos/nacos`，不读取运维环境变量。不要提交真实生产凭据。随附的本地 Nacos 服务关闭了鉴权，仅设置客户端凭据不会开启服务器鉴权。

启动程序将校验后的值写入 `/run` 下权限为 0600 的文件，Compose 将 `/run` 挂载为临时内存。`DSH_DATABASE_SECRET` 与 `DSH_REDIS_SECRET` 仅用于内部传递已从 Nacos 读取的文档，不是运维配置的回退来源，且都不会传给工具子进程。

<a id="redis-cache"></a>
## Redis 缓存

`deployment.redis` 必须与数据库设置声明在同一个 Nacos 条目中。`host` 必填，示例列出其余连接与缓存字段的默认值。可选的 `username` 和 `password` 配置 Redis ACL 认证。`tls: true` 启用证书校验的 TLS。未知字段、其他 key 前缀、非正数 TTL 或不一致的字节限制都会拒绝启动。连接与缓存策略变更在应用重启后生效。

所有 key 都以 `dsh-` 开头，并隔离应用、数据库、用户、会话及数据库物理行。各部分采用百分号编码；行哈希防止同一会话 ID 重建后复用旧缓存。

```text
dsh-<app>:db:<database>:user:<user>:session:<session>:{<row-hash>}:event:<seq>
dsh-<app>:db:<database>:user:<user>:session:<session>:{<row-hash>}:event:<seq>:part:<n>
```

每个 Redis 字符串连同 JSON 包装最多占用 `maxChunkBytes`。较大事件拆成带校验和的字节分块，流水线大小由 `batchSize` 限制。超过 `maxEventBytes` 的事件完整保留在 MySQL 中，不进入 Redis。不创建持续膨胀的用户级或会话级列表、哈希或整段对话值。每个读取或写入的 key 都获得 `ttlSeconds` 有效期，默认 172800 秒（2 天）；过期不删除数据库历史。

MySQL 提交后才发布缓存。每次读取先检查数据库用户归属和日志范围，再从 Redis 读取事件页。过期、缺失、格式错误或部分淘汰的页会从 MySQL 重新加载并回填 Redis。运行时 Redis 故障也使用 MySQL，但启动仍要求配置的 Redis 服务可连接。随附的开发 Redis 关闭快照和 AOF，内存限制为 256 MiB，采用 `allkeys-lru`；整个缓存丢失也可恢复。

<a id="temporary-files"></a>
## 临时文件

`deployment.attachments.temporaryRoot` 选择相对于服务工作目录（容器内为 `/app`）的子目录，默认为 `tmp/dsh-attachments`。绝对路径、父目录跳转以及工作目录本身均被拒绝。Compose 将默认的 `/app/tmp/dsh-attachments` 挂载为临时内存；选择其他目录的部署自行管理清理与挂载策略。

图片引用只包含相对路径、文件名，以及渲染和完整性校验所需的少量元数据。图片字节、base64 上传内容和生成的请求图片文件都不进入 Redis 或 MySQL。普通文件提及本来就只记录路径；工具产生的文本仍保留在会话日志中，因为它是模型可见输出，不是存储的文件对象。

Agent 每一步执行前，缺失的临时图片会转成已记录的纯路径文本替换。模型不依赖该文件即可继续；再次查看图片需要重新附加文件，或使用仍保留该文件的共享临时文件系统。历史图片预览可能提示文件缺失。已开始的图片请求若遇到同时清理文件，仍可能失败。已有数据库附件行不会被删除或迁移。

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

构建上下文是仓库根目录。[docker-compose.yml](docker-compose.yml) 定义应用、Redis、Nacos 与 OceanBase 服务。启动后端服务、建立当前表结构并创建必需的 Nacos 设置后，再启动应用。

```sh
docker compose -f deploy/docker-compose.yml up -d oceanbase nacos redis
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  docker compose -f deploy/docker-compose.yml up -d --build dsh
```

Web 应用监听 3080。本地 Nacos 控制台使用 8080，API 使用 8848，客户端 gRPC 端点使用 9848。OceanBase 使用 2881。随附 Compose 配置选择 `order-svc` Nacos 命名空间；请创建它，或将 `DSH_NACOS_NAMESPACE` 设为已有命名空间。

默认运行时基础镜像为 `node:24-bookworm-slim`。如果本地只缓存了完整 Node 24 镜像，可使用构建参数 `--build-arg RUNTIME_BASE_IMAGE=node:24-bookworm`，不必更改应用或数据库配置。

运维环境变量只保留 Nacos 坐标、条目名、应用监听端口和可选的插件安装设置。数据库与 Redis 凭据和连接选项不属于 Compose 应用环境字段。模型 API key 放在 `dsh-credentials.yaml` 中，继承的模型密钥环境变量仍保留原有的只读优先级。

<a id="configuration-updates"></a>
## 配置更新

| Nacos 条目 | 用途 | 生效方式 |
|---|---|---|
| `dsh-settings.yaml` | `deployment` 与模型、应用设置 | 数据库、Redis、临时文件和应用名需要重启，支持的设置实时更新 |
| `dsh-credentials.yaml` | 模型 API key 与授权凭据 | 实时 |
| `dsh-plugin-roster.yml` | 插件包规格及可选的仓库、token | 重启时安装或移除清单拥有的包 |
| `dsh-plugins.yml` | 已安装插件的补丁 | 配置档实时重载 |
| `dsh-agents.md` | 用户全局指令 | 镜像到 Harness 主目录 |

应用拥有自己的 Nacos 命名空间，`appName` 将其数据库行与其他应用分开。修改名称会选择另一组行，不会迁移数据。`DSH_PLUGINS` 仍可与 Nacos 清单共同提供可选包规格。安装新插件包需要重启，因为模块解析发生在配置档组合时。

<a id="operational-limits"></a>
## 运维限制

- Nacos 设置与凭据含有密钥。应限制其命名空间访问，并在非开发部署中开启服务器鉴权。
- 源码中的示例 Nacos 凭据不是密钥管理机制。生产凭据必须通过部署专用的安全构建或经批准的密钥注入设计提供。
- 会话上下文通过 Redis 与 MySQL 共享，但活跃 Agent、收件箱、事件流和任务仍属于各自进程。网关必须将活跃会话固定路由到所属进程；此缓存不是分布式执行、写入租约或多租户 shell 沙箱。切换节点恢复前，应先停止原执行节点。
- 验证新部署和回滚流程之前，必须保留原数据库与配置备份。
