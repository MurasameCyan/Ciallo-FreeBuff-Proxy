# 思考循环收敛改动记录（2026-08-24）

## 锚点 commit

出发点 / 回滚目标：**`268b2b2dfcf237c00b45f55d06ca0b032878d813`**
（`fix(usage): 上游流式补 include_usage，成功调用不再记 0 token`，分支 `beta`）

回滚方式：`git revert <本次提交>`，或容器内用 `/tmp/rollback-worker-preIdleGuard.js` 覆盖 `/app/worker.js`。

## 背景

ds4p / ds4f 偶发「无限思考循环」。排查结论：循环由上游模型产生，
不是网关制造的，但网关有三处让它无法收场。请求侧已确认无罪：

- `MODEL_EFFORTS` 对这两个模型只做 clamp-down（只降不升），没有偷偷抬高思考强度。
- 注入的 `stop: ['"cb_easp"']` 仅在客户端未给 `stop` 时补，且工具调用走
  `delta.tool_calls`，不经过 content 的 stop 匹配，吞不掉工具调用。
- Anthropic 入站 `anthropicText` 只保留 `type === "text"`，Responses 入站显式
  skip `reasoning` 条目 —— 这两条协议天然不会把上一轮思考回灌上游。

## 本次做的（1 和 2）

### 1. 流式空闲超时

改前：`signal: isStream ? requestSignal : AbortSignal.timeout(NONSTREAM_TIMEOUT_MS)`
—— 非流式有 45s 帽子，流式只跟客户端 signal。模型陷入循环时持续吐
`reasoning_content`，连接一直活着、字节一直在流，服务端没有任何上限，
账号租约也被一直占着。

改后：新增 `STREAM_IDLE_TIMEOUT_MS`，在 `resp.body` 外包一层
`guardStreamConvergence`。主判据是**空闲**而不是总时长（另有 STREAM_MAX_DURATION_MS 做总时长兜底） —— 长思考只要还在
出字节就不打断，只有「N 秒内一个 chunk 都没有」才中断。三条协议共用
同一处包装（Anthropic 也走 `executeChat`，拿到的是同一份 OpenAI SSE 流）。

### 2. 剥掉历史里的 reasoning_content

改前 `normalizeMessages` 是 `const item = { ...m }`，除 role 归一和 Buffy
前缀注入外全部透传，OpenAI 协议客户端若把上一轮 `reasoning_content` 回传
就会原样发给上游。DeepSeek 官方明确要求多轮请求不要带回历史思考。

改后：无条件剥掉该字段（连我们自己打的 reasoning_used_as_content 标记一起），与 Anthropic / Responses 两条路径
已有行为对齐。

## 没做的（3）

`streamToNonStream` 的 `reasoning_used_as_content`：只拿到思考、没拿到正文时
把思考原文当答案塞进 `content`。涉及语义取舍，单独讨论，本次不动。
