# Ciallo-FreeBuff-Proxy

来都来了 不点个⭐再走吗~?

Freebuff 免费模型 → OpenAI / Anthropic / Responses 兼容 API，带 Web 管理面板与账号池管理。

- 9 个免费模型，只有 2 个不限地区，另 6 个**必须走美国出口**才解锁（见「[模型一览](#模型一览)」）
- 支持 OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`、Responses `/v1/responses`
- Web 面板：账号池管理（添加/删除/探测/额度）、API Key 管理、模型别名映射
- 出口代理：可选接机场订阅（mihomo 内核），上游流量经节点出站换 IP
- 构建标识 + 检查更新：跟随 beta 分支，GitHub Actions 自动构建镜像

## 快速开始（Docker）

```bash
cp .env.example .env     # 填 ADMIN_PASSWORD（面板密码）
docker compose up -d
```

打开 http://127.0.0.1:8787 ，用 `.env` 里的密码登录面板，在「账号池 → 添加」里粘贴 Freebuff token。

### 数据目录（账号文件）

账号池、API Key、模型映射、mihomo 缓存都持久化在数据目录。`docker-compose.yml` 默认把它
绑挂到 compose 文件同级的 `./data`，方便直接在宿主机查看和管理：

```
data/
├─ credentials/
│  ├─ freebuff_credentials.json   # 账号池（token）
│  └─ server-key.txt              # 面板 API Key
└─ aliases.json                   # 自定义模型别名
```

容器以 `node`(uid 1000) 运行，入口脚本启动时会把 `/data` 属主修正为 `node`，所以宿主目录
属主对不上也不会 permission denied，**无需手动 chown**。想让数据交给 Docker 托管、不落宿主
目录，把 `docker-compose.yml` 里的挂载换成命名卷 `- freebuff-data:/data`（文件内有说明）。


### 局域网 / 容器互通（可选）

默认端口只绑本机回环。想让同机其它 compose 项目（agent 容器）按容器名访问，解开
`docker-compose.yml` 里的 `ai-internal` 网络注释（两处），先建好外部网络再启动：

```bash
docker network create ai-internal
docker compose up -d
```

之后其它容器用 `http://freebuff-proxy:8787/v1` 即可，无需暴露宿主端口。

## 配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 是 | 面板登录密码（未设则面板不鉴权） |
| `SUBSCRIPTION_URL` | 否 | 机场订阅地址，配置后上游流量经 mihomo 节点出站 |
| `FREEBUFF_API_KEY` | 否 | 面板 API Key，不设则首次启动自动生成 |
| `FREEBUFF_TOKEN` | 否 | 账号池 token（多账号逗号分隔），也可在面板里添加 |
| `FREEBUFF_READONLY` | 否 | `true` 时禁止面板修改账号池 |
| `FREEBUFF_DATA_DIR` | 否 | 数据目录（账号池/Key/模型映射/内核缓存），容器默认 `/data`，本地默认 `./data` |

## 出口代理（订阅）

配置 `SUBSCRIPTION_URL` 后：

1. 启动时自动拉起 mihomo 内核（镜像已内置），拉取并解析订阅
2. 所有上游请求（session/chat/探测）经订阅里的节点出站
3. 默认交给 mihomo 自动测速选点（`freebuff-auto` 组），`codebuff.com` 域名走代理，其余直连
4. 测活没通过的节点会从面板节点列表里剔除；「当前订阅」右侧的「更新」按钮可随时重拉订阅并重测

不配置则保持直连，mihomo 不启动。

> ⚠️ **想稳定用到 premium 模型就别用自动选点**。访问层由出口 IP 决定（见「[模型一览](#模型一览)」），
> 自动组只按延迟挑，随时可能把你换到一个非美国或被判 VPN 的节点，账号就从 `full` 掉成 `limited`。
> 在面板里手动固定一个验证过能拿 `full` 的美国节点更可靠。

## 模型一览

Freebuff 把免费账号分成两个**访问层**（`accessTier`）：出口 IP 落在受支持地区才是 `full`，否则是
`limited`。两层能用的模型完全不同 —— 这是上游的地区门控，不是本代理的限制。官方源码
（`common/src/constants/freebuff-models.ts:1444`）写得很直白：

> Models available to limited-region Freebuff Web users. They share the
> limited-region session pool; **every other model remains geo-gated**.

那份「地理豁免」名单只有两个模型，正是 `deepseek-v4-flash` 与 `mimo-v2.5`；`LIMITED_FREEBUFF_MODEL_ID`
（limited 层的默认模型）也硬编码为 Flash。

| 模型 ID | 官方名 | 需要 US 出口 | 思考强度档位 | 实测状态 |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash 07/31 | **否** | `low` `high` `max` | ✅ 可用（limited 层默认模型） |
| `mimo/mimo-v2.5` | MiMo 2.5 | **否** | 无档位（仅思考开/关） | ✅ 可用 |
| `z-ai/glm-5.2` | GLM 5.2 | 否，但要邀请解锁 | 路由忽略 `reasoning_effort` | ⚠️ 额度 `0/0`，未解锁 |
| `minimax/minimax-m3` | MiniMax M3 | **是** | 无档位（adaptive / 关） | ✅ full 层实测可用 |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro 08/13 | **是** | `low` `high` `max` | ✅ full 层实测可用 |
| `openai/gpt-5.6-luna` | GPT-5.6 Luna | **是** | `low` `medium` `high` `xhigh` `max` | ✅ full 层实测可用 |
| `crof/kimi-k3-eco` | Kimi K3（Eco 量化版） | **是** | 路由忽略 `reasoning_effort` | ✅ full 层实测可用 |
| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 | **是** | `minimal`→`xhigh`（**不吃 `max`**） | ❌ 上游回 `invalid_api_key`，调不通 |
| `anthropic/claude-fable-5` | Claude Fable 5 | **是** | `low` `medium` `high` `xhigh` `max` | ❌ 409 `session_model_mismatch`，账号未授权 |

「无档位」「路由忽略」的模型不代表不思考 —— 官方 `efforts` 字段缺省的含义是「不提供档位选择」，
M3 与 MiMo 照样会思考，只是没有深浅可调。给这些模型发 `reasoning_effort` 是无害的空操作。

### 怎么判断自己在哪一层

看面板「账号池」里每行的额度表，或直接读 `GET /_api/accounts` 的 `accessTier`：

| | `limited` | `full` |
|---|---|---|
| 额度表内容 | `deepseek-v4-flash`、`mimo-v2.5`（+ `glm-5.2` 的 `0/0`） | `minimax-m3`、`deepseek-v4-pro`、`gpt-5.6-luna`、`kimi-k3-eco`、`muse-spark` 五个 |
| 每日额度 | 两个模型各 6 次 session | 五个模型**共享**一份 6 次，按调用加权（`used` 会是 1.3 这种小数） |

两个池都在太平洋日 `07:00 UTC`（北京时间 15:00）重置；GLM 5.2 是独立的邀请解锁池，不占以上任何一份。

### 关于 US 出口的两个坑（实测）

1. **美国节点 ≠ 一定拿到 full**。Freebuff 除了看地区还按 IP 判 VPN / 机房流量，同一个机场的美国
   节点里只有一部分能换到 `full`，得**逐个试**：`PUT /_api/proxy/node {"mode":"manual","node":"<节点名>"}`
   换完再打一次 `GET /_api/accounts`。试探是零成本的 —— 账号探测走上游 `GET /api/v1/me`，不消耗每日额度。
2. **掉层要付代价，而且是逐个账号慢慢恢复**。2026-08-16 实测：整池账号在某个美国节点上是 `full`，
   拿 HK / JP / LK 节点各探测一次后**全部**掉成 `limited`；换回同一个美国节点并没有立刻恢复 ——
   十几分钟后在**同一个出口 IP** 上，4 个存活账号里只有 1 个变回 `full`，其余 3 个仍是 `limited`。
   说明访问层是**按账号缓存在上游**的，不是每次请求按当前 IP 现算。所以别拿非美国节点做试探，
   代价是整池账号临时降级。

被上游按出口 IP 拒绝（`country_blocked` / `ip_capped`）时，面板出口代理卡会显示「节点被 Freebuff 拒绝」。

### 上游后端（实测响应指纹）

Freebuff 会把响应里的 `model` 字段改写成自己的命名，**问模型自己更不可信**（V4 Pro 会自称 Claude）。
可靠判据是上游原样透传的 `id` 格式与 `usage` 独有字段：

| 模型 | 响应 `id` 格式 | `usage` 独有字段 | 实际后端 |
|---|---|---|---|
| `deepseek/deepseek-v4-pro` | 裸 UUID | `prompt_cache_hit_tokens` | DeepSeek 官方直连 |
| `openai/gpt-5.6-luna` | `gen-<epoch>-<rand>` | `is_byok` | OpenRouter 中转 |
| `crof/kimi-k3-eco` | `chatcmpl-<epoch.微秒>` | `tokens_per_second`、`prompt_cost` | CrofAI |
| `minimax/minimax-m3` | `chatcmpl-<32 位 hex>` | 无 `completion_tokens_details` | Fireworks（官方源码注明） |

四套 id 格式 + 四套 usage schema 互不相同 → 这几个 id 没有被偷偷合并路由到同一个后端。

### 别名映射

- 面板「模型映射」可自定义别名（如 `fast` → `deepseek/deepseek-v4-flash`），保存即生效
- 别名是纯本地字符串解析，不触发上游请求、不消耗额度
- 带日期的 slug（如 `deepseek-v4-pro-0813`）**上游会拒**，wire id 一律不带日期；想在客户端里区分
  版本就用别名指过去

## 本地开发

```bash
node server.js          # 需要 Node 20+
```

测试：`node test/unit.test.mjs`、`node test/proxy.test.mjs`、`node test/web-layout.test.mjs`

## 构建

GitHub Actions 在 push 到 `beta` 分支时自动构建 `linux/amd64,linux/arm64` 镜像并推送到 GHCR。
打 `v*` tag 出版本号镜像。PR 只构建不推送。

> GHCR 新包默认私有：首次推送后需在
> https://github.com/users/你的用户名/packages/container/ciallo-freebuff-proxy/settings
> 把可见性改为 Public，用户才能匿名 `docker compose pull`。

## 致谢

本项目站在这几个项目的肩膀上，没有它们就没有这一份：

- **[pingmike2/freebuff2api-wokers](https://github.com/pingmike2/freebuff2api-wokers)** —— 本项目的**基座**。
  单文件 `worker.js`、账号池轮换与冷却、session 复用、广告/streak 兼容流程都来自它。协议 AGPL-3.0。
- **[Quorinex/Freebuff2API](https://github.com/Quorinex/Freebuff2API)** —— Go 实现的同类代理，协议 MIT。
  思考强度映射（Anthropic `thinking` → `reasoning_effort`）与 Anthropic 流式状态机是照着它的
  `mapClaudeThinkingToReasoningEffort` / `anthropic.go` 对齐的。
- **[CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff)** —— 官方源码公开镜像。
  模型清单、`efforts` 档位表、访问层与地区门控规则都以它为事实来源，本文所有「官方源码写着」均指此处。
