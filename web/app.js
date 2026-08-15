/**
 * app.js —— DOM 绑定层。
 * 只做三件事:轮询 /_api/* 填数据、按钮发命令、渲染。
 * 所有逻辑都在这里,不引入框架。
 */

const $ = (id) => document.getElementById(id);
const POLL_MS = 3600000; // 默认 1 小时自动刷新；需要即时数据可点概况区的刷新图标

const S = {
  accounts: [], health: {}, aliases: {},
  models: [], proxy: null,
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
function accountUsage(probe) {
  if (!probe || !Array.isArray(probe.quota) || !probe.quota.length) return null;
  let top = null;
  for (const q of probe.quota) {
    if (typeof q.limit !== 'number') continue;
    if (!top || Number(q.used ?? 0) > Number(top.used ?? 0)) top = q;
  }
  return top;
}

// 可用模型列：只列账号的可用模型 +（池级统一的）重置时间；用量已上移到账号名后。
function modelsCellHtml(probe) {
  if (!probe || !Array.isArray(probe.quota) || !probe.quota.length) return '<span class="quota">—</span>';
  const models = probe.quota.map(q => `<b>${esc(q.model)}</b>`).join('');
  const reset = probe.quota.map(q => q.resetAt).find(Boolean);
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
    const value = String(Number.isFinite(seconds) && seconds > 0 ? seconds : 600);
    if (![...healthSelect.options].some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} 秒`;
      healthSelect.append(option);
    }
    healthSelect.value = value;
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
    const value = String(Number.isFinite(rawUpdateInterval) && rawUpdateInterval > 0 ? rawUpdateInterval : 21600);
    if (![...updateSelect.options].some((option) => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} 秒`;
      updateSelect.append(option);
    }
    updateSelect.value = value;
    updateSelect.disabled = !updateEnabled || state === 'disabled' || state === 'starting';
  }
}

// ── 轮询 ────────────────────────────────────────────────

async function refresh() {
  try {
    const cfg = await api('/config').catch(() => null);
    const acc = await api('/accounts').catch(() => null);
    const proxy = await api('/proxy').catch(() => null);
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
    // /v1/models 是 worker 路由,带 key 头直连
    const models = await rawApi('/v1/models', { headers: { 'Authorization': 'Bearer ' + S.apiKey } }).catch(() => null);
    if (models) S.models = models.data || [];
    renderStats(); renderAccounts(); renderAliases(); renderModels(); renderProxy();
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
