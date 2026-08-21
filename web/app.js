/**
 * app.js —— DOM 绑定层。
 * 只做三件事:轮询 /_api/* 填数据、按钮发命令、渲染。
 * 所有逻辑都在这里,不引入框架。
 */

const $ = (id) => document.getElementById(id);
const POLL_MS = 3600000; // 默认 1 小时自动刷新；需要即时数据可点概况区的刷新图标
// 调用日志单独快轮询：只打 /usage(worker 进程内存快照,零上游开销),不像
// refresh() 那样连带 /accounts 逐个探号——1 小时那条限制是为它设的,与这里无关。
// 代价：每次回全量环形缓冲(上限 200 条)。真嫌费流量就上 SSE 或按 since 增量。
const LOG_POLL_MS = 3000;

const S = {
  accounts: [], health: {}, accountEgress: {}, aliases: {},
  models: [], proxy: null, usage: null,
  // 分享 key：keys 是配置，keyStats 是 worker 进程内的归账（按备注名 join）
  keys: [], keyStats: {}, ownerName: '主 Key', keysLocked: false,
  // 账号列邮箱去敏：默认开着（截图/投屏不漏），点表头那只眼睛才展开；只影响展示，F5 回到默认
  maskEmail: true,
  build: '', buildUrl: '', repoUrl: '', trackRef: '', latest: '',
};

// ── HTTP ────────────────────────────────────────────────

async function api(path, opts) {
  const r = await fetch(`/_api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就当空 */ }
  if (r.status === 401) {
    location.replace('/');
    throw new Error('未登录');
  }
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

/** 直连 worker 路由(不加 /_api 前缀) */
async function rawApi(path, opts) {
  const r = await fetch(path, { ...opts, headers: { ...(opts?.headers || {}) } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就当空 */ }
  if (r.status === 401) { location.replace('/'); throw new Error('未登录'); }
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

// ── 工具 ────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
  // 莫比乌斯环 = 不限。两瓣在正中 (12,12) 交叉；真·扭转带在 16px 上糊成一团，取它的双纽线形。
  mobius: '<path d="M12 12c-1.8-2.5-3.6-3.8-5.5-3.8a3.8 3.8 0 0 0 0 7.6c1.9 0 3.7-1.3 5.5-3.8"/><path d="M12 12c1.8 2.5 3.6 3.8 5.5 3.8a3.8 3.8 0 0 0 0-7.6c-1.9 0-3.7 1.3-5.5 3.8"/>',
  eye: '<path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c7 0 10.5 6.5 10.5 6.5a18 18 0 0 1-3.3 4.1"/><path d="M6.4 7.7A17.8 17.8 0 0 0 1.5 12S5 18.5 12 18.5a9.7 9.7 0 0 0 3.6-.66"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
};

function iconSvg(icon, size = 15) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
}

function iconButton(icon, label, attrs = '', tone = '') {
  return `<button type="button" class="btn tiny icon ${tone}" ${attrs} title="${esc(label)}" aria-label="${esc(label)}">${iconSvg(icon)}</button>`;
}

// 会话不限：只画环，"不限"二字挪到 title / aria-label，读屏和悬停都还在。
const UNLIMITED_GLYPH = `<span class="unlimited" title="不限" aria-label="不限" role="img">${iconSvg('mobius', 16)}</span>`;

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * 页内确认框,取代浏览器原生弹窗。resolve true 表示确认。
 * 复用 index.html 里那一个 <dialog>:同时只会弹一个,不必每次建 DOM。
 */
function confirmBox({ title = '确认', text = '', ok = '确认', danger = true } = {}) {
  const dlg = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;      // textContent:文案里带账号名/邮箱,不能当 HTML 插
  const okBtn = $('confirmOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  okBtn.classList.toggle('primary', !danger);
  dlg.returnValue = '';                     // 上一次的结果不能留到这一次
  // 点遮罩=取消。dialog 自身没有内衬(见 style.css 的 .modal),所以事件目标是它本人时,
  // 点的就是 .modal-box 之外的遮罩区域。用 onclick 赋值:重复弹不会摞监听器。
  dlg.onclick = (event) => { if (event.target === dlg) dlg.close(); };
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

/** 按钮跑异步命令期间禁用,避免连点 */
async function run(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const extra = await fn();
    toast(extra ? `${label}完成,${extra}` : `${label}完成`, 'ok');
  } catch (e) {
    toast(`${label}失败:${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    refresh();
  }
}

function tag(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

// ── 调用日志格式化（与 zen core.js 同口径） ──────────────
const grouped = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 12345 -> "12,345" */
function fmtCount(n) {
  return grouped.format(Number(n) || 0);
}

/** 1234567 -> "1.2M"；token 数动辄七位，面板上放不下全长 */
function fmtTokens(n) {
  return compact.format(Number(n) || 0);
}

/** 时间戳 -> HH:MM:SS（本地时区）；日志每行都要，坏值不能炸 */
function fmtClock(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8);
}

/**
 * 毫秒时长 -> 显示文本，逐级向上换单位。没测过是 '—'，不是 0。
 * 首字节测不到（非流式）与「零延迟」不是一回事，null/≤0 都显示 —。
 */
function fmtDelay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 60000) return `${(n / 60000).toFixed(1)}m`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

/**
 * calls -> 可直接渲染的行 + 汇总。最近的排最前。
 * 只有成功的调用会进来（见 worker.js 的 logCall），失败只累计到 totals。
 */
function callLog(calls) {
  const rows = [];
  const acc = { ttfbMs: 0, ttfbCount: 0, durationMs: 0, durationCount: 0 };
  let tokens = 0;
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c || typeof c !== 'object') continue;
    const n = (k) => Number(c[k]) || 0;
    const row = {
      at: n('at'),
      // 详情里的「节点」在本项目改为调度的账号名（见 worker.js accountLabel）
      account: String(c.account ?? '').trim(),
      // 发这条的客户端 key（备注名，不是明文）。'' = 加多 key 之前的历史行
      key: String(c.key ?? '').trim(),
      model: String(c.model ?? '').trim(),
      // '' 保留原样 —— 前端显示 '—'，表示没发这个字段（随上游默认）
      effort: String(c.effort ?? '').trim(),
      in: n('in'), out: n('out'), reasoning: n('reasoning'),
      // null 和 0 要分开：测不到首字节和「零延迟」不是一回事
      ttfb: Number.isFinite(Number(c.ttfb)) && Number(c.ttfb) > 0 ? Number(c.ttfb) : null,
      ms: Number.isFinite(Number(c.ms)) ? Number(c.ms) : null,
    };
    row.total = row.in + row.out;
    tokens += row.total;
    if (row.ttfb != null) { acc.ttfbMs += row.ttfb; acc.ttfbCount++; }
    if (row.ms != null) { acc.durationMs += row.ms; acc.durationCount++; }
    rows.push(row);
  }
  // 后端是 push 追加的，数组本身即时间序；倒过来即可，同毫秒两条也保真实先后
  rows.reverse();
  const avg = (sum, count) => (count > 0 ? sum / count : null);
  return {
    rows, tokens,
    ttfb: avg(acc.ttfbMs, acc.ttfbCount),
    duration: avg(acc.durationMs, acc.durationCount),
  };
}

/** 「标签 + 值」那一小块。值加粗，标签留灰，扫的时候只看粗体就行 */
function num(label, value) {
  const s = tag('num', `${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  s.append(b);
  return s;
}

// ── 概况格式化（与 zen core.js 同口径） ──────────────────

/** 毫秒时长 -> 中文粗粒度，只保留两级单位（天时 / 时分 / 分秒 / 秒） */
function fmtUptime(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 时`;
  if (h) return `${h} 时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 成功率。没有任何请求时返回 null —— 显示 0% 会被当成全挂了，其实是「还没跑过」 */
function successRate(total) {
  const req = Number(total?.requests) || 0;
  if (!req) return null;
  return (Number(total?.success) || 0) / req;
}

/** 0.9231 -> "92.3%"；null -> "—" */
function fmtPercent(r) {
  return r == null ? '—' : `${(r * 100).toFixed(1)}%`;
}

/**
 * { 模型: {success,requests,totalTokens} } -> 按成功次数降序的数组。
 * 排序和过滤都用 success：一个模型每次都失败却排榜首没意义；一次都没成功过的
 * 直接不出现。limit=0 表示不截断（模型统计那格全量显示，自己滚动）。
 */
function rankBreakdown(map, limit = 5) {
  const rows = Object.entries(map || {})
    .map(([key, v]) => ({
      key,
      success: Number(v?.success) || 0,
      requests: Number(v?.requests) || 0,
      totalTokens: Number(v?.totalTokens) || 0,
    }))
    .filter((r) => r.success > 0)
    .sort((a, b) => b.success - a.success || a.key.localeCompare(b.key));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

// ── 渲染 ────────────────────────────────────────────────

/** 构建标识：hash 链到那次 commit，有新版本时徽标高亮 */
function hasNewer(latest, build) {
  return !!latest && !!build && latest !== build;
}

function renderBuild() {
  const el = $('build-id');
  el.textContent = S.build || '—';
  if (S.repoUrl) $('repo-link').href = S.repoUrl;

  const stale = hasNewer(S.latest, S.build);
  el.classList.toggle('new', stale);
  // 徽标只有 7 个字符，「跟谁比的」放 title 里 —— 不然「有新版本」这个状态
  // 看不出是拿哪个分支比出来的
  el.title = S.build
    ? `当前构建 ${S.build}${S.trackRef ? ` · 跟随 ${S.trackRef} 分支` : ''}${stale ? ` · 有新版本 ${S.latest}` : ''}`
    : '构建标识未知(构建时没注入 GIT_COMMIT)';
}

function stateDot(s, detail = '') {
  const map = {
    ok: ['ok', '存活'], token_invalid: ['danger', '失效'], banned: ['danger', '封禁'],
    country_blocked: ['warn', '地区受限'], rate_limited: ['warn', '模型额度受限'],
    spend_limited: ['warn', '账号消费额度受限'], waiting_room: ['warn', '等待室排队'],
    model_locked: ['warn', 'session 被锁定'], ip_capped: ['warn', 'IP 并发上限'],
    blocked: ['warn', '访问被拒'], unknown: ['muted', '未知'],
  };
  const [cls, fallback] = map[s] || ['muted', s || '未知'];
  const label = detail || fallback;
  return `<span class="account-state-dot dot ${cls}" title="状态：${esc(label)}" aria-label="状态：${esc(label)}" role="img"></span>`;
}

// 面板只显示模型名（去掉 provider/ 前缀）；完整 id 留在 title 和 API/白名单值里。
// tag 只表达当前额度池：免费 / 高级 / Luna / DS4P / 限定 / 停用。
// 上游显式 pool 优先，静态表只在旧快照或旧 Key 没有 pool 时兼容展示。
const MODEL_DISPLAY = {
  'openai/gpt-5.6-luna': { label: 'Luna', tier: 'us_sg' },
  'deepseek/deepseek-v4-pro': { label: 'DS4P', tier: 'us_sg' },
  'deepseek/deepseek-v4-flash': { label: '高级', tier: 'us_sg' },
  'minimax/minimax-m3': { label: '停用', tier: 'paused' },
  'crof/kimi-k3-eco': { label: '高级', tier: 'us_sg' },
  'meta/muse-spark-1.2-contributor': { label: '高级', tier: 'us_sg' },
  'mimo/mimo-v2.5': { label: '免费', tier: 'free' },
  'z-ai/glm-5.2': { label: '限定', tier: 'limited' },
  'anthropic/claude-fable-5': { label: '限定', tier: 'limited' },
};

// 官方已撤回但动态目录可能不再返回的模型，保留在管理面板用于说明历史配置，
// 不代表它仍可调用；worker /v1/models 和请求入口都会将其排除。
const PAUSED_MODEL_IDS = new Set(['minimax/minimax-m3']);
const HIDDEN_MODEL_IDS = new Set(['stealth/ox-alpha']);

function isHiddenModelId(modelId) {
  const value = String(modelId || '').trim().toLowerCase();
  return HIDDEN_MODEL_IDS.has(value) || value === 'ox-alpha'
    || value === 'anthropic/ox-alpha' || value.endsWith('/ox-alpha');
}

function catalogModelIds() {
  const ids = Array.isArray(S.models) ? S.models.map((m) => m.id)
    .filter((id) => id && !isHiddenModelId(id)) : [];
  for (const id of PAUSED_MODEL_IDS) if (!ids.includes(id)) ids.push(id);
  return ids;
}

const MODEL_QUOTA_POOLS = {
  'deepseek/deepseek-v4-pro': 'deepseek_pro',
  'openai/gpt-5.6-luna': 'luna',
  'deepseek/deepseek-v4-flash': 'premium',
  'crof/kimi-k3-eco': 'premium',
  'meta/muse-spark-1.2-contributor': 'premium',
};

const KNOWN_POOL_TAGS = {
  premium: { label: '高级', tierKey: 'premium' },
  luna: { label: 'Luna', tierKey: 'luna' },
  deepseek_pro: { label: 'DS4P', tierKey: 'deepseek_pro' },
  glm: { label: '限定', tierKey: 'glm' },
  standard: { label: '免费', tierKey: 'free' },
};

// 未收录的动态模型退回 /v1/models 的 tier 分组文案。
// name 只保留 provider/ 后面的模型名，完整 id 仍放在 title 并继续作为 API/白名单值。
function modelName(id) {
  const value = String(id || '');
  return value.slice(value.lastIndexOf('/') + 1);
}

function modelDisplay(id, model = null) {
  const known = MODEL_DISPLAY[id] || {};
  if (PAUSED_MODEL_IDS.has(id)) {
    return { id, name: modelName(id), tierKey: 'paused', tier: '停用' };
  }
  const rawPool = String(model?.pool || '').trim().slice(0, 64);
  const name = modelName(id);
  if (rawPool) {
    const poolTag = KNOWN_POOL_TAGS[rawPool.toLowerCase()];
    return {
      id,
      name,
      tierKey: poolTag?.tierKey || 'pool-other',
      tier: poolTag?.label || rawPool,
    };
  }
  const tierKey = known.tier || model?.tier || '';
  return { id, name, tierKey, tier: known.label || MODEL_TIER_LABELS[tierKey] || '' };
}

function modelListHtml(modelIds = [], models = null) {
  const byId = new Map((Array.isArray(S.models) ? S.models : [])
    .filter((model) => model?.id)
    .map((model) => [model.id, model]));
  for (const model of Array.isArray(models) ? models : []) {
    if (!model?.id) continue;
    byId.set(model.id, { ...byId.get(model.id), ...model });
  }
  return [...new Set((Array.isArray(modelIds) ? modelIds : []).filter((id) => {
    return id && !isHiddenModelId(id);
  }))].map((id) => {
    const { name, tier, tierKey } = modelDisplay(id, byId.get(id));
    return `<span class="model-label" title="${esc(id)}">${esc(name)}${tier ? ` <span class="pill tier tier-${esc(tierKey)}">${esc(tier)}</span>` : ''}</span>`;
  }).join(', ');
}

function quotaPoolForRow(row) {
  const explicit = String(row?.pool || '').trim().toLowerCase();
  if (explicit) return explicit;
  const model = Array.isArray(S.models)
    ? S.models.find((entry) => entry?.id === row?.model)
    : null;
  return String(model?.pool || '').trim().toLowerCase() || MODEL_QUOTA_POOLS[row?.model] || '';
}

// 额度展示按上游 pool 聚合。D/L/P 是池上限的紧凑摘要，已用/总量只放 title，
// 避免一行账号被某个模型的计数冒充成整个账号额度。
function quotaRows(probe) {
  if (!probe || !Array.isArray(probe.quota)) return [];
  return probe.quota.filter((q) => {
    const limit = Number(q?.limit);
    return Number.isFinite(limit) && limit >= 0
      && !PAUSED_MODEL_IDS.has(String(q?.model || '')) && !isHiddenModelId(q?.model);
  });
}

function usableQuota(probe) {
  return quotaRows(probe).filter((q) => Number(q.limit) > 0);
}

function accountQuotaSummary(probe) {
  const pools = new Map();
  for (const row of quotaRows(probe)) {
    const pool = quotaPoolForRow(row);
    if (!['deepseek_pro', 'luna', 'premium'].includes(pool)) continue;
    const limit = Number(row.limit);
    const usedValue = row.used ?? row.recentCount;
    const used = Number.isFinite(Number(usedValue)) ? Number(usedValue) : null;
    const previous = pools.get(pool);
    if (!previous) pools.set(pool, { limit, used });
    else {
      // 同一共享池的各模型行正常应完全一致。若上游短暂返回不一致快照，
      // 用较小上限避免 UI 高估可用额度；已用量取较大值同样保持保守。
      pools.set(pool, {
        limit: Math.min(previous.limit, limit),
        used: previous.used == null ? used : used == null ? previous.used : Math.max(previous.used, used),
      });
    }
  }
  const poolOrder = [
    ['deepseek_pro', 'D'],
    ['luna', 'L'],
    ['premium', 'P'],
  ];
  const parts = [];
  const details = [];
  for (const [pool, label] of poolOrder) {
    const row = pools.get(pool);
    if (!row) continue;
    parts.push(`${label}${row.limit}`);
    details.push(`${label} ${row.used == null ? '—' : row.used}/${row.limit}`);
  }
  if (!parts.length) return null;
  return { text: `( ${parts.join(' ')} )`, title: `额度 ${details.join(' · ')}` };
}

// 可用模型列：只列真正有额度（limit>0）的模型，每个模型独占一行；0/0 未解锁模型
// （如 glm-5.2）直接隐藏。用量已上移到账号名后，重置时间上移到列标题。
// 被封禁/隔离的号没有额度表：永久终态明确显示「永久隔离」；
// 只有带有本地临时截止时间的非终态才显示「隔离至」。
function modelsCellHtml(probe) {
  const rows = usableQuota(probe);
  if (!rows.length) {
    if (probe?.isolatedPermanent) {
      return '<span class="quota" title="上游终态账号只允许管理员成功探测或清除后恢复">永久隔离</span>';
    }
    const until = Number(probe && probe.isolatedUntil);
    if (Number.isFinite(until) && until > 0) {
      const when = formatResetAt(new Date(until).toISOString());
      return `<span class="quota" title="该账号暂时隔离至 ${when}">隔离至 ${when}</span>`;
    }
    return '<span class="quota">—</span>';
  }
  const items = rows.map((q) => `<li>${modelListHtml([q.model], [q])}</li>`).join('');
  return `<ul class="quota quota-models">${items}</ul>`;
}

// 重置时间优先取快照中的池级 resetAt；逐行重复一遍没有信息量，提到列标题上只显示一次。
function poolResetAt() {
  for (const a of S.accounts) {
    const reset = usableQuota(S.health[a.key]).map((q) => q.resetAt).find(Boolean);
    if (reset) return reset;
  }
  return '';
}

function renderQuotaHead() {
  const reset = poolResetAt();
  // 还没探测出额度时回落到静态标题，别显示「重置 日期未知」那种半截信息
  $('quotaHead').textContent = reset ? `可用模型 (重置 ${formatResetAt(reset)})` : '可用模型(重置时间)';
}

// ISO 时间戳 → 固定北京时间（UTC+8）YYYY-MM-DD HH:mm。这里显式折算到东八区，
// 不依赖浏览器/服务器所在时区，任何环境下都稳定显示上游给出的 resetAt。
function formatResetAt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '日期未知';
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

function renderStats() {
  const counts = { ok: 0, warn: 0, bad: 0 };
  for (const a of S.accounts) {
    const h = S.health[a.key];
    if (!h || h.state === 'unknown') { counts.warn++; continue; }
    if (h.state === 'ok') counts.ok++;
    else if (['banned', 'token_invalid'].includes(h.state)) counts.bad++;
    else counts.warn++;
  }
  $('sTotal').textContent = S.accounts.length;
  $('sAlive').textContent = counts.ok;
  $('sWarn').textContent = counts.warn;
  $('sBad').textContent = counts.bad;
  $('sTotalSub').textContent = `${S.accounts.filter(a => a.hasToken).length} 个含 token`;
}

// 账号列邮箱去敏：只留本地部分首 1–2 位和一级域名（he***@***.cc），中间几级子域一起抹掉，
// 星号定长所以连长度都不泄。备注名不含 @ 就原样返回，主行/次行都能无脑套一层。
function maskEmail(s) {
  const text = String(s ?? '');
  if (!S.maskEmail) return text;
  return text.replace(/([^@\s]+)@([^@\s]+)/g, (_, user, domain) => {
    const dot = domain.lastIndexOf('.');   // 取最后一段：do-ge.v0n0v.eu.cc 只剩 .cc
    return `${user.slice(0, user.length > 3 ? 2 : 1)}***@***${dot > 0 ? domain.slice(dot) : ''}`;
  });
}

// 表头那只眼睛：一键去敏整列，文字说明只放 title / aria-label
function renderMaskToggle() {
  const btn = $('maskEmail');
  if (!btn) return;
  const label = S.maskEmail ? '显示完整邮箱' : '隐藏邮箱';
  btn.innerHTML = iconSvg(S.maskEmail ? 'eyeOff' : 'eye', 14);
  btn.setAttribute('aria-pressed', String(S.maskEmail));
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function normalizeAccountEgress(account = {}) {
  const inline = account.egress && typeof account.egress === 'object' ? account.egress : {};
  const runtime = S.accountEgress?.[account.key];
  const detail = runtime && typeof runtime === 'object' ? { ...inline, ...runtime } : inline;
  const mode = String(account.egressMode ?? detail.mode ?? 'auto').toLowerCase() === 'manual'
    ? 'manual' : 'auto';
  const configuredNode = String(account.egressNode ?? detail.configuredNode ?? '').trim();
  const currentNode = String(account.egressCurrentNode ?? detail.currentNode ?? detail.selectedNode ?? configuredNode).trim();
  const state = String(account.egressState ?? detail.state ?? (currentNode ? 'ready' : 'pending')).toLowerCase();
  const error = String(account.egressError ?? detail.error ?? '').trim();
  const reject = detail.reject && typeof detail.reject === 'object' ? detail.reject : null;
  return { mode, configuredNode, currentNode, state, error, reject };
}

const ACCOUNT_EGRESS_STATE_LABELS = {
  ready: '已就绪', probing: '验证中', pending: '选择中', starting: '选择中', configuring: '选择中',
  error: '异常', failed: '异常', unavailable: '暂无正常节点',
  proxy_offline: '代理未就绪', rejected: '节点被拒绝',
};

function accountEgressStateLabel(state) {
  return ACCOUNT_EGRESS_STATE_LABELS[state] || '等待选择';
}

function accountEgressSummary(account) {
  const egress = normalizeAccountEgress(account);
  const mode = egress.mode === 'manual' ? '手动' : '自动';
  const node = egress.currentNode || (egress.mode === 'manual' ? '未设置' : accountEgressStateLabel(egress.state));
  const failed = egress.error || ['error', 'failed', 'unavailable', 'proxy_offline', 'rejected'].includes(egress.state);
  const title = [mode, egress.currentNode, egress.error || egress.reject?.state].filter(Boolean).join(' · ');
  return `<div class="account-egress-summary ${failed ? 'error' : egress.currentNode ? 'ready' : 'pending'}" title="${esc(title || `${mode} · ${node}`)}">
    <span class="account-egress-mode-label">${mode}</span>
    <span class="account-egress-node mono">${esc(node)}</span>
  </div>`;
}

function proxyNodesForAccount() {
  return (Array.isArray(S.proxy?.nodes) ? S.proxy.nodes : []).map((node) => typeof node === 'string'
    ? { name: node, healthy: null, delay: null }
    : {
        name: String(node?.name || node?.id || ''),
        healthy: node?.healthy ?? null,
        delay: Number.isFinite(Number(node?.delay)) ? Number(node.delay) : null,
      }
  ).filter((node) => node.name);
}

function fillAccountEgressNodes(configuredNode = '') {
  const select = $('accountEgressNode');
  const nodes = proxyNodesForAccount();
  if (configuredNode && !nodes.some((node) => node.name === configuredNode)) {
    nodes.unshift({ name: configuredNode, healthy: null, delay: null, missing: true });
  }
  const values = nodes.length ? nodes : [{ name: '', healthy: null, delay: null }];
  select.replaceChildren(...values.map((node) => {
    const option = document.createElement('option');
    option.value = node.name;
    const health = node.healthy === true ? '● ' : node.healthy === false ? '○ ' : '';
    const delay = Number.isFinite(node.delay) && node.delay > 0 ? ` · ${node.delay}ms` : '';
    option.textContent = node.name
      ? `${health}${node.name}${node.missing ? ' · 当前列表缺失' : delay}`
      : '暂无可用节点';
    return option;
  }));
  if (configuredNode) select.value = configuredNode;
}

let accountEgressEditing = null;
let accountEgressSaving = false;

function setAccountEgressMode(mode) {
  const normalized = mode === 'manual' ? 'manual' : 'auto';
  const dialog = $('accountEgressDialog');
  dialog.dataset.mode = normalized;
  for (const [id, active] of [
    ['accountEgressModeAuto', normalized === 'auto'],
    ['accountEgressModeManual', normalized === 'manual'],
  ]) {
    const button = $(id);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = Boolean(S.readonly) || accountEgressSaving;
  }
  $('accountEgressNodeField').hidden = normalized !== 'manual';
  const hasNode = Boolean($('accountEgressNode').value);
  $('accountEgressNode').disabled = Boolean(S.readonly) || accountEgressSaving
    || normalized !== 'manual' || !hasNode;
  $('accountEgressSave').disabled = Boolean(S.readonly) || accountEgressSaving
    || (normalized === 'manual' && !hasNode);
  $('accountEgressCancel').disabled = accountEgressSaving;
}

function renderAccountEgressStatus(account) {
  const egress = normalizeAccountEgress(account);
  const mode = egress.mode === 'manual' ? '手动' : '自动';
  const state = accountEgressStateLabel(egress.state);
  const failed = egress.error || ['error', 'failed', 'unavailable', 'proxy_offline', 'rejected'].includes(egress.state);
  $('accountEgressStatus').textContent = `${mode} · ${state}${egress.currentNode ? ` · ${egress.currentNode}` : ''}`;
  $('accountEgressStatus').className = `account-egress-status ${failed ? 'error' : egress.currentNode ? 'ready' : 'pending'}`;
  $('accountEgressError').textContent = egress.error || (egress.reject?.state ? `拒绝原因：${egress.reject.state}` : '');
}

function openAccountEgress(key) {
  if (accountEgressSaving) return;
  const account = S.accounts.find((item) => item.key === key);
  if (!account || S.readonly) return;
  accountEgressEditing = key;
  const egress = normalizeAccountEgress(account);
  $('accountEgressAccount').textContent = maskEmail(account.name || account.email || account.key);
  $('accountEgressError').textContent = '';
  fillAccountEgressNodes(egress.configuredNode || egress.currentNode);
  setAccountEgressMode(egress.mode);
  renderAccountEgressStatus(account);
  const dialog = $('accountEgressDialog');
  dialog.onclick = (event) => {
    if (event.target === dialog && !accountEgressSaving) dialog.close();
  };
  dialog.showModal();
}

function renderAccounts() {
  const table = document.querySelector('.account-table');
  table.classList.toggle('is-empty', S.accounts.length === 0);
  $('acctCount').textContent = `${S.accounts.length} 个`;
  renderQuotaHead();
  renderMaskToggle();
  if (!S.accounts.length) {
    $('acctBody').innerHTML = '<tr><td colspan="5" class="empty">暂无账号，请切换到「添加」</td></tr>';
    return;
  }
  $('acctBody').innerHTML = S.accounts.map(a => {
    const h = S.health[a.key];
    const usage = accountQuotaSummary(h);
    const usageHtml = usage
      ? ` <span class="acct-usage" title="${esc(usage.title)}">${esc(usage.text)}</span>`
      : '';
    // 主行=备注名(或邮箱)+池级用量，次行=邮箱。
    const label = a.name || a.email || a.key;
    const secondary = a.email && a.email !== label ? a.email : '';
    const egressDisabled = S.readonly ? 'disabled' : '';
    return `<tr>
      <td>
        <div class="nm">${esc(maskEmail(label))}${usageHtml}</div>
        ${secondary ? `<div class="mono">${esc(maskEmail(secondary))}</div>` : ''}
      </td>
      <td>${h ? stateDot(h.state, h.label) : stateDot('unknown', '未探测')}</td>
      <td>${accountEgressSummary(a)}</td>
      <td>${modelsCellHtml(h)}</td>
      <td class="action-col">
        <div class="actions icon-actions">
          ${iconButton('route', '设置出站节点', `data-egress="${esc(a.key)}" ${egressDisabled}`)}
          ${S.readonly ? '' : iconButton('trash', '删除账号', `data-del="${esc(a.key)}"`, 'danger')}
        </div>
      </td>
    </tr>`;
  }).join('');

  // 没有「探测」按钮：GET /_api/accounts 每次都会在服务端逐个探测，状态与额度随
  // 轮询（每小时）和概况区的立即刷新一起更新，手动逐个探测是多余的一层
  $('acctBody').querySelectorAll('[data-egress]').forEach((button) =>
    button.addEventListener('click', () => openAccountEgress(button.dataset.egress)));
  $('acctBody').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const key = b.dataset.del;
      const acct = S.accounts.find((a) => a.key === key);
      const label = acct?.name || acct?.email || key.slice(0, 20) + '…';
      if (!await confirmBox({
        title: '删除账号',
        text: `确认删除「${maskEmail(label)}」？账号会从池子里移除，正在进行的请求不受影响。`,
        ok: '删除',
      })) return;
      try {
        await api('/accounts/' + encodeURIComponent(key), { method: 'DELETE' });
        // 删完先在本地摘掉这一行再渲染。不能等 refresh():那一轮会让服务端把剩下的账号
        // 逐个探上游(GET /_api/accounts 每个号一次请求),几秒后行才消失,看着像点了没反应。
        S.accounts = S.accounts.filter((a) => a.key !== key);
        delete S.health[key];
        renderStats(); renderAccounts(); syncColumnBottoms();
        toast('已删除', 'ok');
        refresh();                          // 不 await:后台跟服务端对账,慢也不挡手感
      } catch (e) { toast('删除失败:' + e.message, 'err'); }
    }));
}

function renderAliases() {
  const keys = Object.keys(S.aliases);
  $('aliasCount').textContent = `${keys.length} 个`;
  if (!keys.length) {
    $('aliasBody').innerHTML = '<tr><td colspan="3" class="empty">暂无映射,添加一个试试(如 gpt-5 → deepseek/deepseek-v4-flash)</td></tr>';
    return;
  }
  $('aliasBody').innerHTML = keys.map(k =>
    `<tr><td><code>${esc(k)}</code></td><td><code>${esc(S.aliases[k])}</code></td>
     <td class="action-col"><div class="actions icon-actions">${iconButton('trash', '删除模型映射', `data-adel="${esc(k)}"`, 'danger')}</div></td></tr>`
  ).join('');
  $('aliasBody').querySelectorAll('[data-adel]').forEach(b =>
    b.addEventListener('click', async () => {
      const next = { ...S.aliases };
      delete next[b.dataset.adel];
      await saveAliases(next);
    }));
}

async function saveAliases(next) {
  try {
    const r = await api('/aliases', {
      method: 'PUT',
      body: JSON.stringify({ aliases: next }),
    });
    S.aliases = r.aliases || next;
    renderAliases();
    $('aliasMsg').textContent = '已保存,立即生效(无需重启)';
    toast('模型映射已保存', 'ok');
  } catch (e) {
    $('aliasMsg').textContent = '保存失败:' + e.message;
    toast('保存失败:' + e.message, 'err');
  }
}

// ── 分享 Key ────────────────────────────────────────────
// 「模型与 Key」卡的第二页。一个表单管新建与编辑：keyEditing 有值就是编辑那把
// （PATCH），空就是发新的（POST）—— 省掉第二套 DOM 和第二条提交路径。
let keyEditing = null;
let keyEditingPausedModels = [];
let keyEditingHiddenModels = [];

function keyMask(key) {
  return `${key.slice(0, 8)}…`;
}

/** 已存的白名单模型即使当前模型表里没有也保留，
    否则编辑一把限了「暂时拉不到的模型」的 key，一保存就把白名单清空了。 */
function selectedKeyModels() {
  const selected = [...$('newKeyModels').querySelectorAll('[data-key-model][aria-pressed="true"]')]
    .map((button) => button.dataset.keyModel)
    .filter(Boolean);
  return [...new Set([...selected, ...keyEditingPausedModels, ...keyEditingHiddenModels])];
}

function setKeyModelSelection(selected = []) {
  const wanted = new Set([...selected, ...keyEditingPausedModels, ...keyEditingHiddenModels]);
  const hasSpecific = wanted.size > 0;
  $('newKeyModels').querySelectorAll('[data-key-model]').forEach((button) => {
    const model = button.dataset.keyModel;
    button.setAttribute('aria-pressed', String(model ? wanted.has(model) : !hasSpecific));
  });
}

function fillKeyModelButtons(selected = []) {
  const chosen = [...new Set(selected.filter(Boolean))];
  const ids = catalogModelIds();
  for (const id of chosen) if (!ids.includes(id) && !isHiddenModelId(id)) ids.push(id);
  const root = $('newKeyModels');
  root.innerHTML = [
    `<button type="button" class="key-model-option" data-key-model="" aria-pressed="${chosen.length === 0}" title="不限模型">All</button>`,
    ...ids.map((id) => {
      const model = (Array.isArray(S.models) ? S.models : []).find((entry) => entry?.id === id);
      const { name, tier } = modelDisplay(id, model);
      const paused = PAUSED_MODEL_IDS.has(id);
      return `<button type="button" class="key-model-option${paused ? ' is-paused' : ''}" data-key-model="${esc(id)}" aria-pressed="${chosen.includes(id)}"${paused ? ' disabled aria-disabled="true"' : ''} title="${esc(id)}">${esc(name)}${tier ? ` · ${esc(tier)}` : ''}</button>`;
    }),
  ].join('');
  root.querySelectorAll('[data-key-model]').forEach((button) => button.addEventListener('click', () => {
    const model = button.dataset.keyModel;
    if (!model) {
      setKeyModelSelection([]);
    } else {
      const selected = new Set(selectedKeyModels());
      if (selected.has(model)) selected.delete(model);
      else selected.add(model);
      setKeyModelSelection([...selected]);
    }
  }));
}

function resetKeyForm() {
  keyEditing = null;
  keyEditingPausedModels = [];
  keyEditingHiddenModels = [];
  $('newKeyName').value = '';
  $('newKeyConcurrency').value = '1';   // 并发默认 1：免费通道同号并发 >1 就出问题
  $('newKeyDaily').value = '0';
  fillKeyModelButtons([]);
  $('keyAdd').textContent = '新建 Key';
  $('keyCancel').hidden = true;
}

function fillKeyForm(k) {
  keyEditing = k.key;
  keyEditingPausedModels = Array.isArray(k.models)
    ? k.models.filter((model) => PAUSED_MODEL_IDS.has(model))
    : [];
  keyEditingHiddenModels = Array.isArray(k.models)
    ? k.models.filter((model) => isHiddenModelId(model))
    : [];
  $('newKeyName').value = k.name || '';
  $('newKeyConcurrency').value = String(k.concurrency ?? 1);
  $('newKeyDaily').value = String(k.dailyLimit ?? 0);
  fillKeyModelButtons(Array.isArray(k.models) ? k.models : []);
  $('keyAdd').textContent = '保存修改';
  $('keyCancel').hidden = false;
  $('newKeyName').focus();
}

function renderKeys() {
  const list = Array.isArray(S.keys) ? S.keys : [];
  $('keyCount').textContent = `${list.length} 把`;
  const body = $('keyBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">'
      + (S.keysLocked
        ? '未设置 ADMIN_PASSWORD,不能发分享 Key —— 拿到面板地址的人都能进来发 Key'
        : '还没有分享 Key。下面填个备注名就能发一把,默认并发 1、不限模型。')
      + '</td></tr>';
  } else {
    body.innerHTML = list.map((k) => {
      const st = S.keyStats[k.name] || {};
      const modelIds = Array.isArray(k.models) ? k.models : [];
      const visibleModelIds = modelIds.filter((model) => !isHiddenModelId(model));
      const models = modelIds.length ? (modelListHtml(modelIds) || '—') : 'All';
      const modelsTitle = visibleModelIds.length ? visibleModelIds.join(', ') : (modelIds.length ? '—' : 'All');
      const running = st.inFlight > 0 ? ` · <span class="key-inflight" title="在跑 ${st.inFlight}" aria-label="在跑 ${st.inFlight}">${st.inFlight}</span>` : '';
      return `<tr class="${k.disabled ? 'key-off' : ''}">
        <td><span class="nm">${esc(k.name)}</span>${k.disabled ? ' <span class="pill">已停用</span>' : ''}</td>
        <td><code>${esc(keyMask(k.key))}</code></td>
        <td>${esc(String(k.concurrency))}</td>
        <td>${k.dailyLimit > 0 ? esc(String(k.dailyLimit)) : UNLIMITED_GLYPH}</td>
        <td class="mono">${fmtCount(st.dayCount || 0)} / ${fmtCount(st.total || 0)}${running}</td>
        <td class="mono" title="历史累计 token ${esc(fmtCount(st.totalTokens || 0))}">${fmtTokens(st.totalTokens || 0)}</td>
        <td class="key-models-cell mono" title="${esc(modelsTitle)}">${models}</td>
        <td class="action-col"><div class="actions icon-actions">
          ${iconButton('copy', '复制 Key', `data-kcopy="${esc(k.key)}"`)}
          ${iconButton('edit', '编辑 Key', `data-kedit="${esc(k.key)}"`)}
          ${iconButton('power', k.disabled ? '启用 Key' : '停用 Key', `data-ktoggle="${esc(k.key)}"`, k.disabled ? 'ok' : 'warn')}
          ${iconButton('trash', '删除 Key', `data-kdel="${esc(k.key)}"`, 'danger')}
        </div></td></tr>`;
    }).join('');
  }

  body.querySelectorAll('[data-kcopy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.kcopy);
      toast('已复制 Key', 'ok');
    } catch { toast('复制失败', 'err'); }
  }));
  body.querySelectorAll('[data-kedit]').forEach((b) => b.addEventListener('click', () => {
    const k = list.find((x) => x.key === b.dataset.kedit);
    if (k) fillKeyForm(k);
  }));
  body.querySelectorAll('[data-ktoggle]').forEach((b) => b.addEventListener('click', async () => {
    const k = list.find((x) => x.key === b.dataset.ktoggle);
    if (!k) return;
    await patchKey(k.key, { disabled: !k.disabled }, k.disabled ? '已启用' : '已停用');
  }));
  body.querySelectorAll('[data-kdel]').forEach((b) => b.addEventListener('click', async () => {
    const k = list.find((x) => x.key === b.dataset.kdel);
    if (!k) return;
    if (!await confirmBox({
      title: '删除分享 Key',
      text: `删除「${k.name}」后这把 Key 立即失效，正在用它的人会收到 401。继续？`,
      ok: '删除',
    })) return;
    try {
      await api('/keys/' + encodeURIComponent(k.key), { method: 'DELETE' });
      if (keyEditing === k.key) resetKeyForm();
      toast('已删除', 'ok');
      await loadKeys();
    } catch (e) { toast('删除失败:' + e.message, 'err'); }
  }));

  // 模型表是异步来的（/v1/models 比这张表晚），到了就补进按钮组，
  // 顺手保留用户已经选中的项 —— 1 小时那拍自动刷新不该把选择清掉。
  fillKeyModelButtons(selectedKeyModels());
}

// 返回是否成功：改名撞重名会被 400 挡回来，那时表单必须留着用户填的内容。
async function patchKey(key, patch, okMsg) {
  try {
    await api('/keys/' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify(patch) });
    $('keyMsg').textContent = okMsg + '，立即生效（无需重启）';
    toast(okMsg, 'ok');
    await loadKeys();
    return true;
  } catch (e) {
    $('keyMsg').textContent = '保存失败:' + e.message;
    toast('保存失败:' + e.message, 'err');
    return false;
  }
}

async function loadKeys() {
  const r = await api('/keys').catch(() => null);
  if (!r) return;
  S.keys = r.keys || [];
  S.keyStats = r.stats || {};
  S.ownerName = r.ownerName || S.ownerName;
  S.keysLocked = r.locked === true;
  renderKeys();
}

async function submitKeyForm() {
  const name = $('newKeyName').value.trim();
  if (!name) { $('keyMsg').textContent = '请填写备注名（给谁用的）'; return; }
  const body = {
    name,
    concurrency: Number($('newKeyConcurrency').value) || 1,
    dailyLimit: Number($('newKeyDaily').value) || 0,
    models: selectedKeyModels(),
  };
  if (keyEditing) {
    if (await patchKey(keyEditing, body, '已保存')) resetKeyForm();
    return;
  }
  try {
    const r = await api('/keys', { method: 'POST', body: JSON.stringify(body) });
    resetKeyForm();
    await loadKeys();
    // 明文只在表里显示掩码，这里把整把 key 直接放进剪贴板：发出去就是要用的那一刻。
    try {
      await navigator.clipboard.writeText(r.key.key);
      $('keyMsg').textContent = `已发出「${name}」，文本 Key 已复制到剪贴板`;
    } catch {
      $('keyMsg').textContent = `已发出「${name}」，点该 Key 行的复制图标获取完整 Key`;
    }
    toast('已发出新 Key', 'ok');
  } catch (e) {
    $('keyMsg').textContent = '创建失败:' + e.message;
    toast('创建失败:' + e.message, 'err');
  }
}

// 模型分组 tag：键与顺序由 worker 的 MODEL_TIERS 决定（/v1/models 的 tier 字段），
// 这里只负责文案。排序已经在 worker 侧做过，前端不再二次排序。
const MODEL_TIER_LABELS = { free: '免费', us_sg: '高级', limited: '限定' };

function renderModels() {
  const ul = $('models');
  const known = new Map((Array.isArray(S.models) ? S.models : []).map((m) => [m.id, m]));
  for (const id of PAUSED_MODEL_IDS) if (!known.has(id)) known.set(id, { id, tier: 'paused' });
  const list = [...known.values()].filter((m) => {
    return m?.id && !isHiddenModelId(m.id);
  });
  const modelCount = $('modelCount');
  if (modelCount) modelCount.textContent = `${list.length} 个`;
  $('models-empty').hidden = list.length > 0;
  ul.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    const { name, tier, tierKey } = modelDisplay(m.id, m);
    li.textContent = name;
    li.title = m.id;
    // 未分组的模型不带任何 tag
    if (tier) li.append(' ', tag(`pill tier tier-${tierKey}`, tier));
    return li;
  }));
  // 溢出项给键盘可达
  for (const li of ul.children) {
    if (li.scrollWidth > li.clientWidth + 1) li.tabIndex = 0;
  }
}

// 间隔候选值(秒)。检测间隔:1/5/10/30 分钟 + 1/6/12 小时;更新间隔:1/3/6/12/24 小时。
const HEALTH_INTERVALS = [60, 300, 600, 1800, 3600, 21600, 43200];
const UPDATE_INTERVALS = [3600, 10800, 21600, 43200, 86400];

// 秒 → 人类可读标签:整除 3600 → N 小时;整除 60 → N 分钟;否则 N 秒。
function fmtInterval(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} 小时`;
  if (sec % 60 === 0) return `${sec / 60} 分钟`;
  return `${sec} 秒`;
}

// 用固定候选值受控重建间隔下拉:升序去重、分钟/小时标签。不再把后端存的非标准秒值
// 追加成「N 秒」垃圾项(旧逻辑会累积出 300 秒 / 43 秒)。存值不在候选里时吸附到最近项。
function syncIntervalSelect(select, canonical, savedSec, fallbackSec) {
  const values = [...new Set(canonical)].sort((a, b) => a - b);
  const saved = Number.isFinite(savedSec) && savedSec > 0 ? Math.round(savedSec) : fallbackSec;
  let pick = values[0];
  for (const v of values) if (Math.abs(v - saved) < Math.abs(pick - saved)) pick = v;
  const signature = `${values.join(',')}|${pick}`;
  if (select.dataset.intervalSig !== signature) {
    select.dataset.intervalSig = signature;
    select.replaceChildren(...values.map((v) => {
      const option = document.createElement('option');
      option.value = String(v);
      option.textContent = fmtInterval(v);
      return option;
    }));
  }
  select.value = String(pick);
}

/** 代理订阅状态只显示服务端脱敏结果，浏览器不接触完整订阅 URL。 */
function renderProxy() {
  const p = S.proxy || {};
  const labels = {
    disabled: '未配置', starting: '启动中', ready: '已连接',
    error: '异常', stopped: '已停止', muted: '未知',
  };
  const state = String(p.state || (p.configured ? 'starting' : 'disabled')).toLowerCase();
  const status = $('proxyStatus');
  if (status) {
    status.className = `proxy-status ${['disabled', 'starting', 'ready', 'error', 'stopped'].includes(state) ? state : 'muted'}`;
    status.textContent = labels[state] || '未知';
  }
  const put = (id, value, fallback = '—') => {
    const el = $(id);
    if (el) el.textContent = value == null || value === '' ? fallback : String(value);
  };
  put('proxyUrl', p.urlMasked || p.subscriptionUrlMasked, p.configured ? '已配置（地址已隐藏）' : '未配置');
  put('proxyNodeCount', p.nodeCount, '—');
  put('proxyHealthyCount', p.healthyCount, '—');
  put('proxyCurrentNode', p.currentNode, state === 'ready' ? '自动选择' : '直连');
  put('proxyVersion', p.version ? `mihomo ${p.version}` : '', '—');
  put('proxyLastRefresh', p.lastRefreshAt ? formatResetAt(p.lastRefreshAt) : '', '—');
  put('proxyError', p.error, '');
  // 节点被 freebuff 拒（后端已把原因归因到当时在用的节点）。没有记录就整行藏起来。
  // 变量别叫 r：调用日志那边禁止出现 r 点 node 这种字段名，重名会误伤契约测试。
  const reject = $('proxyReject');
  if (reject) {
    const rj = p.reject;
    const why = {
      country_blocked: '地区被封禁', ip_capped: 'IP 触发上限', blocked: '被拒绝访问（403）',
    }[String(rj?.state || '')] || '被拒绝';
    reject.hidden = !rj?.node;
    reject.textContent = rj?.node ? `节点被 freebuff ${why} · ${rj.node} · ${formatResetAt(rj.at)}` : '';
  }
  const msg = $('proxyMessage');
  if (msg) msg.textContent = p.envLocked ? '订阅由环境变量管理，面板仅可查看' : '';
  const subscriptionInput = $('proxySubscription');
  const subscriptionSave = $('proxySubscriptionSave');
  if (subscriptionInput) {
    subscriptionInput.disabled = Boolean(p.envLocked) || state === 'starting';
    subscriptionInput.placeholder = p.envLocked ? '由 SUBSCRIPTION_URL 环境变量管理' : '粘贴订阅链接，保存后自动解析';
  }
  if (subscriptionSave) subscriptionSave.disabled = Boolean(p.envLocked) || state === 'starting';
  // 手动更新按钮：未配置订阅时后端 refreshCore 会静默返回快照（不报错），点了会 toast
  // 一个假的「更新完成」，所以这里拦住。envLocked 不拦——环境变量锁的是改地址，重拉合法。
  const refreshBtn = $('proxyRefresh');
  if (refreshBtn) refreshBtn.disabled = !p.configured || state === 'starting';

  const accountPriority = p.accountSelectionPriority === 'unused' ? 'unused' : 'advanced';
  const accountPriorityToggle = $('accountPriorityToggle');
  if (accountPriorityToggle) {
    const advanced = accountPriority === 'advanced';
    accountPriorityToggle.textContent = advanced ? '优先高级' : '优先未用';
    accountPriorityToggle.classList.toggle('active', advanced);
    accountPriorityToggle.setAttribute('aria-pressed', String(advanced));
    accountPriorityToggle.title = advanced
      ? '当前优先选择高级授权节点，点击切换为优先未用'
      : '当前优先选择未被其他账号使用的节点，点击切换为优先高级';
    accountPriorityToggle.disabled = !p.configured || state === 'starting';
  }
  const accountEgressRefresh = $('accountEgressRefresh');
  if (accountEgressRefresh) accountEgressRefresh.disabled = !p.configured || state === 'starting';

  const rawNodes = Array.isArray(p.nodes) ? p.nodes : [];
  // 后端已按延迟升序排序（失效节点垫底），前端只如实呈现顺序与延迟。
  const nodes = rawNodes.map((node) => typeof node === 'string'
    ? { name: node, healthy: null, delay: null }
    : { name: String(node?.name || node?.id || ''), healthy: node?.healthy ?? null, delay: node?.delay ?? null }
  ).filter((node) => node.name);
  const mode = String(p.mode || p.nodeMode || 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto';
  const selectedNode = String(p.selectedNode || p.currentNode || '');
  const nodeSelect = $('proxyNode');
  if (nodeSelect) {
    const signature = nodes.map((node) => `${node.name}:${node.healthy}:${node.delay ?? ''}`).join('|');
    if (nodeSelect.dataset.signature !== signature) {
      nodeSelect.dataset.signature = signature;
      const values = nodes.length ? nodes : [{ name: '', healthy: null, delay: null }];
      nodeSelect.replaceChildren(...values.map((node) => {
        const option = document.createElement('option');
        option.value = node.name;
        const dot = node.healthy === true ? '● ' : node.healthy === false ? '○ ' : '';
        const delay = Number.isFinite(node.delay) && node.delay > 0 ? ` · ${node.delay}ms` : '';
        option.textContent = node.name ? `${dot}${node.name}${delay}` : '暂无可用节点';
        return option;
      }));
    }
    if (selectedNode && nodes.some((node) => node.name === selectedNode)) nodeSelect.value = selectedNode;
    nodeSelect.disabled = mode !== 'manual' || !nodes.length || state !== 'ready';
  }
  for (const [id, active] of [['proxyModeAuto', mode === 'auto'], ['proxyModeManual', mode === 'manual']]) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.disabled = state !== 'ready';
  }

  const healthEnabled = p.autoHealthCheck ?? p.healthCheck?.enabled ?? false;
  const rawInterval = Number(p.healthCheckInterval ?? p.healthCheck?.interval ?? 600);
  const healthToggle = $('proxyHealthEnabled');
  const healthSelect = $('proxyHealthInterval');
  if (healthToggle) {
    healthToggle.checked = Boolean(healthEnabled);
    healthToggle.disabled = state === 'disabled' || state === 'starting';
  }
  if (healthSelect) {
    // 后端始终以秒返回（上限 86400）。超过上限的才当作误存的毫秒值折算回秒。
    const seconds = rawInterval > 86400 ? Math.round(rawInterval / 1000) : rawInterval;
    syncIntervalSelect(healthSelect, HEALTH_INTERVALS, seconds, 600);
    healthSelect.disabled = !healthEnabled || state === 'disabled' || state === 'starting';
  }

  const updateEnabled = p.autoUpdate ?? p.update?.enabled ?? false;
  const rawUpdateInterval = Number(p.autoUpdateInterval ?? p.update?.interval ?? 21600);
  const updateToggle = $('proxyAutoUpdate');
  const updateSelect = $('proxyUpdateInterval');
  if (updateToggle) {
    updateToggle.checked = Boolean(updateEnabled);
    updateToggle.disabled = state === 'disabled' || state === 'starting';
  }
  if (updateSelect) {
    syncIntervalSelect(updateSelect, UPDATE_INTERVALS, rawUpdateInterval, 21600);
    updateSelect.disabled = !updateEnabled || state === 'disabled' || state === 'starting';
  }
}

// ── 轮询 ────────────────────────────────────────────────

/**
 * 调用日志卡。数据来自 /usage.calls —— 每条成功的上游调用一行，最近的在最前。
 * 详情主行的账号名（.nm）就是那次实际调度到的账号（worker 记录时解析）。
 */
function renderCallLog() {
  const { rows, tokens, ttfb, duration } = callLog(S.usage?.calls);
  // 失败三项来自 totals（逐条只收成功的）。标「累计」：它是开机至今的总数，
  // 和前面「最近 N 条」不是同一个窗口，不标会被当成这 N 条里的失败数
  const totals = S.usage?.totals || {};
  const tc = (k) => fmtCount(totals[k] || 0);
  $('calllog-empty').hidden = rows.length > 0;
  $('calllog-sum').textContent = rows.length
    ? `最近 ${fmtCount(rows.length)} 条 · Token ${fmtTokens(tokens)}`
      // 折叠状态下只看得见这行，两个平均值放这儿：哪次慢展开才知道，
      // 但「整体现在快不快」不该逼人先点开
      + ` · 平均首字 ${fmtDelay(ttfb)} · 平均耗时 ${fmtDelay(duration)}`
      + ` · 累计限流 ${tc('rateLimited')} · 超时 ${tc('timeout')} · 错误 ${tc('upstreamError')}`
    : '';

  // 列表是自己的滚动容器（限高 + 藏起来的滚动条），replaceChildren 清空瞬间
  // scrollTop 会被夹回 0；存回来，否则每次轮询就把人弹回顶部，翻旧记录翻不动
  const ul = $('callLog');
  const top = ul.scrollTop;
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'calllog-row';

    // 时刻在最左：这张表按时间倒序，没有它看不出两行差了多久。
    // 和账号名拆成两个元素 —— 时刻要等宽数字才对得齐，账号名要能省略号截断
    const at = tag('at', fmtClock(r.at));
    const nm = tag('nm', r.account || '—');
    nm.title = r.account;
    const main = document.createElement('div');
    main.className = 'calllog-main';
    main.append(
      at, nm,
      // 模型和强度紧跟账号名 —— 排查透传时要的就是这两个数，挨着看才对得上。
      // 强度 '—' = 没发这个字段（随上游默认），和显式发了 high 是两回事。
      num('模型', r.model || '—'),
      num('强度', r.effort || '—'),
      num('首字', fmtDelay(r.ttfb)),
      num('耗时', fmtDelay(r.ms)),
    );

    const sub = document.createElement('p');
    sub.className = 'sub';
    // Token 总数下来和分项同行：它就是入+出的和，拆两行对不起来。
    // 推理 token 单列：它不计入 total（上游算在 completion 里），但「这次想了
    // 多少」是判断强度有没有生效最直接的一个数
    sub.textContent = `Token ${fmtTokens(r.total)} · 入 ${fmtTokens(r.in)}`
      + ` · 出 ${fmtTokens(r.out)} · 推理 ${fmtTokens(r.reasoning)}`;
    // 哪把 key 发的。只在多 key 场景有意义：主 Key 自己用时这行是噪音，
    // 空值（加多 key 之前的历史行）也不显示。
    if (r.key && r.key !== S.ownerName) sub.textContent += ` · Key ${r.key}`;

    li.append(main, sub);
    return li;
  }));
  ul.scrollTop = top;
}

/**
 * 概况卡（移植自 zen）。数据来自 /usage 的 total·byModel·startTime·lastRequest。
 * 和 renderStats() 刻意分开：那个渲染账号池的存活状态（存活/异常/失效），
 * 这个渲染请求与 token 的累计用量（开机至今，重启清零）。
 */
function renderUsageOverview() {
  const t = S.usage?.total;
  if (!t) return;

  $('s-req').textContent = fmtCount(t.requests);
  $('s-req-sub').textContent = `成功 ${fmtCount(t.success)} · 失败 ${fmtCount(t.fail)}`;

  // 「成功率」三个字由那列的 <h3> 出，这里只填数值与进度条宽度
  const rate = successRate(t);
  $('s-rate').textContent = fmtPercent(rate);
  $('s-rate-bar').style.width = `${(rate ?? 0) * 100}%`;

  $('s-tok').textContent = fmtTokens(t.totalTokens);
  $('s-tok-sub').textContent =
    `输入 ${fmtTokens(t.promptTokens)} · 输出 ${fmtTokens(t.completionTokens)}`
    + ` · 推理 ${fmtTokens(t.reasoningTokens)} · 缓存读 ${fmtTokens(t.cacheReadTokens)}`
    + ` · 缓存写 ${fmtTokens(t.cacheWriteTokens)}`;

  $('s-up').textContent = fmtUptime(Date.now() - (S.usage.startTime || Date.now()));
  $('s-up-sub').textContent = S.usage.lastRequest
    ? `最后请求 ${fmtClock(S.usage.lastRequest)}`
    : '还没有请求';

  renderUsageModels();
}

/**
 * 模型统计格：各模型的**成功**调用次数，按次数降序（排序在 rankBreakdown）。
 * 口径和「调用日志」刻意不同：那张表是最近 200 条的时间线，这一格是开机至今的
 * 累计分布 —— 逐条日志被环形缓冲截断后，早期调用只在这个累计数里还留着。
 */
function renderUsageModels() {
  const rows = rankBreakdown(S.usage?.byModel, 0).filter((row) => !isHiddenModelId(row.key));
  $('s-models-empty').hidden = rows.length > 0;

  const ul = $('s-models');
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const nm = tag('nm', modelName(r.key));
    nm.title = r.key;              // 窄档省略号截断，悬停看全名
    const n = document.createElement('b');
    n.textContent = fmtCount(r.success);
    li.append(nm, n);
    return li;
  }));

  // 行高量出来写进 --row，让 CSS 的「5 行」有准确基准：等宽 <b> 在 baseline 对齐下
  // 行盒更高，calc(5*1.45em) 会差几像素露出第六行的边，交给 JS 量准。
  const first = ul.firstElementChild;
  if (first) {
    const h = first.getBoundingClientRect().height;
    if (h > 0) ul.style.setProperty('--row', `${h}px`);
  }

  // 限高 5 行、滚动条藏了：装不下时给键盘一条路（有 tabindex 才聚焦得了、
  // 方向键才滚得动），正好装得下时不加 —— 不可滚的容器占个 Tab 停留点是白挡路。
  const over = ul.scrollHeight > ul.clientHeight + 1;   // +1 吸收亚像素误差
  if (over) {
    ul.tabIndex = 0;
    ul.setAttribute('role', 'group');
  } else {
    ul.removeAttribute('tabindex');
    ul.removeAttribute('role');
  }
}

async function refresh() {
  try {
    const cfg = await api('/config').catch(() => null);
    const acc = await api('/accounts').catch(() => null);
    const proxy = await api('/proxy').catch(() => null);
    const usage = await api('/usage').catch(() => null);
    const usagePersistence = await api('/usage-persistence').catch(() => null);
    const keys = await api('/keys').catch(() => null);
    if (cfg) {
      S.aliases = cfg.aliases || {};
      S.apiKey = cfg.apiKey || 'freebuff-default-key';
      S.keyRotatable = cfg.keyRotatable !== false;
      S.build = cfg.build || ''; S.buildUrl = cfg.buildUrl || ''; S.repoUrl = cfg.repoUrl || '';
      S.trackRef = cfg.trackRef || '';
      $('key-mask').textContent = S.apiKey.slice(0, 8) + '…';
      renderBuild();
    }
    if (acc) {
      S.accounts = acc.accounts || [];
      S.health = acc.health || {};
      S.accountEgress = acc.egress || {};
      S.readonly = acc.readonly;
    }
    if (proxy) S.proxy = proxy.proxy || proxy;
    if (usage) S.usage = usage;
    if (usagePersistence) {
      const toggle = $('usagePersistence');
      if (toggle) toggle.checked = usagePersistence.enabled === true;
    }
    if (keys) {
      S.keys = keys.keys || [];
      S.keyStats = keys.stats || {};
      S.ownerName = keys.ownerName || S.ownerName;
      S.keysLocked = keys.locked === true;
    }
    // /v1/models 是 worker 路由,带 key 头直连
    const models = await rawApi('/v1/models', { headers: { 'Authorization': 'Bearer ' + S.apiKey } }).catch(() => null);
    if (models) S.models = models.data || [];
    renderStats(); renderAccounts(); renderAliases(); renderKeys(); renderModels(); renderProxy(); renderUsageOverview(); renderCallLog();
    syncColumnBottoms();
  } catch (e) {
    if (e.message !== '未登录') toast('加载失败:' + e.message, 'err');
  }
}

// ── 两列底边对齐 ────────────────────────────────────────
// 右列(概况 + 出口代理)的高度由自己的内容决定,左列的账号表与映射表都是内联滚动区,
// 所以把左列的高度上限钉在「出口代理卡底边」:模型配置卡底边就和它齐平,左列多出来的
// 账号行走滚动,不再把整列顶出去一两百像素。
// 为什么不是纯 CSS:grid 行高想按 min-content 收,得让左列的 min-content 塌下来,
// 但 Chrome 里纵向 flex 容器的 min-content 高度等于 max-content(求最小高度时不压缩
// 子项),给 .col-main 加 min-height:0 也没用 —— 实测行高照旧 1399,只有显式的
// max-height 才收得住。
function syncColumnBottoms() {
  const main = document.querySelector('.col-main');
  const side = document.querySelector('.col-side');
  const anchor = $('proxyCard');            // 右列末卡,它的底边就是对齐基准
  if (!main || !side || !anchor) return;
  main.style.maxHeight = '';                // 先还原,量的是自然高度而不是上一次的上限
  // ≤1200px 时两列变成上下两段(见 style.css 的媒体查询),这时候限高只会白白裁掉内容
  if (Math.abs(side.getBoundingClientRect().top - main.getBoundingClientRect().top) > 1) return;
  const cap = Math.round(anchor.getBoundingClientRect().bottom - main.getBoundingClientRect().top);
  if (cap > 320) main.style.maxHeight = cap + 'px';  // 320 兜底:量出离谱小值就不设上限
}

// 右列自己长高/变矮(节点数、订阅地址换行)或窗口尺寸变化时重算。只观察右列两张卡:
// 它们的高度与上限无关,不会和 maxHeight 互相触发。
function watchColumnBottoms() {
  window.addEventListener('resize', syncColumnBottoms);
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver(() => syncColumnBottoms());
  for (const el of [$('usageCard'), $('proxyCard')]) if (el) ro.observe(el);
}

/**
 * 调用日志的实时刷新。刻意只取 /usage 并只重渲染吃这份数据的两张卡
 * (调用日志 + 运行概况),不走 refresh():那个会连带探账号、拉模型表。
 * 页面切到后台就停,回到前台由 visibilitychange 立刻补一次,不用等下一拍。
 */
let logPolling = false;
async function refreshCallLogLive() {
  if (logPolling || document.hidden) return;  // 上一发没回就跳过,别堆积
  logPolling = true;
  try {
    S.usage = await api('/usage');
    renderUsageOverview(); renderCallLog();
  } catch {
    // 静默:3 秒一次,弹 toast 会刷屏;下一拍自然重试。401 已由 api() 跳登录页
  } finally {
    logPolling = false;
  }
}

// ── 交互 ────────────────────────────────────────────────

function wire() {
  // 分段切换。每个 tablist 各自成组:同页现在有两组(账号池 管理|添加、
  // 模型与 Key 模型与映射|Key 管理),按 .card 划范围,不然点一组会把另一组的
  // 分页一起藏掉。.proxy-mode 是 role="group" 且按钮没有 data-pane,不在此列。
  document.querySelectorAll('.seg[role="tablist"]').forEach((nav) => {
    const segBtns = nav.querySelectorAll('.seg-btn[data-pane]');
    const scope = nav.closest('.card') || document;
    const panes = scope.querySelectorAll(':scope > .pane[data-pane]');
    const activatePane = (btn, focus = false) => {
      const pane = btn.dataset.pane;
      segBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active);
        b.tabIndex = active ? 0 : -1;
      });
      panes.forEach(p => p.hidden = p.dataset.pane !== pane);
      if (focus) btn.focus();
    };
    segBtns.forEach(btn => {
      btn.addEventListener('click', () => activatePane(btn));
      btn.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = [...segBtns].indexOf(btn);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? segBtns.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + segBtns.length) % segBtns.length;
        activatePane(segBtns[next], true);
      });
    });
  });

  // 检查更新:只在点的时候出站(GitHub 匿名 API 每小时 60 次,自动查会烧光)
  $('btn-update').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      const r = await api('/check-update', { method: 'POST' });
      S.latest = r?.latest || '';
      if (r?.error) toast(`检查更新失败:${r.error}`, 'err');
      else if (r?.hasUpdate) toast(`有新版本 ${r.latest} —— 拉取最新代码后重启服务`, 'ok');
      else toast(`已是最新${r?.current ? ` ${r.current}` : ''}`, 'ok');
    } catch (err) {
      toast(`检查更新失败:${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('spin');
      renderBuild();
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* 照样跳 */ }
    location.replace('/');
  });

  // 概况区刷新图标：自动轮询已降到 5 分钟，这里点一下立即拉一次最新数据。
  $('btn-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spin');
    try {
      await refresh();
      toast('已刷新', 'ok');
    } finally {
      btn.disabled = false;
      btn.classList.remove('spin');
    }
  });

  // 账号列表头的眼睛：只切展示，不重新拉数据（静态按钮，只在这里挂一次监听）
  $('maskEmail')?.addEventListener('click', () => {
    S.maskEmail = !S.maskEmail;
    renderAccounts();
  });
  renderMaskToggle();

  $('accountEgressModeAuto')?.addEventListener('click', () => setAccountEgressMode('auto'));
  $('accountEgressModeManual')?.addEventListener('click', () => setAccountEgressMode('manual'));
  $('accountEgressNode')?.addEventListener('change', () => setAccountEgressMode('manual'));
  $('accountEgressCancel')?.addEventListener('click', () => {
    if (!accountEgressSaving) $('accountEgressDialog').close();
  });
  $('accountEgressDialog')?.addEventListener('cancel', (event) => {
    if (accountEgressSaving) event.preventDefault();
  });
  $('accountEgressForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (accountEgressSaving) return;
    const key = accountEgressEditing;
    const account = S.accounts.find((item) => item.key === key);
    if (!key || !account || S.readonly) return;
    const mode = $('accountEgressDialog').dataset.mode === 'manual' ? 'manual' : 'auto';
    const node = $('accountEgressNode').value;
    if (mode === 'manual' && !node) {
      $('accountEgressError').textContent = '请选择节点';
      return;
    }
    const save = $('accountEgressSave');
    accountEgressSaving = true;
    save.textContent = '保存中…';
    setAccountEgressMode(mode);
    $('accountEgressError').textContent = '';
    let succeeded = false;
    try {
      const r = await api('/accounts/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify({ egressMode: mode, egressNode: mode === 'manual' ? node : '' }),
      });
      const saved = r?.account || r?.user || r;
      account.egressMode = saved?.egressMode === 'manual' ? 'manual' : saved?.egressMode === 'auto' ? 'auto' : mode;
      account.egressNode = String(saved?.egressNode ?? (mode === 'manual' ? node : ''));
      if (r?.egress && typeof r.egress === 'object') S.accountEgress[key] = r.egress;
      else if (saved?.egress && typeof saved.egress === 'object') S.accountEgress[key] = saved.egress;
      for (const field of ['egressCurrentNode', 'egressState', 'egressError']) {
        if (saved && Object.hasOwn(saved, field)) account[field] = saved[field];
      }
      renderAccounts();
      succeeded = true;
      toast('出站节点已保存', 'ok');
    } catch (error) {
      $('accountEgressError').textContent = error.message;
    } finally {
      accountEgressSaving = false;
      save.textContent = '保存';
      setAccountEgressMode(mode);
      if (succeeded) {
        $('accountEgressDialog').close();
        accountEgressEditing = null;
        refresh();
      }
    }
  });

  // 接入地址:各协议复制自己的 base URL
  for (const btn of document.querySelectorAll('[data-copy-proto]')) {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.copyProto;
      const base = location.origin;
      const url = p === 'openai' ? `${base}/v1` : base;
      try {
        await navigator.clipboard.writeText(url);
        toast('已复制 ' + (p === 'openai' ? 'OpenAI 地址' : 'Anthropic 地址'));
      } catch { toast('复制失败', 'err'); }
    });
  }

  // 复制 Key(真值来自 config 接口,屏幕只显示掩码)
  const keyBtn = document.querySelector('[data-copy-key]');
  if (keyBtn) {
    keyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(S.apiKey || '');
        toast('已复制 Master Key', 'ok');
      } catch { toast('复制失败', 'err'); }
    });
  }

  // 重置 Master Key:生成新随机 key,旧 key 立即失效
  const resetBtn = document.querySelector('[data-reset-key]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => run(resetBtn, '重置', async () => {
      if (!S.keyRotatable) throw new Error('当前 Key 由环境变量 FREEBUFF_API_KEY 配置,面板不可重置');
      if (!await confirmBox({
        title: '重置 Master Key',
        text: '重置后旧 Master Key 立即失效，正在使用它的客户端需要更新（分享 Key 不受影响）。继续？',
        ok: '重置',
      })) return '已取消';
      const r = await api('/key/rotate', { method: 'POST' });
      S.apiKey = r.apiKey;
      $('key-mask').textContent = S.apiKey.slice(0, 8) + '…';
      return '新 Master Key 已生效';
    }));
  }

  // 代理订阅：完整 URL 只随保存请求发给服务端，后续轮询只接收脱敏地址。
  const proxyForm = $('proxySubscriptionForm');
  const proxySave = $('proxySubscriptionSave');
  if (proxyForm && proxySave) {
    proxyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      run(proxySave, '保存订阅', async () => {
        const value = $('proxySubscription').value.trim();
        let parsed;
        try { parsed = new URL(value); } catch { throw new Error('请输入有效的订阅地址'); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('订阅地址只支持 http 或 https');
        const saved = await api('/proxy/subscription', {
          method: 'PUT', body: JSON.stringify({ url: value }),
        });
        // 后端在这个单一请求内完成持久化、重载 mihomo 与订阅解析。
        S.proxy = saved?.proxy || saved || S.proxy;
        $('proxySubscription').value = '';
        renderProxy();
        return '节点已重新解析';
      });
    });
  }

  // 手动更新订阅：直接复用后端已有的 POST /_api/proxy/refresh（重拉订阅 → 测活 → 按延迟重排节点）。
  $('proxyRefresh')?.addEventListener('click', (event) => run(event.currentTarget, '更新订阅', async () => {
    const r = await api('/proxy/refresh', { method: 'POST' });
    S.proxy = r?.proxy || r || S.proxy;
    renderProxy();
    return Number.isFinite(S.proxy?.nodeCount) ? `解析到 ${S.proxy.nodeCount} 个节点` : '';
  }));

  const saveProxyNode = (btn, mode, node = '') => run(btn, '切换节点', async () => {
    const selected = node || $('proxyNode')?.value || '';
    if (mode === 'manual' && !selected) throw new Error('暂无节点，请先刷新订阅');
    const r = await api('/proxy/node', {
      method: 'PUT', body: JSON.stringify({ mode, node: mode === 'manual' ? selected : '' }),
    });
    S.proxy = r?.proxy || r || S.proxy;
    renderProxy();
    return mode === 'auto' ? '已启用自动选择' : `已固定 ${selected}`;
  });
  $('proxyModeAuto')?.addEventListener('click', (event) => saveProxyNode(event.currentTarget, 'auto'));
  $('proxyModeManual')?.addEventListener('click', (event) => saveProxyNode(event.currentTarget, 'manual'));
  $('accountPriorityToggle')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const current = S.proxy?.accountSelectionPriority === 'unused' ? 'unused' : 'advanced';
    const priority = current === 'advanced' ? 'unused' : 'advanced';
    run(button, '切换账号选点策略', async () => {
      const r = await api('/proxy/account-priority', {
        method: 'PUT', body: JSON.stringify({ priority }),
      });
      S.proxy = r?.proxy || r || S.proxy;
      renderProxy();
      return priority === 'advanced' ? '已设为优先高级' : '已设为优先未用';
    }).finally(() => renderProxy());
  });
  $('accountEgressRefresh')?.addEventListener('click', (event) => run(event.currentTarget, '刷新出站', async () => {
    const r = await api('/proxy/refresh-egress', { method: 'POST' });
    S.proxy = r?.proxy || S.proxy;
    renderProxy();
    return Number.isFinite(r?.refreshedAccounts) ? `已重测 ${r.refreshedAccounts} 个自动账号` : '';
  }));
  $('proxyNode')?.addEventListener('change', async (event) => {
    const select = event.currentTarget;
    const node = select.value;
    if (!node) return;
    select.disabled = true;
    try {
      const r = await api('/proxy/node', {
        method: 'PUT', body: JSON.stringify({ mode: 'manual', node }),
      });
      S.proxy = r?.proxy || r || S.proxy;
      toast(`已切换到 ${node}`, 'ok');
    } catch (e) {
      toast(`切换节点失败:${e.message}`, 'err');
    } finally {
      renderProxy();
      refresh();
    }
  });

  let healthSaving = false;
  const saveProxyHealth = async () => {
    if (healthSaving) return;
    healthSaving = true;
    const toggle = $('proxyHealthEnabled');
    const interval = $('proxyHealthInterval');
    toggle.disabled = true; interval.disabled = true;
    try {
      const r = await api('/proxy/health', {
        method: 'PUT',
        body: JSON.stringify({ enabled: toggle.checked, interval: Number(interval.value) }),
      });
      S.proxy = r?.proxy || r || S.proxy;
      toast('自动测活设置已保存', 'ok');
    } catch (e) {
      toast(`保存测活设置失败:${e.message}`, 'err');
    } finally {
      healthSaving = false;
      renderProxy();
      refresh();
    }
  };
  $('proxyHealthEnabled')?.addEventListener('change', saveProxyHealth);
  $('proxyHealthInterval')?.addEventListener('change', saveProxyHealth);

  let updateSaving = false;
  const saveProxyUpdate = async () => {
    if (updateSaving) return;
    updateSaving = true;
    const toggle = $('proxyAutoUpdate');
    const interval = $('proxyUpdateInterval');
    toggle.disabled = true; interval.disabled = true;
    try {
      const r = await api('/proxy/update', {
        method: 'PUT',
        body: JSON.stringify({ enabled: toggle.checked, interval: Number(interval.value) }),
      });
      S.proxy = r?.proxy || r || S.proxy;
      toast('自动更新设置已保存', 'ok');
    } catch (e) {
      toast(`保存自动更新设置失败:${e.message}`, 'err');
    } finally {
      updateSaving = false;
      renderProxy();
      refresh();
    }
  };
  $('proxyAutoUpdate')?.addEventListener('change', saveProxyUpdate);
  $('proxyUpdateInterval')?.addEventListener('change', saveProxyUpdate);

  // 概况统计持久化开关。只切设置，不连带全量刷新、也不打任何上游接口；
  // 失败恢复旧状态（开关没真正生效，就不能显示成已生效）。
  $('usagePersistence')?.addEventListener('change', async (e) => {
    const toggle = e.currentTarget;
    const prev = !toggle.checked;   // 记录点击前状态，失败时回滚
    toggle.disabled = true;
    try {
      const r = await api('/usage-persistence', {
        method: 'PUT', body: JSON.stringify({ enabled: toggle.checked }),
      });
      // 服务端是唯一真相；回写它确认后的值（正常情况下与 toggle.checked 一致）。
      toggle.checked = r?.enabled === true;
      toast(toggle.checked ? '统计持久化已开启' : '统计持久化已关闭', 'ok');
    } catch (err) {
      toggle.checked = prev;
      toast(`切换持久化失败:${err.message}`, 'err');
    } finally {
      toggle.disabled = false;
    }
  });

  // 手动添加账号
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run($('addBtn'), '添加', async () => {
      const r = await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          authToken: $('authToken').value.trim(),
          email: $('email').value.trim(),
          name: $('name').value.trim(),
        }),
      });
      $('authToken').value = ''; $('email').value = ''; $('name').value = '';
      return r.probe?.label || '已添加';
    });
  });

  // OAuth 登录
  $('oauthStart').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    // 按钮自己承担「现在在等」这个状态，下面的状态行就不用再重复一遍
    btn.textContent = '等待授权';
    $('oauthStatus').textContent = '生成链接中…';
    api('/login/start', { method: 'POST' })
      .then((j) => {
        $('loginUrl').hidden = false;
        $('loginUrlOpen').textContent = j.loginUrl;
        $('loginUrlOpen').onclick = () => window.open(j.loginUrl, '_blank', 'noopener,noreferrer');
        $('oauthStatus').textContent = OAUTH_PENDING;
        pollOauth(j.fingerprintId);
      })
      .catch((err) => {
        $('oauthStatus').textContent = '';
        toast('授权失败:' + err.message, 'err');
        oauthIdle();
      });
  });

  // 复制授权链接（只有图标）。链接不另存变量：框里显示的就是真值，直接读回来
  $('loginUrlCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('loginUrlOpen').textContent || '');
      toast('已复制授权链接');
    } catch { toast('复制失败', 'err'); }
  });

  // 模型映射添加
  $('aliasAdd').addEventListener('click', () => {
    const alias = $('newAlias').value.trim().toLowerCase();
    const target = $('newAliasTarget').value.trim();
    if (!alias || !target) { $('aliasMsg').textContent = '请填写别名和目标模型 ID'; return; }
    if (/\s/.test(alias)) { $('aliasMsg').textContent = '别名不能含空格'; return; }
    saveAliases({ ...S.aliases, [alias]: target }).then(() => {
      $('newAlias').value = ''; $('newAliasTarget').value = '';
    });
  });
  $('newAlias').addEventListener('keydown', e => { if (e.key === 'Enter') $('aliasAdd').click(); });
  $('newAliasTarget').addEventListener('keydown', e => { if (e.key === 'Enter') $('aliasAdd').click(); });

  // 分享 Key：同一个表单管新建与编辑（submit 而不是 click，回车也能提交）
  $('keyForm').addEventListener('submit', (e) => { e.preventDefault(); submitKeyForm(); });
  $('keyCancel').addEventListener('click', () => { resetKeyForm(); $('keyMsg').textContent = ''; });
}

// ── OAuth 轮询 ──────────────────────────────────────────

// 等待期的状态文案只有这一份：轮询那一拍原本写「等待授权…(每 3 秒检测一次)」，
// 现在这句由按钮文字表达，状态行改回这条指引（也顺手把上一拍的报错覆盖掉）
const OAUTH_PENDING = '请在浏览器完成授权,页面将自动检测…';

/** 授权按钮复位。文案和 disabled 必须一起改，漏一处就永远卡在「等待授权」 */
function oauthIdle() {
  const btn = $('oauthStart');
  btn.disabled = false;
  btn.textContent = '开始授权';
}

let oauthTimer = null;
function pollOauth(fingerprintId) {
  clearTimeout(oauthTimer);
  oauthTimer = setTimeout(async () => {
    try {
      const j = await api('/login/poll?fingerprintId=' + encodeURIComponent(fingerprintId));
      if (j.state === 'done') {
        $('oauthStatus').textContent = '登录成功:' + (j.user?.email || '') + ',已加入账号池';
        $('loginUrl').hidden = true;
        oauthIdle();
        refresh();
      } else if (j.state === 'expired') {
        $('oauthStatus').textContent = '链接已过期,请重新开始授权';
        oauthIdle();
      } else {
        $('oauthStatus').textContent = OAUTH_PENDING;
        pollOauth(fingerprintId);
      }
    } catch {
      $('oauthStatus').textContent = '检测失败,3 秒后重试';
      pollOauth(fingerprintId);
    }
  }, 3000);
}

wire();
watchColumnBottoms();
refresh();
setInterval(refresh, POLL_MS);
setInterval(refreshCallLogLive, LOG_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCallLogLive(); });
