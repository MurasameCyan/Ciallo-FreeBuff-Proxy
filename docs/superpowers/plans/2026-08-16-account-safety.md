# 账号安全改造实现计划

> **已被取代（superseded）：** 本文件记录 2026-08-16 的历史设计。当前契约以
> [`2026-08-17-account-safety-p0.md`](2026-08-17-account-safety-p0.md) 为准；其中
> `resumes_at`、24 小时 `banned` 兜底和 generic 429 的 Pacific midnight 语义不再适用。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变 Freebuff 当前协议链的前提下，持久隔离明确封禁/失效账号，严格处理账号租约和池耗尽，并采用可审计的上游设计参考。

**架构：** 新增 `server/account-state.mjs` 做哈希键状态存储；`worker.js` 接收状态快照，负责结构化错误分类、冷却、选号和租约。管理员成功探测只由 server 清除持久状态。README 与项目记忆记录实际采用的仓库和未采用的规避技术。

**技术栈：** Node.js 20+ ESM、现有 `worker.js` VM 单测、Node `crypto`/`fs`，无新依赖。

---

### 任务 1：添加失败测试

**文件：**
- 修改：`test/unit.test.mjs`
- 创建：`test/account-state.test.mjs`

- [x] **步骤 1：** 在 VM 导出 `parseCooldown`、`nextPacificMidnight`、`pickToken`、`releaseToken` 和 `accountPoolExhaustion`，添加三种 `resumes_at`、24 小时兜底、429 四级优先级、全池不删除冷却、封禁/失效跳过、忙账号跳过与释放、403/429/503 耗尽分类测试。
- [x] **步骤 2：** 创建临时目录测试 `createAccountStateStore`：写入只出现 SHA-256 键，重新创建 store 能恢复，`clear()` 删除状态；坏 JSON 回退为空状态。
- [x] **步骤 3：** 运行单测确认新增断言先红后绿；补充覆盖 429 到期恢复、真实剩余时间、旧快照竞态和流式 pending-read 取消。

### 任务 2：实现持久状态存储

**文件：**
- 创建：`server/account-state.mjs`
- 修改：`server.js:1-160, 468-489, 660-675`

- [x] **步骤 1：** 实现 `createAccountStateStore(file)`，使用 `sha256:<hex>` 作为键，限制状态字段，读取坏文件时返回空快照。
- [x] **步骤 2：** 用同目录临时文件写入后替换目标文件；`snapshot(tokens)` 只为当前 token 返回内存映射。
- [x] **步骤 3：** 在 server 启动时创建 store，在 `buildWorkerEnv()` 注入快照、单调 revision、写入回调和清除回调。
- [x] **步骤 4：** 成功的账号管理员探测调用 `clear(token)`；封禁/失败探测不清除。

### 任务 3：实现 worker 状态机与严格选号

**文件：**
- 修改：`worker.js:520-920, 960-1010, 1780-2075`

- [x] **步骤 1：** 增加持久状态同步、封禁截止时间解析和 token-invalid 标记；保留出口级状态只回调节点。
- [x] **步骤 2：** 重写冷却解析顺序，加入太平洋午夜计算；保留现有 `cooldownInfo` 兼容接口。
- [x] **步骤 3：** 让 `pickToken` 过滤持久隔离/冷却/忙账号，并在选中时取得租约；瞬态健康观测仅供展示；移除“删除最早冷却并放行”的兜底。
- [x] **步骤 4：** 在 chat 与 code-review 两条路径中用 `attempted` 集合，并在非流式、异常、流式完成回调分别释放租约；下游断流通过 `writer.closed` 和 Node `pipeline` 传播到上游。
- [x] **步骤 5：** 无可选账号时返回严格的 403/429/503，并设置 `Retry-After`。
- [x] **步骤 6：** session admission 连续排队时返回 `waiting_room` 类型的 503 和 `Retry-After`，不降级为普通 502。

### 任务 4：文档与来源记忆

**文件：**
- 修改：`README.md`
- 创建：`docs/PROJECT_MEMORY.md`

- [x] **步骤 1：** README 致谢只加入确实落地的设计来源：`trefeon/freebuff-proxy`、`yelixir-dev/freebuff-bridge`、`yuzu-octopus/freebuff2api`、`akasakaid/Freebuff-router`，并注明本地实现和“不复制 TLS/IP 规避”。
- [x] **步骤 2：** 项目记忆记录仓库 URL、许可证、审查日期/提交、借鉴点、本地位置、上游缺陷、定期复查清单和许可证边界。
- [x] **步骤 3：** 更新 README 数据目录说明，包含 `account-state.json`（仅哈希状态）。

### 任务 5：完整验证

**文件：** 无新增文件。

- [x] **步骤 1：** 运行 `node test/unit.test.mjs`、`node --test test/account-state.test.mjs`、`node --test test/proxy.test.mjs`、`node test/web-layout.test.mjs`。
- [x] **步骤 2：** 运行 `node --check worker.js`、`node --check server.js`、`node --check server/account-state.mjs`、`node --check server/http-adapter.mjs` 和 `git diff --check`。
- [x] **步骤 3：** 复查 `git diff`，确认没有原始 token、TLS 伪装、自动注册代码或未引用来源；本次布局测试通过。

### 追加收尾：最终审查回归

- [x] **步骤 1：** Chat/Reviewer 首次 `429`、`banned` 和 `401` 在同一请求返回结构化池耗尽响应。
- [x] **步骤 2：** Response 返回前客户端断开通过 `server/http-adapter.mjs` 传播 `Request.signal`，取消上游 reader 并释放租约。
- [x] **步骤 3：** Windows 状态文件替换不再直接覆盖目标；完整 `.tmp`/`.bak` 可恢复，且有回归测试。
- [x] **步骤 4：** 最终代码审查后收紧状态文件 schema；持久化失败不提交内存/revision，worker 记录失败并保留进程内隔离。
