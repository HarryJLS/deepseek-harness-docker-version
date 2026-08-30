---
description: "容器化部署的配置操作教程：从零起一套栈、五个 Nacos 条目的完整范例、多应用隔离、插件上架与排错。"
kind: "deployment-guide"
---

# 配置指导教程

面向运维和应用开发者。[配置与状态拓扑](CONFIG-TOPOLOGY.zh.md)讲的是「为什么这样分层」，本文讲「具体怎么填」。

## 目录

- [1. 五分钟起一套栈](#quickstart)
- [2. 配置放在哪：一张判断表](#where)
- [3. 环境变量全表](#env)
- [4. 五个 Nacos 条目（完整范例）](#entries)
- [5. 多应用共用一套基础设施](#multi-app)
- [6. 插件：从写到上架](#plugins)
- [7. 排错](#troubleshooting)

-----

<a id="quickstart"></a>
## 1. 五分钟起一套栈

```sh
docker compose -f deploy/docker-compose.yml up -d --build
```

三个服务起来后：

| 服务 | 地址 | 用途 |
|---|---|---|
| dsh | http://localhost:3080 | harness 本体 |
| Nacos 控制台 | http://localhost:8080 | 改实时配置 |
| PostgreSQL | localhost:5432 | 会话与存储 |

**此时还不能用** —— 没有 API key。最小可用配置只需一件事：在 Nacos 控制台新建配置

- Data ID：`dsh-credentials.yaml`
- Group：`DEFAULT_GROUP`
- 内容：

```yaml
refs:
  DEEPSEEK_API_KEY: sk-你的真实key
records: {}
```

发布后 10 秒内生效，无需重启。打开 http://localhost:3080 即可对话。

> 也可以用容器环境变量 `DEEPSEEK_API_KEY` 注入。**环境变量优先且只读** —— 设了它，Nacos 里的同名 ref 会被遮蔽，且写入会被显式拒绝。

-----

<a id="where"></a>
## 2. 配置放在哪：一张判断表

问自己一个问题：**这个值在连上 Nacos 之前需不需要先读到？**

| 需要 → 静态 | 不需要 → 实时 |
|---|---|
| 监听地址端口 | 模型路由、默认模型 |
| Nacos 自己的地址 | API key、授权凭据 |
| 数据库连接串 | agent 循环参数、权限预设 |
| Nacos 命名空间 | 全局提示词 |
| 能力接缝挂哪个实现 | 插件的挂载与配置 |

静态的改法：改 `packages/bundle/docker/cordis.patch.yml` → 重建镜像 → 重新部署。
实时的改法：Nacos 控制台改内容。

**一个例外**：插件清单在 Nacos，但**改完要重启容器**。原因见 [6.4](#plugin-restart)。

-----

<a id="env"></a>
## 3. 环境变量全表

写在 `docker-compose.yml` 的 `dsh.environment` 下。

### 身份与网络

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_APP_NAME` | `dsh` | 应用名的**兜底**值；settings 条目里的 `deployment.appName` 优先 |
| `DSH_PORT` | `3080` | 容器内监听端口 |

### Nacos

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_NACOS_HOST` | `nacos` | 地址；gRPC 端口由 HTTP 端口 +1000 推导 |
| `DSH_NACOS_PORT` | `8848` | HTTP 端口 |
| `DSH_NACOS_NAMESPACE` | 空（public） | 命名空间 id；凭证建议单独隔离 |
| `DSH_NACOS_GROUP` | `DEFAULT_GROUP` | 配置分组 |
| `DSH_NACOS_USERNAME` / `_PASSWORD` | 未设 | Nacos 开鉴权时用 |

单节点 standalone 即可，不需要集群。

### PostgreSQL

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_POSTGRES_URL` | 未设 | 完整连接串；设了就忽略下面的分散字段 |
| `DSH_POSTGRES_HOST` / `_PORT` | `postgres` / `5432` | 地址 |
| `DSH_POSTGRES_DB` / `_USER` / `_PASSWORD` | `dsh` / `dsh` / 未设 | 库名与凭据 |
| `DSH_POSTGRES_SCHEMA` | 由 `DSH_APP_NAME` 推导 | 精确指定 schema，覆盖推导结果 |

### 插件

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PLUGINS` | 空 | 插件规格，逗号或空格分隔。与 Nacos 清单**取并集**。纯 Nacos 管理时留空即可。 |
| `DSH_NPM_REGISTRY` | 未设 | 清单条目没写 `registry` 时的兜底 |
| `DSH_NPM_TOKEN` | 未设 | 清单条目没写 `token` 时的兜底 |

### 条目名覆盖（一般不用改）

| 变量 | 默认 |
|---|---|
| `DSH_NACOS_SETTINGS_DATA_ID` | `dsh-settings.yaml` |
| `DSH_NACOS_CREDENTIALS_DATA_ID` | `dsh-credentials.yaml` |
| `DSH_NACOS_PLUGINS_DATA_ID` | `dsh-plugin-roster.yml` |

-----

<a id="entries"></a>
## 4. 五个 Nacos 条目（完整范例）

五个条目在每个部署里**名字完全相同** —— 每个应用拥有自己的 Nacos 命名空间，隔离由命名空间完成，不靠给条目起不同的名字。Group 一律 `DEFAULT_GROUP`。

新建配置时记得选对**类型**：YAML 条目选 `yaml`（控制台才有语法高亮和校验），`dsh-agents.md` 选 `text`。

| Data ID | 管什么 | 生效 |
|---|---|---|
| `dsh-settings.yaml` | 应用身份 + 用户设置各命名空间 | 秒级 |
| `dsh-credentials.yaml` | API key 与授权记录 | 秒级 |
| `dsh-plugins.yml` | 插件挂载/禁用/改配置 | 秒级 |
| `dsh-plugin-roster.yml` | 装哪些插件、从哪个仓库装 | **需重启** |
| `dsh-agents.md` | 全局提示词 | 新会话 |

### 4.1 `order-svc-settings.yaml` — 用户设置

键是命名空间名，值是该命名空间的用户覆盖层。**只写要覆盖的**，没写的落回 schema 默认值。

顶部的 `deployment` 不是设置命名空间，是这个部署的身份声明 —— entrypoint 在 harness 启动前读它，决定本应用的 PostgreSQL schema。界面写入是按命名空间读改写（`{ ...current, [ns]: section }`），所以这个键不会被冲掉。

```yaml
# 应用身份。改了要重启容器：表打开后无法搬家。
deployment:
  appName: order-svc

# 新会话默认用哪个模型
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high

# DeepSeek 官方适配器：这个应用允许用的模型清单
llm-deepseek:
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
      description: 快速、经济，适合聚焦、常规或并行任务。
      contextWindow: 1000000
      inputModalities:
        - text

# agent 主循环：单步内最多并发多少个工具调用。1 = 串行。
agent-loop:
  maxParallelToolCalls: 4

# 子 agent 模型选择。false = 子 agent 跟随主 agent 的模型。
subagent-model-selection:
  enabled: false
  allowedModels: []

# 新手引导：改版本号让所有用户重看欢迎提示
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
```

接入**第三方模型供应商**用 `llm-pi-ai`，填了 provider 才会注册路由：

```yaml
llm-pi-ai:
  providers:
    my-vendor:
      displayName: 内部网关
      apiKeyEnv: MY_VENDOR_API_KEY    # 对应 credentials 条目 refs 里的键名
      api: anthropic-messages          # 取值：anthropic-messages | openai-responses
      baseURL: https://llm.internal.example.com
      models:
        - id: internal-large
          name: 内部大模型
```

> 实例注册的命名空间不止这些（还有 `permission`、`shell`、`locale`、`ui-theme`、`web-search-deepseek`、`agent-presets` 等）。**各命名空间接受哪些字段以 UI 的设置页为准** —— 在设置页改一次，再回 Nacos 看条目变成什么样，是确认字段名最可靠的方式。乱填的键会被 schema 拒绝。

### 4.2 `order-svc-credentials.yaml` — 凭证

```yaml
# refs — 按环境变量名索引的密钥，供 LLM 适配器按名解析
refs:
  DEEPSEEK_API_KEY: sk-你的真实key
  MY_VENDOR_API_KEY: sk-第三方供应商的key

# records — 授权凭据记录，没有上层可遮蔽，存在即事实
records: {}
```

三条规则：

1. **容器环境变量优先且只读**。设了 `DEEPSEEK_API_KEY` 环境变量，这里的同名 ref 被遮蔽。
2. **写入被遮蔽的引用会显式拒绝**，不会静默忽略 —— 否则界面显示写成功但解析仍返回旧值。
3. **`records` 没有上层**，存在即生效。

> ⚠️ 本条目是明文，Nacos 不额外加密。放在**读权限受限的独立命名空间**，并给 Nacos 开鉴权。

### 4.3 `order-svc-plugins.yml` — 插件补丁层（实时）

被写到 profile 的 `cordis.patch.yml`，Loader 监听该文件，所以**改完无需重启**。内容是 Loader 的 patch 数组。

```yaml
# 改已装插件的配置。注意：整块 config 会被替换，
# 所以要写全这一行拥有的所有键，不能只写要改的那个。
- id: session-title
  config:
    fallbackMaxWords: 5
    fallbackMaxBytes: 40
    maxTitleBytes: 120

# 临时禁用一个插件
- id: demo-plugin
  disabled: true

# 挂载一个已安装、但自身没声明 dsh.bundle 的包
- insert:
    - id: my-plugin
      name: my-plugin-package
      config:
        someOption: true
```

不做任何覆盖时写空数组：

```yaml
[]
```

> ⚠️ **不要 `insert` 一个已经自带 `dsh.bundle` 的包** —— 它会被挂载两次；持有具名资源的插件第二次会报 `already-open`，容器起不来。

### 4.4 `order-svc-plugin-roster.yml` — 插件清单（需重启）

```yaml
# 私有仓库地址。不写则用 DSH_NPM_REGISTRY，再不写用 pnpm 默认源。
registry: https://npm.internal.example.com/

# 私有仓库 bearer token。仓库匿名可读时删掉这行。
token: npm_xxxxxxxxxxxxxxxx

packages:
  - dsh-plugin-example@1.2.0
  - '@acme/dsh-internal-tools'
```

公共源、无鉴权时最简形式：

```yaml
packages:
  - dsh-plugin-example@1.2.0
```

**清单是声明式的**：删掉一行，下次启动会卸载那个包。只卸载由清单装过的（记录在 profile 的 `dsh.roster`），运维手工 `dsh plugin add` 的不动。

配了 `token` 却没配 `registry` 会**直接报错拒绝启动** —— 因为这意味着运维以为有鉴权而实际不会发生，私有包会以一个没有原因的 404 失败。

### 4.5 `order-svc-agents.md` — 全局提示词

纯 Markdown，被写到 `$DSH_HOME/AGENTS.md`，作为用户级全局指令注入**每个会话**的提示词。

```markdown
# 订单服务助手

你是订单服务的运维助手。回答遵循以下约定：

## 语言与风格
- 用中文回答，除非用户用英文提问。
- 先给结论，再给依据。

## 边界
- 涉及退款、改价、取消订单的操作，只说明步骤，不直接执行。

## 上下文
- 订单表主键是 `order_no`，不是自增 id。
- 时区一律按 Asia/Shanghai 处理。
```

改动对**新会话**生效，已在进行的会话保持它加载时的指令。

> 💰 这段文字进每个会话的每次请求。写长了每轮都在付 token。

-----

<a id="multi-app"></a>
## 5. 多应用共用一套基础设施

一份基础镜像，多个应用，共用同一个 Nacos 和同一个 PostgreSQL。

**Nacos 各自隔离，PostgreSQL 共用一个库。**因为库共用，唯一必须按应用区分的就是 schema。应用在自己的 `dsh-settings.yaml` 里声明名字（`deployment.appName`），部署描述里只写坐标：

```yaml
services:
  order-svc:
    image: dsh-dsh
    environment:
      DSH_NACOS_HOST: nacos
      DSH_NACOS_NAMESPACE: order-svc     # 这个应用自己的 Nacos 命名空间
      DSH_POSTGRES_HOST: postgres
    ports: ['3080:3080']

  billing-svc:
    image: dsh-dsh
    environment:
      DSH_NACOS_HOST: nacos
      DSH_NACOS_NAMESPACE: billing-svc   # 只有这里不同
      DSH_POSTGRES_HOST: postgres
    ports: ['3081:3080']
```

应用名会自动折叠成合法的 schema 标识符：

| `deployment.appName` | PG schema |
|---|---|
| 未声明 | `dsh` |
| `order-svc` | `order_svc` |
| `Order Service` | `order_service` |
| `2fa` | 拒绝启动 |

**必须隔离，不能共用 schema**：`kv_record` 的主键是 `(unit, tbl, key)`，不带应用维度。两个应用在同一 schema 里写同一个 unit 会互相覆盖。

数字开头的名字（如 `2fa`）会被**拒绝而不是修复** —— 任何修复都可能把两个不同应用悄悄合并到一个 schema。

其他注意：

- 数据库角色需要 `CREATE` 权限，首次启动时建 schema。
- **改 `deployment.appName` 不会迁移数据**：容器会指向一个空 schema，旧的原样留在那里。

-----

<a id="plugins"></a>
## 6. 插件：从写到上架

### 6.1 三种插件来源

| 来源 | 放在哪 | 适用 |
|---|---|---|
| **仓库内置** | `packages/<组>/<包>/` | 首版默认插件集，随镜像发布 |
| **Nacos 清单** | 私有 npm 仓库 | 各应用的个性化插件 |
| `DSH_PLUGINS` | 同上 | 与清单等价，用环境变量固定时 |

内置插件在镜像的 `/app/packages/` 里；清单装的在 `/var/lib/dsh/profiles/web/node_modules/`。

### 6.2 写一个插件

完整可运行的例子在 [`deploy/testplugin/`](testplugin/)。要点：

```js
// index.js
import { z } from 'zod'

export const name = 'dsh-demo-plugin'

// 注入 storageDomain 而不是 storage：
// 前者是域层挂好后才提供的服务，注入 storage 会在任何 form 挂上之前就激活。
export const inject = ['storageDomain']

const DOMAIN = {
  name: 'demo_plugin',              // 必须匹配 ^[a-z][a-z0-9_]*$
  version: 1,
  tables: {
    loads: { valueSchema: z.object({ at: z.string(), app: z.string() }) },
  },
}

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(DOMAIN)
  ctx.effect(() => async () => { await domain.close() }, 'demo domain')

  const at = new Date().toISOString()
  await domain.table('loads').put(at, { at, app: process.env.DSH_APP_NAME ?? 'dsh' })
}
```

`package.json` 里**声明 `dsh.bundle` 就会自动挂载**，不需要在 Nacos 的 plugins 条目里再写一行：

```json
{
  "name": "dsh-demo-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dependencies": { "zod": "^4.4.3" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# cordis.patch.yml —— 这个包自己的挂载层
- insert:
    - id: demo-plugin
      name: dsh-demo-plugin
```

**没声明 `dsh.bundle`** 的包只会作为普通依赖装上，必须在 `dsh-plugins.yml` 里写 `insert` 才会挂载。

### 6.3 发布并上架

```sh
# 发到私有仓库
npm publish --registry https://npm.internal.example.com/

# 在 Nacos 的 dsh-plugin-roster.yml 加一行
#   packages:
#     - dsh-demo-plugin@0.1.0

# 重启容器
docker restart <容器名>
```

启动日志会显示：

```
entrypoint: order-svc-plugin-roster.yml declares 1 plugin package(s)
entrypoint: installing 1 plugin package(s) from https://npm.internal.example.com/
+ dsh-demo-plugin 0.1.0
```

<a id="plugin-restart"></a>
### 6.4 为什么装插件必须重启

Loader 在**组合插件树时一次性解析** profile 的模块。往运行中的进程里装一个包，Loader 看不见它 —— 无论用什么方式请求挂载都不行。所以安装动作放在 entrypoint、harness 启动之前。

Nacos 换来的是**集中编辑**（不用重新部署、不用改环境变量、每应用一个条目），不是免重启安装。

**挂载则是实时的**：包已经装好的前提下，`dsh-plugins.yml` 挂载、卸载、禁用、改配置全都无需重启。

| 动作 | 是否需要重启 |
|---|---|
| 装一个新包 / 卸载一个包 | ✅ 需要 |
| 挂载已装的包 | ❌ 不需要 |
| 禁用 / 重新启用已挂载的插件 | ❌ 不需要 |
| 改已挂载插件的 config | ❌ 不需要 |

-----

<a id="troubleshooting"></a>
## 7. 排错

### 容器起不来

```sh
docker logs <容器名> 2>&1 | tail -40
```

| 日志 | 原因 | 处理 |
|---|---|---|
| `domain 'xxx' is already open` | 插件被挂载两次 | 从 plugins 条目删掉 `insert`，包自带 `dsh.bundle` 就够了 |
| `ERR_PNPM_FETCH_401` | 私有仓库鉴权失败 | 检查清单条目的 `token` |
| `a plugin-registry token needs a registry` | 配了 token 没配 registry | 补上 `registry` |
| `must match /^[a-z][a-z0-9_]*$/` | 应用名不合法 | 换成字母开头的名字 |
| `ERR_MODULE_NOT_FOUND` | 插件依赖没装上 | 确认依赖写在插件 `package.json` 的 `dependencies` |

### 构建失败但显示成功

`docker compose build` 有时**构建失败却返回 exit 0**。判断镜像是否真的更新了：

```sh
docker images dsh-dsh --format '{{.CreatedSince}}'
```

显示的时间不是刚才，说明没更新。看真实原因：

```sh
docker compose -f deploy/docker-compose.yml build --progress=plain dsh 2>&1 | grep -E 'ERROR|ERR_'
```

最常见的是 `ERR_PNPM_OUTDATED_LOCKFILE` —— 改了任何 `package.json` 后要跑 `pnpm install` 并把 `pnpm-lock.yaml` 一起提交。

### Nacos 改了不生效

先确认条目名对不对：条目前缀是 `DSH_APP_NAME`，不设时是 `dsh`。

```sh
docker exec <nacos容器> sh -c 'curl -s "http://127.0.0.1:8848/nacos/v3/admin/cs/config?dataId=order-svc-settings.yaml&groupName=DEFAULT_GROUP&namespaceId=" -H "serverIdentity: security"'
```

然后按类型判断：插件清单本来就需要重启；其余条目应在 10 秒内生效。

### 确认数据落在哪个 schema

```sh
docker exec <pg容器> psql -U dsh -d dsh -c "\dn"
docker exec <pg容器> psql -U dsh -d dsh -c "select unit, count(*) from order_svc.kv_record group by unit;"
```

-----

## 相关文档

- [容器部署指南](README.md) — 运行栈与环境变量速查
- [配置与状态拓扑](CONFIG-TOPOLOGY.zh.md) — 三层划分的设计依据
- [Nacos 包组](../packages/nacos/README.md) — 提供者与文件镜像的实现
- [manual.html](manual.html) — 同样内容的单文件 HTML 版，浏览器直接打开
