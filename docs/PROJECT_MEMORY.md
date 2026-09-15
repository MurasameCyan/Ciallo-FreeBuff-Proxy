# 项目记忆：Freebuff 上游账号安全参考

最后复查：2026-09-14（上游契约漂移实测，见「待跟进的上游变化」一节）

这份文件记录可持续复查的上游来源和本项目实际采用的行为。它不是把上游代码当作依赖；
修改前先确认当前协议、许可证和测试仍然适用。

## 已采用来源

| 来源 | 许可证 | 本次审查提交（日期） | 实际借鉴 | 本地落点 |
|---|---|---|---|---|
| [trefeon/freebuff-proxy](https://github.com/trefeon/freebuff-proxy/commit/7ced74e75df0b21b0c7ff7689dfe6cddd0524fa3) | MIT | `7ced74e75df0b21b0c7ff7689dfe6cddd0524fa3`（2026-08-15） | 显式 `retryAfterMs`/`resetAt` 提示与池耗尽响应；旧 `resumes_at`/Pacific midnight 仅作第三方观察，不作官方契约 | `worker.js`: `parseCooldown`、scoped cooldown、`poolExhaustionResponse` |
| [yelixir-dev/freebuff-bridge](https://github.com/yelixir-dev/freebuff-bridge/commit/d47a4a66ca3f2ada52e4d867b89fb57cb102d2a3) | MIT | `d47a4a66ca3f2ada52e4d867b89fb57cb102d2a3`（2026-08-15） | 账号 admission 的单并发 `inFlight` 租约，失败/完成均释放 | `worker.js`: `accountLeases`、`pickToken`、`releaseToken` |
| [yuzu-octopus/freebuff2api](https://github.com/yuzu-octopus/freebuff2api/commit/0ad60a18e88788aecaf67e282e96e1f427fd36ba) | MIT | `0ad60a18e88788aecaf67e282e96e1f427fd36ba`（2026-08-09） | 流式 reader 正常结束、异常和取消先停止上游再释放忙状态 | `worker.js`: `pipeUpstreamToClient`/`pipeUpstreamToResponsesStream`；`server.js` 转发断流处理 |
| [akasakaid/Freebuff-router](https://github.com/akasakaid/Freebuff-router/commit/d0377a9040fd7318dc2c5a5376b62c1330d55a65) | MIT | `d0377a9040fd7318dc2c5a5376b62c1330d55a65`（2026-08-11） | 账号状态持久化和全池耗尽时返回明确状态，而不是继续试探坏账号 | `server/account-state.mjs`、`worker.js`: `accountPoolExhaustion` |

本项目没有复制上述仓库的实现代码；只保留行为契约，并按当前 Node 20+、现有数据目录和 worker VM 测试重写。

官方契约基线：`CodebuffAI/freebuff@c674e75e53e8fbd9aced8f099bafe0003f00e900`（2026-08-17 公开号）。
该快照中的 `banned` 是 terminal，wire type 没有 `resumes_at`；服务端完整 admission 实现未公开，
因此未把第三方字段或作者宣传升级为官方保证。

## 行为不变量

- 持久文件 `data/credentials/account-state.json` 只允许 `sha256:<64 hex>` 键，不写原始 token。
- `banned`、`token_invalid` 与 `manual_disabled` 都是永久终态；只允许成功的管理员探测或显式清除恢复，旧有限期 terminal 记录读取时提升为 `until:null`。
- `country_blocked`、`ip_capped`、裸 403 属于出口节点层，不写入账号封禁状态。
- typed 429 按 `account`、已确认 quota pool 或具体 model 作用域冷却；generic 429 不猜太平洋午夜，出口/等待室状态不写账号 quota 冷却。
- 选号永远跳过持久隔离、活动冷却和 `inFlight=1` 的账号；`rate_limited`、`country_blocked` 等瞬态健康观测只供面板展示，不得永久摘号。
- 状态快照带单调 revision；旧请求的低版本空快照不得覆盖刚写入的封禁，只有严格更新的快照可以清除本地脏状态。
- 流式管道同时等待上游 `reader.read()` 和下游 `writer.closed`；下游断开时先 `reader.cancel()`，再在完成/异常/取消路径释放租约。Node 转发使用标准库 `pipeline` 传播背压和断流；响应尚未返回时由 `server/http-adapter.mjs` 把客户端断开传给 Worker `Request.signal`。
- 状态文件只接受 `version: 1` 且 `accounts` 为对象的 schema；合法 JSON 但结构错误时继续读取完整 `.tmp`/`.bak`。写入先落盘下一状态，成功后才替换内存并递增 revision；失败时保留旧快照，只记录不含 token 或异常原文的固定错误消息。Windows 目标已存在时通过 `.bak` 可恢复替换。
- 全封禁返回 403；全额度冷却返回 429 和最早账号的真实剩余 `Retry-After`；其余不可用返回 503。
- 观察到 terminal 后，所有带该账号 Bearer 的 endpoint（含 session、run、chat、FINISH/DELETE）发送前均被阻断；该不变量不等于首次封禁率下降。
- 当前官方模型 root/child run 映射保持不变，不从旧版固定 `base2-free` 链回退。

## 生产评价边界

- 上线前已经失效的账号只记为 `preexisting_isolated`，不得混入新版本效果样本。
- 只有发布后经管理员成功探测确认存活的账号进入 `confirmed_live` cohort；被动观察至少 14 天。
- `post_terminal_authenticated_attempts` 是回归测试硬不变量，目标为 `sum=0`、`max=0`；不新增 token、前缀或哈希维度到生产 API/面板。
- `first_ban_incidence_14d` 只能通过上述 cohort 的长期观察计算。代码、短期无封禁和维护者自述都不能证明因果改善。

## 上游已知局限

- 上游仓库的 README/Issue 中的“防封”“SAFE_MODE”不是平台保证，也没有独立复现证据；冷却和状态隔离只能减少重复请求，不能避免服务条款或上游封禁。
- uTLS/JA3、浏览器头伪装、按账号换 IP 可能改变风控信号，且不适合本项目 Node 架构；明确不采用。
- 上游模型表和协议会变化，旧仓库的固定 agent、旧模型 ID、Cloudflare/TLS 推断不能直接当作当前事实。
- 本项目持久化是单进程 JSON 文件，不是多实例共享数据库；`.tmp`/`.bak` 只提供进程崩溃后的恢复，不解决多实例并发写入；横向扩展前必须先设计锁和一致性。

## 待跟进的上游变化（2026-09-14 容器内实测）

这一节记录**已经证实、但本次未落代码**的上游变化。每条都带实测证据和「为什么先不动」，
下次复查时按此表决定是否实现，不要重新摸一遍。

### G. 周 / 月窗口已经在计量（display-only，尚未执法）

`GET /api/v1/freebuff/session` 的 `freeWindows` 字段（`FreebuffFreeWindowsInfo`）在线上已经返回：

| 字段 | 6 个账号实测值 |
|---|---|
| `dayUsed` / `dayLimit` | `0 / 5` |
| `weekUsed` / `weekLimit` | `2 ~ 3.4 / 14`（滚动 7 天，非固定重置） |
| `monthUsed` / `monthLimit` | `2.1 ~ 6 / 40`（太平洋日历月） |
| `dayResetAt` / `monthResetAt` | ISO 时刻，月边界为 `2026-10-01T07:00:00Z` |

上游类型注释明确写了 **DISPLAY-ONLY**：「nothing refuses on the week or month yet
(operator decision — enforcement is a later change), so `weekUsed` can legitimately exceed
`weekLimit` until it lands」。所以 `weekUsed > weekLimit` 目前是合法状态，不能当耗尽判据。

为什么先不动：现在没有任何拒绝挂在这两个窗口上，实现执法逻辑等于凭空给自己加限制。
但**计数已经在跑**，意味着上游随时可以打开开关。

跟进触发条件（任一出现即需实现）：
- 出现挂在周/月窗口上的 429 / `rate_limited`（`resetAt` 指向周或月边界而不是次日 15:00 北京时间）；
- 上游把该字段的 DISPLAY-ONLY 注释删掉；
- 实测 `weekUsed` 达到 `weekLimit` 后仍能正常 `POST /session`（说明还没执法）或开始被拒（说明已执法）。

实现时的口径：日额度用 `dayUsed/dayLimit`（现有逻辑），周/月只做**展示与调度排序参考**，
在确认执法前不得据此写冷却 —— 否则会重演「limit=0 被判耗尽」那类自伤（见下）。

### A. freebucks 钱包是当前真实计费口径（2026-09-14 已接入调度）

实测：`full` tier 每日 100 freebucks，`limited` tier 每日 **25**（同一份价目表，所以
limited 号的可开次数只有 full 号的四分之一）。价目按 wire 下发，2026-09-14 观测到
`glm-5.3-flash=5`、`kimi-k3-eco=5`、`mimo=10`、`solar-pro4=10`、`ds4f=15`、
`muse-spark-1.2/1.3=15`、`luna=20`、`luna-es=20`、`gemini-3.8-flash=50`。
买 glm-5.3 → `daily.spent 0→5`；买 luna → `5→25`。

⚠️ **报价会变**：同一个 `solar-pro4` 在 09-14 的两次探测之间从 5 变成 10。所以实现
一律从 `freebucks.prices` 读，绝不把价目写进代码 —— 写死的那一刻就开始漂。

已落地（`worker.js`）：

- `recordAccountObservation` 捕获 `freebucks` + `freebucksCheckedAt`，与 `quota` 同为
  三态：带对象 = 新快照，`null`/缺失 = 保留上一份。上游在 `/session/reuse`、
  compact 等响应上就是 `freebucks: null`（注释写明「由客户端自己带着」），清空会
  让刚拿到的报价表凭空消失。6 个 session 观测点全部接入。
- `freebucksAdmissionsLeft(token, model)` = `floor(daily.remaining / prices[model])`。
- `admissionsLeft` = `min(remainingQuota, freebucksAdmissionsLeft)`，两者单位相同
  （都是「还能开几次」），任一为 null 就只看另一个。`pickToken` 的第 ③ 维度改读它。

三条刻意的取舍：

1. **只算 `daily.remaining`，不算 `wallet.balance`。** 上游 `balance` 的定义是两者之和，
   但动钱包要用户明确同意（`consent_required` + `FreebuffWalletConsent`），代理无权替
   用户花钱。少算钱包只让估计偏保守；多算会把号送进一个我们必然拿不到的准入。
2. **`quotaExempt === true` 返回 null**（不构成约束）：服务端授权的豁免，零余额也能开。
3. **不在报价表里的模型返回 null**：freebucks 管不着它，交给场次维度判断。

为什么这不只是「更准」而是必需：`glm-5.3-flash` 是 `premium: false` 的不计量模型，
`full` tier 的 `rateLimitsByModel` 里**根本没有它的行**，`remainingQuota` 恒为 null。
B 项把它放进目录之后，freebucks 成了它唯一的计量信号 —— 不看就只能靠撞
`spend_limited` 才知道没钱了。

### C. 提前 DELETE 只退场次，不退 freebucks

实测：`DELETE /api/v1/freebuff/session` → `{status:"ended", freebucksRefundPending:true}`。
15 秒后复查：场次退了（`dayUsed 1/5 → 0.1/5`，按实际占用时长重新 stamp），
但 `freebucks.spent` 仍是 25，**没有退**。两套计量、只有一套退款。

含义：早退能回收场次窗口（值得做），但不能回收钱包余额。`freebucksRefundPending` 这个 flag
在观测窗口内没有落账，不要据它假设余额会回来。

### D. `/session/admission` 与 `/session/reuse` 路由存在，但 operation 判别式未摸出

- `OPTIONS` 两条路由都回 `allow: OPTIONS, POST`（不是 404，路由真实存在）；
- 16 个 `operation` 候选值 + 5 种字段名（`action`/`type`/`op`/`mode`/`intent`）全部 `400 {"error":"invalid_admission_operation"}`；
- 而 `POST /session/reuse` + `x-freebuff-reuse-instance-id` 头 → **200**，且 `spent` 不变（复用不扣费）。

结论：判别式在**头**上而不是 body 字段里，`admission` 那条的具体 operation 值本次没试出来。
要继续就从头部组合入手，别再穷举 body。

### E. `x-freebuff-wallet-spend-limit: 0` 不是 fail-closed 护栏

实测：带 `x-freebuff-wallet-spend-limit: 0` 发 `POST /session` 仍然 200 active，
并照扣 luna 的 20 freebucks。**不要把这个头当成「防止意外购买」的本地护栏** ——
上游注释说它只在请求以 Freebuff Web 服务账号身份认证时才被采信，普通调用方设了无效。

## 定期复查清单

1. 查看四个来源的默认分支最新提交、许可证和安全公告；将新提交哈希写回本表。
2. 对照官方 `CodebuffAI/freebuff` 的模型/agent 映射和 typed status；不要假设存在 `resumes_at`，并核对 quota pool 作用域是否仍有公开证据。
3. 先把新行为写成失败测试，再决定是否调整 `parseCooldown`、池耗尽分类、revision 或租约。
4. 检查持久文件 schema 兼容、token 是否仍只以哈希落盘、旧快照不会回灌状态、管理员清除是否需要审计日志。
5. 运行 `node test/unit.test.mjs`、`node --test test/account-state.test.mjs`、`node --test test/account-safety-worker.test.mjs`、`node --test test/server-api.test.mjs`、`node --test test/proxy.test.mjs`、`node --test test/usage-persistence.test.mjs`、布局测试、语法检查和 `git diff --check`；确认 terminal 后零 Bearer、scope 429、pre-response abort、错误 schema 备份恢复和写盘失败原子性测试仍通过。
6. 复查 diff 中不得出现原始凭据、自动注册、账号批量创建、TLS/JA3 伪装或换 IP 规避逻辑。

## 许可证边界

当前基座来源包含 AGPL-3.0 代码，仓库应保留并补齐对应许可证声明；本次只参考 MIT 仓库的行为，
没有逐行复制代码。未来若复制实质代码，必须同时保留上游版权/许可证文本，并确认与项目许可证兼容；
未声明许可证的仓库不作为代码来源。

## 明确排除

本记忆不指导规避平台检测、批量注册、临时邮箱养号、代理/IP 轮换或 TLS 指纹伪装。账号安全的
目标是停止重复请求已知坏账号、保留可解释的状态和恢复路径。
