# 概况统计数据持久化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为面板「概况」增加默认关闭的持久化开关，使累计请求、Token 和模型统计可选择性跨进程重启保留。

**架构：** `worker.js` 继续负责内存中的 usage 累计，并新增一个可注入的持久化适配器；每次 `recordRequest()` 更新内存后通知适配器。`server.js` 负责数据目录中的 JSON 文件、设置 API 和启动时恢复快照。前端通过独立的 `/usage-persistence` API 读取/切换设置，概况卡右侧只显示无文字开关。

**技术栈：** Node.js ESM、原生 HTTP API、JSON 文件原子写入、原生 HTML/CSS/JavaScript、Node `node:test`。

---

## 文件清单与职责

- 修改：`worker.js:753-891` —— 抽取可恢复/可持久化的 usage 状态接口；保持 `/usage` 响应兼容。
- 修改：`server.js:1-120,680-780,885-900` —— 新增统计存储、启动恢复、管理 API，并把存储适配器注入 worker。
- 创建：`server/usage-persistence.mjs` —— 只负责 usage JSON 的结构校验、加载、安全写入和开关状态管理，便于独立测试。
- 创建：`test/usage-persistence.test.mjs` —— 服务端持久化单元测试。
- 修改：`web/index.html:194-201` —— 概况标题右侧添加无文字开关及无障碍标签。
- 修改：`web/app.js:14-18,690-712,736-780` —— 加载开关状态、切换 API、失败回滚，不影响实时 usage 轮询。
- 修改：`web/style.css:相关 usage/card-head 区域` —— 让概况标题栏两端对齐，并复用/补充胶囊开关样式。
- 修改：`test/web-layout.test.mjs` —— 锁定开关 DOM、文案可见性、悬停提示和 API 调用契约。

### 任务 1：为持久化模块编写失败测试

**文件：**
- 创建：`test/usage-persistence.test.mjs`
- 创建：`server/usage-persistence.mjs`（先建立最小可导入模块骨架，不提供目标行为）

- [ ] **步骤 1：编写最小失败测试**

测试使用临时目录和真实文件系统，覆盖：默认关闭；开启后保存完整 `total/byModel/startTime/lastRequest`；重新创建 store 能恢复；关闭不再写新数据；损坏 JSON 回退空快照且不抛出启动异常。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsagePersistence } from '../server/usage-persistence.mjs';

const blank = { total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, byModel: {}, startTime: 123, lastRequest: null };

test('默认关闭且不产生统计文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const store = createUsagePersistence(join(dir, 'usage.json'));
    assert.equal(store.enabled(), false);
    await store.save({ ...blank, startTime: 456 });
    await assert.rejects(readFile(join(dir, 'usage.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('开启后保存并可重新加载完整快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const first = createUsagePersistence(file);
    first.setEnabled(true);
    const snapshot = { ...blank, total: { ...blank.total, requests: 3, totalTokens: 99 }, byModel: { 'mimo/mimo-v2.5': { ...blank.total, requests: 3, success: 3 } }, startTime: 456, lastRequest: 789 };
    await first.save(snapshot);
    const second = createUsagePersistence(file);
    assert.equal(second.enabled(), true);
    assert.deepEqual(second.load(), snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('损坏文件回退到空快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    await writeFile(file, '{broken', 'utf8');
    const store = createUsagePersistence(file);
    assert.deepEqual(store.load(), blank);
    assert.equal(store.enabled(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/usage-persistence.test.mjs`

预期：FAIL，提示 `createUsagePersistence` 未导出或目标方法不存在；确认失败原因是功能缺失而不是测试语法错误。

### 任务 2：实现持久化模块并通过服务端单元测试

**文件：**
- 修改：`server/usage-persistence.mjs`
- 修改：`test/usage-persistence.test.mjs`

- [ ] **步骤 1：实现最小 store API**

实现 `createUsagePersistence(file)`，暴露 `enabled()`, `setEnabled(value)`, `load()`, `save(snapshot)`。文件格式固定为 `{ enabled, snapshot }`；`load()` 校验所有累计字段为非负有限数，缺失或损坏时返回空快照；`setEnabled(true)` 创建目录并写入设置，`setEnabled(false)` 仅写设置不删除历史快照；`save()` 在关闭时 no-op，在开启时先写同目录临时文件再 `rename`。

- [ ] **步骤 2：运行测试确认通过**

运行：`node --test test/usage-persistence.test.mjs`

预期：3 个测试 PASS，且没有未处理的文件系统异常。

- [ ] **步骤 3：补写入失败测试并验证红灯**

增加一个将路径指向目录而非文件的测试，断言 `save()` 返回/抛出明确 I/O 错误，同时 store 仍可继续被调用；运行同一命令确认新测试先失败于错误处理契约。

- [ ] **步骤 4：实现明确写入错误并验证绿灯**

让 `save()` 保留原始 I/O 错误信息并拒绝 Promise，不吞掉异常；重新运行 `node --test test/usage-persistence.test.mjs`，预期全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add server/usage-persistence.mjs test/usage-persistence.test.mjs
git commit -m "feat:增加概况统计持久化存储"
```

### 任务 3：为 worker 恢复/持久化注入编写失败测试

**文件：**
- 修改：`test/unit.test.mjs`
- 修改：`worker.js:753-891`

- [ ] **步骤 1：增加行为测试**

通过现有 worker 测试加载方式取得 `getCallLog` 与新接口，断言可以注入 `{ load, save }` 适配器、加载快照覆盖初始统计、调用 `recordRequest` 后调用 `save`，并且保存失败不会阻塞请求完成。测试使用内存适配器，不写真实数据目录。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/unit.test.mjs`

预期：新增断言 FAIL，提示 worker 缺少持久化配置/恢复接口。

- [ ] **步骤 3：实现最小 worker 接口**

在 usage 状态附近增加 `usagePersistence` 引用和 `configureUsagePersistence({ load, save, enabled })`；增加 `restoreUsageSnapshot(snapshot)`，只接受规范化快照；`recordRequest()` 更新内存后调用异步安全保存钩子（不让保存异常冒泡到请求处理）；`callLogSnapshot()` 保持现有字段并继续只返回内存调用日志。

- [ ] **步骤 4：运行 worker 回归测试**

运行：`node --test test/unit.test.mjs`

预期：新增测试与原有测试全部 PASS；确认 `/usage` 的 `calls` 仍不落盘。

- [ ] **步骤 5：Commit**

```bash
git add worker.js test/unit.test.mjs
git commit -m "feat:支持恢复概况统计并异步保存"
```

### 任务 4：接入 server 启动流程和管理 API

**文件：**
- 修改：`server.js:1-120,680-780,885-900`
- 修改：`server/usage-persistence.mjs`
- 修改：`test/usage-persistence.test.mjs`

- [ ] **步骤 1：增加 API 契约失败测试**

在现有 server/API 测试中加入：`GET /_api/usage-persistence` 返回 `{ enabled: false }`；`PUT /_api/usage-persistence` 接收 `{ enabled: true }` 返回开启状态；无效 body 返回 400；API 不调用上游。

- [ ] **步骤 2：运行相关测试确认失败**

运行：`node --test test/usage-persistence.test.mjs test/unit.test.mjs`

预期：API 契约测试 FAIL，因为 server 尚未注册新路由。

- [ ] **步骤 3：接入 server store 与 worker**

在 `server.js` 初始化 `createUsagePersistence(dataFile('usage-stats.json'))`，读取 store 快照和开关；将 `handler.configureUsagePersistence({ load: () => store.load(), enabled: () => store.enabled(), save: snapshot => store.save(snapshot) })` 注入 worker。`GET` 返回当前开关；`PUT` 只接受 boolean，切换为开启时立即保存当前 worker 快照，切换失败返回 500 并保持旧状态。为路由加入现有管理鉴权。

- [ ] **步骤 4：运行服务端测试确认通过**

运行：`node --test test/usage-persistence.test.mjs test/unit.test.mjs test/proxy.test.mjs`

预期：全部 PASS；确认请求失败时内存统计仍更新，磁盘写失败不会让代理进程退出。

- [ ] **步骤 5：Commit**

```bash
git add server.js server/usage-persistence.mjs test/usage-persistence.test.mjs
git commit -m "feat:增加概况统计持久化管理接口"
```

### 任务 5：为前端开关编写失败契约测试

**文件：**
- 修改：`test/web-layout.test.mjs`
- 修改：`web/index.html:194-201`
- 修改：`web/app.js:690-712,736-780`

- [ ] **步骤 1：增加失败断言**

断言概况卡标题区域存在 `#usagePersistence` checkbox、默认 HTML 属性为关闭、`title` 含「默认关闭」、开关只含开关轨道和 `sr-only` 标签；断言脚本包含 `GET /usage-persistence` 与 `PUT /usage-persistence`，且失败时恢复 checked 状态。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/web-layout.test.mjs`

预期：新增断言 FAIL，确认失败来自缺少开关/API 接线。

### 任务 6：实现前端开关并通过浏览器契约

**文件：**
- 修改：`web/index.html:194-201`
- 修改：`web/app.js:690-712,736-780`
- 修改：`web/style.css:usage/card-head 相关规则`

- [ ] **步骤 1：实现 HTML/CSS**

在概况 `.card-head` 内标题之后添加：

```html
<label class="switch usage-persistence-toggle" title="持久化统计数据（默认关闭）">
  <input type="checkbox" id="usagePersistence">
  <span class="switch-track" aria-hidden="true"></span>
  <span class="sr-only">持久化统计数据（默认关闭）</span>
</label>
```

确保标题栏使用 `display:flex; justify-content:space-between; align-items:center`，不显示可见文字。

- [ ] **步骤 2：实现加载与切换**

页面初次 `refresh()` 并行读取 `api('/usage-persistence')`，设置 checkbox；绑定 change 事件，先记录旧值，再 `PUT` `{ enabled: checked }`。请求失败时恢复旧值并 toast 错误；成功只更新状态，不调用 `refresh()` 或任何上游接口。

- [ ] **步骤 3：运行前端测试确认通过**

运行：`node --test test/web-layout.test.mjs`

预期：新增契约与已有布局测试全部 PASS。

- [ ] **步骤 4：Commit**

```bash
git add web/index.html web/app.js web/style.css test/web-layout.test.mjs
git commit -m "feat:在概况面板增加统计持久化开关"
```

### 任务 7：全量验证与交付检查

**文件：**
- 检查：`worker.js`, `server.js`, `server/usage-persistence.mjs`, `web/index.html`, `web/app.js`, `web/style.css`

- [ ] **步骤 1：运行语法和全部测试**

运行：`node --check server.js && node --check worker.js && node --check web/app.js && node --test test/unit.test.mjs test/proxy.test.mjs test/web-layout.test.mjs test/usage-persistence.test.mjs`

预期：所有测试 PASS，命令退出码为 0。

- [ ] **步骤 2：执行浏览器级无额度验证**

使用现有 `.local/stub-panel.mjs` 或等价本地假 API，验证一次页面加载显示关闭开关；模拟 `PUT /usage-persistence` 成功后开关保持开启，模拟失败后恢复关闭。不得调用 `/v1/*` 或真实上游。

- [ ] **步骤 3：检查数据边界与工作树**

确认 `usage-stats.json` 位于数据目录而非仓库根目录，`git status --short` 不包含凭据、临时测试数据或运行时统计文件；确认设计文档 `docs/superpowers/specs/2026-08-17-persistent-usage-stats-design.md` 已保留。

- [ ] **步骤 4：Commit**

```bash
git add worker.js server.js server/usage-persistence.mjs web/index.html web/app.js web/style.css test/
git commit -m "test:验证概况统计持久化功能"
```
