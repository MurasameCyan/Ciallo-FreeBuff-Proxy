import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

const requiredLayout = [
  'class="dashboard"',
  'class="account-summary overview-panel"',
  'class="workspace-grid"',
  'class="card account-card',
  'class="card model-workspace-card',
  'class="model-catalog"',
  'class="alias-editor"',
  'class="access-card',
  'class="card proxy-card"',
];

for (const marker of requiredLayout) {
  assert.ok(html.includes(marker), `管理面板缺少布局标记: ${marker}`);
}
assert.match(html, /class="(?=[^"]*\baccount-card\b)(?=[^"]*\bruntime-card\b)[^"]*"/,
  '账号池卡片必须标记为运行状态卡片');
assert.match(html, /class="(?=[^"]*\baccess-card\b)(?=[^"]*\baccess-inline\b)[^"]*"/,
  '接入信息必须使用 access-inline 紧凑布局');

for (const id of [
  'sTotal', 'sTotalSub', 'sAlive', 'sWarn', 'sBad',
  'accountSummary',
  'acctCount', 'acctBody', 'addForm', 'addBtn', 'authToken', 'email', 'name',
  'quotaHead',
  'oauthStart', 'loginUrl', 'oauthStatus', 'key-mask', 'models', 'models-empty',
  'modelCount',
  'aliasCount', 'aliasBody', 'newAlias', 'newAliasTarget', 'aliasAdd', 'aliasMsg',
  'proxyCard', 'proxyStatus', 'proxyUrl', 'proxyVersion', 'proxyNodeCount', 'proxyHealthyCount',
  'proxyCurrentNode', 'proxyLastRefresh', 'proxyError', 'proxyMessage',
  'proxySubscriptionForm', 'proxySubscription', 'proxySubscriptionSave',
  'proxyModeAuto', 'proxyModeManual', 'proxyNode', 'proxyHealthEnabled', 'proxyHealthInterval',
  'proxyAutoUpdate', 'proxyUpdateInterval',
  'build-id', 'btn-update', 'repo-link', 'logoutBtn', 'toasts', 'btn-refresh',
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `管理面板丢失 DOM 绑定 #${id}`);
}

assert.match(css, /\.workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+400px/s,
  '工作区必须是左弹性、右固定 400px 两列（左数据区 / 右概况·代理）');
assert.match(html,
  /class="workspace-col col-main"[\s\S]*class="card account-card[\s\S]*class="card model-workspace-card[\s\S]*class="workspace-col col-side"[\s\S]*id="usageCard"[\s\S]*id="proxyCard"/s,
  '左列必须是账号池+模型配置，右列必须是运行概况+出口代理');
assert.match(css, /\.workspace-col\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  '每列必须自成一条纵向流，否则同排两卡共享行高会在矮卡下方留出空洞');
assert.match(css, /\.workspace-grid\s*\{[^}]*align-items:\s*stretch/s,
  '两列必须等高，底边齐平');
assert.match(css, /\.col-main\s*>\s*\.model-workspace-card\s*\{[^}]*flex:\s*1\s+1\s+auto/s,
  '左列末卡必须吸收两列高度差，多出的高度进滚动列表而不是留白');
assert.match(css, /\.col-side\s*>\s*\.usage-card\s*\{[^}]*min-height:\s*360px/s,
  '运行概况卡片必须 360 起');
assert.match(css, /\.col-side\s*>\s*\.proxy-card\s*\{[^}]*min-height:\s*660px/s,
  '出口代理卡片必须 660 起');
assert.ok(!/\.workspace-grid\s*>\s*\.[a-z-]+card\s*\{[^}]*grid-row/.test(css),
  '不应再用 2×2 固定行列定位四张卡（那正是上下空洞的来源）');
assert.match(css, /@media\s*\(max-width:\s*1200px\)[\s\S]*?\.col-side\s*>\s*\.usage-card,[\s\S]*?min-height:\s*0/s,
  '单列时侧栏两卡必须解除 360/660 下限，避免拉出空白');
assert.match(css, /@media\s*\(max-width:\s*1200px\)[\s\S]*?\.workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  '窄屏工作区必须退化为单列');
assert.ok(!html.includes('egress-card'), '不应保留重复的出口状态卡片');
assert.match(css, /\.access-inline\s*\{[^}]*display:\s*(?:flex|grid)/s,
  '接入信息必须是纵向紧凑区块（Key 一行、按钮一行）');
assert.match(css, /\.access-actions\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(118px,\s*1fr\)\)/s,
  '四颗接入按钮必须等宽铺开：窄卡 2×2，宽屏一行四颗且不被拉满');
assert.match(css, /\.access-actions \.btn\s*\{[^}]*text-align:\s*center/s,
  '等宽按钮的文字必须居中');
assert.match(css, /\.usage-card \.access-inline\s*\{[^}]*border-top/s,
  '接入信息与概况四格之间必须有分隔线');
assert.ok(!css.includes('.summary-tools'),
  '接入信息移出账号池概况标题后，summary-tools 容器必须删除');
assert.match(css, /\.model-workspace-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/s,
  '模型映射应占剩余空间，可用模型列按内容自适应');
assert.match(css, /\.model-workspace-grid\s*\{[^}]*align-items:\s*stretch[^}]*--model-list-height:\s*240px/s,
  '模型映射与可用模型卡片必须等高(y 对齐)并共享默认列表高度');
assert.match(css, /\.model-catalog\s*,\s*\.alias-editor\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  '模型映射与可用模型卡片必须使用纵向布局以保持等高');
assert.match(css, /\.model-catalog\s+\.models\s*\{[^}]*flex:\s*1\s+1\s+0/s,
  '可用模型列表必须填满卡片高度以对齐模型映射并消除留白');
assert.match(css, /\.alias-editor\s+\.table-scroll\s*\{[^}]*height:\s*var\(--model-list-height\)/s,
  '模型映射列表必须以默认列表高度作为基准以支持内联滚动');
assert.match(css, /\.alias-editor\s+\.table-scroll\s*\{[^}]*flex:\s*1\s+0\s+auto/s,
  '模型映射列表必须吸收多余高度，把添加行顶到卡片底边，消除下方留白');
assert.match(css, /\.model-workspace-card\s+\.table-scroll\s*\{[^}]*scrollbar-width:\s*none/s,
  '模型映射内联滚动必须隐藏滚动条');
assert.match(css, /\.proxy-card[\s\S]*?\.proxy-metrics/s,
  '代理卡必须提供状态指标布局');
assert.match(html,
  /class="proxy-meta-row"[\s\S]*id="proxyCurrentNode"[\s\S]*id="proxyVersion"[\s\S]*id="proxyLastRefresh"/s,
  '当前节点、内核版本、最近刷新必须放在同一行容器');
assert.match(css, /\.proxy-meta-row\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)/s,
  '代理元信息必须使用三列同行布局');
assert.match(css, /\.stat\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  '账号统计块必须使用紧凑的横向数字布局');
assert.match(css, /\.proxy-input-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  '订阅输入与保存按钮必须在同一行');
assert.ok(!/\.alias-table\s*\{[^}]*min-width:\s*[1-9]/.test(css),
  '模型映射表不得硬撑最小宽度：容器只有 ~560px，硬撑会把「操作」列顶到隐藏滚动条之外（删除按钮被切）');
assert.match(css, /\.alias-table th:first-child\s*\{[^}]*width:\s*1%[^}]*white-space:\s*nowrap/s,
  '别名列必须按内容收窄，多余宽度归「映射到」，两列文字之间只剩单元格内边距');
assert.match(css, /\.alias-table \.action-col\s*\{[^}]*width:\s*1%/s,
  '模型映射「操作」列必须按内容收窄，不再定死 84px');
assert.match(css, /\.tbl td\.empty\s*\{[^}]*white-space:\s*normal/s,
  '空态行必须能折行：整行 colspan 的长提示被 nowrap 拖成一行会溢出隐藏滚动条');
assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.alias-table tbody td:first-child\s*\{[^}]*white-space:\s*normal/s,
  '手机端别名列回到定宽百分比，必须解除 nowrap，否则长别名会顶出格子');
assert.match(css, /@media\s*\(max-width:\s*700px\)[\s\S]*?\.alias-table\s*\{[^}]*min-width:\s*0/s,
  '手机端模型映射表必须收缩到视口内');
assert.match(css, /\.account-table\.is-empty\s*\{[^}]*min-width:\s*0/s,
  '手机端空账号状态必须收缩到视口内');
assert.ok(app.includes("table.classList.toggle('is-empty'"), '账号表必须区分空状态与真实数据状态');
assert.match(css, /@media\s*\(max-width:\s*480px\)/,
  '窄手机端必须收紧双字段表单');
assert.match(css, /@media\s*\(max-width:\s*660px\)/,
  '手机端侧栏必须退化为单列');
assert.ok(html.includes('aria-live="polite"'), 'OAuth 状态变化必须可被辅助技术播报');
assert.match(html, /<th id="quotaHead">可用模型\(重置时间\)<\/th>/,
  '额度列标题必须带 id 以便脚本改写为“可用模型 (重置 …)”，并保留静态回落文案');
assert.ok(app.includes('function poolResetAt') && app.includes('function renderQuotaHead'),
  '重置时间必须提到列标题（池级统一，逐行重复无信息量）');
assert.ok(app.includes('`可用模型 (重置 ${formatResetAt(reset)})`'),
  '列标题必须渲染成“可用模型 (重置 YYYY-MM-DD HH:mm)”');
assert.ok(app.includes('renderQuotaHead()'), 'renderAccounts 必须刷新额度列标题');
assert.ok(!app.includes('quota-reset'), '重置时间已上移列标题，行内不应再有 quota-reset');
assert.ok(!app.includes('esc(a.tokenShort || \'\')'),
  'token 短哈希不再无条件占一行，仅在既无备注名也无邮箱时兜底');
assert.ok(app.includes('esc(usage.used') && app.includes('esc(usage.limit'),
  '账号用量必须移动到账号名之后（池级共享，视作账号通用）呈现 (已用/总量)');
assert.match(app, /class="acct-usage"/, '账号名后必须有 acct-usage 承载用量');
assert.match(app, /class="quota quota-models"/, '可用模型列必须列出账号可用模型');
assert.match(app, /function usableQuota/, '必须提供 usableQuota 以过滤未解锁模型');
assert.match(app, /Number\(q\.limit\)\s*>\s*0/,
  '可用模型与账号用量必须只取 limit>0 的池，隐藏 0/0 未解锁模型（如 glm-5.2）');
assert.match(app, /8 \* 3600 \* 1000/, '重置时间必须显式折算到北京时间（UTC+8）');
assert.match(app, /getUTCHours\(\)/, '北京时间格式化必须基于 UTC 偏移而非浏览器本地时区');
assert.ok(!app.includes('quota-row'), '旧的每模型 quota-row 用量行必须移除');
assert.match(css, /\.acct-usage\s*\{[^}]*white-space:\s*nowrap/s, '账号用量必须单行不换行');
assert.match(css, /\.quota-models\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
  '可用模型必须横向排列并自动换行，而非每项独占一行');
assert.match(css, /\.quota-models\s*\{[^}]*list-style:\s*none/s,
  '可用模型清单必须去掉列表符号');
assert.match(html, /id="repo-link"[^>]*aria-label="GitHub 仓库"/s,
  '纯图标仓库链接必须有可访问名称');
assert.match(html, /id="tab-manage"[^>]*aria-controls="pane-manage"/s,
  '账号管理标签必须关联面板');
assert.match(html, /id="tab-add"[^>]*aria-controls="pane-add"/s,
  '账号添加标签必须关联面板');
assert.match(html, /<button[^>]*class="login-url"[^>]*id="loginUrl"/s,
  'OAuth 授权地址必须可通过键盘操作');
for (const binding of ['data-copy-proto="openai"', 'data-copy-proto="anthropic"', 'data-copy-key', 'data-reset-key']) {
  assert.ok(html.includes(binding), `管理面板丢失交互绑定: ${binding}`);
}
assert.match(html,
  /class="(?=[^"]*\baccess-inline\b)[^"]*"[\s\S]*data-copy-proto="openai"[\s\S]*data-copy-proto="anthropic"[\s\S]*data-copy-key[\s\S]*data-reset-key/s,
  '接入信息四个按钮必须保持同组');
assert.match(html,
  /id="usageCard"[\s\S]*class="usage-grid"[\s\S]*class="(?=[^"]*\baccess-card\b)[^"]*"[\s\S]*data-reset-key[\s\S]*id="proxyCard"/s,
  '接入信息必须落在运行概况卡内、四格统计下方');
assert.ok(html.indexOf('data-copy-key') > html.indexOf('id="usageCard"'),
  '账号池概况里不应再残留接入信息按钮（必须整组在概况卡之后）');
assert.match(html,
  /class="model-workspace-grid"[\s\S]*class="alias-editor"[\s\S]*class="model-catalog"/s,
  '模型配置内部顺序必须为模型映射 | 模型列表');
assert.match(html, /id="h-model-workspace">模型与映射<\/h2>/,
  '模型卡标题必须简化为“模型与映射”');
assert.match(html, /<h3 id="h-models">模型列表<\/h3>/,
  '右侧子卡标题必须是“模型列表”（原“可用模型”）');
assert.ok(!/^\.models li\s*\{[^}]*(?:border:|background:)/m.test(css),
  '模型列表条目必须是纯文本，不再套卡片（无边框、无底色）');
assert.match(css, /^\.models li\s*\{[^}]*font:\s*10px/m,
  '模型名称字号必须比原来小 1px（11 → 10）');
assert.match(css, /^\.models\s*\{[^}]*gap:\s*[0-4]px/m,
  '模型列表行距必须收紧（去掉卡片后 7px 太散）');
assert.match(css, /\.model-catalog \.models[\s\S]*scrollbar-width:\s*none/s,
  '模型列表必须使用卡片内滚动且隐藏滚动条');
assert.match(css, /\.model-catalog \.models\s*\{[^}]*justify-items:\s*start/s,
  '模型列表条目必须按模型名称宽度自适应');
assert.match(css, /\.model-catalog \.models li\s*\{[^}]*width:\s*fit-content/s,
  '模型列表条目不应横向拉伸并留下空白');
assert.ok(!html.includes('class="page-intro"'), '页面顶部不应保留运行面板介绍区');
for (const removedText of ['控制台', '运行面板', '账号、模型与出口代理集中管理']) {
  assert.ok(!html.includes(`>${removedText}<`), `页面必须移除介绍文案: ${removedText}`);
}
assert.match(html, /<span class="access-name">Key:<\/span>\s*<code class="access-key" id="key-mask"/s,
  'Key 掩码前必须有可见的「Key:」标签');
assert.match(css, /\.access-head\s*\{[^}]*justify-content:\s*space-between/s,
  '「Key:」贴左、掩码贴右，中间留空');
assert.ok(!html.includes('定时检测节点可用性'), '自动测活说明文案必须移除');
assert.ok(app.includes('切换到「添加」'), '空账号提示必须指向现有的“添加”标签');
assert.match(html, /<th>操作<\/th>/,
  '“操作”表头只剩纯文本：全部探测按钮已移除');
assert.ok(!html.includes('btn-testall') && !html.includes('全部探测'),
  '全部探测按钮必须移除（GET /_api/accounts 每次都会在服务端逐个探测）');
assert.ok(!html.includes('th-actions'), '表头工具条容器随全部探测一起移除');
assert.ok(!app.includes('btn-testall'), '全部探测的事件处理必须一并移除');
assert.ok(!app.includes('data-probe'), '逐行“探测”按钮及其事件处理必须移除');
assert.ok(!html.includes('pane-bar'), '独立的探测工具条必须移除');
assert.match(css, /\.account-table thead th:last-child\s*\{[^}]*width:\s*1%/s,
  '账号表“操作”列必须收窄到内容宽度');
assert.match(css, /\.account-table thead th:first-child\s*\{[^}]*width:\s*1%[^}]*white-space:\s*nowrap/s,
  '账号列必须按内容自适应宽度，不再拉伸留白');
assert.match(css, /\.account-table tbody td:first-child\s*\{[^}]*white-space:\s*nowrap/s,
  '账号列单元格必须单行不换行，列宽才等于最长的账号名/邮箱');
assert.match(css, /\.account-table thead th:nth-child\(2\)\s*\{[^}]*width:\s*1%/s,
  '状态列必须一并收窄，把宽度让给可用模型');
assert.match(css, /\.btn\s*\{[^}]*white-space:\s*nowrap/s,
  '按钮文字必须横排：收缩列里中文会逐字折行（「删除」竖成两行）');
assert.ok(!/\.account-table th:nth-child\(1\)/.test(css),
  '小屏不应再用百分比切死账号表列宽，否则会盖掉自适应规则');
assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.model-catalog\s+\.models\s*\{[^}]*height:\s*var\(--model-list-height\)/s,
  '窄屏可用模型列表必须回退到固定高度');
assert.ok(app.includes("api('/proxy')"), '面板轮询必须读取代理订阅状态');
assert.ok(app.includes("api('/proxy/subscription'"), '保存订阅必须调用订阅配置接口');
assert.ok(app.includes("api('/proxy/node'"), '节点策略必须调用节点选择接口');
assert.ok(app.includes("api('/proxy/health'"), '自动测活设置必须调用测活配置接口');
assert.ok(app.includes("api('/proxy/update'"), '自动更新设置必须调用更新配置接口');
assert.match(html, /id="proxyModeAuto"[^>]*aria-pressed="true"/s,
  '自动节点模式按钮必须暴露 pressed 状态');
assert.match(html, /id="proxyHealthEnabled"/s, '代理卡必须提供自动测活开关');
assert.match(html, /id="proxyAutoUpdate"/s, '代理卡必须提供自动更新开关');
assert.match(html,
  /id="proxyHealthInterval"[\s\S]*?value="60"[^>]*>1 分钟[\s\S]*?value="300"[^>]*>5 分钟[\s\S]*?value="600"[^>]*>10 分钟[\s\S]*?value="1800"[^>]*>30 分钟[\s\S]*?value="3600"[^>]*>1 小时[\s\S]*?value="21600"[^>]*>6 小时[\s\S]*?value="43200"[^>]*>12 小时[\s\S]*?<\/select>/s,
  '检测间隔选项必须按 1/5/10/30 分钟、1/6/12 小时升序排列');
assert.ok(app.includes('syncIntervalSelect'),
  '间隔下拉必须用固定候选值受控重建（升序、分钟/小时标签）');
assert.ok(!app.includes('healthSelect.append') && !app.includes('updateSelect.append'),
  '不应再把后端非标准秒值追加为「N 秒」下拉项（如 43 秒/300 秒）累积成垃圾');
assert.match(html, /id="proxyUpdateInterval"[\s\S]*?value="3600"[\s\S]*?value="86400"[\s\S]*?<\/select>/s,
  '自动更新间隔必须提供 1 小时到 24 小时的选项');
assert.ok(!html.includes('id="proxyRefresh"'), '代理卡不应保留重复的底部刷新按钮');
assert.ok(!app.includes("api('/proxy/refresh'"), '保存订阅应由单次 PUT 完成，不应再重复 POST 刷新');

// 账号池概况：自动轮询降到 1 小时，并提供可即时刷新的图标按钮。
assert.ok(app.includes('const POLL_MS = 3600000'), '默认轮询间隔必须为 1 小时（3600000ms）');
assert.ok(!html.includes('每 5 秒更新'), '概况区不应再声称每 5 秒更新');
assert.ok(!html.includes('每 5 分钟刷新'), '概况区不应再声称每 5 分钟刷新');
assert.match(html, /class="summary-live"[\s\S]*?每小时刷新/s, '概况区必须标注每小时刷新节奏');
assert.match(html, /id="btn-refresh"[^>]*aria-label="立即刷新"/s, '概况区刷新图标必须有可访问名称');

// ── 调用日志卡（移植自 zen；详情里的“节点”改为调度的账号名） ──────────
for (const id of ['callLogCard', 'callLog', 'calllog-sum', 'calllog-empty', 'h-calllog']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `调用日志卡丢失 DOM 绑定 #${id}`);
}
assert.match(html, /<details class="card calllog-card"[^>]*id="callLogCard"/,
  '调用日志必须是默认折叠的通栏卡');
assert.match(html, /<summary class="calllog-summary">/, '调用日志卡必须用 summary 承载卡头');
assert.match(html, /<span class="calllog-title">调用日志<\/span>/, '调用日志标题必须为“调用日志”');
assert.match(html, /<ul class="calllog" id="callLog" tabindex="0"/,
  '调用日志列表必须可聚焦以支持键盘滚动');
assert.ok(html.includes('还没有成功的调用'), '调用日志空态文案必须保留');

// 详情主行必须展示“调度的账号名”，而非 zen 原本的“节点”
assert.ok(app.includes('c.account'), '调用日志聚合必须读取账号字段 account');
assert.ok(app.includes('r.account'), '调用日志主行必须渲染调度到的账号名');
assert.ok(!app.includes('c.node') && !app.includes('r.node'),
  '详情里的“节点”必须改为调度的账号名，不应保留 node 字段');
assert.ok(app.includes("tag('nm'"), '调用日志主行必须有 .nm 承载账号名');

// 聚合与格式化（与 zen core.js 同口径）
for (const fn of ['function fmtClock', 'function fmtDelay', 'function fmtTokens',
  'function fmtCount', 'function callLog', 'function renderCallLog', 'function num']) {
  assert.ok(app.includes(fn), `调用日志缺少函数: ${fn}`);
}
assert.ok(app.includes("api('/usage')"), '面板轮询必须读取调用日志 /usage');
assert.ok(app.includes('renderCallLog()'), 'refresh 必须渲染调用日志');
for (const label of ['最近 ', '平均首字', '平均耗时', '累计限流', '超时', '错误']) {
  assert.ok(app.includes(label), `调用日志摘要缺少字段: ${label}`);
}
assert.ok(!app.includes('每条成功的上游调用记一行'),
  '调用日志空态摘要不再展示记账口径说明（已按要求移除）');
assert.match(app, /Token \$\{fmtTokens\(r\.total\)\}[\s\S]*入[\s\S]*出[\s\S]*推理/,
  '逐条明细必须呈现 Token 总量与入/出/推理分项');

// CSS：限高 + 内部滚动 + 藏滚动条 + 主行可折行
assert.match(css, /\.calllog\s*\{[^}]*max-height:\s*60vh[^}]*overflow-y:\s*auto/s,
  '调用日志列表必须限高并内部滚动');
assert.match(css, /\.calllog\s*\{[^}]*scrollbar-width:\s*none/s,
  '调用日志列表必须隐藏滚动条');
assert.match(css, /\.calllog-main\s*\{[^}]*flex-wrap:\s*wrap/s,
  '调用日志主行必须可折行，避免横向溢出');

// ── 运行概况卡（移植自 zen；右列上半，出口代理上方） ────────────
for (const id of ['usageCard', 's-tok', 's-tok-sub', 's-models', 's-models-empty',
  's-req', 's-req-sub', 's-rate', 's-rate-bar', 's-up', 's-up-sub', 'h-usage']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `概况卡丢失 DOM 绑定 #${id}`);
}
assert.match(html, /<section class="card usage-card" id="usageCard"/,
  '概况必须是 usage-card 卡');
assert.match(html, /class="workspace-col col-side"[\s\S]*id="usageCard"/s,
  '概况卡必须在工作区右列');
assert.match(html, /id="usageCard"[\s\S]*id="proxyCard"/s,
  '概况卡必须排在出口代理之前（右列自上而下）');
assert.match(html, /<h2 id="h-usage">概况<\/h2>/, '概况标题必须为“概况”');
assert.match(html, /class="usage-grid"/, '概况必须用 usage-grid 承载 2×2 四格');
const usageStatCount = (html.match(/class="usage-stat"/g) || []).length;
assert.equal(usageStatCount, 4, `概况必须正好 4 个 usage-stat，实际 ${usageStatCount}`);
for (const label of ['Token 消耗', '模型统计', '请求总数', '成功率', '运行时长']) {
  assert.ok(html.includes(`>${label}<`), `概况缺少字段标题: ${label}`);
}
assert.match(html, /class="usage-duo"[\s\S]*id="s-req"[\s\S]*id="h-rate"[\s\S]*id="s-rate"/s,
  '请求总数与成功率必须并进一格 usage-duo');
assert.match(html, /class="usage-bar"[^>]*role="img"[\s\S]*id="s-rate-bar"/s,
  '成功率必须有进度条 s-rate-bar');

// 概况聚合与格式化（与 zen 同口径）+ 接线
for (const fn of ['function fmtUptime', 'function successRate', 'function fmtPercent',
  'function rankBreakdown', 'function renderUsageOverview', 'function renderUsageModels']) {
  assert.ok(app.includes(fn), `概况缺少函数: ${fn}`);
}
assert.ok(app.includes('renderUsageOverview()'), 'refresh 必须渲染概况');
for (const field of ['S.usage?.total', 'S.usage?.byModel', 'S.usage.startTime', 'S.usage.lastRequest']) {
  assert.ok(app.includes(field), `概况必须读取 ${field}`);
}
assert.ok(
  app.includes('fmtTokens(t.promptTokens)') && app.includes('fmtTokens(t.completionTokens)')
  && app.includes('fmtTokens(t.reasoningTokens)') && app.includes('fmtTokens(t.cacheReadTokens)')
  && app.includes('fmtTokens(t.cacheWriteTokens)'),
  'Token 副行必须呈现输入/输出/推理/缓存读/缓存写分项');
assert.match(app, /成功 \$\{fmtCount\(t\.success\)\} · 失败 \$\{fmtCount\(t\.fail\)\}/,
  '请求副行必须呈现成功/失败拆分');
assert.match(app, /fmtPercent\(rate\)[\s\S]*s-rate-bar[\s\S]*width/s,
  '成功率必须驱动进度条宽度');

// 概况 CSS：私有 .usage-* 类，2 列网格 + 模型统计限高滚动藏条 + 进度条渐变 + 窄屏单列
assert.match(css, /\.usage-card \.usage-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)/s,
  '概况必须是 2 列 2×2 网格');
assert.match(css, /\.usage-card \.usage-models\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s,
  '模型统计列表必须限高并内部滚动');
assert.match(css, /\.usage-card \.usage-models\s*\{[^}]*scrollbar-width:\s*none/s,
  '模型统计列表必须隐藏滚动条');
assert.match(css, /\.usage-card \.usage-bar span\s*\{[^}]*linear-gradient/s,
  '成功率进度条必须有渐变填充');
assert.match(css, /@media\s*\(max-width:\s*660px\)[\s\S]*?\.usage-card \.usage-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  '窄屏概况必须退化为单列');

// 所有 id 必须唯一，避免重排后 renderStats/renderModels 写入错误节点。
const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
assert.deepEqual([...new Set(duplicates)], [], `页面存在重复 id: ${[...new Set(duplicates)].join(', ')}`);

console.log('web layout contract: pass');
