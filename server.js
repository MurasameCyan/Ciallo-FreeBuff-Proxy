import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildInfo, checkUpdate } from './server/build.mjs';
import { initProxy, stopProxy, setLogger, getUpstreamFetch, mihomo } from './server/proxy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// Ciallo-FreeBuff-Proxy 服务端
// ---------------------------------------------------------------------------
// 职责：
//   1. 加载并运行 worker.js（OpenAI / Anthropic / Responses 兼容层）
//   2. Web 管理面板（静态页面 + 会话鉴权）
//   3. 账号池管理 API（查看 / 添加 / 删除 / 探测状态）
//   4. Freebuff 授权码登录代理（POST /api/auth/cli/code + 轮询 status）
//      —— 避免在浏览器直连 codebuff.com，也避免 token 落到前端 JS
// ===========================================================================

// === 配置加载 ===
const env = { ...process.env };

const CFG = {
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '0.0.0.0',
  // Web 管理面板登录密码（未设置时默认空 = 面板不要求密码，仅建议内网使用）
  adminPassword: env.ADMIN_PASSWORD || '',
  // 会话有效期（小时）
  sessionTtlHours: parseFloat(env.ADMIN_SESSION_TTL_HOURS || '24'),
  // 账号池文件路径
  credFile: env.FREEBUFF_CREDENTIALS_FILE || resolve(__dirname, 'credentials/freebuff_credentials.json'),
  // 自定义模型映射文件路径（可选，格式同 MODEL_ALIASES env：别名=模型id 逗号分隔）
  aliasFile: env.MODEL_ALIASES_FILE || resolve(__dirname, 'aliases.json'),
  // 上游（与 worker.js 的 CODEBUFF_API 保持一致）
  codebuffApi: env.CODEBUFF_API || 'https://www.codebuff.com',
  // 是否禁止前端修改账号池（只读部署）
  readonlyAccounts: env.FREEBUFF_READONLY === 'true',
  debug: env.FREEBUFF_DEBUG === 'true',
  // 出口代理订阅地址（可选）。配置后启动 mihomo 内核，上游流量经订阅节点出站。
  // 格式：机场订阅 URL（clash/v2ray base64 均可，mihomo proxy-providers 自动解析）
  subscriptionUrl: env.SUBSCRIPTION_URL || '',
};

// === API Key 持久化（面板「重置 Key」生成的随机 key 存这里，env 未设时生效） ===
const KEY_FILE = resolve(__dirname, 'credentials/server-key.txt');
function currentApiKey() {
  if (env.FREEBUFF_API_KEY) return env.FREEBUFF_API_KEY; // env 显式配置优先
  try {
    const saved = readFileSync(KEY_FILE, 'utf-8').trim();
    if (saved) return saved;
  } catch {}
  return 'freebuff-default-key';
}
function saveApiKey(key) {
  ensureCredDir();
  writeFileSync(KEY_FILE, key + '\n', 'utf-8');
}

// === 账号池存储（JSON 文件，结构对齐 freebuff_tools/extract_freebuff.py） ===
function ensureCredDir() {
  mkdirSync(dirname(CFG.credFile), { recursive: true });
}

function loadAccounts() {
  if (!existsSync(CFG.credFile)) return { accounts: {} };
  try {
    const raw = readFileSync(CFG.credFile, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return { accounts: {} };
    if (obj.accounts && typeof obj.accounts === 'object') return obj;
    // 兼容单账号顶层格式 {authToken, email, id, name}
    if (obj.authToken) return { accounts: { [accountKey(obj)]: obj } };
    return { accounts: {} };
  } catch (e) {
    console.error('[server] load credentials failed:', e.message);
    return { accounts: {} };
  }
}

function accountKey(user) {
  const uid = user?.id || '';
  const email = user?.email || '';
  if (uid) return String(uid);
  if (email) return String(email);
  return 'token-' + (user?.authToken || '').slice(0, 12);
}

function saveAccounts(obj) {
  ensureCredDir();
  const tmp = CFG.credFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  writeFileSync(CFG.credFile, readFileSync(tmp, 'utf-8'), 'utf-8');
}

// 账号列表（含脱敏 token）
function listAccounts() {
  const obj = loadAccounts();
  return Object.entries(obj.accounts || {}).map(([key, u]) => ({
    key,
    id: u.id || key,
    name: u.name || '',
    email: u.email || '',
    token: u.authToken || '',
    tokenShort: (u.authToken || '').slice(0, 8) + '...',
    fingerprintId: u.fingerprintId || '',
    hasToken: Boolean(u.authToken),
  }));
}

// 多账号 token 拼接（喂给 worker.js 的 env.FREEBUFF_TOKEN）
function allTokens() {
  const obj = loadAccounts();
  const toks = [];
  for (const u of Object.values(obj.accounts || {})) {
    if (u.authToken) toks.push(u.authToken.trim());
  }
  return toks;
}

// === Web 面板会话鉴权 ===
const sessions = new Map(); // sessionId -> { exp, createdAt }

function requireAdmin(req, res) {
  const cookie = parseCookies(req);
  const sid = cookie['fbp_session'];
  if (sid && sessions.has(sid) && sessions.get(sid).exp > Date.now()) return true;
  // 未设置 ADMIN_PASSWORD 时，允许直连（内网部署便利，公网请务必设置）
  if (!CFG.adminPassword) return true;
  return false;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function makeSession() {
  const sid = crypto.randomUUID().replace(/-/g, '');
  sessions.set(sid, { exp: Date.now() + CFG.sessionTtlHours * 3600 * 1000, createdAt: Date.now() });
  return sid;
}

// === 简易 JSON 响应 ===
function json(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function err(res, status, message, type = 'api_error') {
  json(res, status, { error: { message, type } });
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// === 上游代理（登录 OAuth + 账号探测），串行队列与 worker.js 保持一致 ===
let chainTail = Promise.resolve();
function enqueueUp(fn) {
  const run = chainTail.then(() => new Promise((r) => setTimeout(r, 300))).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

async function upstreamJson(method, path, token, body, extraHeaders = {}, timeoutMs = 15000) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, extraHeaders);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 走代理（配了订阅时）或直连：getUpstreamFetch() 无代理返回 null → 用全局 fetch
  const upstreamFetch = getUpstreamFetch() || fetch;
  try {
    const resp = await upstreamFetch(CFG.codebuffApi + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: resp.status, data, text };
  } catch (e) {
    return { status: 0, data: null, text: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function enqueueUpstream(method, path, token, body, extraHeaders, timeoutMs) {
  return enqueueUp(() => upstreamJson(method, path, token, body, extraHeaders, timeoutMs));
}

// 账号健康探测：GET /api/v1/freebuff/session（0 消耗，不创建 session）
// 判定规则与 extract_freebuff.py _check_one 一致
async function probeAccount(token) {
  const r = await enqueueUpstream('GET', '/api/v1/freebuff/session', token, undefined,
    { 'x-freebuff-include-unused-rate-limits': '1' });
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  let state = 'unknown', label = '未知', quota = null, retryAfterMs = null;
  const fmtQuota = () => {
    const rl = data.rateLimitsByModel;
    if (!rl || typeof rl !== 'object') return null;
    const rows = [];
    for (const [m, info] of Object.entries(rl)) {
      if (info && typeof info === 'object' && typeof info.recentCount === 'number' && typeof info.limit === 'number') {
        rows.push({ model: m, used: info.recentCount, limit: info.limit, resetAt: info.resetAt || null });
      }
    }
    return rows.length ? rows : null;
  };
  if (r.status === 401) { state = 'token_invalid'; label = 'token 失效'; }
  else if (r.status === 403) {
    if (data.status === 'banned') { state = 'banned'; label = '已被封禁'; }
    else if (data.status === 'country_blocked') { state = 'country_blocked'; label = '地区受限'; }
    else { state = 'blocked'; label = '访问被拒'; }
  } else if (r.status === 429) { state = 'rate_limited'; label = '额度用完'; quota = fmtQuota(); retryAfterMs = data.retryAfterMs || null; }
  else if (r.status === 404) { state = 'ok'; label = '存活（无活跃 session）'; quota = fmtQuota(); }
  else if (r.status === 200) {
    if (data.status === 'banned') { state = 'banned'; label = '已被封禁'; }
    else if (data.status === 'country_blocked') { state = 'country_blocked'; label = '地区受限'; }
    else if (data.status === 'model_locked') { state = 'model_locked'; label = 'session 被锁定'; }
    else if (data.status === 'rate_limited') { state = 'rate_limited'; label = '额度用完'; quota = fmtQuota(); }
    else if (data.status === 'ip_capped') { state = 'ip_capped'; label = 'IP 并发上限'; }
    else { state = 'ok'; label = '存活'; quota = fmtQuota(); }
  } else { state = 'unknown'; label = `HTTP ${r.status}`; }
  return {
    state, label, quota, retryAfterMs,
    uid: data.uid || null,
    accessTier: data.accessTier || null,
    model: data.model || null,
    statusCode: r.status,
    raw: String(r.text || '').slice(0, 500),
  };
}

// === Freebuff 授权码登录（OAuth 代理） ===
// 流程（与官方 CLI 一致）：
//   POST /api/auth/cli/code {fingerprintId} → { loginUrl, fingerprintHash, expiresAt }
//   GET  /api/auth/cli/status?fingerprintId=&fingerprintHash=&expiresAt= → { user: { authToken, email, id, ... } }
// 浏览器拿到 loginUrl 打开完成授权后，轮询本服务（本服务代为轮询上游）。
const loginJobs = new Map(); // fingerprintId -> { fingerprintHash, expiresAt, startedAt, result, done }

function genFingerprint() {
  const rand = crypto.randomBytes(6).toString('base64url').slice(0, 8);
  return `codebuff-cli-${rand}`;
}

// === 静态资源 MIME ===
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  // 防目录穿越
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safe = resolve(__dirname, 'web', rel);
  if (!safe.startsWith(resolve(__dirname, 'web'))) return false;
  if (!existsSync(safe) || !statSync(safe).isFile()) return false;
  const mime = MIME[extname(safe)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(safe));
  return true;
}

// === 主请求入口 ===
const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url, `http://${nodeReq.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // ================= Web 管理 API =================
    if (pathname.startsWith('/_api/')) return handleWebApi(nodeReq, nodeRes, url);

    // ================= 静态页面 =================
    if (nodeReq.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
      if (pathname.startsWith('/static/')) {
        if (!serveStatic(nodeReq, nodeRes, '/' + pathname.slice('/static/'.length))) {
          return json(nodeRes, 404, { error: { message: 'not found' } });
        }
        return;
      }
      // 根路径：若已登录返回面板，否则返回登录页
      const authed = requireAdmin(nodeReq, nodeRes);
      const page = authed ? 'index.html' : 'login.html';
      return serveStatic(nodeReq, nodeRes, '/' + page) || json(nodeRes, 404, { error: { message: 'not found' } });
    }

    // ================= 透明转发给 worker（OpenAI/Anthropic API） =================
    // healthz 免鉴权（worker 内部逻辑）；其余路径由 worker 自己鉴权
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const upstreamUrl = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(upstreamUrl, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
    });

    const workerEnv = buildWorkerEnv();
    const response = await handler.fetch(request, workerEnv);

    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch {
        // 客户端断流正常
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (e) {
    console.error('[server] request error:', e.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) nodeRes.end();
  }
});

// 自定义模型映射：合并 env.MODEL_ALIASES 与 aliases.json（env 优先覆盖同名别名）
function loadModelAliases() {
  const merged = new Map();
  // 1) 文件（若存在且合法）
  try {
    if (existsSync(CFG.aliasFile)) {
      const obj = JSON.parse(readFileSync(CFG.aliasFile, 'utf-8'));
      if (obj && typeof obj === 'object') {
        // 支持两种形态：{aliases:{a:"b"}} 或 {a:"b"}
        const src = obj.aliases && typeof obj.aliases === 'object' ? obj.aliases : obj;
        for (const [k, v] of Object.entries(src)) {
          if (typeof v === 'string' && v.trim()) merged.set(String(k).toLowerCase(), v.trim());
        }
      }
    }
  } catch (e) {
    console.error('[server] load aliases.json failed:', e.message);
  }
  // 2) env（优先覆盖文件同名别名）
  if (env.MODEL_ALIASES) {
    for (const part of String(env.MODEL_ALIASES).split(',')) {
      const kv = part.trim().split('=');
      if (kv.length === 2 && kv[0].trim() && kv[1].trim()) merged.set(kv[0].trim().toLowerCase(), kv[1].trim());
    }
  }
  return merged;
}

// worker.js 读取的 env（含动态账号池 → FREEBUFF_TOKEN）
function buildWorkerEnv() {
  const tokens = allTokens();
  const envTokens = (env.FREEBUFF_TOKEN || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  for (const t of envTokens) if (!tokens.includes(t)) tokens.push(t);
  // 模型映射序列化（worker.js parseModelAliases 逆解析）
  const aliasStr = [...loadModelAliases().entries()].map(([k, v]) => `${k}=${v}`).join(',');
  return {
    FREEBUFF_TOKEN: tokens.join(','),
    FREEBUFF_API_KEY: currentApiKey(),
    API_KEY: env.API_KEY || '',
    FREEBUFF_DEBUG: env.FREEBUFF_DEBUG || 'false',
    CODEBUFF_API: env.CODEBUFF_API || '',
    RELAY_KEY: env.RELAY_KEY || '',
    MODEL_ALIASES: aliasStr,
    // 出口代理注入（有订阅且 mihomo 就绪时返回走代理的 fetch；否则 undefined → worker 直连）
    FREEBUFF_UPSTREAM_FETCH: getUpstreamFetch() || undefined,
  };
}

// === Web 管理 API 路由 ===
async function handleWebApi(req, res, url) {
  const method = req.method;
  const path = url.pathname.replace(/^\/_api\//, '').replace(/\/+$/, '');
  const [seg, sub] = path.split('/');

  // ---------- 登录 / 登出 ----------
  if (path === 'login' && method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf-8') || '{}'); } catch { return err(res, 400, 'Invalid JSON'); }
    if (CFG.adminPassword) {
      if (body.password !== CFG.adminPassword) return err(res, 401, '密码错误', 'auth_error');
    }
    const sid = makeSession();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `fbp_session=${sid}; Path=/; HttpOnly; Max-Age=${CFG.sessionTtlHours * 3600}`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (path === 'logout' && method === 'POST') {
    const cookie = parseCookies(req);
    if (cookie['fbp_session']) sessions.delete(cookie['fbp_session']);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'fbp_session=; Path=/; HttpOnly; Max-Age=0',
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (path === 'status' && method === 'GET') {
    const authed = requireAdmin(req, res);
    return json(res, 200, { authed, passwordRequired: Boolean(CFG.adminPassword) });
  }

  // ---------- 以下接口需要管理员会话 ----------
  if (!requireAdmin(req, res)) return err(res, 401, '未登录或会话已过期', 'auth_error');

  // 账号池
  if (seg === 'accounts') {
    if (method === 'GET' && !sub) {
      const accounts = listAccounts();
      const health = {};
      // 并发探测（受上游串行队列约束，内部自动排队）
      for (const acct of accounts) {
        if (acct.hasToken) health[acct.key] = await probeAccount(acct.token);
      }
      return json(res, 200, { accounts, health, readonly: CFG.readonlyAccounts });
    }
    if (method === 'POST' && !sub) {
      if (CFG.readonlyAccounts) return err(res, 403, '账号池为只读模式', 'readonly');
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf-8') || '{}'); } catch { return err(res, 400, 'Invalid JSON'); }
      const authToken = String(body.authToken || '').trim();
      const email = String(body.email || '').trim();
      const name = String(body.name || '').trim();
      if (authToken.length < 20) return err(res, 400, 'authToken 无效（长度不足）', 'invalid_token');
      const obj = loadAccounts();
      const key = accountKey({ id: body.id, email: email || undefined, authToken });
      const existing = obj.accounts[key] || {};
      obj.accounts[key] = {
        id: body.id || existing.id || key,
        name: name || existing.name || '',
        email: email || existing.email || '',
        authToken,
        fingerprintId: body.fingerprintId || existing.fingerprintId || '',
        ...(body.extra && typeof body.extra === 'object' ? body.extra : {}),
      };
      saveAccounts(obj);
      const probe = await probeAccount(authToken);
      return json(res, 200, { ok: true, key, probe });
    }
    if (method === 'DELETE' && sub) {
      if (CFG.readonlyAccounts) return err(res, 403, '账号池为只读模式', 'readonly');
      const obj = loadAccounts();
      const key = decodeURIComponent(sub);
      if (!obj.accounts[key]) return err(res, 404, '账号不存在', 'not_found');
      delete obj.accounts[key];
      saveAccounts(obj);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && sub) {
      // 探测单个账号
      const accounts = listAccounts();
      const acct = accounts.find((a) => a.key === decodeURIComponent(sub));
      if (!acct || !acct.hasToken) return err(res, 404, '账号不存在', 'not_found');
      return json(res, 200, await probeAccount(acct.token));
    }
    return err(res, 405, 'method not allowed');
  }

  // ---------- Freebuff 授权码登录（OAuth） ----------
  if (seg === 'login') {
    if (method === 'POST' && sub === 'start') {
      // 1) 向 codebuff 请求授权 URL
      const fingerprintId = genFingerprint();
      const r = await enqueueUpstream('POST', '/api/auth/cli/code', null, { fingerprintId });
      if (r.status !== 200 || !r.data || !r.data.loginUrl) {
        return err(res, 502, '请求授权 URL 失败: ' + String(r.text || r.status).slice(0, 300), 'upstream_error');
      }
      loginJobs.set(fingerprintId, {
        fingerprintHash: r.data.fingerprintHash,
        expiresAt: r.data.expiresAt,
        startedAt: Date.now(),
        result: null, done: false,
      });
      // 清理超时任务（10 分钟）
      for (const [k, v] of loginJobs) if (Date.now() - v.startedAt > 10 * 60 * 1000) loginJobs.delete(k);
      return json(res, 200, {
        fingerprintId,
        loginUrl: r.data.loginUrl,
        expiresAt: r.data.expiresAt,
      });
    }
    if (method === 'GET' && sub === 'poll') {
      const fingerprintId = url.searchParams.get('fingerprintId') || '';
      const job = loginJobs.get(fingerprintId);
      if (!job) return json(res, 200, { state: 'expired' });
      if (job.done) return json(res, 200, { state: 'done', user: sanitizeUser(job.result) });
      // 轮询上游
      const q = `?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(job.fingerprintHash)}&expiresAt=${encodeURIComponent(job.expiresAt)}`;
      const rr = await enqueueUpstream('GET', '/api/auth/cli/status' + q, null, undefined, undefined, 10000);
      if (rr.status === 200 && rr.data && rr.data.user && rr.data.user.authToken) {
        job.done = true;
        job.result = rr.data.user;
        // 自动保存到账号池（分键追加）
        if (!CFG.readonlyAccounts) {
          const obj = loadAccounts();
          const user = rr.data.user;
          const key = accountKey(user);
          obj.accounts[key] = {
            id: user.id || key,
            name: user.name || '',
            email: user.email || '',
            authToken: user.authToken,
            fingerprintId,
          };
          saveAccounts(obj);
        }
        return json(res, 200, { state: 'done', user: sanitizeUser(rr.data.user) });
      }
      if (rr.status === 401) return json(res, 200, { state: 'pending' });
      if (rr.status === 400) { job.done = true; return json(res, 200, { state: 'expired' }); }
      return json(res, 200, { state: 'pending', note: 'status ' + rr.status });
    }
    return err(res, 405, 'method not allowed');
  }

  // ---------- 其他 ----------
  if (seg === 'config' && method === 'GET') {
    const workerApiKey = currentApiKey();
    return json(res, 200, {
      readonly: CFG.readonlyAccounts,
      debug: CFG.debug,
      version: '2.0.0',
      modelCount: 0,
      apiKey: workerApiKey,
      // env 配置的 key 是否允许面板重置（env 显式配置时不重置，改它会和部署环境冲突）
      keyRotatable: !env.FREEBUFF_API_KEY,
      // 自定义模型映射（只读展示；编辑走 aliases.json / env）
      aliases: Object.fromEntries(loadModelAliases()),
      aliasesFile: CFG.aliasFile,
      // build / buildUrl / repoUrl / trackRef：面板右上角那个 hash 徽标。
      // 搭 config 轮询的车带过去，不另开一个路由 —— 它是常量，不值得再来一次请求
      ...buildInfo(),
    });
  }

  // ---------- 检查更新（只在用户点的时候出站，消耗 GitHub 匿名配额） ----------
  // 错误统一走返回值的 error 字段（HTTP 仍 200）：检查失败不该让按钮变成 500，
  // 「为什么失败」要能显示给用户看（限流 / 分支不存在 / 网络）。
  if (seg === 'check-update' && method === 'POST') {
    const r = await checkUpdate();
    return json(res, 200, r);
  }

  // ---------- API Key 重置（生成随机 key，写入 credentials/server-key.txt） ----------
  if (seg === 'key' && sub === 'rotate' && method === 'POST') {
    if (env.FREEBUFF_API_KEY) return err(res, 403, 'FREEBUFF_API_KEY 由环境变量配置，面板不可重置', 'readonly_key');
    const key = 'fb-' + crypto.randomBytes(24).toString('base64url');
    try {
      saveApiKey(key);
    } catch (e) {
      return err(res, 500, '写入 key 失败: ' + e.message, 'io_error');
    }
    return json(res, 200, { ok: true, apiKey: key });
  }

  // ---------- 自定义模型映射管理（写入 aliases.json，热生效） ----------
  if (seg === 'aliases') {
    if (method === 'GET') {
      return json(res, 200, { aliases: Object.fromEntries(loadModelAliases()), file: CFG.aliasFile });
    }
    if (method === 'PUT') {
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf-8') || '{}'); } catch { return err(res, 400, 'Invalid JSON'); }
      const next = {};
      for (const [k, v] of Object.entries(body.aliases || {})) {
        const alias = String(k).trim().toLowerCase();
        const modelId = String(v || '').trim();
        if (!alias || !modelId) continue;
        // 校验目标模型存在（静态 MODELS / 动态表 / 其它别名均不接受，避免自引用环）
        next[alias] = modelId;
      }
      try {
        mkdirSync(dirname(CFG.aliasFile), { recursive: true });
        const tmp = CFG.aliasFile + '.tmp';
        writeFileSync(tmp, JSON.stringify({ aliases: next }, null, 2) + '\n', 'utf-8');
        writeFileSync(CFG.aliasFile, readFileSync(tmp, 'utf-8'), 'utf-8');
      } catch (e) {
        return err(res, 500, '写入 aliases.json 失败: ' + e.message, 'io_error');
      }
      return json(res, 200, { ok: true, aliases: next, file: CFG.aliasFile });
    }
    return err(res, 405, 'method not allowed');
  }

  return err(res, 404, 'not found');
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id || '',
    name: user.name || '',
    email: user.email || '',
    authToken: user.authToken || '',
    credits: user.credits ?? null,
  };
}

// ===========================================================================
// 启动
// ===========================================================================
ensureCredDir();

// 出口代理（可选）：配了 SUBSCRIPTION_URL 才起 mihomo，否则保持直连。
// mihomo 就绪后 getUpstreamFetch() 返回走代理的 fetch，注入 worker env。
if (CFG.subscriptionUrl) {
  setLogger((level, msg) => console.log(`[${level}] ${msg}`));
  await initProxy(CFG.subscriptionUrl)
    .then(() => console.log(`[ciallo] proxy: mihomo @ mixed-port ${mihomo.mixedPort} (ctrl ${mihomo.ctrlPort})`))
    .catch((e) => console.error(`[ciallo] proxy 初始化失败(保持直连): ${e.message}`));
} else {
  console.log('[ciallo] proxy: 未配置 SUBSCRIPTION_URL，上游直连');
}

// 加载 worker（顶层 await，Node 20+ 支持）
const worker = await import('./worker.js');
const handler = worker.default;

server.listen(CFG.port, CFG.host, () => {
  const n = listAccounts().length;
  console.log(`[ciallo] listening on http://${CFG.host}:${CFG.port}`);
  console.log(`[ciallo] web panel: http://localhost:${CFG.port}/  (admin password: ${CFG.adminPassword ? 'set' : 'NOT SET (内网建议设置)'})`);
  console.log(`[ciallo] accounts: ${n} (file: ${CFG.credFile})`);
});

// 优雅退出：停 mihomo（容器 SIGTERM 时）
process.on('SIGTERM', async () => {
  console.log('[ciallo] SIGTERM, 正在退出...');
  try { await stopProxy(); } catch {}
  process.exit(0);
});
process.on('SIGINT', async () => {
  try { await stopProxy(); } catch {}
  process.exit(0);
});
