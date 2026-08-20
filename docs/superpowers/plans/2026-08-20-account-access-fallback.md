# 账号授权探测与回落实现计划

**目标：** 修复自动出站探测慢、复验状态阻断账号、首账号出站未就绪导致整池 503，并精简分享 Key 展示。

## 任务 1：回归契约

- [x] 在 `test/proxy.test.mjs` 覆盖 D4P、Luna、DS4F、Mimo 优先级和 Free 15 分钟缓存。
- [x] 在 `test/account-safety-worker.test.mjs` 覆盖首账号本地出站不可用后继续换号。
- [x] 在 `test/server-api.test.mjs` 覆盖账号并发初始化与旧路由复验期间保持 ready。
- [x] 在 `test/web-layout.test.mjs` 覆盖短 Key、绿色进行中数字和移除 aff 预打开。
- [x] 运行聚焦测试，确认旧实现按预期失败。

## 任务 2：最小实现

- [x] `server/proxy.mjs` 返回授权分类元数据，并按级别设置缓存期限。
- [x] `server.js` 并发调度账号初始化，修正 stale route 状态并在刷新后主动恢复。
- [x] `worker.js` 遇到账号本地出站不可用时继续尝试下一账号。
- [x] `web/app.js`、`web/style.css` 实现展示调整并删除推广预打开。

## 任务 3：验收

- [x] 运行聚焦测试和完整 CI 等价测试。
- [x] 独立审查改动并修复重要发现。
- [x] 热更新并重启目标容器，确认健康与文件散列。
- [x] 使用脱敏诊断验证目标分享 Key 的 Luna 路径与会话计数。
