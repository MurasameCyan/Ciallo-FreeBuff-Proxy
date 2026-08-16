/**
 * app.js —— DOM 绑定层。
 * 只做三件事:轮询 /_api/* 填数据、按钮发命令、渲染。
 * 所有逻辑都在这里,不引入框架。
 */

const $ = (id) => document.getElementById(id);
const POLL_MS = 3600000; // 默认 1 小时自动刷新；需要即时数据可点概况区的刷新图标

const S = {
  accounts: [], health: {}, aliases: {},
  models: [], proxy: null, usage: null,
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

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
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

function statePill(s) {
  const map = {
    ok: ['ok', '存活'], token_invalid: ['danger', '失效'], banned: ['danger', '封禁'],
    country_blocked: ['warn', '受限'], rate_limited: ['warn', '额度用完'],
    model_locked: ['warn', '锁定'], ip_capped: ['warn', 'IP 上限'],
    blocked: ['warn', '拒绝'], unknown: ['muted', '未知'],
  };
  const [cls, label] = map[s] || ['muted', s];
  return `<span class="pill ${cls}"><span class="dot ${cls}"></span>${label}</span>`;
}

// 额度是「池级」共享计数：同一池（STANDARD=flash/mimo、PREMIUM 等）下所有模型
// 共用一份每日次数，因此免费号的可用模型用量完全一致、每日 07:00 UTC 统一重置。
// 账号级用量取用量最高的池呈现（免费号只有一个池，等价于账号通用）。
// 「可用池」= 有真实额度（limit>0）。免费号里 glm-5.2 等未解锁模型上游会以 0/0
// （limit=0）返回，既非真正可用、又会污染账号用量取值，这里统一滤掉。
function usableQuota(probe) {
  if (!probe || !Array.isArray(probe.quota)) return [];
  return probe.quota.filter((q) => Number(q.limit) > 0);
}

function accountUsage(probe) {
  const rows = usableQuota(probe);
  if (!rows.length) return null;
  let top = null;
  for (const q of rows) {
    if (!top || Number(q.used ?? 0) > Number(top.used ?? 0)) top = q;
  }
  return top;
}

// 可用模型列：只列真正有额度（limit>0）的模型 +（池级统一的）重置时间；0/0 未解锁
// 模型（如免费号的 glm-5.2）直接隐藏。用量已上移到账号名后。
function modelsCellHtml(probe) {
  const rows = usableQuota(probe);
  if (!rows.length) return '<span class="quota">—</span>';
  const models = rows.map(q => `<b>${esc(q.model)}</b>`).join('');
  const reset = rows.map(q => q.resetAt).find(Boolean);
  const resetHtml = reset ? `<span class="quota-reset">重置 ${esc(formatResetAt(reset))}</span>` : '';
  return `<div class="quota"><div class="quota-models">${models}</div>${resetHtml}</div>`;
}

// ISO 时间戳（2026-08-16T07:00:00.000Z）→ 固定北京时间（UTC+8）YYYY-MM-DD HH:mm。
// 额度按上游太平洋日 07:00 UTC 每日结算（= 北京 15:00），这里显式折算到东八区，
// 不依赖浏览器/服务器所在时区，任何环境下都稳定显示北京时间。
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

function renderAccounts() {
  const table = document.querySelector('.account-table');
  table.classList.toggle('is-empty', S.accounts.length === 0);
  $('acctCount').textContent = `${S.accounts.length} 个`;
  if (!S.accounts.length) {
    $('acctBody').innerHTML = '<tr><td colspan="4" class="empty">暂无账号，请切换到「添加」</td></tr>';
    return;
  }
  $('acctBody').innerHTML = S.accounts.map(a => {
    const h = S.health[a.key];
    const usage = accountUsage(h);
    const usageHtml = usage
      ? ` <span class="acct-usage" title="已用 / 总量（每日额度，池级共享）">( ${esc(usage.used ?? '—')} / ${esc(usage.limit ?? '—')} )</span>`
      : '';
    return `<tr>
      <td>
        <div class="nm">${esc(a.name || a.email || a.key)}${usageHtml}</div>
        <div class="mono">${esc(a.email || '')}</div>
        <div class="mono">${esc(a.tokenShort || '')}</div>
      </td>
      <td>${h ? statePill(h.state) : '<span class="pill muted">未探测</span>'}</td>
      <td>${modelsCellHtml(h)}</td>
      <td>
        <div class="actions">
          <button class="btn tiny" data-probe="${esc(a.key)}">探测</button>
          ${S.readonly ? '' : `<button class="btn tiny danger" data-del="${esc(a.key)}">删除</button>`}
        </div>
      </td>
    </tr>`;
  }).join('');

  $('acctBody').querySelectorAll('[data-probe]').forEach(b =>
    b.addEventListener('click', () => run(b, '探测', async () => {
      const h = await api('/accounts/' + encodeURIComponent(b.dataset.probe));
      S.health[b.dataset.probe] = h;
      renderAccounts(); renderStats();
      return h.label || h.state;
    })));
  $('acctBody').querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('确认删除账号 ' + b.dataset.del.slice(0, 20) + '…？')) return;
      try {
        await api('/accounts/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        toast('已删除', 'ok');
        refresh();
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
     <td><button class="btn tiny danger" data-adel="${esc(k)}">删除</button></td></tr>`
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

function renderModels() {
  const ul = $('models');
  const list = Array.isArray(S.models) ? S.models : [];
  const modelCount = $('modelCount');
  if (modelCount) modelCount.textContent = `${list.length} 个`;
  $('models-empty').hidden = list.length > 0;
  ul.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    li.textContent = m.id;
    li.title = li.textContent;
    // 只有免费账号实测可用的模型打“免费”胶囊；其余模型不带任何 tag
    if (m.free) li.append(' ', tag('pill free', '免费'));
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
  const msg = $('proxyMessage');
  if (msg) msg.textContent = p.envLocked ? '订阅由环境变量管理，面板仅可查看' : '';
  const subscriptionInput = $('proxySubscription');
  const subscriptionSave = $('proxySubscriptionSave');
  if (subscriptionInput) {
    subscriptionInput.disabled = Boolean(p.envLocked) || state === 'starting';
    subscriptionInput.placeholder = p.envLocked ? '由 SUBSCRIPTION_URL 环境变量管理' : '粘贴订阅链接，保存后自动解析';
  }
  if (subscriptionSave) subscriptionSave.disabled = Boolean(p.envLocked) || state === 'starting';

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
  const rows = rankBreakdown(S.usage?.byModel, 0);
  $('s-models-empty').hidden = rows.length > 0;

  const ul = $('s-models');
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const nm = tag('nm', r.key);
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
    if (cfg) {
      S.aliases = cfg.aliases || {};
      S.apiKey = cfg.apiKey || 'freebuff-default-key';
      S.keyRotatable = cfg.keyRotatable !== false;
      S.build = cfg.build || ''; S.buildUrl = cfg.buildUrl || ''; S.repoUrl = cfg.repoUrl || '';
      S.trackRef = cfg.trackRef || '';
      $('key-mask').textContent = S.apiKey.slice(0, 8) + '…';
      renderBuild();
    }
    if (acc) { S.accounts = acc.accounts || []; S.health = acc.health || {}; S.readonly = acc.readonly; }
    if (proxy) S.proxy = proxy.proxy || proxy;
    if (usage) S.usage = usage;
    // /v1/models 是 worker 路由,带 key 头直连
    const models = await rawApi('/v1/models', { headers: { 'Authorization': 'Bearer ' + S.apiKey } }).catch(() => null);
    if (models) S.models = models.data || [];
    renderStats(); renderAccounts(); renderAliases(); renderModels(); renderProxy(); renderUsageOverview(); renderCallLog();
  } catch (e) {
    if (e.message !== '未登录') toast('加载失败:' + e.message, 'err');
  }
}

// ── 交互 ────────────────────────────────────────────────

function wire() {
  // 账号池分段切换:管理 | 添加
  const segBtns = document.querySelectorAll('.seg-btn[data-pane]');
  const panes = document.querySelectorAll('.pane[data-pane]');
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
        toast('已复制 Key', 'ok');
      } catch { toast('复制失败', 'err'); }
    });
  }

  // 重置 Key:生成新随机 key,旧 key 立即失效
  const resetBtn = document.querySelector('[data-reset-key]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => run(resetBtn, '重置', async () => {
      if (!S.keyRotatable) throw new Error('当前 Key 由环境变量 FREEBUFF_API_KEY 配置,面板不可重置');
      if (!confirm('重置后旧 Key 立即失效,正在使用该 Key 的客户端需要更新。继续?')) return '已取消';
      const r = await api('/key/rotate', { method: 'POST' });
      S.apiKey = r.apiKey;
      $('key-mask').textContent = S.apiKey.slice(0, 8) + '…';
      return '新 Key 已生效';
    }));
  }

  // 全部探测
  $('btn-testall').addEventListener('click', () => run($('btn-testall'), '探测', async () => {
    const acc = await api('/accounts');
    S.accounts = acc.accounts; S.health = acc.health; S.readonly = acc.readonly;
    renderStats(); renderAccounts();
    const alive = Object.values(S.health).filter(h => h.state === 'ok').length;
    return `${alive}/${S.accounts.length} 存活`;
  }));

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
    $('oauthStatus').textContent = '生成链接中…';
    api('/login/start', { method: 'POST' })
      .then((j) => {
        $('loginUrl').hidden = false;
        $('loginUrl').textContent = j.loginUrl;
        $('loginUrl').onclick = () => window.open(j.loginUrl, '_blank');
        $('oauthStatus').textContent = '请在浏览器完成授权,页面将自动检测…';
        pollOauth(j.fingerprintId);
      })
      .catch((err) => {
        $('oauthStatus').textContent = '';
        toast('授权失败:' + err.message, 'err');
        btn.disabled = false;
      });
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
}

// ── OAuth 轮询 ──────────────────────────────────────────

let oauthTimer = null;
function pollOauth(fingerprintId) {
  clearTimeout(oauthTimer);
  oauthTimer = setTimeout(async () => {
    try {
      const j = await api('/login/poll?fingerprintId=' + encodeURIComponent(fingerprintId));
      if (j.state === 'done') {
        $('oauthStatus').textContent = '登录成功:' + (j.user?.email || '') + ',已加入账号池';
        $('loginUrl').hidden = true;
        $('oauthStart').disabled = false;
        refresh();
      } else if (j.state === 'expired') {
        $('oauthStatus').textContent = '链接已过期,请重新开始授权';
        $('oauthStart').disabled = false;
      } else {
        $('oauthStatus').textContent = '等待授权…(每 3 秒检测一次)';
        pollOauth(fingerprintId);
      }
    } catch {
      $('oauthStatus').textContent = '检测失败,3 秒后重试';
      pollOauth(fingerprintId);
    }
  }, 3000);
}

wire();
refresh();
setInterval(refresh, POLL_MS);
