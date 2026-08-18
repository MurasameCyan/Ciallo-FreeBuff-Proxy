# 账号安全 P0 修正实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 修正 `e7be70d` 后仍存在的 fail-open 与作用域污染，使 terminal 账号永久隔离、429 只影响其真实作用域，并保证观察到 terminal 后不再发送任何 Bearer 鉴权上游请求。

**架构：** 保留现有 Node 单进程账号租约和 version 1 哈希状态文件；`banned` 使用现有 `until: null` 表示永久隔离，旧有限期 banned 在读取和 worker 同步时提升为永久。429 使用独立的作用域键；terminal typed Error 快速中止当前调用链，统一 Bearer 出站门禁封住排队请求和清理路径的 TOCTOU。新建隔离 VM + FakeUpstream 测试，不使用真实账号或公网。

**技术栈：** Node.js 20+ ESM（CI/Docker 为 Node 22）、现有 `worker.js` VM、Node `node:test`/`vm`/`fs`，无新依赖。

## 全局约束

- 官方契约基线是 `CodebuffAI/freebuff@c674e75e53e8fbd9aced8f099bafe0003f00e900`：`banned` 是 terminal，官方 wire shape 没有 `resumes_at`。
- `banned`、`token_invalid` 和 `manual_disabled` 只允许管理员成功探测或显式清除；普通业务成功不得清除。替换 token 会自然使用新的 SHA-256 key。
- 不写原始 token；不得把 token 前缀或 SHA-256 宣称为匿名身份。
- Premium 模型共享 `pool:premium`；GLM 5.2 使用 `pool:glm`；Standard/Limited 是否共池未被公开服务端实现证实，因此按 `model:<id>` 隔离。
- `spend_limited` 是 `account` 作用域；`ip_capped`/`country_blocked` 是 egress 作用域，不得写入 token 冷却；`waiting_room_queued` 是 session admission；generic 429 只采用显式 retry hint 做短期 `model:<id>` 退避，不回退到 Pacific midnight。
- 每个 Bearer 上游发送点在实际 fetch 前必须再次检查 terminal 状态。terminal 响应之后，同 token 的所有 endpoint（ads、usage、session、agent-runs、chat、FINISH/DELETE）新增鉴权请求数必须严格为 0。
- 当前部署仍是单进程、单副本；本计划不伪称 JSON 持久化能提供跨进程租约。
- 禁止增加 TLS/JA3、请求头伪装、随机抖动、换 IP、自动注册或养号措施；已有相关代码不在本计划中扩展。
- 测试不得继承真实 `FREEBUFF_*` 凭据、代理订阅或代理环境；只允许内存 fetch 和 `127.0.0.1`。
- 不新增依赖，不复制无许可证仓库代码，不修改模型 root/child run 映射。
- 不在任务中 commit 或 push；用户未要求发布。每个任务由独立审查关卡验证未提交 diff。

---

### 任务 1：恢复实施基线并固定计划

**文件：**
- 创建：`docs/superpowers/plans/2026-08-17-account-safety-p0.md`
- 本地账本：`.superpowers/sdd/progress.md`（Git 排除）

- [x] **步骤 1：核对隔离工作树。** 使用已有 `feat/account-safety-p0` worktree，确认基线为 `9c0d0d7` 且工作树干净。
- [x] **步骤 2：安装锁定依赖并运行基线。** 单元 `136/136`、状态 `5/5`、代理 `20/20`、API `6/6`、统计 `5/5`、布局、语法和 `git diff --check` 全通过。
- [x] **步骤 3：固定根因。** 记录旧设计的 24 小时 banned fail-open、token-wide 429、terminal 后仍会 POST/FINISH，以及已有 singleFlight 不应重做。

### 任务 2：将 banned 迁移为永久隔离

**文件：**
- 修改：`server/account-state.mjs:12-21`
- 修改：`worker.js:564-655,696-750,1318-1347`
- 修改：`server.js:315-324`
- 测试：`test/account-state.test.mjs`
- 创建：`test/account-safety-worker.test.mjs`

- [x] **步骤 1：编写失败测试。** 覆盖旧有限期 terminal 快照迁移、新状态落盘、fake clock、重载、零上游请求和管理员清除恢复。
- [x] **步骤 2：运行红灯。** 基线确认旧有限期 banned 会按旧语义到期；失败测试随后锁定新契约。
- [x] **步骤 3：实现最小迁移。** 所有 terminal 状态统一为 `until:null`；删除 banned 到期自动清除和 `BANNED_DEFAULT_COOLDOWN_MS`/`banUntil()` 依赖；业务观测写永久状态。
- [x] **步骤 4：更新管理员探测字段。** `isolatedUntil` 对永久状态保持 `null`，以 `isolatedPermanent` 表达永久，不伪造解封时间。
- [x] **步骤 5：运行绿灯。** 聚焦测试、worker 单测和 API 测试全部通过。

### 任务 3：按真实作用域拆分 429 admission 状态

**文件：**
- 修改：`worker.js:126-183,319-340,409-418,554-562,696-750,996-1065,1130-1237,1318-1363,2200-2579`
- 修改：`server.js:274-324`
- 测试：`test/account-safety-worker.test.mjs`
- 测试：`test/unit.test.mjs`

- [x] **步骤 1：编写失败测试。** 表驱动覆盖 Premium/GLM/具体模型、`spend_limited`、egress、waiting room、generic 429 和 GLM fallback。
- [x] **步骤 2：运行红灯。** 基线复现 token-wide 冷却和错误作用域污染。
- [x] **步骤 3：增加最小作用域模型。** quota 锁使用 `(token, scope)`，并保留模型级 transient 锁。
- [x] **步骤 4：统一 typed 429 分类。** 只信任结构化状态和显式时间提示；generic 429 使用有界退避。
- [x] **步骤 5：接入统一 admission。** Chat、Reviewer、session/run 和池耗尽均按当前模型查询作用域。
- [x] **步骤 6：修正健康语义。** 加入 `spend_limited`、egress/waiting-room 分流和 GLM fallback。
- [x] **步骤 7：运行绿灯。** 聚焦测试与 worker 单测全通过。

### 任务 4：terminal 后阻止所有 Bearer 上游请求

**文件：**
- 修改：`worker.js:696-750,1365-1513,1633-1835,2200-2579`
- 测试：`test/account-safety-worker.test.mjs`
- 测试：`test/unit.test.mjs`

- [x] **步骤 1：编写失败测试。** FakeUpstream trace 覆盖 session、run、chat、Reviewer 清理、预置 terminal 和排队 TOCTOU。
- [x] **步骤 2：运行红灯。** 基线复现 terminal 后继续 POST/FINISH 的请求。
- [x] **步骤 3：实现 typed terminal 传播。** `TerminalAccountStateError` 只携带固定状态字段，所有解析边界立即终止当前链。
- [x] **步骤 4：实现统一发送前门禁。** 所有带 token 的底层出站在 fetch 前检查 terminal 状态。
- [x] **步骤 5：保持清理不变量。** terminal 不发送清理 Bearer；租约在非流式、流式和异常路径恰好释放。
- [x] **步骤 6：运行绿灯。** Chat/Reviewer trace 中 terminal 后 Bearer 请求数严格为 0。

### 任务 5：只补缺失的 quota-aware picker 与 create gate 生产回归

**文件：**
- 修改：`worker.js:691-750,996-1040,1196-1215,1677-1787`
- 测试：`test/account-safety-worker.test.mjs`
- 测试：`test/unit.test.mjs`

- [x] **步骤 1：编写失败测试。** 覆盖生产 `createSession` singleFlight、失败重试、quota freshness 和 picker 排序。
- [x] **步骤 2：运行红灯。** 基线确认生产 gate/quota-aware picker 覆盖不足。
- [x] **步骤 3：最小实现。** 保留现有 gate，增加 freshness 和新鲜额度排序，不新增主动探测或持久层。
- [x] **步骤 4：运行绿灯。** 聚焦测试与完整 worker 单测通过。

### 任务 6：补齐离线 oracle、CI 与权威文档

**文件：**
- 修改：`.github/workflows/docker.yml`
- 修改：`README.md`
- 修改：`docs/PROJECT_MEMORY.md`
- 修改：`docs/superpowers/plans/2026-08-16-account-safety.md`
- 修改：`docs/superpowers/specs/2026-08-16-account-safety-design.md`
- 测试：`test/account-safety-worker.test.mjs`

- [x] **步骤 1：拒绝过度观测。** 不新增生产 metric/API/面板；terminal 后 Bearer 零请求只作测试 oracle。
- [x] **步骤 2：接入 CI。** CI 显式运行完整离线测试并清空凭据、订阅和代理环境。
- [x] **步骤 3：更新当前文档。** README/PROJECT_MEMORY 已改为 terminal、scoped 429、零 Bearer 和 FakeUpstream 口径。
- [x] **步骤 4：标记旧设计已取代。** 历史 plan/spec 顶部已加 superseded 注记。
- [x] **步骤 5：更新长期评价口径。** 文档明确 `preexisting_isolated`、`confirmed_live`、14 天观察和首次封禁因果边界。

### 任务 7：完整验证与最终审查

**文件：** 无新增生产文件。

- [x] **步骤 1：运行严格离线完整测试。** 清空 Freebuff/代理环境后，7 个入口全部通过；未启动真实 server 配置、未读取真实 token、未访问公网。
- [x] **步骤 2：运行静态检查。** 16 个受跟踪 `.js/.mjs` 通过 `node --check`，`git diff --check` 和敏感模式扫描通过。
- [x] **步骤 3：逐项核对不变量。** 永久 terminal、状态迁移、scope 429、terminal 后零 Bearer、租约、singleFlight、quota freshness 和池耗尽均有测试证据。
- [x] **步骤 4：执行宽范围审查。** 子代理渠道不可用；主线完成静态/控制流/隐私/迁移/测试真实性审查，未发现 Critical/Important 未处理项。
- [x] **步骤 5：保留工作树。** 未 commit、未 push；首次封禁率仍明确为无法由代码证明。
