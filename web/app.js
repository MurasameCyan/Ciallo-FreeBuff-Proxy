/**
 * app.js —— DOM 绑定层。
 * 只做三件事:轮询 /_api/* 填数据、按钮发命令、渲染。
 * 所有逻辑都在这里,不引入框架。
 */

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;

const S = {
  accounts: [], health: {}, aliases: {},
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

function quotaHtml(probe) {
  if (!probe || !probe.quota || !probe.quota.length) return '<span class="quota">—</span>';
  return '<div class="quota">' + probe.quota.map(q =>
    `<div><b>${esc(q.model)}</b> ${q.used}/${q.limit}${q.resetAt ? '<br><span>' + esc(q.resetAt) + '</span>' : ''}</div>`
  ).join('') + '</div>';
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
  $('acctCount').textContent = `${S.accounts.length} 个`;
  if (!S.accounts.length) {
    $('acctBody').innerHTML = '<tr><td colspan="4" class="empty">暂无账号,在「配置」里添加</td></tr>';
    return;
  }
  $('acctBody').innerHTML = S.accounts.map(a => {
    const h = S.health[a.key];
    return `<tr>
      <td>
        <div class="nm">${esc(a.name || a.email || a.key)}</div>
        <div class="mono">${esc(a.email || '')}</div>
        <div class="mono">${esc(a.tokenShort || '')}</div>
      </td>
      <td>${h ? statePill(h.state) : '<span class="pill muted">未探测</span>'}</td>
      <td>${quotaHtml(h)}</td>
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
  $('models-empty').hidden = list.length > 0;
  ul.replaceChildren(...list.map((m) => {
    const li = document.createElement('li');
    li.textContent = m.owned_by && m.owned_by.startsWith('alias→')
      ? `${m.id} ⟶ ${m.owned_by.slice(6)}`
      : m.id;
    li.title = li.textContent;
    if (m.owned_by && m.owned_by.startsWith('alias→')) li.classList.add('alias');
    return li;
  }));
  // 溢出项给键盘可达
  for (const li of ul.children) {
    if (li.scrollWidth > li.clientWidth + 1) li.tabIndex = 0;
  }
}

// ── 轮询 ────────────────────────────────────────────────

async function refresh() {
  try {
    const cfg = await api('/config').catch(() => null);
    const acc = await api('/accounts').catch(() => null);
    if (cfg) {
      S.aliases = cfg.aliases || {};
      S.apiKey = cfg.apiKey || 'freebuff-default-key';
      $('verBadge').textContent = 'v' + (cfg.version || '—');
      $('key-mask').textContent = S.apiKey.slice(0, 8) + '…';
    }
    if (acc) { S.accounts = acc.accounts || []; S.health = acc.health || {}; S.readonly = acc.readonly; }
    // /v1/models 是 worker 路由,带 key 头直连
    const models = await rawApi('/v1/models', { headers: { 'Authorization': 'Bearer ' + S.apiKey } }).catch(() => null);
    if (models) S.models = models.data || [];
    renderStats(); renderAccounts(); renderAliases(); renderModels();
  } catch (e) {
    if (e.message !== '未登录') toast('加载失败:' + e.message, 'err');
  }
}

// ── 交互 ────────────────────────────────────────────────

function wire() {
  $('refreshBtn').addEventListener('click', refresh);

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* 照样跳 */ }
    location.replace('/');
  });

  $('copyTokens').addEventListener('click', async () => {
    const toks = S.accounts.filter(a => a.hasToken).map(a => a.token).join('\n');
    if (!toks) return toast('没有可复制的 token', 'err');
    try {
      await navigator.clipboard.writeText(toks);
      toast('已复制 ' + S.accounts.filter(a => a.hasToken).length + ' 个 token');
    } catch { toast('复制失败', 'err'); }
  });

  // 接入地址:两个协议各复制自己的 base URL
  for (const btn of document.querySelectorAll('[data-copy-proto]')) {
    btn.addEventListener('click', async () => {
      const p = btn.dataset.copyProto;
      const base = location.origin;
      const url = p === 'openai' ? `${base}/v1` : p === 'anthropic' ? base : `${base}/v1/responses`;
      try {
        await navigator.clipboard.writeText(url);
        toast('已复制 ' + (p === 'openai' ? 'OpenAI 地址' : p === 'anthropic' ? 'Anthropic 地址' : 'Responses 地址'));
      } catch { toast('复制失败', 'err'); }
    });
  }

  // 复制 API Key(真值来自 config 接口,屏幕只显示掩码)
  const keyBtn = document.querySelector('[data-copy-key]');
  if (keyBtn) {
    keyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(S.apiKey || '');
        toast('已复制 API Key', 'ok');
      } catch { toast('复制失败', 'err'); }
    });
  }

  // 全部探测
  $('btn-testall').addEventListener('click', () => run($('btn-testall'), '探测', async () => {
    const acc = await api('/accounts');
    S.accounts = acc.accounts; S.health = acc.health; S.readonly = acc.readonly;
    renderStats(); renderAccounts();
    const alive = Object.values(S.health).filter(h => h.state === 'ok').length;
    return `${alive}/${S.accounts.length} 存活`;
  }));

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
