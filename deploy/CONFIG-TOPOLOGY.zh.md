---
description: "容器化部署的三层配置与状态分布：镜像内静态配置、Nacos 实时配置、PostgreSQL 持久化数据。"
kind: "deployment-reference"
---

# 配置与状态拓扑

改造后的 dsh 不再依赖任何挂载目录。所有配置和状态被拆进三层，区分它们的不是重要性，而是**改它的方式和生效速度**。

| 层 | 位置 | 改法 | 生效 |
|---|---|---|---|
| 静态配置 | `packages/bundle/docker/cordis.patch.yml` | 改文件 → 重建镜像 → 重新部署 | 下次部署 |
| 实时配置 | Nacos 的 5 个配置条目 | Nacos 控制台改内容 | 秒级；插件清单需重启 |
| 运行数据 | PostgreSQL 的 6 张表（schema 由 `DSH_APP_NAME` 决定） | 由程序写入，运维不直接改 | — |

## 划分依据只有一条

一个值如果**在连上 Nacos 之前就必须读到**，它就只能是静态的——否则会形成循环依赖：要读配置得先连 Nacos，而 Nacos 的地址本身就在配置里。

绑定地址、Nacos 坐标、数据库连接串，全部属于这一类。**除此之外的一切都应该放进 Nacos。**

## 第一层 · 静态配置

随代码进镜像。这一层回答「挂载了哪些插件、服务怎么被访问到、后端在哪」，不回答「运维今天想要什么」。

### 网络与访问

| 配置行 | 值 | 说明 |
|---|---|---|
| `webserver.host` | `0.0.0.0` | 绑定全部网卡。容器有独立网络命名空间，只暴露运行时发布的端口。CLI 的 `--host 0.0.0.0` 被刻意拒绝，composition 层才是官方支持的声明方式。 |
| `webserver.port` | `DSH_PORT`，默认 3080 | 容器内监听端口。 |
| `connection.allowAnyHost` | `true` | 放通 Host 信任栅栏。容器经端口转发或 Ingress 访问，进程无法枚举客户端实际写的地址。 |
| `connection.requireAuth` | `false` | 关闭浏览器会话认证。**两道闸门都开，等于端口可达即可驱动 agent 执行 shell。** |

收回访问控制：把 `requireAuth` 改回 `true` 并删掉 `allowAnyHost`，dsh 会恢复要求浏览器会话 token，且只接受 `trustedHosts` 列出的来源。

### 后端坐标（经环境变量注入，一份镜像通用）

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_NACOS_HOST` | `nacos` | Nacos 地址；gRPC 端口由它 +1000 推导 |
| `DSH_NACOS_PORT` | `8848` | Nacos HTTP 端口 |
| `DSH_NACOS_NAMESPACE` | 空（public） | Nacos 命名空间；凭证条目建议单独隔离 |
| `DSH_NACOS_GROUP` | `DEFAULT_GROUP` | 配置分组 |
| `DSH_NACOS_USERNAME` / `_PASSWORD` | 未设 | Nacos 开启鉴权时使用 |
| `DSH_POSTGRES_URL` | 未设 | 完整连接串；设了就优先于下面的分散字段 |
| `DSH_POSTGRES_HOST` / `_PORT` | `postgres` / `5432` | 数据库地址 |
| `DSH_POSTGRES_DB` / `_USER` / `_PASSWORD` | `dsh` / `dsh` / 未设 | 库名与凭据 |
| `DSH_PLUGINS` | 空 | 启动时安装的插件规格，逗号或空格分隔；与 Nacos 清单合并 |
| `DSH_NACOS_PLUGINS_DATA_ID` | `<应用名>-plugin-roster.yml` | 插件清单条目 |
| `DSH_NPM_REGISTRY` | 未设 | 清单条目未指定 registry 时使用的仓库 |

### 五个提供者替换

这一层还决定了每个能力接缝挂的是哪个实现。原实现全部禁用，换成容器版：

| 原实现（已禁用） | 替换为 | 后端 |
|---|---|---|
| `settings-file` | `settings-nacos` | Nacos |
| `credentials-local` | `credentials-nacos` | Nacos |
| `storage-json` | `storage-postgres` | PostgreSQL |
| `session-persistence-jsonl` | `session-persistence-postgres` | PostgreSQL |
| `attachment-local` | `attachment-postgres` | PostgreSQL |

因为这些都是 Cordis 的**能力接缝**，替换只改变「数据存在哪」，不改变任何消费方——Models 页面、LLM 适配器、默认模型读到的接口完全一致。

## 第二层 · Nacos 实时配置

运维随时会调、且必须立刻对所有副本生效的东西。客户端走 gRPC 长连接，服务端主动推送变更，实测发布后 10 秒内生效。

### 条目一：`<应用名>-settings.yaml` — 用户设置

YAML 映射，键是命名空间名，值是该命名空间的用户层。当前实例注册了 14 个，全部 `applies=live`（改了立即生效，无需重启）：

| 命名空间 | 管什么 |
|---|---|
| `agent-default-model` | 新会话的默认模型与供应商 |
| `llm-deepseek` | DeepSeek 官方适配器配置 |
| `llm-pi-ai` | 多供应商适配器；填了 provider profile 才会注册路由 |
| `subagent-model-selection` | 子 agent 的模型选择策略 |
| `agent-loop` | agent 主循环参数 |
| `agent-presets` | 默认 agent 预设 |
| `permission` | 权限预设 |
| `shell` | shell 执行相关设置 |
| `web-search-deepseek` | 联网搜索配置 |
| `locale` | 界面语言 |
| `ui-theme` | 主题 |
| `ui-chat` / `ui-conversation` | 对话界面偏好 |
| `ui-onboarding` | 新手引导状态 |

条目里**只需写你要覆盖的命名空间**。没写的自动落回 schema 默认值与 composition base 层。当前 14 个里只有 2 个被实际覆盖，其余走默认。

### 条目二：`<应用名>-credentials.yaml` — 凭证

两个区段：`refs` 是按环境变量名索引的密钥，`records` 是授权凭据记录。

```yaml
refs:
  DEEPSEEK_API_KEY: sk-xxxxxxxx
records:
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: ... }
```

分层规则保持不变，这点很关键：

- **继承的进程环境优先且只读**——通过容器环境变量注入的 key 保持权威。
- 写入被环境变量遮蔽的引用会**显式拒绝**，而不是静默忽略。否则界面会显示写入成功但解析仍返回旧值。
- `records` 区段没有上层可遮蔽，存在即事实。

安全提示：这个条目存放明文密钥，Nacos 本身不额外加密。请把它放在**读权限受限的独立命名空间**，并给 Nacos 开启鉴权。

### 条目三：`<应用名>-plugins.yml` — 插件补丁层

被 `nacos-file-mirror` 写到 profile 的 `cordis.patch.yml`，内容是 Loader 的 patch 数组。`web` profile 声明了 `patchReload: live`，所以这个条目改了**无需重启**即可挂载、卸载、禁用或重配已安装的插件。

### 条目四：`<应用名>-plugin-roster.yml` — 插件清单

声明这个应用要装哪些插件，以及从哪个 npm 仓库下载：

```yaml
registry: https://npm.internal.example.com/
packages:
  - dsh-plugin-example@1.2.0
  - '@acme/dsh-internal-tools'
```

清单是声明式的：删掉一行，下次启动就会卸载那个包。只有由清单装过的包会被卸载，运维手工 `dsh plugin add` 的不会被动。

**改清单必须重启容器，这不是条目的限制。** Loader 在组合时一次性解析 profile 的模块，运行中新装的包它看不见——无论用什么方式请求挂载。所以安装动作放在 entrypoint、harness 启动之前。Nacos 换来的是集中编辑（不用重新部署、不用改环境变量、每个应用一个条目），不是免重启安装。

**挂载则是实时的**：已安装的包，通过 `<应用名>-plugins.yml` 挂载、卸载、禁用、改配置都无需重启。注意不要 `insert` 一个已经自带 `dsh.bundle` 的包——会重复挂载，持有具名资源的插件第二次会失败。

### 条目五：`<应用名>-agents.md` — 全局提示词

被 mirror 写到 `$DSH_HOME/AGENTS.md`，作为用户级全局指令注入每个会话的提示词。改了对**新会话**生效。

## 第三层 · PostgreSQL 持久化

运行时产生、无法重算的数据。这是「服务器不固定」能成立的前提——容器被销毁重建后，全新实例连上同一个库就能恢复。

| 表 | 列 | 存什么 |
|---|---|---|
| `session` | `id, meta jsonb, revision bigint, created_at` | 会话头。`revision` 每次写入递增，用于判断某个副本持有的视图是否已过期。 |
| `session_event` | `session_id, seq, event jsonb` | 会话事件日志，一行一事件，按 `seq` 有序。能按 seq 寻址，所以投影从水位线恢复时只读后缀。 |
| `kv_unit` | `unit, version` | 各存储单元的格式版本戳。版本不匹配会拒绝打开而非静默迁移。 |
| `kv_record` | `unit, tbl, key, value jsonb` | 存储记录。当前实际使用者：会话投影缓存、工作区、消息反馈。 |
| `kv_global` | `unit, value jsonb` | 各单元的全局单例槽。 |
| `attachment_object` | `sha256, media_type, bytes, width, height, data bytea, created_at` | 归一化后的图片二进制，按内容寻址。**去重是主键冲突**，不需要额外逻辑。 |

### 刻意不落库的东西

模型请求用的**派生图片变体**留在容器本地临时目录。每个变体都是「引用 + 路由策略」的确定性函数，被替换的容器会重新生成完全相同的字节。落库只会白白消耗数据库空间和写带宽。

判断原则：**只有无法重算的东西才需要持久化。**

### 建表时机

六张表由运行中的容器自建，无需预先执行 DDL。三个 PG 插件共用该应用的 schema，而 `CREATE SCHEMA IF NOT EXISTS` 在 PostgreSQL 中**对并发创建者不是原子的**，Cordis 又是并发加载插件的——所以建 schema 的动作做了容错，竞争失败即视为成功（schema 已存在正是调用方要的结果）。

## 相关文档

- [配置指导教程](CONFIGURATION-GUIDE.zh.md) — 起栈、五个条目的完整范例、多应用、插件上架、排错
- [容器部署指南](README.md) — 运行栈、修改运行中的部署、环境变量全表
- [Nacos 包组](../packages/nacos/README.md) — 实时配置提供者与文件镜像的设计
- [docker bundle](../packages/bundle/docker/README.md) — 这一层 patch 本身的说明
