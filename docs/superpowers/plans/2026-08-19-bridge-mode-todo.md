# 待办：bridge 模式（朋友自带 freebuff 账号）

**状态**：待办，未开工。2026-08-19 记，多 key（分享 Key）上线时一并讨论过，当轮只做了共享 Key。

## 是什么

现在分享 Key 是「用我的账号池 + 我的额度」。bridge 模式是另一条路：朋友带自己的 freebuff
账号 token 来，本服务只提供协议转换（OpenAI / Anthropic / Responses）和 US/SG 出口。

参考实现：[`trefeon/freebuff-proxy`](https://github.com/trefeon/freebuff-proxy) 的 bridge mode。

## 为什么值得做

免费额度是**按账号**算的，一天只有个位数。共享 Key 再怎么限并发/限每日，几个人用同一个池子
就是在分同一份额度；bridge 模式下额度是各人自己的，公平性、预算、按 key 归账这些问题全部消失。

## 大致做法

- 客户端在 `Authorization` 之外另带自己的 freebuff token（形如 `x-freebuff-token`，或把
  `Bearer` 值约定成 `fbk-xxx:<自带 token>`）。
- `resolveClient()` 认出这类请求后，让 `pickToken()` 直接锁定这个 token，不进账号池调度，
  也不写 `account-state.json`（那是我们自己账号的隔离状态，不该被外部 token 污染）。
- 调用日志按 key 备注名归账，但不落这个 token 的任何明文/前缀。

## 已经清掉的前置

`RELAY_KEY` 这个死配置（`buildWorkerEnv()` 塞给 worker、`worker.js` 从来没读）已随多 key
一起删除。它大概是上游基座留下的中继模式痕迹，真要做 bridge 不必沿用这个名字。

## 决定前要想清楚的

1. 朋友愿不愿意自己注册号 —— 不愿意的话这个模式对他们没价值，共享 Key 才是要的东西。
2. 外部 token 只在内存里过一遍还是允许存盘。存盘就要按现有 `account-state.json` 的口径
   哈希处理，别把别人的凭据明文落在我们的数据目录里。
3. 出口节点是共享的。bridge 模式下别人的账号会跟着我们的出口 IP 走，上游把 IP 触顶
   （`ip_capped`）归因到节点时，会连带影响自己的账号。
