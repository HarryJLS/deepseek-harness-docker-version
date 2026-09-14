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
- [共享确认](#shared-confirmation)
- [临时文件](#temporary-files)
- [用户隔离](#user-isolation)
- [表结构](#schema)
- [保留数据](#retained-data)
- [部署](#deployment)
- [隔离验证](#isolated-verification)
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
  execution:
    leaseMs: 30000
    renewIntervalMs: 5000
    pollIntervalMs: 500
    maxQuestionBytes: 65536
    uploadReceiptTtlMs: 172800000
    assistantStateChunkBytes: 49152
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

<a id="shared-confirmation"></a>
## 共享确认

Docker 配置档启用持久化问题与方案审核。提交的问题记录在既有会话事件 JSON 中，提问的本轮随即结束。原 Web 卡片将会话、问题标识、版本和决定作为新请求提交，任意副本均可加载已提交上下文并继续。相同重试不会再次启动已经执行的后续流程；过期版本或冲突回答会被拒绝。

同一 Nacos 文档中的 `deployment.execution` 管理上述时间与问题大小限制。可续期的执行占用使用既有 `dsh_kv_record` 表中的小记录，不增加审批表或会话列。过期以数据库时间为准，每次会话写入在事务中验证执行权，Redis 淘汰不会移除保护。一次操作持有执行权直到 agent 与写入结束，其间其他修改请求返回忙碌。取消请求可以进入其他副本；历史事件流轮询已提交事件，不依赖执行副本的内存。

共用表的每个并发副本仍需独立的 Nacos 配置项 `deployment.database.snowflakeWorkerId`。共享文件要求所有副本使用相同 NAS 挂载和相对目录，请将 Compose 中的附件 tmpfs 替换为该挂载。数据库历史与待确认卡片可在文件清理后保留，但上下文缓存不能恢复已删除的文件内容或预览。

服务于相同活跃会话的副本使用相同的持久化确认版本和 Nacos 策略。工作区元数据通过短数据库事务刷新，包括新建工作区和并发会话关联。

此模式支持使用 `exit_plan_mode` 和 `ask_user_question` 的顺序式顶层 Web 会话，不序列化存活的权限审批回调、运行中的终端、委派任务或任意插件资源。外部副作用执行期间崩溃不能证明该操作是否完成；上传和业务接口需要自身的幂等标识，未完成的副作用不会自动重放。

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

<a id="retained-data"></a>
## 保留数据

Docker 发行版使用相同的表、字段及索引存储当前 Session 记录。历史对话保留在原来的 `app` 值下作为归档；当前应用不转换、继续执行或展示这些对话。

在这些表上启用全新部署时，先停止旧应用副本，并保留数据库备份及对应的 Nacos 配置。为所有新副本选择一个未使用的 `deployment.appName`，例如 `order-svc-v015`。数据库连接及 `DSH_NACOS_NAMESPACE` 保持不变。每个并行运行的副本仍需使用独立的 `snowflakeWorkerId`。仅在部署匹配版本时应用该配置；应用标识不会自动切换。

新标识选择空的 Session 和应用 KV 状态，包括工作区注册信息，不修改归档行。存储在数据库中的应用状态需要重新配置；Nacos 管理的模型设置、凭据及插件条目仍在同一命名空间中。Redis 键也包含应用标识，因此保留的缓存不会向新部署提供旧 Session。

保留数据不是新版 Web 界面中可浏览的归档。查看它需要旧版本及其应用标识。回退前先停止新副本，旧版本不得读取新应用的记录。临时附件文件可独立过期，数据库备份不会保留这些文件。

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

容器命令参数可提供额外的 `--patch <path>` 补丁层。入口程序将这些参数放在自动添加的应用级 `--no-open` 参数之前，并将带引号的路径保留为单个参数。

运维环境变量只保留 Nacos 坐标、条目名、应用监听端口和可选的插件安装设置。数据库与 Redis 凭据和连接选项不属于 Compose 应用环境字段。模型 API key 放在 `dsh-credentials.yaml` 中，继承的模型密钥环境变量仍保留原有的只读优先级。

<a id="isolated-verification"></a>
## 隔离验证

[双副本测试](../apps/cli/tests/profiles/docker/replicas.e2e.ts)需要 Docker Compose、已安装的工作区依赖、Playwright Chromium 以及本地构建的应用镜像。将 `DSH_DOCKER_TEST_IMAGE` 设置为该镜像后运行：

```sh
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/docker/replicas.e2e.ts --retry 0
```

测试创建随机命名的 Compose 项目，独立运行 OceanBase、Redis、Nacos、模型 fixture 及两个应用副本。应用使用仅具 DML 权限的数据库账号；测试检查上传归属、跨副本流式回复、缓存恢复、容器替换后的确认操作，以及归档行和表定义保持不变。测试认证仅存在于代理 fixture 中，生产身份仍由可信平台提供。诊断文件保留在 `.artifacts/dsh-v3-*`；清理流程会删除该项目的容器和卷，失败后也会执行。测试不会操作既有应用服务，未选择镜像时会跳过。

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
- 共享确认不会转移任意运行中的插件资源，也不提供多租户 shell 沙箱。执行、文件共享和外部副作用的限制见[共享确认](#shared-confirmation)。
- 验证新部署和回滚流程之前，必须保留原数据库与配置备份。
