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
  'proxyCurrentNode', 'proxyLastRefresh', 'proxyError', 'proxyReject', 'proxyMessage',
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
// 两列底边对齐的收缩链：左列矮 → 模型卡长高吃掉差额；左列高 → 差额从账号表扣、走内联滚动。
assert.match(css, /\.col-main\s*>\s*\.model-workspace-card\s*\{[^}]*flex:\s*1\s+0\s+auto/s,
  '左列末卡只涨不缩：左列比右列矮时它吸收差额（进映射表/模型列表而不是留白），比右列高时差额得从账号表扣，模型卡保持自然高');
assert.match(css, /\.col-main\s*>\s*\.runtime-card\s*\{[^}]*flex:\s*0\s+1\s+auto[^}]*min-height:\s*0/s,
  '账号池卡必须是唯一可收缩的那张，否则账号一多整列就比右列高出一两百像素');
assert.match(css, /\.account-card\s*\{[^}]*overflow:\s*hidden[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
  '账号池卡必须是纵向 flex 且裁掉溢出，表格才能成为唯一的伸缩区');
assert.match(css, /\.account-card > \.card-head\s*\{[^}]*flex:\s*none/s,
  '账号池概况与标题固定高度，压缩只允许发生在表格上');
assert.match(css, /\.account-card \.table-scroll\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*min-height:\s*1[0-9][0-9]px[^}]*overflow:\s*auto/s,
  '账号表必须内联滚动吸收高度差，并留出至少三位数的下限（再挤宁可整列略高，也不把表压成一条缝）');
assert.match(css, /\.account-card \.table-scroll\s*\{[^}]*scrollbar-width:\s*none/s,
  '账号表内联滚动必须隐藏滚动条');
assert.match(css, /\.account-card \.table-scroll::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
  'WebKit/Blink 认伪元素而非 scrollbar-width，两处都要关');
assert.match(css, /\.account-card > \.pane\.add-pane\s*\{[^}]*overflow-y:\s*auto/s,
  '「添加」分页在卡被压矮时也要内联滚动，否则表单被 overflow:hidden 切掉');
// 纯 CSS 收不住左列：Chrome 里纵向 flex 容器的 min-content 高度等于 max-content，
// grid-template-rows:min-content / min-height:0 都是空转，只有显式 max-height 才封得住。
assert.match(app, /function syncColumnBottoms\(\)[\s\S]*?\$\('proxyCard'\)/s,
  '底边对齐必须以右列末卡 #proxyCard 的底边为基准');
assert.match(app, /function syncColumnBottoms\(\)[\s\S]*?main\.style\.maxHeight = ''/s,
  '重算前必须先清掉上一次的上限，否则量到的是被自己压过的高度');
assert.match(app, /function syncColumnBottoms\(\)[\s\S]*?getBoundingClientRect\(\)\.top[\s\S]*?return/s,
  '两列上边不齐（≤1200px 退成单列）时必须直接返回，限高只会白白裁掉内容');
assert.match(app, /function syncColumnBottoms\(\)[\s\S]*?main\.style\.maxHeight = cap \+ 'px'/s,
  '对齐靠给 .col-main 设 max-height 实现（Chrome 下纵向 flex 的 min-content == max-content，纯 CSS 收不住）');
assert.match(app, /ResizeObserver[\s\S]*?\$\('usageCard'\), \$\('proxyCard'\)/s,
  '右列自己长高/变矮时要重算；只观察右列两卡，避免与自己设的 maxHeight 互相触发');
assert.ok(app.includes('watchColumnBottoms();'), '底边对齐必须挂上 resize/ResizeObserver 监听');
assert.ok(app.includes('syncColumnBottoms();'), '每轮渲染后必须重算底边对齐（账号行数会变）');
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
assert.match(css, /\.alias-editor\s+\.table-scroll\s*\{[^}]*flex:\s*1\s+1\s+auto/s,
  '模型映射列表要能双向伸缩：涨着把添加行顶到卡片底边消除留白，映射条数多又被压矮时收缩、多出的行走内联滚动');
assert.match(css, /\.alias-editor\s+\.table-scroll\s*\{[^}]*min-height:\s*96px/s,
  '模型映射至少露出表头 + 一行，再挤就不缩了');
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
assert.match(app, /probe && probe\.isolatedUntil/,
  '无额度表的封禁账号必须在可用模型列显示本地隔离到期时间，而不是一个光秃秃的 —');
assert.ok(!/解封 \$\{|解封至/.test(app),
  '不能把本地 24h 兜底说成「解封」：上游 banned 响应不含解封时间，措辞必须是「隔离至」');
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
// 授权链接显示框：框内是「可点开的链接文字 + 纯图标复制按钮」两颗 button，
// 框自身必须是 div —— button 套 button 是非法 HTML，浏览器会把内层拆出去。
assert.match(html, /<div class="login-url" id="loginUrl" hidden>/,
  '授权链接显示框必须是 div，才能在框内放复制按钮');
const urlBox = html.slice(html.indexOf('<div class="login-url"'), html.indexOf('id="oauthStatus"'));
assert.match(urlBox, /<button[^>]*class="login-url-text"[^>]*id="loginUrlOpen"/s,
  'OAuth 授权地址必须可通过键盘操作');
assert.match(urlBox, /<button[^>]*id="loginUrlCopy"[^>]*aria-label="复制授权链接"/s,
  '复制按钮必须在授权链接框内，且纯图标要有可访问名称');
assert.match(urlBox, /id="loginUrlCopy"[^>]*>\s*<svg[\s\S]*?<\/svg>\s*<\/button>/s,
  '复制按钮只放图标，不带文字');
assert.ok(app.includes("$('loginUrlOpen').textContent = j.loginUrl"),
  '链接文字必须写进内层 button，而不是外层的框');
assert.match(app, /loginUrlCopy[\s\S]*?clipboard\.writeText\(\$\('loginUrlOpen'\)\.textContent/s,
  '复制按钮必须把框里显示的链接写入剪贴板');

// 开始授权按钮：点下去就自报「等待授权」，三条出口（成功/过期/失败）都要复位
assert.ok(app.includes("btn.textContent = '等待授权'"),
  '点击开始授权后按钮文案必须变为「等待授权」');
assert.match(app, /function oauthIdle\(\)[\s\S]*?textContent = '开始授权'/s,
  '必须有统一的复位函数把按钮文案改回「开始授权」');
assert.equal(app.split('oauthIdle()').length - 1, 4,
  'oauthIdle 必须在定义之外的三处出口（成功/过期/失败）都被调用');
// 带引号匹配字符串字面量：注释里引用这句旧文案（说明为什么撤掉）是允许的
assert.ok(!app.includes("'等待授权…(每 3 秒检测一次)'"),
  '轮询状态行不应再重复「等待授权…(每 3 秒检测一次)」（已由按钮文案表达）');
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
assert.match(app, /MODEL_TIER_LABELS = \{ free: '免费', us_sg: 'US \/ SG', limited: '限定' \}/,
  '模型列表的三个分组 tag 文案必须是 免费 / US / SG / 限定');
assert.match(app, /MODEL_TIER_LABELS\[m\.tier\]/,
  '分组 tag 必须读 /v1/models 的 tier 字段（旧的 m.free 已废弃）');
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
// 手动更新订阅：按钮 + 复用后端 refresh 接口 + 未配置订阅时必须禁用
// （后端 refreshCore 在无订阅时静默返回快照，不拦就会 toast 一个假的「更新完成」）。
assert.match(html,
  /class="proxy-field proxy-url-field"[\s\S]*?id="proxyUrl"[\s\S]*?<button[^>]*class="btn primary"[^>]*id="proxyRefresh"[^>]*>更新</s,
  '手动更新按钮必须在「当前订阅」右侧，与「保存」同为 primary 配色，文案为「更新」');
assert.match(css, /\.proxy-url-field\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s,
  '「当前订阅」行必须与订阅输入行同列宽，「更新」才会正好落在「保存」下方');
assert.ok(app.includes("api('/proxy/refresh'"), '手动更新必须调用后端订阅刷新接口');
assert.match(app, /\$\('proxyRefresh'\)[\s\S]{0,120}disabled\s*=\s*!p\.configured/s,
  '未配置订阅时手动更新按钮必须禁用');
// 节点被 freebuff 拒绝：独立一行、与 proxyError 分开（那条是内核/订阅故障，这条是出口 IP 不被收）
assert.match(html, /id="proxyError"[\s\S]{0,240}id="proxyReject"[^>]*hidden/s,
  '节点被拒提示必须独立成行、排在代理错误之后，且默认隐藏（没记录时不占位）');
assert.match(css, /\.proxy-reject\s*\{[^}]*color:\s*var\(--amber\)/s,
  '节点被拒是琥珀色而非 rose：代理本身没坏，是出口 IP 不被接受');
assert.ok(app.includes('p.reject'), '面板必须读取代理快照里的 reject 记录');
assert.match(app, /country_blocked:[^\n]*ip_capped:/s,
  '被拒原因必须按 country_blocked / ip_capped 等状态译成中文');
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
// 旧断言曾禁止 #proxyRefresh，理由是「与保存订阅重复」——那只对保存流程成立：重拉已配置的
// 订阅需要重新粘一遍 URL，envLocked 时还根本粘不了。手动更新按钮已按需求重新加回（见上方断言）。
// 仍要守住的是原来那条禁令的有效部分：保存流程本身不许再补一次 POST 刷新。
const saveFlow = app.slice(app.indexOf("'保存订阅'"), app.indexOf("'节点已重新解析'"));
assert.ok(saveFlow.length > 0 && !saveFlow.includes('/proxy/refresh'),
  '保存订阅应由单次 PUT 完成，不应在保存流程里再 POST 刷新');

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

// 展开标记：<details> 自带的三角形按要求隐藏（两套前缀都要关，否则旧版 Safari 还留着）
assert.match(css, /\.calllog-summary\s*\{[^}]*list-style:\s*none/s,
  '调用日志卡头不应显示 <details> 自带的展开三角');
assert.match(css, /\.calllog-summary::-webkit-details-marker\s*\{[^}]*display:\s*none/s,
  '调用日志卡头必须同时关掉 WebKit 的 details marker');
assert.ok(!/\.calllog-summary\s*\{[^}]*list-style-position/s.test(css),
  '标记已隐藏，不应再为它保留 list-style-position');
assert.match(css, /\.calllog-summary \.card-head\s*\{[^}]*width:\s*100%/s,
  '标记撤掉后卡头应占满整行（原先让出的 20px 要收回）');

// 实时刷新：调用日志自带快轮询，不再靠用户手动刷新页面。
// 必须与 1 小时的 refresh() 分开——那条慢是因为它连带探账号，日志只读内存快照。
assert.match(app, /const LOG_POLL_MS = (\d+)/, '调用日志必须有独立的快轮询间隔 LOG_POLL_MS');
assert.ok(Number(app.match(/const LOG_POLL_MS = (\d+)/)[1]) <= 5000,
  '调用日志轮询间隔必须 ≤5s，否则算不上实时');
assert.ok(app.includes('setInterval(refreshCallLogLive, LOG_POLL_MS)'),
  '调用日志快轮询必须挂上 setInterval');
const liveFlow = app.slice(app.indexOf('async function refreshCallLogLive'), app.indexOf('// ── 交互'));
assert.ok(liveFlow.includes("api('/usage')"), '快轮询必须只读 /usage');
for (const heavy of ["api('/accounts')", "api('/config')", "api('/proxy')", '/v1/models']) {
  assert.ok(!liveFlow.includes(heavy), `快轮询不应触发 ${heavy}（每 3 秒探一次账号会打爆上游）`);
}
assert.ok(liveFlow.includes('document.hidden') && liveFlow.includes('logPolling'),
  '快轮询必须在页面隐藏时停下，并防止请求堆积');
assert.match(app, /visibilitychange[\s\S]*refreshCallLogLive\(\)/,
  '切回前台应立即补一次，不用等下一拍');

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

// ── 概况统计持久化开关（无文字胶囊开关，右侧） ────────────
assert.match(html,
  /<label class="switch usage-persistence-toggle" title="持久化统计数据（默认关闭）">[\s\S]*?<input type="checkbox" id="usagePersistence">[\s\S]*?<span class="switch-track"[\s\S]*?<span class="sr-only">持久化统计数据（默认关闭）<\/span>/s,
  '概况标题右侧必须有无文字胶囊开关，悬停提示「持久化统计数据（默认关闭）」');
// 开关必须落在概况卡 .card-head 内（标题之后），不是卡别处。
const usageHead = html.slice(html.indexOf('<div class="card-head">', html.indexOf('id="usageCard"')), html.indexOf('<div class="usage-grid">'));
assert.match(usageHead, /id="usagePersistence"/, '持久化开关必须位于概况卡 card-head 内');
// 可见文字只有 sr-only 的可访问名：label 里除 sr-only 外不应有文字节点承载说明。
assert.ok(html.includes('持久化统计数据（默认关闭）'), '开关悬停提示与无障碍名必须写明「默认关闭」');
// 默认关闭：checkbox 不带 checked 属性。
assert.ok(!/<input type="checkbox" id="usagePersistence"[^>]*checked/.test(html),
  '持久化开关 HTML 默认必须关闭');
// 前端接线：加载读 GET、切换发 PUT、失败恢复旧状态、成功回写服务端确认值。
assert.ok(app.includes("api('/usage-persistence')"), '面板必须读取持久化开关状态');
assert.match(app, /\$\('usagePersistence'\)[\s\S]*api\('\/usage-persistence',\s*\{[\s\S]*method:\s*'PUT'[\s\S]*enabled:/s,
  '切换开关必须 PUT /usage-persistence 并带 enabled 布尔');
assert.match(app, /catch\s*\(err\)\s*\{[\s\S]*toggle\.checked\s*=\s*prev/s,
  'PUT 失败必须恢复旧状态（开关没生效不能显示成生效）');
assert.ok(app.includes('toggle.checked = r?.enabled === true'),
  '开关最终状态必须回写服务端确认值，而非本地猜测');
// 开关切设置不得触发 refresh()（那条会连带探账号/拉模型表）。
const persistFlow = app.slice(app.indexOf("$('usagePersistence')?.addEventListener"), app.indexOf('// 手动添加账号'));
assert.ok(persistFlow.includes("api('/usage-persistence'"), '持久化开关切换必须调用自己的 API');
assert.ok(!persistFlow.includes('refresh()'),
  '持久化开关切换不应触发全量 refresh()，也不应打任何上游接口');

// 所有 id 必须唯一，避免重排后 renderStats/renderModels 写入错误节点。
const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
assert.deepEqual([...new Set(duplicates)], [], `页面存在重复 id: ${[...new Set(duplicates)].join(', ')}`);

console.log('web layout contract: pass');
