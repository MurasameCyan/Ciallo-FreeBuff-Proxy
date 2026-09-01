import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const login = readFileSync(new URL('../web/login.js', import.meta.url), 'utf8');

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
  'quotaHead', 'maskEmail',
  'oauthStart', 'loginUrl', 'oauthStatus', 'key-mask', 'models', 'models-empty',
  'modelCount', 'modelRefresh',
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
// 授权是首选路径（点一下就完事），手写 token 是兜底，顺序按这个来。
assert.match(html, /id="pane-add"[\s\S]*id="h-oauth-add">Freebuff 授权[\s\S]*id="h-manual-add">手动添加/s,
  '「添加」分页必须 Freebuff 授权在上、手动添加在下');
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
assert.match(html,
  /<th>账号 [\s\S]*?id="maskEmail"[\s\S]*?<\/th><th>状态<\/th><th>出站节点<\/th><th id="quotaHead">可用模型\(重置时间\)<\/th><th>操作<\/th>/s,
  '账号池必须按账号、状态、出站节点、可用模型、操作排列');
assert.match(html, /id="acctBody"><tr><td colspan="5" class="empty">加载中…<\/td>/,
  '账号池新增出站节点列后，初始空态必须横跨 5 列');
assert.match(html, /id="accountPriorityToggle"[^>]*aria-pressed="true"[^>]*>优先高级<\/button>/s,
  '账号池必须提供默认“优先高级”点击切换按钮');
assert.match(html,
  /id="accountPriorityToggle"[^>]*>优先高级<\/button>\s*<button[^>]*id="accountEgressRefresh"[^>]*>刷新出站<\/button>/s,
  '账号池必须在“优先高级”右侧提供刷新出站按钮');
assert.ok(app.includes('accountSelectionPriority') && app.includes("/proxy/account-priority"),
  '账号优先级按钮必须读取状态并调用专用管理 API');
assert.ok(app.includes("api('/proxy/refresh-egress'"),
  '刷新出站按钮必须调用独立管理 API，不能复用只更新订阅的接口');
assert.match(app, /\$\('accountEgressRefresh'\)[\s\S]{0,160}disabled\s*=\s*!p\.configured\s*\|\|\s*state\s*===\s*'starting'/,
  '未配置订阅或代理启动中时刷新出站按钮必须禁用');
assert.match(css, /\.account-priority-toggle\s*\{[^}]*white-space:\s*nowrap/s,
  '账号优先级按钮必须保持紧凑单行');
assert.match(css, /\.account-egress-refresh\s*\{[^}]*white-space:\s*nowrap/s,
  '刷新出站按钮必须保持紧凑单行');
assert.match(app,
  /const PAUSED_MODEL_IDS = new Set\(\[[\s\S]*?'minimax\/minimax-m3'[\s\S]*?'deepseek\/deepseek-v4-pro'[\s\S]*?'stealth\/ox-alpha'[\s\S]*?\]\)/,
  '暂停模型集合必须包含 M3、D4P 与 Ox Alpha');
assert.match(app, /const HIDDEN_MODEL_IDS = new Set\(\[[\s\S]*?'openai\/gpt-5\.6-luna-es'[\s\S]*?'crof\/kimi-k3-eco'[\s\S]*?\]\)/,
  '面板仍必须过滤 god-only luna-es / K3 Eco，避免旧缓存或 Key 白名单重新显示');
assert.match(app, /function isHiddenModelId\(modelId\)[\s\S]*?value\.startsWith\('crof\/kimi-k3-eco'\)/,
  'god-only K3 Eco 的日期/变体后缀同样要挡住，与 worker.js 保持一致');
assert.match(app, /for \(const id of chosen\) if \(!ids\.includes\(id\) && !isHiddenModelId\(id\)\) ids\.push\(id\)/,
  '旧 Key 白名单里目录已撤下的模型仍必须保留为历史按钮');
assert.match(app, /function quotaRows\(probe\)[\s\S]*?!isPausedModelId\(q\?\.model\)[\s\S]*?!isHiddenModelId\(q\?\.model\)/,
  '账号可用模型列表必须在生成行之前排除暂停模型与 god-only 模型');
assert.ok(app.includes('function poolResetAt') && app.includes('function renderQuotaHead'),
  '重置时间必须提到列标题（池级统一，逐行重复无信息量）');
assert.ok(app.includes('`可用模型 (重置 ${formatResetAt(reset)})`'),
  '列标题必须渲染成“可用模型 (重置 YYYY-MM-DD HH:mm)”');
assert.ok(app.includes('renderQuotaHead()'), 'renderAccounts 必须刷新额度列标题');
assert.ok(!app.includes('quota-reset'), '重置时间已上移列标题，行内不应再有 quota-reset');
assert.ok(!app.includes('tokenShort'),
  '账号面板不得展示或依赖 token 短哈希');
assert.match(app, /const POOL_BADGE_LABELS = \{[\s\S]*?glm_v53_flash: 'G'[\s\S]*?premium: 'P'/s,
  '账号额度必须把 GLM 5.3 Flash 独立池与 Premium 分开聚合');
// 官方 FreebuffSessionRateLimit 对 pool 的要求是「clients must GROUP by it and
// never match on its value, or the next pool needs a release」。之前这里按
// ['glm_v53_flash','premium','limited'] 白名单过滤，任何没登记的池整行被丢掉，
// 账号行只剩 ( P5 )，看起来像独立额度探测失败。
assert.doesNotMatch(app, /\[[^\]]*'glm_v53_flash'[^\]]*\]\.includes\(pool\)/,
  '额度聚合不得用池白名单过滤，未登记的上游池会整行丢失');
assert.match(app, /`\( \$\{parts\.join\(' '\)\} \)`/,
  '账号名后必须紧凑呈现 ( G2 P3 ) 形式的剩余可开会话数');
assert.doesNotMatch(app, /parts\.push\([^)]*\/\$\{row\.limit\}/,
  '徽标只显示剩余，上限只出现在 title 里');
assert.doesNotMatch(app, /function accountUsage\(/,
  '不得再从所有模型行里取一个最大 used/limit 冒充账号总额度');
assert.match(app, /class="acct-usage"/, '账号名后必须有 acct-usage 承载用量');
assert.match(app, /class="quota quota-models"/, '可用模型列必须列出账号可用模型');
assert.match(app, /probe\?\.isolatedPermanent/,
  '无额度表的终态账号必须显式显示永久隔离');
assert.match(app, /永久隔离/,
  '面板必须把 banned/token_invalid 的永久状态与临时隔离区分开');
assert.ok(!/24h 兜底|解封 \$\{|解封至/.test(app),
  '面板不得把官方 terminal 状态描述成本地 24h 解封倒计时');
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

// ── 每账号独立出站节点 ──────────────────────────────────
for (const id of ['accountEgressDialog', 'accountEgressTitle', 'accountEgressAccount',
  'accountEgressModeAuto', 'accountEgressModeManual', 'accountEgressNodeField',
  'accountEgressNode', 'accountEgressStatus', 'accountEgressError',
  'accountEgressCancel', 'accountEgressSave']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `账号出站弹窗丢失 DOM 绑定 #${id}`);
}
assert.match(html, /<dialog class="modal account-egress-modal" id="accountEgressDialog"/,
  '账号出站设置必须使用独立原生 dialog，不与删除确认框复用');
assert.match(html, /id="accountEgressModeAuto"[^>]*aria-pressed="true"[^>]*>自动<\/button>/s,
  '出站弹窗必须提供默认选中的自动模式按钮');
assert.match(html, /id="accountEgressModeManual"[^>]*aria-pressed="false"[^>]*>手动<\/button>/s,
  '出站弹窗必须提供手动模式按钮');
assert.match(html, /id="accountEgressStatus"[^>]*aria-live="polite"/s,
  '自动选点状态必须可被辅助技术播报');
assert.match(html, /id="accountEgressError"[^>]*aria-live="polite"/s,
  '账号出站保存或选点错误必须留在弹窗内并可播报');

assert.match(app, /route:\s*'<[\s\S]*?'/,
  '账号出站操作必须使用统一图标集里的 route 线框图标');
assert.match(app, /iconButton\('route',\s*'设置出站节点',[^\n]*data-egress=/,
  '每个账号必须有纯图标出站设置按钮');
assert.match(app, /S\.readonly\s*\?\s*'disabled'/,
  '账号池只读模式必须禁用出站设置按钮');
assert.ok(app.includes('function normalizeAccountEgress'),
  '账号行和弹窗必须统一读取账号配置与运行态出站状态');
assert.match(app, /S\.accountEgress\s*=\s*acc\.egress\s*\|\|\s*\{\}/,
  'GET /accounts 顶层 egress 状态映射必须随账号列表一起保存');
assert.match(app, /S\.accountEgress\?\.\[account\.key\]/,
  '账号实际节点必须按 account key 从顶层 egress 映射读取');
assert.ok(app.includes('function openAccountEgress'),
  '点击账号出站图标必须打开专用设置弹窗');
assert.ok(app.includes('function fillAccountEgressNodes'),
  '手动节点选项必须来自 GET /_api/proxy 的节点列表');
assert.match(app, /configuredNode[\s\S]*?!nodes\.some\([\s\S]*?unshift/s,
  '手动已配置节点即使不在当前候选列表，也必须保留并显示');
assert.match(app, /api\('\/accounts\/'\s*\+\s*encodeURIComponent\(key\),\s*\{[\s\S]*?method:\s*'PATCH'[\s\S]*?JSON\.stringify\(\{\s*egressMode:\s*mode,\s*egressNode:/s,
  '保存必须 PATCH /_api/accounts/:key，并只提交 egressMode/egressNode');
assert.match(app, /if \(r\?\.egress[\s\S]*?S\.accountEgress\[key\]\s*=\s*r\.egress/,
  'PATCH 成功必须立即用响应里的单账号 egress 状态更新行摘要');
assert.match(app, /let accountEgressSaving\s*=\s*false/,
  '账号出站弹窗必须记录保存中的互斥状态');
assert.match(app, /function openAccountEgress\([^)]*\)\s*\{\s*if \(accountEgressSaving\) return;/,
  '旧账号保存完成前不得为另一个账号重用同一弹窗');
assert.match(app, /accountEgressDialog[\s\S]*?addEventListener\('cancel',[\s\S]*?accountEgressSaving[\s\S]*?preventDefault/s,
  '账号出站保存期间按 Esc 不得关闭弹窗并制造迟到结果竞态');
assert.match(app, /accountEgressSaving\s*=\s*true[\s\S]*?finally\s*\{[\s\S]*?accountEgressSaving\s*=\s*false/s,
  '账号出站保存互斥必须在 finally 中释放');
for (const state of ['ready', 'probing', 'unavailable', 'proxy_offline', 'rejected', 'terminal']) {
  assert.ok(app.includes(`${state}:`), `账号出站状态必须明确处理 ${state}`);
}
// 节点格用行为断言锁死：源码正则只能证明写法，证不出终态号那一格到底显示什么。
// 状态取值走 S.accountEgress[key]，跟 GET /_api/accounts 顶层 egress 映射的线上形状一致。
const egressVm = { globalThis: null };
egressVm.globalThis = egressVm;
vm.runInNewContext(
  'const S = { readonly: false, accountEgress: {} };\n'
  + 'const esc = (value) => String(value);\n'
  + 'const iconSvg = () => "<svg/>";\n'
  + `${app.slice(app.indexOf('function normalizeAccountEgress('), app.indexOf('function proxyNodesForAccount'))}\n`
  + 'globalThis.__egressState = S;\n'
  + 'globalThis.__egressUi = { accountEgressSummary, accountEgressStateLabel };',
  egressVm,
);
const egressCell = (account, runtime = null) => {
  egressVm.__egressState.accountEgress = runtime ? { [account.key]: runtime } : {};
  const cell = egressVm.__egressUi.accountEgressSummary(account);
  return {
    node: cell.match(/account-egress-node mono">([^<]*)</)[1],
    tone: cell.match(/account-egress-summary ([a-z]+)/)[1],
  };
};
assert.deepEqual(
  egressCell({ key: 'a', egressMode: 'auto' }, { state: 'unavailable', currentNode: null }),
  { node: '暂无正常节点', tone: 'error' },
  '自动模式没有实际节点时，行摘要必须显示真实运行态，不能把不可用误写成“选择中”',
);
assert.deepEqual(
  egressCell({ key: 'a', egressMode: 'auto' }, { state: 'ready', currentNode: 'JP-02' }),
  { node: 'JP-02', tone: 'ready' },
  '自动模式选出节点后必须显示实际节点名',
);
// 终态号（封禁/凭据失效/停用）不会再选节点，这一格必须直说原因：自动模式以前落到兜底
// 「等待选择」，用户只能看成一直卡在检查中；手动模式又会把存盘的固定节点显示出来，
// 看着像还在正常出站。原因以前只藏在 title 里（2026-08-29 用户反馈）。
assert.deepEqual(
  egressCell({ key: 'a', egressMode: 'auto' }, {
    state: 'terminal', currentNode: null, error: '已被封禁',
    terminal: { state: 'banned', reason: 'upstream_banned' },
  }),
  { node: '已被封禁', tone: 'error' },
  '终态账号的自动出站必须直说隔离原因，不能显示成“等待选择”这类进行中文案',
);
assert.deepEqual(
  egressCell({ key: 'a', egressMode: 'manual', egressNode: 'HK-01' }, {
    state: 'terminal', configuredNode: 'HK-01', error: '凭据已失效',
    terminal: { state: 'token_invalid', reason: 'token_invalid' },
  }),
  { node: '凭据已失效', tone: 'error' },
  '终态账号的手动出站不得用存盘节点名掩盖隔离状态',
);
assert.equal(egressVm.__egressUi.accountEgressStateLabel('terminal'), '账号已隔离',
  'terminal 必须有专属标签，兜底“等待选择”会把永久隔离说成进行中');
assert.match(app, /account\.egressMode[\s\S]*?account\.egressNode[\s\S]*?currentNode/s,
  '账号出站摘要必须展示配置模式，并优先呈现自动实际节点');
assert.match(css, /\.account-egress-summary\s*\{[^}]*display:\s*grid/s,
  '账号行出站摘要必须紧凑分两行，不能挤占可用模型列');
assert.match(css, /\.account-egress-modal \.modal-box\s*\{[^}]*width:\s*min\(/s,
  '账号出站弹窗必须有稳定的响应式宽度');
// ── 出站摘要行内「重测」按钮 ──────────────────────────────
assert.match(app, /refresh:\s*'<[\s\S]*?'/,
  '行内重测图标必须进统一图标集，不得在渲染处内联散落 svg');
assert.match(app, /iconSvg\('refresh',\s*12\)/,
  '出站摘要的刷新按钮必须复用统一图标集里的 refresh 线框图标');
assert.match(app, /!S\.readonly\s*&&\s*egress\.mode === 'auto'/,
  '只读模式和手动模式都不得渲染行内重测按钮（手动节点是固定的）');
assert.match(app, /data-egress-refresh="\$\{esc\(account\.key\)\}"/,
  '行内重测按钮必须携带账号 key 供事件委托定位');
assert.match(app, /const egressRechecking = new Set\(\)/,
  '轮询会整体重建表格行，重测进行中的转圈态必须用 key 集合跨渲染存活');
assert.match(app, /recheckAccountEgress[\s\S]*?if \(!acct \|\| S\.readonly \|\| egressRechecking\.has\(key\)\) return;/,
  '同一账号的重测请求必须互斥，连点不得叠加上游探测');
assert.match(app,
  /recheckAccountEgress[\s\S]*?method:\s*'PATCH'[\s\S]*?JSON\.stringify\(\{\s*egressMode:\s*'auto',\s*egressNode:\s*''\s*\}\)/s,
  '行内重测必须走弹窗保存同款 PATCH（服务端对 auto 强制重选节点），不得另开接口');
assert.match(app, /if \(r\?\.egress\) S\.accountEgress\[key\] = r\.egress/,
  '重测成功必须立即用响应里的单账号 egress 状态回填，不等下一拍轮询');
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
assert.doesNotMatch(app, /FREEBUFF_REFERRAL_URL/,
  '授权流程不得保留推广链接配置');
const oauthClick = app.slice(
  app.indexOf("$('oauthStart').addEventListener"),
  app.indexOf('// 复制授权链接'),
);
assert.match(oauthClick, /loginUrlOpen[\s\S]*?window\.open\(j\.loginUrl, '_blank', 'noopener,noreferrer'\)/s,
  '正式授权必须原样打开上游一次性 loginUrl，不能把推广参数拼进去');
assert.doesNotMatch(oauthClick, /window\.open\([^)]*(?:REFERRAL|freebuff\.com\/\?ref=)/i,
  '开始授权不得在正式 loginUrl 之前预打开推广页');
assert.doesNotMatch(oauthClick, /new URL\(j\.loginUrl\)|j\.loginUrl\s*[+]\s*|searchParams\.set\(['"]ref/s,
  '不得改写 fingerprint 绑定的一次性授权 URL');

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
// 两个按钮动的是主 Key，不是分享 Key —— 文案必须写明 Master，否则跟下面的「新建 Key」混
assert.match(html, /data-copy-key>复制 Master Key<\/button>/, '复制按钮必须点明是 Master Key');
assert.match(html, /data-reset-key>重置 Master Key<\/button>/, '重置按钮必须点明是 Master Key');
assert.match(app, /title: '重置 Master Key',\s*\n\s*text: '重置后旧 Master Key 立即失效[^']*分享 Key 不受影响/,
  '重置确认框必须同样说 Master Key，并交代分享 Key 不受影响');
assert.match(html,
  /class="model-workspace-grid"[\s\S]*class="alias-editor"[\s\S]*class="model-catalog"/s,
  '模型配置内部顺序必须为模型映射 | 模型列表');
assert.match(html, /id="h-model-workspace">模型与 Key<\/h2>/,
  '模型卡标题必须是“模型与 Key”（同卡两页：模型与映射 | Key 管理）');
assert.match(html, /<h3 id="h-models">模型列表<\/h3>/,
  '右侧子卡标题必须是“模型列表”（原“可用模型”）');
assert.match(html,
  /id="modelRefresh"[^>]*title="获取最新模型列表"[^>]*aria-label="获取最新模型列表"/,
  '模型列表必须提供带可访问名称的独立刷新按钮');
assert.match(html, /id="modelRefresh"[\s\S]*?refresh/s,
  '模型列表刷新按钮必须使用刷新图标');
assert.match(app,
  /modelRefresh[\s\S]*?rawApi\('\/v1\/models\?refresh=1'/s,
  '模型列表刷新按钮必须请求无 session 的强制模型目录接口');
const modelRefreshStart = app.indexOf("$('modelRefresh')", app.indexOf('function wire()'));
const modelRefreshFlow = app.slice(modelRefreshStart, app.indexOf("$('maskEmail')", modelRefreshStart));
assert.ok(modelRefreshFlow.includes('S.models = models.data || []'),
  '模型列表刷新成功后必须更新前端模型状态');
assert.ok(modelRefreshFlow.includes('renderModels()') && modelRefreshFlow.includes('renderKeys()'),
  '模型列表刷新成功后必须同步模型目录和 Key 模型选择');
assert.ok(modelRefreshFlow.includes('syncColumnBottoms()'),
  '模型数量变化后必须重算两列高度，不能保留旧布局上限');
assert.ok(modelRefreshFlow.includes('models.refresh?.updated')
  && modelRefreshFlow.includes('未能获取最新模型，已保留当前列表'),
  '模型目录源全部失败时必须明确提示使用旧列表，不能误报刷新成功');
assert.ok(!modelRefreshFlow.includes("refresh()") && !modelRefreshFlow.includes("api('/accounts')")
  && !modelRefreshFlow.includes("api('/proxy')"),
  '模型列表刷新不得触发账号探测或完整 refresh()');
assert.match(html,
  /class="tbl key-table"[\s\S]*?<thead><tr><th>备注<\/th><th>Key<\/th><th>并发<\/th><th>会话<\/th><th>今日 \/ 累计<\/th><th>统计<\/th><th>可用模型<\/th><th class="action-col">操作<\/th><\/tr><\/thead>/s,
  '分享 Key 表格必须按 会话 → 今日 / 累计 → 统计 排列，再显示可用模型');
assert.match(html, /id="keyBody"><tr><td colspan="8" class="empty">/,
  '分享 Key 空态必须覆盖新增后的 8 列');
assert.match(app, /<td class="mono" title="历史累计 token \$\{esc\(fmtCount\(st\.totalTokens \|\| 0\)\)\}">\$\{fmtTokens\(st\.totalTokens \|\| 0\)\}<\/td>/,
  '分享 Key 的统计列必须显示该 Key 历史累计 token，并在悬停里给出精确值（列头只有“统计”两个字，不写明就看不出是 token）');
assert.match(app, /\/ \$\{fmtCount\(st\.total \|\| 0\)\}\$\{running\}<\/td>\s*\n\s*<td class="mono" title="历史累计 token/,
  '统计列必须紧跟在今日 \/ 累计右侧');
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
assert.match(css, /\.model-catalog \.models\s*\{[^}]*align-content:\s*start/s,
  '模型列表被 flex 拉高时，自动行必须紧贴顶部，不能均分剩余高度拉大行距');
assert.match(css, /\.model-catalog \.models\s*\{[^}]*grid-auto-rows:\s*max-content/s,
  '模型列表隐式行必须按内容高度，不能被卡片剩余高度拉伸');
assert.match(css, /\.model-catalog \.models\s*\{[^}]*row-gap:\s*3px/s,
  '模型列表纵向间距必须固定为紧凑的 3px，不能被通用 gap 或 flex 剩余高度放大');
assert.match(css, /\.model-catalog \.models li\s*\{[^}]*width:\s*fit-content/s,
  '模型列表条目不应横向拉伸并留下空白');
assert.ok(!html.includes('model-availability-note'),
  'D4P 已暂停，模型列表不得再显示过期的时段说明');
assert.ok(!html.includes('08:00–18:00') && !html.includes('UTC 00:00–10:00'),
  '已失效的 D4P 可用时段文案必须删除');
assert.match(app, /MODEL_TIER_LABELS = \{ free: '免费', us_sg: '高级', limited: '限定' \}/,
  '模型列表的通用分组 tag 文案必须是 免费 / 高级 / 限定');
for (const [id, label] of [
  ['openai/gpt-5.6-luna', '高级'],
  ['deepseek/deepseek-v4-pro', '停用'],
  ['stealth/ox-alpha', '停用'],
  ['deepseek/deepseek-v4-flash', '免费'],
  ['minimax/minimax-m3', '停用'],
  ['crof/kimi-k3-eco', '高级'],
  ['meta/muse-spark-1.2-contributor', '高级'],
  ['mimo/mimo-v2.5', '免费'],
  ['z-ai/glm-5.2', '限定'],
  ['z-ai/glm-5.3-flash', 'GLM'],
  ['anthropic/claude-fable-5', '限定'],
]) {
  assert.ok(app.includes(`'${id}': { label: '${label}'`), `${id} 必须显示标签 ${label}`);
}
assert.match(app, /function modelDisplay\(/,
  '模型目录、Key 选择按钮和 Key 表格必须复用统一展示映射');
assert.match(app, /fillKeyModelButtons[\s\S]*?modelDisplay\(/s,
  'Key 模型按钮必须使用统一标签展示');
assert.match(app, /function renderKeys\(\)[\s\S]*?modelListHtml\(/s,
  'Key 表格的可用模型必须使用统一标签展示');
assert.match(app, /function renderModels\(\)[\s\S]*?modelDisplay\(/s,
  '模型列表必须使用统一标签展示');
assert.match(app, /function renderModels\(\)[\s\S]*?li\.textContent = name/s,
  '模型列表条目必须只显示模型名（去掉 provider 前缀）');
assert.match(app, /fillKeyModelButtons[\s\S]*?title="\$\{esc\(id\)\}">\$\{esc\(name\)\}/s,
  'Key 模型按钮必须只显示模型名，完整 id 留在 title');
assert.match(app, /PAUSED_MODEL_IDS[\s\S]*?fillKeyModelButtons[\s\S]*?disabled aria-disabled="true"/s,
  'Key 模型列表必须展示暂停模型，但不得允许新 Key 选择它们');
assert.match(app, /function fillKeyModelButtons[\s\S]*?const paused = isPausedModelId\(id\)/s,
  'Key 模型按钮必须用统一暂停判定，日期快照变体也要禁用');
assert.match(app, /keyEditingPausedModels = Array\.isArray\(k\.models\)[\s\S]*?isPausedModelId\(model\)/s,
  '编辑旧 Key 时日期快照变体必须进入暂停白名单保留路径');
assert.match(app, /function selectedKeyModels\(\)[\s\S]*?\.filter\(Boolean\)/s,
  '编辑旧 Key 时必须保留已暂停模型白名单，不能静默丢失');
assert.match(css, /\.pill\.tier-glm_v53_flash\s*\{[^}]*color:/s,
  'GLM 5.3 Flash 独立 tag 必须有专用样式');
assert.doesNotMatch(css, /\.pill\.cap\s*\{/s,
  '独立 cap 不再渲染成徽标，样式必须一起删掉');
// 上游 rateLimitsByModel 每个模型只给一行（「下一次准入记到哪个池」），cap 未触顶时
// 那行就是共享池，独立 cap 的已用次数根本不在 wire 上：既算不出剩余，也没必要把上限
// 再说一遍——账号名后的额度徽标已经给过这个数字了。
assert.doesNotMatch(app, /上限 \$\{[^}]*\}\/日/s,
  '模型行不得再渲染「上限 N/日」注记：账号名后的额度徽标已经给过这个数字');
assert.doesNotMatch(app, /function perModelCapLimit[\s\S]*?limit\s*-\s*(?:used|row\.used|recentCount)/s,
  '独立 cap 不得推算剩余次数：上游不下发这一层的已用计数');

const helperSource = `const S = { models: [], health: {} };\nconst esc = (value) => String(value);\n${app.match(/const MODEL_TIER_LABELS = \{[^\n]+/)[0]}\n`
  + `${app.slice(app.indexOf('const MODEL_DISPLAY ='), app.indexOf('function poolResetAt'))}\n`
  + 'globalThis.__modelState = S;\n'
  + 'globalThis.__modelUi = { accountQuotaSummary, modelName, modelDisplay, modelListHtml, perModelCapLimit, modelsCellHtml };';
const helperVm = { globalThis: null };
helperVm.globalThis = helperVm;
vm.runInNewContext(helperSource, helperVm);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'z-ai/glm-5.3-flash', used: 0, limit: 2, pool: 'glm_v53_flash' },
    { model: 'openai/gpt-5.6-luna', used: 2, limit: 5, pool: 'premium' },
    { model: 'deepseek/deepseek-v4-flash', used: 3, limit: 5, pool: 'premium' },
    { model: 'meta/muse-spark-1.2-contributor', used: 3, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( G2 P2 )', title: '额度 G 剩 2 / 已用 0 / 上限 2 · P 剩 2 / 已用 3 / 上限 5' },
  'G/P 摘要必须按 pool 去重，GLM 独立池与 Premium 并列且 Premium 多模型行只显示一个 P',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'openai/gpt-5.6-luna', used: 1, limit: 4, pool: 'luna' },
    { model: 'deepseek/deepseek-v4-flash', used: 1, limit: 4, pool: 'premium' },
  ] }))),
  { text: '( P3 )', title: '额度 P 剩 3 / 已用 1 / 上限 4' },
  '旧 luna pool 必须兼容归并到 Premium，不能继续显示独立 L 或重复计数',
);
// Premium 同池多行必须保守合并，Luna 没有独立池。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: null, limit: 7, pool: 'premium' },
    { model: 'openai/gpt-5.6-luna', used: 2, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( P3 )', title: '额度 P 剩 3 / 已用 2 / 上限 5' },
  'Premium 行异常不一致时必须保守取最小 limit，并优先显示已知 used',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: 0, limit: 0, pool: 'premium' },
    { model: 'openai/gpt-5.6-luna', used: 2, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( P0 )', title: '额度 P 剩 0 / 已用 2 / 上限 0' },
  'Premium 同池出现 0 与正数冲突时，UI 必须与 worker 一样保守，不能丢掉 0 后显示 P5',
);
// GLM 5.3 独立池打满，Premium 池按半次计费出现小数。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'z-ai/glm-5.3-flash', used: 2, limit: 2, pool: 'glm_v53_flash' },
    { model: 'deepseek/deepseek-v4-flash', used: 2.5, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( G0 P2.5 )', title: '额度 G 剩 0 / 已用 2 / 上限 2 · P 剩 2.5 / 已用 2.5 / 上限 5' },
  '打满的池必须显示剩余 0，小数用量不得被取整',
);
// 2026-08-23 线上实测：premium limit 5 / used 3.7 直接相减是 1.2999999999999998，
// 徽标必须按 0.1 粒度归整，否则账号行会甩出一串浮点渣。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'openai/gpt-5.6-luna', used: 3.7, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( P1.3 )', title: '额度 P 剩 1.3 / 已用 3.7 / 上限 5' },
  '小数剩余必须归整到 0.1，不能出现 1.2999999999999998',
);
// accessTier=limited 的号只有 pool="limited"（poolLabel Daily，只覆盖 flash/mimo）。
// 不认这个池会让这类账号整行没有剩余数字，看着像探测失败。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: 0.2, limit: 6, pool: 'limited' },
    { model: 'mimo/mimo-v2.5', used: 0.2, limit: 6, pool: 'limited' },
    { model: 'z-ai/glm-5.2', used: 0, limit: 0, pool: 'glm' },
  ] }))),
  { text: '( Ltd5.8 )', title: '额度 Ltd 剩 5.8 / 已用 0.2 / 上限 6' },
  'limited 档账号必须显示 Daily 池剩余，不能整行空白',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: null, limit: 5, pool: 'premium' },
  ] }))),
  { text: '( P? )', title: '额度 P 剩 — / 已用 — / 上限 5' },
  '已用未知时不得把剩余猜成满额',
);
// god-only（官方 FREEBUFF_WEB_GOD_ONLY_MODELS）行必须整行丢掉：普通账号一定调不通，
// 把它算进 premium 摘要只会让面板显示一个永远用不到的额度。
assert.equal(
  helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'crof/kimi-k3-eco', used: 0, limit: 9, pool: 'premium' },
  ] }),
  null,
  'god-only K3 Eco 不得单独撑起 Premium 摘要',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: 1, limit: 4, pool: 'premium' },
    { model: 'crof/kimi-k3-eco', used: 3, limit: 9, pool: 'premium' },
  ] }))),
  { text: '( P3 )', title: '额度 P 剩 3 / 已用 1 / 上限 4' },
  'god-only 行不得参与同池保守取值，否则会污染真实 Premium 数字',
);
assert.equal(
  helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'minimax/minimax-m3', used: 0, limit: 99, pool: 'premium' },
    { model: 'deepseek/deepseek-v4-pro', used: 0, limit: 99, pool: 'premium' },
    { model: 'stealth/ox-alpha', used: 0, limit: 99, pool: 'premium' },
  ] }),
  null,
  '暂停模型的残留额度行不得生成 P 摘要',
);
helperVm.__modelState.models = [{ id: 'z-ai/glm-5.3-flash', pool: 'glm_v53_flash' }];
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'z-ai/glm-5.3-flash', used: 0, limit: 2 },
  ] }))),
  { text: '( G2 )', title: '额度 G 剩 2 / 已用 0 / 上限 2' },
  '账号行缺少 pool 时必须使用模型目录的 GLM 5.3 独立池',
);
assert.match(
  helperVm.__modelUi.modelListHtml(
    ['z-ai/glm-5.3-flash'],
    [{ id: 'z-ai/glm-5.3-flash' }],
  ),
  /tier-glm_v53_flash">GLM<\/span>/,
  '账号行缺少 pool 时必须回退模型目录的 GLM 标签',
);

// ── 独立额度不得因为池名不在白名单里被整行丢掉 ─────────────────────
// 现网实测：账号行显示 ( P5 )，GLM 5.3 Flash 的 2 次/日独立额度完全不出现。
// 原因不在 worker（目录解析出的 pool 就是 glm_v53_flash），而在面板：
// accountQuotaSummary 曾用 ['glm_v53_flash','premium','limited'] 白名单过滤，
// 池名一旦落在名单外（目录把 5.3 归进 GLM 集合 → pool='glm'）整行被 continue 掉。
// 官方 FreebuffSessionRateLimit 明确要求 pool 按不透明 token 分组、不得按值匹配。
helperVm.__modelState.models = [{ id: 'z-ai/glm-5.3-flash', pool: 'glm' }];
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'z-ai/glm-5.3-flash', used: 0, limit: 2 },
    { model: 'deepseek/deepseek-v4-flash', used: 0, limit: 5, pool: 'premium' },
  ] }))),
  {
    text: '( P5 G52:2 )',
    title: '额度 P 剩 5 / 已用 0 / 上限 5 · G52 剩 2 / 已用 0 / 上限 2',
  },
  '池名不在已知短名表里也必须出徽标，不能只剩 ( P5 ) 让独立额度看起来没探到',
);
// 不透明 token：上游改名/新增池都不该需要发面板版本。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: 0, limit: 5, pool: 'premium' },
    {
      model: 'z-ai/glm-5.3-flash',
      used: 0.5,
      limit: 2,
      pool: 'glm_v53_flash_v2',
      poolLabel: 'GLM 5.3 Flash',
    },
  ] }))),
  {
    text: '( P5 glmv53:1.5 )',
    title: '额度 P 剩 5 / 已用 0 / 上限 5 · glmv53(GLM 5.3 Flash) 剩 1.5 / 已用 0.5 / 上限 2',
  },
  '全新池 token 必须照样显示，并把上游 poolLabel 带进 title',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'vendor/a', used: 1, limit: 5, pool: 'Pool-A' },
    { model: 'vendor/b', used: 0, limit: 8, pool: 'pool-a' },
  ] }))),
  {
    text: '( PoolA4 poola8 )',
    title: '额度 PoolA 剩 4 / 已用 1 / 上限 5 · poola 剩 8 / 已用 0 / 上限 8',
  },
  'opaque pool token 必须按精确值分组，大小写不同的 token 不能合并',
);
// 多字符短名和数字之间必须有分隔：G52 + 2 不能连成看不懂的 G522。
helperVm.__modelState.models = [];
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'z-ai/glm-5.2', used: 1, limit: 3, pool: 'glm', poolLabel: 'GLM 5.2' },
  ] }))),
  { text: '( G52:2 )', title: '额度 G52(GLM 5.2) 剩 2 / 已用 1 / 上限 3' },
  '多字符池短名必须与数字分隔，否则 G52 剩 2 会显示成 G522',
);
// 0/0 = 该池未解锁（没拿到 referral 的 glm-5.2），与「解锁了但打满」不同：
// 前者不出徽标，后者必须显示成 0。
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.accountQuotaSummary({ quota: [
    { model: 'deepseek/deepseek-v4-flash', used: 0, limit: 5, pool: 'premium' },
    { model: 'z-ai/glm-5.2', used: 0, limit: 0, pool: 'glm' },
  ] }))),
  { text: '( P5 )', title: '额度 P 剩 5 / 已用 0 / 上限 5' },
  '整池 0/0 的未解锁池不得多出一个永远是 0 的徽标',
);

// ── 独立 cap：只用来判断该不该补出模型行，不渲染任何文字 ──────────────
// 上游 rateLimitsByModel 每个模型只给一行，报的是「下一次准入会记到哪个池」：
// GLM 5.3 Flash 的 cap 没触顶时那行就是共享池 premium 5 次，独立 cap 的已用次数
// 根本不在 wire 上，所以剩余算不出来；而上限已经由账号名后的额度徽标给过（G2），
// 模型行再挂一个「上限 2/日」是同一件事说两遍。
helperVm.__modelState.models = [{
  id: 'z-ai/glm-5.3-flash',
  pool: 'glm_v53_flash',
  perModelCap: { limit: 2, poolLabel: 'GLM 5.3 Flash' },
}];
assert.equal(helperVm.__modelUi.perModelCapLimit('z-ai/glm-5.3-flash'), 2,
  '有独立 cap 的模型必须回上限数字，供补行判断使用');
assert.equal(helperVm.__modelUi.perModelCapLimit('openai/gpt-5.6-luna'), 0,
  '没有独立 cap 的模型必须回 0');
assert.equal(helperVm.__modelUi.perModelCapLimit('vendor/unknown'), 0,
  '目录里没有的模型必须回 0');
helperVm.__modelState.models = [
  {
    id: 'z-ai/glm-5.3-flash',
    pool: 'glm_v53_flash',
    sharedPool: 'premium',
    perModelCap: { limit: 2, poolLabel: 'GLM 5.3 Flash' },
  },
  { id: 'openai/gpt-5.6-luna', pool: 'premium' },
];
const capCell = helperVm.__modelUi.modelsCellHtml({ quota: [
  { model: 'openai/gpt-5.6-luna', used: 0, limit: 5, pool: 'premium' },
] });
assert.match(capCell, /glm-5\.3-flash/,
  '上游没有 GLM quota 行时，也必须用共享 Premium 行补出目录中带独立 cap 的模型');
assert.doesNotMatch(capCell, /上限/,
  '补出的模型行不得再挂「上限 N/日」：账号名后的额度徽标已经给过这个数字');
assert.doesNotMatch(
  helperVm.__modelUi.modelsCellHtml({ quota: [
    { model: 'z-ai/glm-5.3-flash', used: 0, limit: 0, pool: 'glm_v53_flash' },
    { model: 'openai/gpt-5.6-luna', used: 0, limit: 5, pool: 'premium' },
  ] }),
  /glm-5\.3-flash/,
  '上游明确返回 GLM 0/0 时表示未解锁，不得按缺行重新补出独立 cap',
);
helperVm.__modelState.models = [{ id: 'z-ai/glm-5.3-flash', perModelCap: { limit: 0 } }];
assert.equal(helperVm.__modelUi.perModelCapLimit('z-ai/glm-5.3-flash'), 0,
  'limit<=0 的畸形 cap 必须当作没有 cap，不能拿去补行');
helperVm.__modelState.models = [];
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('minimax/minimax-m3'))),
  { id: 'minimax/minimax-m3', name: 'minimax-m3', tierKey: 'paused', tier: '停用' },
  'M3 在模型与 Key 展示中必须标为停用',
);
for (const id of ['deepseek/deepseek-v4-pro', 'stealth/ox-alpha']) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay(id, { pool: 'premium' }))),
    { id, name: id.slice(id.lastIndexOf('/') + 1), tierKey: 'paused', tier: '停用' },
    `${id} 即使旧快照仍带 pool，也必须优先显示停用`,
  );
}
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('deepseek/deepseek-v4-pro-20260827'))),
  {
    id: 'deepseek/deepseek-v4-pro-20260827',
    name: 'deepseek-v4-pro-20260827',
    tierKey: 'paused',
    tier: '停用',
  },
  'D4P 日期快照变体必须继承暂停状态',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay(
    'deepseek/deepseek-v4-pro-max', { pool: 'premium' },
  ))),
  {
    id: 'deepseek/deepseek-v4-pro-max',
    name: 'deepseek-v4-pro-max',
    tierKey: 'premium',
    tier: '高级',
  },
  '非日期后缀 deepseek-v4-pro-max 不得被暂停规则误伤',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('deepseek/deepseek-v4-flash'))),
  { id: 'deepseek/deepseek-v4-flash', name: 'deepseek-v4-flash', tierKey: 'free', tier: '免费' },
  'DS4F 必须去掉 provider 前缀，只保留模型名 + 免费标签',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('anthropic/claude-fable-5', { pool: 'standard' }))),
  { id: 'anthropic/claude-fable-5', name: 'claude-fable-5', tierKey: 'limited', tier: '限定' },
  'Fable 的 standard 兼容池不能覆盖限定标签',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('openai/gpt-5.6-luna', { pool: 'premium' }))),
  { id: 'openai/gpt-5.6-luna', name: 'gpt-5.6-luna', tierKey: 'premium', tier: '高级' },
  'Luna 计入共享 Premium 时必须显示高级',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('openai/gpt-5.6-luna', { pool: 'luna' }))),
  { id: 'openai/gpt-5.6-luna', name: 'gpt-5.6-luna', tierKey: 'premium', tier: '高级' },
  '旧 Luna 独立池数据必须兼容显示为 Premium 高级，不得再显示 Luna tag',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('z-ai/glm-5.3-flash', { pool: 'glm_v53_flash' }))),
  { id: 'z-ai/glm-5.3-flash', name: 'glm-5.3-flash', tierKey: 'glm_v53_flash', tier: 'GLM' },
  'GLM 5.3 Flash 有独立池时必须显示 GLM tag',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('vendor/new-model', { pool: 'preview_pool' }))),
  { id: 'vendor/new-model', name: 'new-model', tierKey: 'pool-other', tier: 'preview_pool' },
  '未知 pool 必须原样显示且使用通用配色，不能猜成高级池',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay('z-ai/glm-5.3-flash', { pool: 'preview_pool' }))),
  { id: 'z-ai/glm-5.3-flash', name: 'glm-5.3-flash', tierKey: 'glm_v53_flash', tier: 'GLM' },
  'GLM 5.3 的固定独立额度 tag 不得被目录中的旧 pool 声明覆盖',
);
assert.match(app, /function modelsCellHtml[\s\S]*?modelListHtml\(\[q\.model\], \[q\]\)/s,
  '账号可用模型必须把实时额度行传给统一 Tag 解析器');
assert.match(
  helperVm.__modelUi.modelListHtml(
    ['z-ai/glm-5.3-flash'],
    [{ id: 'z-ai/glm-5.3-flash', pool: 'glm_v53_flash' }],
  ),
  /tier-glm_v53_flash">GLM<\/span>/,
  '账号额度行 pool=glm_v53_flash 时必须显示 GLM',
);
helperVm.__modelState.models = [{ id: 'z-ai/glm-5.3-flash', pool: 'premium' }];
assert.match(
  helperVm.__modelUi.modelListHtml(
    ['z-ai/glm-5.3-flash'],
    [{ model: 'z-ai/glm-5.3-flash', pool: 'glm_v53_flash', limit: 2 }],
  ),
  /tier-glm_v53_flash">GLM<\/span>/,
  '账号额度行必须优先于模型目录 pool，不能把 GLM 独立池错标为 Premium',
);
helperVm.__modelState.models = [
  { id: 'z-ai/glm-5.3-flash', pool: 'premium', tier: 'us_sg' },
  { id: 'openai/gpt-5.6-luna', pool: 'premium', tier: 'us_sg' },
];
helperVm.__modelState.health = {
  account: { quota: [
    { model: 'z-ai/glm-5.3-flash', pool: 'glm_v53_flash', limit: 2 },
    { model: 'openai/gpt-5.6-luna', pool: 'luna', limit: 2 },
  ] },
};
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay(
    'z-ai/glm-5.3-flash', helperVm.__modelState.models[0],
  ))),
  { id: 'z-ai/glm-5.3-flash', name: 'glm-5.3-flash', tierKey: 'glm_v53_flash', tier: 'GLM' },
  '全局模型列表必须根据账号额度表识别 GLM 5.3 独立池',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(helperVm.__modelUi.modelDisplay(
    'openai/gpt-5.6-luna', helperVm.__modelState.models[1],
  ))),
  { id: 'openai/gpt-5.6-luna', name: 'gpt-5.6-luna', tierKey: 'premium', tier: '高级' },
  '全局模型列表必须把旧 Luna pool 兼容归入 Premium',
);
helperVm.__modelState.health = {};
assert.ok(!helperVm.__modelUi.modelListHtml(['openai/gpt-5.6-luna-es']),
  'Luna-ES 必须从面板模型标签和可用模型列表隐藏');
assert.equal(
  helperVm.__modelUi.modelListHtml(
    ['openai/gpt-5.6-luna'],
    [{ id: 'openai/gpt-5.6-luna', pool: 'luna' }],
  ),
  '<span class="model-label" title="openai/gpt-5.6-luna">gpt-5.6-luna'
  + ' <span class="pill tier tier-premium">高级</span></span>',
  '旧 Luna pool 必须显示模型名 + 高级 tag',
);
assert.match(helperVm.__modelUi.modelListHtml(
  ['z-ai/glm-5.3-flash'],
  [{ id: 'z-ai/glm-5.3-flash', pool: 'glm_v53_flash' }],
),
  /">glm-5\.3-flash <span class="pill tier tier-glm_v53_flash">GLM<\/span>/,
  'GLM 独立池必须显示去 provider 的模型名 + GLM tag');
assert.match(helperVm.__modelUi.modelListHtml(['mimo/mimo-v2.5']),
  /">mimo-v2\.5 <span class="pill tier tier-free">免费<\/span>/,
  'MiMo 的免费标签必须使用 free 配色');
assert.match(helperVm.__modelUi.modelListHtml(['z-ai/glm-5.2']),
  /">glm-5\.2 <span class="pill tier tier-limited">限定<\/span>/,
  'GLM 的限定标签必须使用 limited 配色');
assert.equal(helperVm.__modelUi.modelName('crof/kimi-k3-eco'), 'kimi-k3-eco',
  '统一模型名称函数必须去掉供应商前缀');
assert.ok(!/short:\s*'/.test(app.slice(app.indexOf('const MODEL_DISPLAY ='), app.indexOf('function modelsCellHtml'))),
  '模型展示不得再保留短名映射');
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

// 账号列的邮箱去敏：表头一只眼睛切整列，去敏后连长度都不能泄。
assert.match(html, /<th>账号 <button type="button" class="mask-toggle" id="maskEmail" aria-pressed="true"><\/button><\/th>/,
  '去敏开关必须在账号列表头、账号二字右侧（图标由 JS 填，初始为已按下）');
assert.match(app, /maskEmail: true,/, '邮箱去敏必须默认开着：默认漏了才是问题，多点一下不是');
assert.match(app, /function maskEmail\(s\)[\s\S]*?if \(!S\.maskEmail\) return text;[\s\S]*?domain\.lastIndexOf\('\.'\)[\s\S]*?\*\*\*@\*\*\*\$\{dot > 0 \? domain\.slice\(dot\) : ''\}/s,
  '去敏后域名只能留最后一段：取 lastIndexOf 而不是第一个点，否则子域全露出来');
// 纯字符串逻辑，静态断言看不出「两个字的邮箱名会不会整个露出来」——把函数抠出来真跑一遍。
{
  const src = app.slice(app.indexOf('function maskEmail(s)'), app.indexOf('// 表头那只眼睛'));
  const build = (on) => new Function('S', `${src}; return maskEmail;`)({ maskEmail: on });
  const mask = build(true);
  assert.equal(mask('henryhall9920@do-ge.v0n0v.eu.cc'), 'he***@***.cc', '多级子域只留一级域名');
  assert.equal(mask('hello@freebuff.cc'), 'he***@***.cc', '本地部分留 2 位，域名只剩一级域名');
  assert.equal(mask('ab@qq.com'), 'a***@***.com', '本地部分 ≤3 位时只留 1 位，否则等于没去敏');
  assert.equal(mask('alice.wang@gmail.com'), 'al***@***.com', '星号定长，不透露长度');
  assert.equal(mask('bob@outlook.co.uk'), 'b***@***.uk', '.co.uk 也只留最后一段');
  assert.equal(mask('dev@localhost'), 'd***@***', '没有点的域名整段抹掉');
  assert.equal(mask('小明'), '小明', '备注名不含 @ 就原样显示');
  assert.equal(mask(null), '', '空值要渲染成空串而不是 "null"');
  assert.equal(build(false)('alice.wang@gmail.com'), 'alice.wang@gmail.com', '关掉去敏必须原样显示');
}
assert.match(app, /<div class="nm">\$\{esc\(maskEmail\(label\)\)\}[\s\S]*?<div class="mono">\$\{esc\(maskEmail\(secondary\)\)\}/s,
  '账号行主次两行都要过去敏，否则没备注名的账号仍露出完整邮箱');
assert.match(app, /确认删除「\$\{maskEmail\(label\)\}」/, '删除确认框也不能把去敏掉的邮箱抖出来');
assert.match(app, /\$\('maskEmail'\)\?\.addEventListener\('click', \(\) => \{\s*\n\s*S\.maskEmail = !S\.maskEmail;\s*\n\s*renderAccounts\(\);/,
  '去敏开关是静态按钮：监听只挂一次，切换只重渲染不重新拉数据');
assert.match(app, /function renderMaskToggle\(\)[\s\S]*?iconSvg\(S\.maskEmail \? 'eyeOff' : 'eye'[\s\S]*?aria-pressed[\s\S]*?aria-label/s,
  '眼睛图标必须随状态换形并同步 aria-pressed / aria-label');
assert.match(css, /\.mask-toggle\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s,
  '去敏开关必须是不撑高表头的小方块');
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

// 时间下方的详情行：User 与 Token 同行；分享 Key 显示备注名，主 Key 固定写 Master Key。
assert.match(app, /user\.textContent = `User: \$\{r\.key === S\.ownerName \? 'Master Key' : r\.key\}`/,
  'User 行必须把主 Key 显示成 Master Key，并把分享 Key 显示成其备注名');
assert.ok(app.includes('calllog-user'), 'User 行必须用 .calllog-user 承载');
assert.match(app, /sub\.append\(user, token\)/,
  'User 与 Token 必须追加到同一个详情行');
assert.match(app, /li\.append\(main, sub\)/,
  '调用日志明细必须只有时间主行和 User\/Token 详情行');
assert.ok(!app.includes('li.append(main, user, sub)'),
  '调用日志不得继续渲染时间、User、Token 三行');
assert.ok(!/sub\.textContent \+= ` · Key /.test(app),
  '行尾的「· Key xxx」必须并入 User 行，不得重复出现');

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
assert.match(css, /\.calllog-row \.sub\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/s,
  'User 与 Token 详情必须使用不换行的同一 flex 行');
assert.match(css, /\.calllog-row \.calllog-user\s*\{[^}]*margin-right:\s*auto/s,
  'User 必须在详情行左侧，Token 保持右侧');
assert.match(css, /\.calllog-row \.calllog-token\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s,
  '窄屏时 Token 必须可收缩并省略，不能水平溢出卡片');
assert.match(app, /user\.title = user\.textContent[\s\S]*token\.title = token\.textContent/s,
  'User 或 Token 被省略时必须通过 title 保留完整内容');

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
assert.match(app, /function renderUsageModels\(\)[\s\S]*?modelName\(r\.key\)/s,
  '概况模型统计必须去掉 provider 前缀，只显示模型名称');
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
  /<label class="switch usage-persistence-toggle" title="持久化概况统计（Key 统计始终保存）">[\s\S]*?<input type="checkbox" id="usagePersistence">[\s\S]*?<span class="switch-track"[\s\S]*?<span class="sr-only">持久化概况统计（Key 统计始终保存，默认关闭）<\/span>/s,
  '概况标题右侧必须有无文字胶囊开关，并说明 Key 统计始终保存');
// 开关必须落在概况卡 .card-head 内（标题之后），不是卡别处。
const usageHead = html.slice(html.indexOf('<div class="card-head">', html.indexOf('id="usageCard"')), html.indexOf('<div class="usage-grid">'));
assert.match(usageHead, /id="usagePersistence"/, '持久化开关必须位于概况卡 card-head 内');
// 可见文字只有 sr-only 的可访问名：label 里除 sr-only 外不应有文字节点承载说明。
assert.ok(html.includes('持久化概况统计（Key 统计始终保存，默认关闭）'),
  '开关悬停提示与无障碍名必须说明 Key 统计始终保存');
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

// ── 页内确认框（取代浏览器原生弹窗） ────────────────────
for (const id of ['confirmDialog', 'confirmTitle', 'confirmText', 'confirmOk']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `确认框丢失 DOM 绑定 #${id}`);
}
assert.match(html, /<dialog class="modal" id="confirmDialog"[\s\S]*?<form method="dialog"/s,
  '确认框必须是原生 <dialog> + method="dialog" 的表单（Esc/焦点圈定/遮罩交给浏览器）');
const confirmStart = html.indexOf('<dialog class="modal" id="confirmDialog"');
const confirmBox = html.slice(confirmStart, html.indexOf('</dialog>', confirmStart));
assert.match(confirmBox, /value=""[^>]*>取消[\s\S]*value="ok"[\s\S]*id="confirmOk"/s,
  '「取消」必须排在「确认」之前：dialog 自动聚焦第一个可聚焦元素，危险操作默认落在取消上');
assert.match(css, /\.modal\s*\{[^}]*padding:\s*0[^}]*border:\s*0/s,
  'dialog 自身不能有边框内衬，否则点遮罩判定（event.target === dlg）会连边缘一起吃掉');
assert.match(css, /\.modal::backdrop/, '确认框必须有遮罩样式');
for (const [name, src] of [['app.js', app], ['login.js', login]]) {
  assert.ok(!/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(src),
    `${name} 不得使用浏览器原生弹窗，改用页内 confirmBox()`);
}
assert.match(app, /function confirmBox\([\s\S]*?dlg\.returnValue === 'ok'/s,
  'confirmBox 必须以 returnValue 判定结果：Esc 关闭时 returnValue 是空串，等于取消');
assert.match(app, /\$\('confirmText'\)\.textContent =/,
  '确认文案必须用 textContent 写入（内容里带账号名/邮箱，不能当 HTML 插）');

// 删除账号：本地先摘行再渲染。等 refresh() 会先把剩下的账号逐个探上游，
// 几秒后行才消失，用户看着像点了没反应。
const delFlow = app.slice(app.indexOf("querySelectorAll('[data-del]')"), app.indexOf('function renderAliases'));
assert.ok(delFlow.includes("method: 'DELETE'"), '删除账号必须调用 DELETE 接口');
assert.match(delFlow, /S\.accounts = S\.accounts\.filter\([\s\S]*?renderAccounts\(\)/s,
  '删除成功后必须先在本地移除该账号并立即重渲染，不能等 refresh() 回来');
assert.ok(delFlow.lastIndexOf('refresh()') > delFlow.indexOf('renderAccounts()'),
  'refresh() 只做事后对账，必须排在本地重渲染之后');
assert.ok(!/await\s+refresh\(\)/.test(delFlow),
  'refresh() 不得 await：它会在服务端逐个探号，await 就把等待又搬回到手感上');

// ── 分享 Key：「模型与 Key」卡的第二页 ────────────────────
// 刻意不新开一张卡：工作区的底边对齐契约（上面那段收缩链）是按四张卡算的，
// 多一张左列就得重新分配收缩顺序。分页只在卡内换内容，两列高度关系不变。
for (const id of ['tab-models', 'tab-keys', 'pane-models', 'pane-keys', 'keyBody', 'keyForm',
  'newKeyName', 'newKeyConcurrency', 'newKeyDaily', 'newKeyModels', 'keyAdd', 'keyCancel', 'keyMsg', 'keyCount']) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `分享 Key 分页丢失 DOM 绑定 #${id}`);
}
assert.match(html, /id="tab-models"[^>]*aria-controls="pane-models"/s, '模型与映射标签必须关联面板');
assert.match(html, /id="tab-keys"[^>]*aria-controls="pane-keys"/s, 'Key 管理标签必须关联面板');
// 分页顺序：Key 管理在前、模型与映射在后，第一页就是打开面板时看到的那页。
assert.ok(html.indexOf('id="tab-keys"') < html.indexOf('id="tab-models"'),
  'Key 管理必须排在模型与映射之前');
assert.match(html, /id="tab-keys"[^>]*aria-selected="true"/s, '默认页是「Key 管理」');
assert.match(html, /id="pane-models"[^>]*hidden/s, '模型与映射页默认收起');
assert.doesNotMatch(html, /id="pane-keys"[^>]*hidden/s, 'Key 页是默认页，不能带 hidden');
assert.match(html, /class="pane"[^>]*id="pane-models"[\s\S]*class="model-workspace-grid"/s,
  '模型与映射整块必须整体搬进 pane-models，内部结构不动');
// 同页现在有两组 tablist（账号池 管理|添加、模型与 Key 模型与映射|Key 管理）。
// 全局 querySelectorAll 会让点一组把另一组的页一起藏掉。
assert.match(app, /querySelectorAll\('\.seg\[role="tablist"\]'\)[\s\S]*?nav\.closest\('\.card'\)[\s\S]*?querySelectorAll\(':scope > \.pane\[data-pane\]'\)/s,
  '分页切换必须按 .card 划范围，且只认卡的直接子 pane');
assert.match(css, /\.col-main\s*>\s*\.model-workspace-card\s*>\s*\.pane\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*min-height:\s*0/s,
  '多出的 .pane 层必须把高度继续往下传，否则左列的高度差没人吸收，两列底边又会错开');
assert.match(css, /\.col-main\s*>\s*\.model-workspace-card\s*>\s*\.pane\[hidden\]\s*\{[^}]*display:\s*none/s,
  '收起的页必须显式 display:none —— .pane 设了 display:flex 会盖掉 hidden 属性的默认样式');
assert.match(html, /id="newKeyConcurrency"[^>]*value="1"/s,
  '并发默认必须是 1（免费通道同号并发 >1 就出问题）');
assert.match(app, /\$\('newKeyConcurrency'\)\.value = '1'/,
  '重置表单也要回到并发 1，不能沿用上一把 key 的值');
// 一个表单管新建与编辑：keyEditing 有值 → PATCH，空 → POST。
assert.match(app, /if \(keyEditing\)\s*\{[\s\S]*?patchKey\(/s, '编辑走 PATCH');
assert.match(app, /if \(await patchKey\(keyEditing, body, '已保存'\)\) resetKeyForm\(\)/,
  '保存失败（改名撞重名回 400）时表单必须留着用户填的内容，不能清空');
assert.match(app, /api\('\/keys',\s*\{\s*method:\s*'POST'/, '新建走 POST');
assert.match(app, /function keyMask\(key\)\s*\{\s*return `\$\{key\.slice\(0, 8\)\}…`;\s*\}/s,
  '表里只显示 Key 前 8 位和省略号，完整 Key 走「复制」按钮');
assert.doesNotMatch(app, /key\.slice\(-4\)/,
  'Key 掩码不得暴露末尾字符');
assert.doesNotMatch(app, /<code title="\$\{esc\(k\.key\)\}">/,
  'Key 单元格的悬停提示也不得暴露完整 Key');
assert.match(app, /const running = st\.inFlight > 0 \? ` · <span class="key-inflight" title="在跑 \$\{st\.inFlight\}" aria-label="在跑 \$\{st\.inFlight\}">\$\{st\.inFlight\}<\/span>` : '';/,
  '今日/累计只显示绿色在跑数字，完整语义保留在 title 和 aria-label');
assert.doesNotMatch(app, /在跑 \$\{st\.inFlight\}<\/span>/,
  '运行状态的可见文本不得再包含“在跑”');
assert.match(css, /\.key-inflight\s*\{[^}]*color:\s*var\(--mint\)/s,
  '运行中的数量必须使用绿色样式');
assert.match(app, /if \(r\.key\)/,
  '调用日志必须为分享 Key 和 Master Key 都显示 User 行，历史空值不显示');
assert.ok(app.includes("api('/keys')"), '面板必须读取分享 Key 列表与归账');

// ── Key 面板控件精简：纯图标操作、圆点状态、模型按钮组 ──────────
// 账号池 / 模型映射 / Key 管理的操作统一为线框 SVG；纯图标仍须有悬停和读屏说明。
assert.match(app, /const ICONS\s*=\s*\{[\s\S]*?copy:[\s\S]*?edit:[\s\S]*?power:[\s\S]*?trash:/s,
  '动态表格必须集中定义复制、编辑、电源和垃圾桶线框图标');
assert.match(app, /function iconSvg\(icon, size = 15\)[\s\S]*?<svg viewBox="0 0 24 24" width="\$\{size\}"[\s\S]*?stroke="currentColor"[\s\S]*?\$\{ICONS\[icon\]\}/s,
  'SVG 外壳必须只有一份，图标按钮与独立字形共用');
assert.match(app, /function iconButton\([\s\S]*?title="\$\{esc\(label\)\}"[\s\S]*?aria-label="\$\{esc\(label\)\}"[\s\S]*?\$\{iconSvg\(icon\)\}/s,
  '纯图标按钮必须由统一 helper 输出 title、aria-label 和 SVG');
for (const binding of ['data-del', 'data-adel', 'data-kcopy', 'data-kedit', 'data-ktoggle', 'data-kdel']) {
  assert.match(app, new RegExp(`iconButton\\([^\\n]*${binding}`), `${binding} 操作必须使用纯图标按钮`);
}
const dynamicTables = app.slice(app.indexOf('function renderAccounts'), app.indexOf('// 模型分组 tag'));
assert.ok(!/>\s*(?:复制|编辑|启用|停用|删除)\s*<\/button>/.test(dynamicTables),
  '账号池、模型映射和 Key 管理不得再渲染文字操作按钮');
assert.match(css, /\.action-col \.btn\.icon\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s,
  '表格纯图标按钮必须使用紧凑且一致的 30px 方形点击区');

// 账号状态只显示一个圆点；文字语义放进 title / aria-label。
assert.match(app, /function stateDot\(s, detail = ''\)[\s\S]*?class="account-state-dot dot \$\{cls\}"[\s\S]*?title="状态：\$\{esc\(label\)\}"[\s\S]*?aria-label="状态：\$\{esc\(label\)\}"[\s\S]*?role="img"/s,
  '账号状态必须渲染成带悬停详情和可访问名称的单个圆点');
assert.match(app, /spend_limited: \['warn'[^\n]*waiting_room: \['warn'/,
  '账号消费额度受限与等待室排队必须使用琥珀色，不能回落成灰色未知状态');
assert.match(app, /<td>\$\{h \? stateDot\(h\.state, h\.label\) : stateDot\('unknown', '未探测'\)\}<\/td>/,
  '账号行只显示状态圆点，并优先把后端详细 label 用作悬停说明');
assert.match(css, /\.account-state-dot\s*\{[^}]*display:\s*inline-block[^}]*width:\s*8px[^}]*height:\s*8px/s,
  '状态圆点必须是不带胶囊文字的独立 8px 圆点');

// 会话列的「不限」同样只留字形：莫比乌斯环 + title / aria-label。
assert.match(app, /\n {2}mobius: '<path d="M12 12c[^']*"\/><path d="M12 12c[^']*"\/>',/,
  'ICONS 必须提供双瓣交叉的莫比乌斯环图标');
assert.match(app, /const UNLIMITED_GLYPH = `<span class="unlimited" title="不限" aria-label="不限" role="img">\$\{iconSvg\('mobius', 16\)\}<\/span>`/,
  '不限字形必须带悬停说明和可访问名称，不能只丢一个无语义符号');
assert.match(app, /<td>\$\{k\.dailyLimit > 0 \? esc\(String\(k\.dailyLimit\)\) : UNLIMITED_GLYPH\}<\/td>/,
  '会话列不限时显示莫比乌斯环，有上限时仍显示数字');
assert.match(css, /\.unlimited\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
  '莫比乌斯环必须与同格文字基线对齐，不能把行高顶开');

// 原生 Ctrl/⌘ 多选下拉改为按钮组；数据契约仍是 []（不限）或模型 ID 数组。
assert.match(html, /<div class="key-model-options" id="newKeyModels" role="group"[^>]*aria-label="可用模型，可多选"/s,
  '可用模型必须使用有可访问名称的按钮组');
// 列头缩成「会话」「今日 / 累计」后，session 口径只剩 hint 与 aria-label 交代，必须保住。
for (const label of ['每日会话上限，0 表示不限', '同一小时会话内重复调用只计一次']) {
  assert.ok(html.includes(label), `Key 面板必须明确 session 计数口径：${label}`);
}
assert.ok(!/<select[^>]*id="newKeyModels"/.test(html), '不得保留 Ctrl/⌘ 多选下拉');
assert.match(app, /function fillKeyModelButtons\(selected = \[\]\)[\s\S]*?data-key-model=""[^>]*title="不限模型">All<\/button>/s,
  '模型按钮组必须提供代表 models: [] 的 All 按钮，中文口径留在 title 里');
assert.match(app, /const modelIds = Array\.isArray\(k\.models\)[\s\S]*?modelListHtml\(modelIds\)/s,
  '可用模型列必须保留 All 语义，并用统一模型标签渲染具体白名单');
assert.match(app, /function selectedKeyModels\(\)[\s\S]*?\[data-key-model\]\[aria-pressed="true"\][\s\S]*?dataset\.keyModel/s,
  '提交时必须从 aria-pressed=true 的具体模型按钮读取白名单');
assert.match(css, /\.key-model-option\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
  'Key 模型按钮显示官方模型名时必须在窄屏内换行');
assert.match(css, /\.model-label\s*\{[^}]*overflow-wrap:\s*anywhere/s,
  'Key 表格和账号模型列表中的官方模型名必须允许任意断行');
assert.match(app, /let keyEditingPausedModels = \[\]/,
  '编辑旧 Key 时必须单独记住暂停模型白名单');
assert.match(app, /const chosen = \[\.\.\.new Set\(selected\.filter\(Boolean\)\)\]/,
  '旧 Key 已存的 M3 必须保留在按钮选择状态中');
assert.match(app, /aria-pressed="\$\{chosen\.includes\(id\)\}"[^>]*disabled aria-disabled="true"/s,
  '旧 Key 的 M3 按钮必须保持选中但禁用，新 Key 仍不能主动选择');
assert.match(app, /if \(!model\)[\s\S]*?setKeyModelSelection\(\[\]\)[\s\S]*?else[\s\S]*?selected\.has\(model\)[\s\S]*?setKeyModelSelection/s,
  '点击 All 须清空具体模型，具体模型须支持独立切换并在空集时回到 All');
assert.match(app, /models:\s*selectedKeyModels\(\)/,
  'Key POST/PATCH 数据必须继续提交 models 数组');
assert.match(css, /\.key-model-options\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
  '模型按钮组必须自动换行');
assert.match(css, /\.key-model-option\[aria-pressed="true"\]/,
  '模型按钮必须有明确的选中样式');

// 主按钮和状态消息同处一行，空间不足时自然换行。
const keyActions = html.slice(html.indexOf('<div class="key-form-actions">'), html.indexOf('</form>', html.indexOf('<div class="key-form-actions">')));
assert.match(keyActions, /id="keyAdd">新建 Key<\/button>[\s\S]*id="keyCancel"[\s\S]*id="keyMsg"[^>]*aria-live="polite"/s,
  '新建/编辑按钮和状态消息必须位于同一个操作区，默认文案为“新建 Key”');
assert.ok(!/<p class="hint key-message"[^>]*id="keyMsg"/.test(html.slice(html.indexOf('</form>'))),
  'keyMsg 不得再独占表单下方一行');
assert.match(app, /\$\('keyAdd'\)\.textContent = '新建 Key'/,
  '重置表单后主按钮必须回到“新建 Key”');
assert.ok(app.includes('文本 Key 已复制到剪贴板'), '新建成功消息必须明确写“文本 Key 已复制到剪贴板”');
assert.ok(app.includes('复制图标获取完整 Key'), '剪贴板失败消息必须指向行内复制图标');
assert.match(css, /\.key-form-actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*align-items:\s*center/s,
  'Key 操作区必须允许按钮和反馈消息同行并在窄屏换行');
assert.match(css, /\.key-message\s*\{[^}]*margin:\s*0[^}]*flex:\s*1\s+1/s,
  '状态消息必须取消独立行外边距并吸收按钮右侧剩余空间');


// ── 被收敛护栏截断的调用行必须一眼认得出 ──────────────────────────────────
// worker 掐断流时会给这条调用日志标 truncated 并记入 fail。但主行的账号/模型/
// 耗时和成功行长得一模一样，前端不标就只能靠猜 —— 用户拿到的是 200 + 不完整回答。
assert.ok(app.includes("c.truncated"),
  '调用日志聚合必须保留 truncated 字段，否则前端拿不到截断信息');
assert.ok(app.includes('r.truncated'),
  '调用日志主行必须根据 truncated 渲染标记');
assert.match(app, /TRUNCATION_LABELS\s*=\s*\{[^}]*idle:[^}]*duration_cap:[^}]*\}/s,
  '两种截断原因（idle / duration_cap）都必须有中文文案');
assert.ok(!app.includes('只有成功的调用会进来'),
  'callLog 的注释必须更新：截断行也会进逐条日志，旧注释已经不成立');

// 类名一致性：JS 里 tag() 建的 class 必须真的有 CSS 规则。
// 这条是实打实踩过的坑 —— JS 写 'trunc'、CSS 写 '.calllog-trunc'，
// 徽标照样渲染但完全没有样式，跑测试和看截图都发现不了。
const truncFlagClass = /const flag = tag\('([^']+)'/.exec(app)?.[1];
assert.ok(truncFlagClass, '截断标记必须用 tag() 创建，便于校验类名');
assert.ok(css.includes('.' + truncFlagClass),
  `截断标记的类名 .${truncFlagClass} 在 style.css 里没有任何规则：JS 与 CSS 对不上，徽标会裸奔`);
assert.match(css, new RegExp(`\\.${truncFlagClass}\\s*\\{[^}]*var\\(--amber\\)`, 's'),
  '截断标记必须用项目既有的 --amber 警示色，不要引入不存在的变量');

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
assert.deepEqual([...new Set(duplicates)], [], `页面存在重复 id: ${[...new Set(duplicates)].join(', ')}`);

console.log('web layout contract: pass');
