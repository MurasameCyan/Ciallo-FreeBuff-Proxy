# 账号级出站节点实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框语法跟踪进度。

**目标：** 为每个 FreeBuff 账号独立选择自动或手动出站节点，并允许多个账号同时经不同 US/SG 节点请求。

**架构：** mihomo 提供 64 个互相独立的账号业务 selector/listener（`17900..17963`），每个账号持久化分配一个 lane，worker 按账号路由到对应 listener，因此多账号可以同时固定在不同节点。另设一个仅用于自动选点的串行 probe selector/listener（`17964`），自动模式只验证 US/SG 候选，并要求该账号经候选节点拥有可用的 `openai/gpt-5.6-luna` 额度；通过后再把该账号的业务 selector 固定到所选节点。业务 lane、probe 和后台任务都带身份/拓扑代际校验，旧请求或迟到探测不得覆盖新配置。

**技术栈：** Node.js、mihomo、ProxyAgent、现有 JSON 持久化、原生 HTML/CSS/JS、node:test。

---

### 任务 1：后端、配置与 API

**文件：** `server.js`、`worker.js`、`server/proxy.mjs`、相关测试。

- [x] 先写失败测试：账号配置支持 `egressMode: auto|manual` 与 `egressNode`，非法节点/模式返回 400，公开 DTO 不泄露 token。
- [x] 先写失败测试：mihomo 配置产生 64 个互不共享 selector 状态的账号 listener，并提供独立 probe listener。
- [x] 先写失败测试：不同账号并发请求分别选用各自 listener。
- [x] 先写失败测试：自动模式只考虑 US/SG，且只有经该账号获取额度表包含未耗尽 `openai/gpt-5.6-luna` 的节点才可选；结果缓存，失败失效重选。
- [x] 运行聚焦测试确认因功能缺失而失败。
- [x] 写最少实现使测试通过，并保持现有未配置账号兼容自动模式。
- [x] 运行聚焦测试与相关回归。

### 任务 2：账号池界面

**文件：** `web/index.html`、`web/app.js`、`web/style.css`、`test/web-layout.test.mjs`。

- [x] 先写失败布局/行为测试：账号池新增“出站节点”列和设置按钮。
- [x] 实现自动/手动选择控件；手动列出可用节点，自动展示当前选中与探测状态。
- [x] 保持现有表格密度、邮箱去敏与删除图标布局。
- [x] 运行前端契约测试确认通过。

### 任务 3：集成验收与发布

- [x] 跑完整离线 CI 等价测试与语法检查。
- [x] 独立代码审查并修复关键/重要问题。
- [x] 通过 stdin 写入容器 `/tmp`，核对 SHA-256、Node 22 语法后原子替换并重启。
- [x] 真实验证两个账号同时绑定不同节点，各自保持独立出口。
- [x] 验证自动模式只选通过 `openai/gpt-5.6-luna` 额度检查的 US/SG 节点。
- [ ] 提交、推送 `beta`，确认 Actions test/build 成功。
