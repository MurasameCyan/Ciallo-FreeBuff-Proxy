# Key 面板控件精简实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用纯图标统一表格操作，把账号状态缩成带提示的圆点，并把 Key 模型白名单改成可点击的多选按钮组。

**架构：** 仅调整静态面板的 DOM、渲染函数和 CSS，继续提交现有 `models: [] | string[]` 数据。用一个 SVG 图标渲染函数和一个按钮组状态函数集中管理动态控件，避免各表格重复标记。

**技术栈：** 原生 HTML、CSS、JavaScript、Node.js `assert` 合同测试、Docker 容器静态文件热改。

---

## 文件结构

- 修改 `test/web-layout.test.mjs`：锁定纯图标、状态圆点、模型按钮组和消息同行契约。
- 修改 `web/index.html`：用按钮组容器替换 `<select multiple>`，把状态消息移入操作区。
- 修改 `web/app.js`：渲染 SVG 图标、状态圆点和模型选择按钮，读取选择值。
- 修改 `web/style.css`：图标按钮、状态圆点、模型按钮组及可换行操作区样式。
- 创建 `docs/superpowers/specs/2026-08-19-key-panel-controls-design.md`：记录批准设计。
- 创建 `docs/superpowers/plans/2026-08-19-key-panel-controls.md`：记录实现步骤。

### 任务 1：建立失败的前端合同

**文件：**
- 测试：`test/web-layout.test.mjs`

- [ ] **步骤 1：添加精确断言**

断言 `#newKeyModels` 是 `role="group"` 容器而非 `<select>`，`#keyMsg` 位于 `.key-form-actions` 内，默认文案为「新建 Key」。断言动态操作按钮通过 `iconButton()` 生成 SVG、`title` 和 `aria-label`；断言 `stateDot()` 只有 `.dot` 且带可访问名称。

- [ ] **步骤 2：运行合同测试确认失败**

运行：`node test/web-layout.test.mjs`

预期：FAIL，首个失败指向旧 `<select multiple>`、文字操作按钮或状态胶囊。

### 任务 2：实现 DOM 和渲染逻辑

**文件：**
- 修改：`web/index.html:224-233`
- 修改：`web/app.js:257-266,350-380,408-424,443-609`

- [ ] **步骤 1：替换模型选择 DOM**

把 `<select id="newKeyModels" multiple>` 改为：

```html
<div class="key-model-options" id="newKeyModels" role="group" aria-label="可用模型，可多选" aria-describedby="keyMsg"></div>
```

把 `keyMsg` 移进 `.key-form-actions`，并把主按钮文案改为「新建 Key」。

- [ ] **步骤 2：集中生成图标按钮**

实现 `ICONS`、`iconButton(icon, label, attrs, tone)`，所有动态表格操作按钮只输出 SVG，并带 `title`、`aria-label`。

- [ ] **步骤 3：把账号状态改为圆点**

实现 `stateDot(state)`，返回：

```html
<span class="account-state-dot dot ok" title="状态：存活" aria-label="状态：存活" role="img"></span>
```

未探测也使用灰色圆点，替换原 `statePill()` 与文字回退。

- [ ] **步骤 4：实现模型按钮组状态**

用 `fillKeyModelButtons(selected)` 渲染「不限」和模型按钮；具体模型通过 `data-key-model` 标识，`aria-pressed` 反映选中状态。点击「不限」清空其他项；点击模型切换选择，最后一项取消后恢复「不限」。用 `selectedKeyModels()` 读取选中的模型 ID。

- [ ] **步骤 5：接入新建、编辑与异步刷新**

`resetKeyForm()`、`fillKeyForm()`、`renderKeys()` 和 `submitKeyForm()` 统一改用按钮组函数。成功消息严格使用「文本 Key 已复制到剪贴板」和「复制图标」文案。

### 任务 3：实现样式并转绿

**文件：**
- 修改：`web/style.css:395-423,565-596,749-756`
- 测试：`test/web-layout.test.mjs`

- [ ] **步骤 1：添加紧凑图标按钮样式**

给 `.actions.icon-actions` 与 `.action-col .btn.icon` 固定方形点击区，SVG 使用当前色，危险操作保持 rose；不改变表格和工作区尺寸契约。

- [ ] **步骤 2：添加纯状态圆点样式**

`.account-state-dot` 只保留直径、颜色和轻微光晕，不带胶囊边框、内边距或文字。

- [ ] **步骤 3：添加模型按钮组样式**

`.key-model-options` 使用 flex 换行；`.key-model-option[aria-pressed="true"]` 使用当前主题强调色；容器限高并可纵向滚动，模型多时不拉坏卡片。

- [ ] **步骤 4：让反馈消息与按钮同行**

`.key-form-actions` 允许换行并垂直居中；`.key-message` 去掉顶部外边距并允许占用剩余宽度。

- [ ] **步骤 5：运行聚焦测试**

运行：

```bash
node --check web/app.js
node test/web-layout.test.mjs
```

预期：语法通过，合同测试输出 `web layout contract: pass`。

### 任务 4：完整验证与容器热改

**文件：**
- 验证所有修改文件
- 容器目标：`m365-server` 上 `ciallo-freebuff-proxy:/app/web/`

- [ ] **步骤 1：运行完整离线套件**

运行 package/CI 中全部 Node 测试入口、所有受跟踪 JS/ESM 的 `node --check`，并运行 `git diff --check`。预期全部退出码为 0。

- [ ] **步骤 2：原子覆盖容器前端文件**

分别把 `web/app.js`、`web/index.html`、`web/style.css` 从本地 stdin 写入容器 `/tmp/stage-*`，比较本地与远端散列后在容器内 `mv` 到 `/app/web/`。不使用 `docker cp`，不写宿主机，不重启容器。

- [ ] **步骤 3：验证容器静态响应**

在容器内请求页面或读取文件，确认新文案「新建 Key」和新按钮组标记存在；确认容器仍在运行。通知用户强制刷新检查。

- [ ] **步骤 4：等待视觉反馈**

用户确认后再决定是否提交、推送和构建；热改在容器重建后会回滚。
