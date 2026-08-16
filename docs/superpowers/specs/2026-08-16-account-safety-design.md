# 账号隔离与池耗尽安全设计

## 目标

减少同一账号在上游已经明确拒绝后被重复请求的次数，并让封禁/凭据失效状态在服务重启后继续生效。请求内仍保留现有的多账号故障转移和按模型复用 session 行为。

## 非目标

- 不伪造 TLS/JA3 指纹，不改 User-Agent 以规避检测。
- 不自动注册、批量养号或轮换代理来规避上游限制。
- 不改变官方当前的模型 root agent / child agent 协议。
- 不把 `country_blocked`、`ip_capped` 这类出口节点问题写成账号封禁。

## 状态模型

worker 内存中维护三类状态：

1. 短期冷却：`cooldowns`，记录 `quota`、`invalidation` 或普通错误的到期时间。它主要防止短时间重复打上游。
2. 持久隔离：按 token 的 SHA-256 哈希存储在 `data/credentials/account-state.json`。只保存 `banned`、`token_invalid` 和人工禁用；不保存原始 token。
3. 健康观测：`acctHealth` 记录最近的上游状态供面板显示。`rate_limited`、`country_blocked` 等瞬态状态不参与永久摘号。

持久记录形状为：

```json
{
  "version": 1,
  "accounts": {
    "sha256:<64 hex>": {
      "state": "banned",
      "until": 1780000000000,
      "reason": "upstream_banned",
      "updatedAt": 1780000000000
    }
  }
}
```

`banned` 优先使用上游 `resumes_at`；没有截止时间时至少隔离 24 小时。`token_invalid` 没有自动到期时间，必须替换凭据或由成功的管理员探测清除。

## 调度与租约

`pickToken(env, model, attempted)` 只从同时满足以下条件的账号中选择：未持久隔离、未短期冷却、`inFlight` 为 0、且不在当前请求的 `attempted` 集合中。选中时立即取得一次租约（每账号最多一个并发请求）。

如果没有可选账号，绝不删除冷却记录或强行放行账号：

- 全部是 `banned`：返回 403。
- 全部仅因 `quota` 冷却：返回 429，并使用最早的重试时间。
- 其余（凭据失效、忙、普通错误或混合状态）：返回 503。

如果 session admission 已进入 waiting-room，尝试完请求内可用账号后返回结构化 503 和 `Retry-After`，不伪装成普通 502。

非流式请求和错误路径在 `finally` 释放租约；流式请求把释放函数交给 SSE 管道的完成回调。SSE 管道把上游 `reader.read()` 与下游 `writer.closed` 竞速，正常结束、写入失败或下游取消都会先停止上游再释放。Node adapter 使用 `pipeline(Readable.fromWeb(...), nodeRes)` 处理背压和 socket 断流，并在 Worker Response 返回前用 `Request.signal` 把客户端断开传进首 chunk guard。

## 冷却解析

解析顺序：

1. JSON 中的 `retryAfterMs`。
2. JSON 中的 `resetAt`（RFC3339、Unix 秒或 Unix 毫秒）。
3. HTTP `Retry-After`（秒或 HTTP 日期）。
4. 429 没有上述信息时，使用下一个 `America/Los_Angeles` 本地午夜。

封禁截止时间同样接受 RFC3339、Unix 秒和 Unix 毫秒。解析失败时使用 24 小时封禁兜底；普通 403/网络错误继续使用短暂冷却，不会被误记为封禁。

## 持久化边界

`server/account-state.mjs` 负责同步读写、token 哈希、坏文件回退、临时文件替换/崩溃恢复和进程内单调 revision。只有 `version: 1` 且 `accounts` 为对象的文件才算有效；合法 JSON 但 schema 错误时继续读取完整 `.tmp`/`.bak`。Unix 上可直接原子 rename；Windows 目标已存在时先保留 `.bak` 再替换，启动优先读取有效主文件，其次读取完整 `.tmp`/`.bak`，不直接覆盖目标文件。写入采用“构造下一状态、成功落盘、再替换内存并递增 revision”的顺序，失败时保留原快照和 revision。`buildWorkerEnv()` 向 worker 注入当前 token 对应的内存快照、revision，以及 `set/clear` 回调。worker 按 token 保存最近 revision，忽略旧请求携带的低版本快照；持久化回调异常只输出固定消息，不回显可能含 token 的异常原文。Cloudflare Worker 等没有 Node 持久化回调的运行环境仍能使用内存隔离，但不能声称跨重启持久化。

管理员对账号执行成功的 `GET /_api/accounts/:key` 探测时，server 清除该账号的持久隔离；失败探测不会清除。这个动作是显式恢复，不由普通业务成功响应隐式触发。

## 验证标准

- `resumes_at` 的三种格式和 24 小时兜底有单测。
- 429 的四级解析和太平洋午夜跨日行为有单测。
- waiting-room 返回 503、`Retry-After` 和 `waiting_room` 错误类型。
- 所有账号冷却/封禁时，选号不改变已有记录，池耗尽状态码正确。
- 忙账号被跳过，完成回调释放后可再次选择。
- 429 冷却到期后账号重新可选，`Retry-After` 使用最早活动冷却的真实剩余时间。
- 持久文件只含 token 哈希；重载后仍能恢复；旧 revision 不覆盖新封禁，成功探测的新 revision 可清除。
- 下游在上游 read pending 时取消，Chat/Responses 管道均会取消上游并释放租约。
- Worker Response 返回前客户端断开时，HTTP adapter 的 `Request.signal`、上游 reader 取消和租约释放有端到端回归测试。
- 主状态文件损坏/缺失时，完整 `.tmp`/`.bak` 恢复有单测。
- 主状态文件为合法 JSON 但 version/accounts schema 错误时仍会回退；写盘失败不会提交内存状态或 revision。
- 现有单测、代理测试、布局测试、语法检查和 `git diff --check` 全部运行。
