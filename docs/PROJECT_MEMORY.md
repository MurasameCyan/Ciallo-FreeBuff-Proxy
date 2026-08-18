# 项目记忆：Freebuff 上游账号安全参考

最后复查：2026-08-18

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
