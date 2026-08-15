# Ciallo-FreeBuff-Proxy

Freebuff 免费模型 → OpenAI / Anthropic / Responses 兼容 API，带 Web 管理面板与账号池管理。

- 免费模型（实测可用）：`deepseek/deepseek-v4-flash`、`mimo/mimo-v2.5`
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
3. 节点由 mihomo 自动测速选择（`freebuff-auto` 组），`codebuff.com` 域名走代理，其余直连

不配置则保持直连，mihomo 不启动。

## 本地开发

```bash
node server.js          # 需要 Node 20+
```

测试：`node test/unit.test.mjs`

## 模型与别名

- 免费账号实测只有 `deepseek-v4-flash`、`mimo-v2.5` 可建会话（其余模型上游 409/403 拒绝）
- 面板「模型映射」可自定义别名（如 `fast` → `deepseek/deepseek-v4-flash`），保存即生效
- 别名调用不消耗 /v1/models 请求，纯本地解析

## 构建

GitHub Actions 在 push 到 `beta` 分支时自动构建 `linux/amd64,linux/arm64` 镜像并推送到 GHCR。
打 `v*` tag 出版本号镜像。PR 只构建不推送。

> GHCR 新包默认私有：首次推送后需在
> https://github.com/users/你的用户名/packages/container/ciallo-freebuff-proxy/settings
> 把可见性改为 Public，用户才能匿名 `docker compose pull`。
