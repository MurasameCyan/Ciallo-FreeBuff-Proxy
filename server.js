import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildInfo, checkUpdate } from './server/build.mjs';
import { createAccountStateStore } from './server/account-state.mjs';
import { forwardWorkerRequest } from './server/http-adapter.mjs';
import {
  initProxy,
  stopProxy,
  setLogger,
  getUpstreamFetch,
  getProxyStatus,
  setProxySubscription,
  setProxyNode,
  setAccountProxySelectionPriority,
  setProxyHealth,
  setProxyUpdate,
  refreshSubscription,
  getConfiguredSubscription,
  isProxyEnvLocked,
  mihomo,
  noteEgressReject,
  ACCOUNT_EGRESS_LANE_COUNT,
  setAccountProxyNode,
  selectAccountProxyNodeAuto,
  releaseAccountProxyLane,
  getAccountUpstreamFetch,
  getAccountAutoUpstreamFetch,
  getAccountProxyNode,
  getAccountProxyGeneration,
  getAccountEgressReject,
  inferNodeRegion,
  classifyAccountProbeAuthorization,
  setAccountAutoRefreshHandler,
} from './server/proxy.mjs';
import { createUsagePersistence } from './server/usage-persistence.mjs';
import { createApiKeyStore, OWNER_KEY_NAME } from './server/api-keys.mjs';
import { closeHttpServer } from './server/graceful-shutdown.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 时区默认上海：镜像里 ENV TZ 也写了这一行的值，但已在跑的容器改不了 env
// （要 docker run 重建），而给用户看的时间（会话解锁时间点等）不能是 UTC。
// Node 22 支持运行时改 TZ（会重置内部缓存），且 node:alpine 不装 tzdata 也能解析
// 命名时区（ICU 自带 tz 数据）。显式传 TZ 的部署照旧生效。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';

// 持久化数据目录：账号池、API Key、模型映射、mihomo 缓存都放这里。
// Docker 里是挂载的 /data 卷（容器内以 node 用户运行，/app 只读写不进）；
// 本地开发默认 ./data。FREEBUFF_DATA_DIR 显式设置优先。
// 容器检测：/.dockerenv 是 docker 创建的标记文件（非 Windows 虚拟根映射）。
function isDocker() {
  try {
    return existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
const DATA_DIR = process.env.FREEBUFF_DATA_DIR
  || (isDocker() ? '/data' : resolve(__dirname, 'data'));
function dataFile(...parts) {
  return resolve(DATA_DIR, ...parts);
}

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
  // 账号池文件路径（数据目录可写，Docker 里是 /data 卷）
  credFile: env.FREEBUFF_CREDENTIALS_FILE || dataFile('credentials', 'freebuff_credentials.json'),
  // 账号封禁/凭据失效状态（只保存 token 哈希）
  accountStateFile: env.FREEBUFF_ACCOUNT_STATE_FILE || dataFile('credentials', 'account-state.json'),
  // 自定义模型映射文件路径（面板可改，需落盘 → 放数据目录。格式同 MODEL_ALIASES env：别名=模型id 逗号分隔）
  aliasFile: env.MODEL_ALIASES_FILE || dataFile('aliases.json'),
  // 上游（与 worker.js 的 CODEBUFF_API 保持一致）
  codebuffApi: env.CODEBUFF_API || 'https://www.codebuff.com',
  // 是否禁止前端修改账号池（只读部署）
  readonlyAccounts: env.FREEBUFF_READONLY === 'true',
  debug: env.FREEBUFF_DEBUG === 'true',
  // 出口代理订阅地址（可选）。配置后启动 mihomo 内核，上游流量经订阅节点出站。
  // 格式：机场订阅 URL（clash/v2ray base64 均可，mihomo proxy-providers 自动解析）
  // 代理服务会把 data/.mihomo/proxy-settings.json 合并进来；环境变量
  // 非空时由服务端锁定并优先于持久化配置。
  subscriptionUrl: getConfiguredSubscription(),
};

const accountStateStore = createAccountStateStore(CFG.accountStateFile);

// 分享给别人的 key（主 Key 不在里面，见 server/api-keys.mjs 顶部说明）
const apiKeyStore = createApiKeyStore(dataFile('credentials', 'api-keys.json'));

// === API Key 持久化（面板「重置 Key」生成的随机 key 存这里，env 未设时生效） ===
const KEY_FILE = dataFile('credentials', 'server-key.txt');
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
    if (obj.accounts && typeof obj.accounts === 'object') return migrateAccountEgress(migrateAccountKeys(obj));
    // 兼容单账号顶层格式 {authToken, email, id, name}
    if (obj.authToken) {
      const key = accountKey(obj);
      const converted = { accounts: { [key]: { ...obj, id: obj.id || key } } };
      try { if (!CFG.readonlyAccounts) saveAccounts(converted); } catch (e) { console.error('[server] migrate credentials failed:', e.message); }
      return migrateAccountEgress(converted);
    }
    return { accounts: {} };
  } catch (e) {
    console.error('[server] load credentials failed:', e.message);
    return { accounts: {} };
  }
}

const opaqueAccountKeys = new Map();
function opaqueAccountKey(seed = '') {
  const cacheKey = String(seed || '');
  if (cacheKey && opaqueAccountKeys.has(cacheKey)) return opaqueAccountKeys.get(cacheKey);
  const key = 'acct-' + crypto.randomUUID();
  if (cacheKey) opaqueAccountKeys.set(cacheKey, key);
  return key;
}

function migrateAccountKeys(obj) {
  const accounts = {};
  const tokenOwners = new Map();
  let changed = false;
  for (const [rawKey, rawUser] of Object.entries(obj.accounts || {})) {
    const key = String(rawKey);
    const user = rawUser && typeof rawUser === 'object' ? { ...rawUser } : {};
    const legacy = key.startsWith('token-') || String(user.id || '').startsWith('token-');
    let nextKey = key;
    if (legacy) {
      nextKey = opaqueAccountKey(key || user.authToken);
      while (accounts[nextKey]) nextKey = opaqueAccountKey(key + ':' + Object.keys(accounts).length);
      if (!user.id || user.id === key || String(user.id).startsWith('token-')) user.id = nextKey;
      changed = true;
    }
    const token = String(user.authToken || '').trim();
    if (token !== String(user.authToken || '')) changed = true;
    if (token) user.authToken = token;
    else if (Object.hasOwn(user, 'authToken')) user.authToken = '';
    const tokenIdentity = normalizeAccountToken(token);
    if (tokenIdentity && tokenOwners.has(tokenIdentity)) {
      changed = true;
      console.warn('[server] credentials migration removed a duplicate account token');
      continue;
    }
    accounts[nextKey] = user;
    if (tokenIdentity) tokenOwners.set(tokenIdentity, nextKey);
  }
  if (!changed) return obj;
  const migrated = { ...obj, accounts };
  try {
    if (!CFG.readonlyAccounts) saveAccounts(migrated);
  } catch (e) {
    // Read-only or temporarily unwritable stores still get the in-memory opaque DTO.
    console.error('[server] migrate credentials failed:', e.message);
  }
  return migrated;
}

function nextAccountEgressLane(accounts, excludedKey = '') {
  const used = new Set();
  for (const [key, user] of Object.entries(accounts || {})) {
    if (key === excludedKey) continue;
    const lane = Number(user?.egressLane);
    if (Number.isInteger(lane) && lane >= 0 && lane < ACCOUNT_EGRESS_LANE_COUNT) used.add(lane);
  }
  for (let lane = 0; lane < ACCOUNT_EGRESS_LANE_COUNT; lane++) if (!used.has(lane)) return lane;
  return null;
}

function migrateAccountEgress(obj) {
  const accounts = {};
  const claimed = new Set();
  let changed = false;
  for (const [key, rawUser] of Object.entries(obj.accounts || {})) {
    const user = rawUser && typeof rawUser === 'object' ? { ...rawUser } : {};
    const mode = user.egressMode === 'manual' ? 'manual' : 'auto';
    const node = String(user.egressNode || '').trim();
    const lane = Number(user.egressLane);
    if (mode !== user.egressMode || node !== user.egressNode) changed = true;
    user.egressMode = mode;
    user.egressNode = node;
    if (Number.isInteger(lane) && lane >= 0 && lane < ACCOUNT_EGRESS_LANE_COUNT && !claimed.has(lane)) {
      user.egressLane = lane;
      claimed.add(lane);
    } else {
      user.egressLane = null;
      changed = true;
    }
    accounts[key] = user;
  }
  for (const user of Object.values(accounts)) {
    if (user.egressLane !== null) continue;
    let lane = 0;
    while (claimed.has(lane) && lane < ACCOUNT_EGRESS_LANE_COUNT) lane++;
    if (lane >= ACCOUNT_EGRESS_LANE_COUNT) continue;
    user.egressLane = lane;
    claimed.add(lane);
  }
  const migrated = { ...obj, accounts };
  if (changed) {
    try {
      if (!CFG.readonlyAccounts) saveAccounts(migrated);
    } catch (e) {
      console.error('[server] migrate account egress failed:', e.message);
    }
  }
  return migrated;
}

function accountKey(user) {
  const uid = user?.id || '';
  const email = user?.email || '';
  if (uid && !String(uid).startsWith('token-')) return String(uid);
  if (email) return String(email);
  return opaqueAccountKey(user?.authToken ? 'token:' + String(user.authToken) : 'new');
}

function existingAccountKey(obj, token) {
  const wanted = normalizeAccountToken(token);
  for (const [key, user] of Object.entries(obj.accounts || {})) {
    if (user && normalizeAccountToken(user.authToken) === wanted) return key;
  }
  return null;
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
    egressMode: u.egressMode === 'manual' ? 'manual' : 'auto',
    egressNode: String(u.egressNode || ''),
    egressLane: Number.isInteger(u.egressLane) ? u.egressLane : null,
    hasToken: Boolean(u.authToken),
  }));
}

function publicAccountDto(account) {
  const { token, tokenShort, egressLane, ...publicAccount } = account;
  return publicAccount;
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

// token → 展示名映射（喂给 worker，用于调用日志的"调度的账号名"）。
// 名字取 备注名 → 邮箱；都没有时不放，由 worker 回落 token 短哈希。
function accountLabels() {
  const labels = {};
  for (const acct of listAccounts()) {
    const name = acct.name || acct.email || '';
    if (acct.token && name) labels[acct.token.trim()] = name;
  }
  return labels;
}

// === Web 面板会话鉴权 ===
const sessions = new Map(); // sessionId -> { exp, createdAt }

function requireAdmin(req, res) {
  const cookie = parseCookies(req);
  const sid = cookie['fbp_session'];
  if (sid && sessions.has(sid) && sessions.get(sid).exp > Date.now()) return true;
  // 未设置 ADMIN_PASSWORD 时，允许直连（内网部署便利，公网请务必设置）
  if (!CFG.adminPassword) return true;
  // HTTP Basic auth：便于 curl / 监控探针 / CI 脚本免 Cookie 直接访问 /_api/*。
  // 用户名忽略，只校验密码 == ADMIN_PASSWORD（和 /_api/login 的口令同源）。
  // 刻意不回 WWW-Authenticate：否则浏览器打开面板会弹原生 Basic 登录框，
  // 与我们自己的登录页冲突；curl -u 会预发 Authorization 头，无需质询。
  const auth = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (m) {
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf-8'); } catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    if (idx >= 0 && decoded.slice(idx + 1) === CFG.adminPassword) return true;
  }
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

function err(res, status, message, type = 'api_error', extraHeaders = {}) {
  json(res, status, { error: { message, type } }, extraHeaders);
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

// === 上游代理 ===
// OAuth 与无账号上下文的探测保留串行节流；账号池按账号排队、跨账号有限并发。
let chainTail = Promise.resolve();
function enqueueUp(fn) {
  const run = chainTail.then(() => new Promise((r) => setTimeout(r, 300))).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

const ACCOUNT_EGRESS_PROBE_CONCURRENCY = 8;
const accountProbeFlights = new Set();
const accountProbeTails = new Map();

async function runWithAccountProbeSlot(fn) {
  while (accountProbeFlights.size >= ACCOUNT_EGRESS_PROBE_CONCURRENCY) {
    await Promise.race(accountProbeFlights);
  }
  const run = Promise.resolve().then(fn);
  const settled = run.catch(() => {});
  accountProbeFlights.add(settled);
  try {
    return await run;
  } finally {
    accountProbeFlights.delete(settled);
  }
}

function enqueueAccountProbe(key, fn) {
  const queueKey = String(key ?? '');
  const previous = accountProbeTails.get(queueKey) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => runWithAccountProbeSlot(fn));
  accountProbeTails.set(queueKey, run);
  const clear = () => {
    if (accountProbeTails.get(queueKey) === run) accountProbeTails.delete(queueKey);
  };
  run.then(clear, clear);
  return run;
}

async function upstreamJson(method, path, token, body, extraHeaders = {}, timeoutMs = 15000, fetchOverride = null) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${normalizeAccountToken(token)}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, extraHeaders);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 走代理（配了订阅时）或直连：getUpstreamFetch() 无代理返回 null → 用全局 fetch
  const upstreamFetch = fetchOverride || getUpstreamFetch() || fetch;
  try {
    const resp = await upstreamFetch(CFG.codebuffApi + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: resp.status, data, text, headers: resp.headers };
  } catch (e) {
    if (e?.code === 'ACCOUNT_EGRESS_UNAVAILABLE') throw e;
    return { status: 0, data: null, text: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function enqueueUpstream(method, path, token, body, extraHeaders, timeoutMs, fetchOverride = null) {
  return enqueueUp(() => upstreamJson(method, path, token, body, extraHeaders, timeoutMs, fetchOverride));
}

function findProbeState(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  let fallback = null;
  const priority = new Set([
    'banned', 'token_invalid', 'country_blocked', 'ip_capped',
    'rate_limited', 'rate_limit_exceeded', 'quota_exceeded', 'spend_limited',
    'waiting_room_queued', 'waiting_room_required', 'model_locked',
  ]);
  for (const name of ['status', 'state', 'code', 'errorCode', 'error_code', 'type']) {
    const raw = value[name];
    if (typeof raw !== 'string') continue;
    const state = raw.trim().toLowerCase().replace(/[- ]+/g, '_');
    if (!state) continue;
    if (priority.has(state) || state.startsWith('free_mode_')) return state;
    fallback ||= state;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const nested = findProbeState(child, depth + 1);
    if (!nested) continue;
    if (priority.has(nested) || nested.startsWith('free_mode_')) return nested;
    fallback ||= nested;
  }
  return fallback;
}

const ACCOUNT_EGRESS_PROBE_TIMEOUT_MS = 5000;

// 账号健康探测：GET /api/v1/freebuff/session（0 消耗，不创建 session）
// 判定规则与 extract_freebuff.py _check_one 一致
async function probeAccount(token, {
  upstreamFetch = null,
  updateIsolation = true,
  timeoutMs = 15000,
  queueKey = null,
} = {}) {
  const stateToken = normalizeAccountToken(token);
  const headers = { 'x-freebuff-include-unused-rate-limits': '1' };
  const r = queueKey == null
    ? await enqueueUpstream('GET', '/api/v1/freebuff/session', token, undefined,
      headers, timeoutMs, upstreamFetch)
    : await enqueueAccountProbe(queueKey, () => upstreamJson('GET', '/api/v1/freebuff/session', token, undefined,
      headers, timeoutMs, upstreamFetch));
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  let state = 'unknown', label = '未知', quota = null, retryAfterMs = null;
  const fmtQuota = () => {
    const rl = data.rateLimitsByModel;
    if (!rl || typeof rl !== 'object') return null;
    const rows = [];
    for (const [m, info] of Object.entries(rl)) {
      if (info && typeof info === 'object' && typeof info.limit === 'number') {
        const row = {
          model: m,
          used: typeof info.recentCount === 'number' ? info.recentCount : null,
          limit: info.limit,
          remaining: typeof info.remaining === 'number' ? info.remaining : null,
          resetAt: info.resetAt || null,
        };
        // 当前上游把 premium、luna、deepseek_pro 拆成不同池；没有这些字段时
        // 仍兼容旧响应，但不能在服务端擅自把模型行合并成一个总额度。
        for (const key of ['pool', 'poolLabel', 'period', 'windowHours', 'resetTimeZone']) {
          if (typeof info[key] === 'string' || typeof info[key] === 'number') row[key] = info[key];
        }
        if (info.entitlementBreakdown && typeof info.entitlementBreakdown === 'object') {
          row.entitlementBreakdown = info.entitlementBreakdown;
        }
        rows.push(row);
      }
    }
    return rows.length ? rows : null;
  };
  const typedState = findProbeState(data);
  if (r.status === 401) { state = 'token_invalid'; label = 'token 失效'; }
  else if (r.status === 403) {
    if (typedState === 'banned') { state = 'banned'; label = '已被封禁'; }
    else if (typedState === 'country_blocked') { state = 'country_blocked'; label = '地区受限'; }
    else { state = 'blocked'; label = '访问被拒'; }
  } else if (r.status === 429) {
    if (typedState === 'spend_limited') { state = 'spend_limited'; label = '账号消费额度受限'; }
    else if (typedState === 'ip_capped') { state = 'ip_capped'; label = 'IP 并发上限'; }
    else if (typedState === 'country_blocked') { state = 'country_blocked'; label = '地区受限'; }
    else if (typedState === 'waiting_room_queued' || typedState === 'waiting_room_required') { state = 'waiting_room'; label = '等待室排队'; }
    else { state = 'rate_limited'; label = '模型额度受限'; }
    quota = fmtQuota();
    retryAfterMs = data.retryAfterMs || null;
  }
  else if (r.status === 404) { state = 'ok'; label = '存活（无活跃 session）'; quota = fmtQuota(); }
  else if (r.status === 200) {
    if (typedState === 'banned') { state = 'banned'; label = '已被封禁'; }
    else if (typedState === 'country_blocked') { state = 'country_blocked'; label = '地区受限'; }
    else if (typedState === 'model_locked') { state = 'model_locked'; label = 'session 被锁定'; }
    else if (typedState === 'rate_limited' || typedState === 'spend_limited') { state = typedState; label = typedState === 'spend_limited' ? '账号消费额度受限' : '模型额度受限'; quota = fmtQuota(); }
    else if (typedState === 'ip_capped') { state = 'ip_capped'; label = 'IP 并发上限'; }
    else if (typedState === 'waiting_room_queued' || typedState === 'waiting_room_required') { state = 'waiting_room'; label = '等待室排队'; quota = fmtQuota(); }
    else { state = 'ok'; label = '存活'; quota = fmtQuota(); }
  } else { state = 'unknown'; label = `HTTP ${r.status}`; }
  const result = {
    state, label, quota, retryAfterMs,
    uid: data.uid || null,
    accessTier: data.accessTier || null,
    model: data.model || null,
    statusCode: r.status,
  };
  // 只有管理员主动探测得到明确存活结果时才清除持久隔离；业务成功响应
  // 不自动清除，避免上游短暂异常造成封禁状态抖动。
  if (updateIsolation) {
    const existingState = accountStateStore.snapshot([stateToken])[stateToken] || null;
    if (result.state === 'ok') accountStateStore.clear(stateToken);
    else if (result.state === 'banned' && existingState?.state !== 'banned') {
      accountStateStore.set(stateToken, { state: 'banned', until: null, reason: 'upstream_banned' });
      cancelAccountEgressTasksForToken(stateToken);
    } else if (result.state === 'token_invalid' && existingState?.state !== 'token_invalid') {
      accountStateStore.set(stateToken, { state: 'token_invalid', until: null, reason: 'upstream_auth_rejected' });
      cancelAccountEgressTasksForToken(stateToken);
    }
  }
  // 官方 banned 没有恢复时间；永久隔离只由管理员成功探测或 clear 解除。
  const isolation = accountStateStore.snapshot([stateToken])[stateToken];
  result.isolatedUntil = isolation && isolation.until != null ? isolation.until : null;
  result.isolatedPermanent = Boolean(
    isolation && isolation.until == null
      && ['banned', 'token_invalid', 'manual_disabled'].includes(isolation.state),
  );
  return result;
}

const accountEgressTasks = new Map();
const accountEgressMutations = new Map();

function beginAccountEgressMutation(key) {
  accountEgressMutations.set(key, (accountEgressMutations.get(key) || 0) + 1);
}

function endAccountEgressMutation(key) {
  const remaining = (accountEgressMutations.get(key) || 0) - 1;
  if (remaining > 0) accountEgressMutations.set(key, remaining);
  else accountEgressMutations.delete(key);
}

function accountEgressMutationActive(key) {
  return accountEgressMutations.has(key);
}

const managedAccountTokenHistory = new Set();

function accountEgressIdentity(account) {
  const token = String(account?.token || account?.authToken || '').trim();
  return token ? crypto.createHash('sha256').update(token).digest('hex') : '';
}

function accountEgressTaskKey(account) {
  return `${String(account?.key || '')}\0${accountEgressIdentity(account)}`;
}

function accountEgressTaskActive(account) {
  return accountEgressTasks.has(accountEgressTaskKey(account));
}

function cancelAccountEgressTasks(accountKey) {
  const prefix = `${String(accountKey || '')}\0`;
  for (const [key, record] of accountEgressTasks) {
    if (!key.startsWith(prefix)) continue;
    record.cancelled = true;
    accountEgressTasks.delete(key);
  }
}

function cancelAccountEgressTasksForToken(token) {
  const account = accountByToken(token);
  if (account) cancelAccountEgressTasks(account.key);
}

function normalizeAccountToken(value) {
  const token = String(value || '').trim();
  const colon = token.indexOf(':');
  return colon > 0 ? token.slice(0, colon).trim() : token;
}

function accountByToken(token) {
  const wanted = normalizeAccountToken(token);
  let found = null;
  for (const account of listAccounts()) {
    if (normalizeAccountToken(account.token) === wanted) found = account;
  }
  return found;
}

function accountByKey(key) {
  return listAccounts().find((account) => account.key === key) || null;
}

const TERMINAL_ACCOUNT_STATE_LABELS = Object.freeze({
  banned: '已被封禁',
  token_invalid: '凭据已失效',
  manual_disabled: '管理员已停用',
});

function accountTerminalState(account) {
  const token = normalizeAccountToken(account?.token);
  if (!token) return null;
  return accountStateStore.snapshot([token])[token] || null;
}

function isTerminalAccount(account) {
  return Boolean(accountTerminalState(account));
}

function terminalAccountProbe(account) {
  const state = accountTerminalState(account);
  if (!state) return null;
  return {
    state: state.state,
    label: TERMINAL_ACCOUNT_STATE_LABELS[state.state] || '账号已隔离',
    quota: null,
    retryAfterMs: null,
    uid: null,
    accessTier: null,
    model: null,
    statusCode: state.state === 'token_invalid' ? 401 : 403,
    isolatedUntil: null,
    isolatedPermanent: true,
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

function accountEgressUnavailableFetch() {
  const error = new Error('账号出站节点尚未就绪');
  error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
  return Promise.reject(error);
}

function resolveAccountUpstreamRoute(token) {
  const wanted = normalizeAccountToken(token);
  if (!wanted) return null;
  const account = accountByToken(wanted);
  if (account) {
    managedAccountTokenHistory.add(wanted);
    return accountEgressFetch(account, { withRoute: true });
  }
  if (managedAccountTokenHistory.has(wanted)) return accountEgressUnavailableFetch;
  const envTokens = (env.FREEBUFF_TOKEN || '').split(/[\n,]/).map(normalizeAccountToken).filter(Boolean);
  if (envTokens.includes(wanted)) return null;
  return null;
}

function isAccountUpstreamRouteReady(token) {
  const wanted = normalizeAccountToken(token);
  if (!wanted) return false;
  const account = accountByToken(wanted);
  if (account) {
    managedAccountTokenHistory.add(wanted);
    const selectedFetch = accountEgressFetch(account, { schedule: false });
    return selectedFetch !== accountEgressUnavailableFetch;
  }
  if (managedAccountTokenHistory.has(wanted)) return false;
  return null;
}

function accountEgressFetch(account, { schedule = true, withRoute = false, allowTerminal = false } = {}) {
  if (!account) return null;
  const route = (selectedFetch) => {
    if (!withRoute) return selectedFetch;
    return {
      fetch: selectedFetch,
      egress: {
        lane: account.egressLane,
        node: getAccountProxyNode(account.egressLane),
        generation: getAccountProxyGeneration(account.egressLane),
      },
    };
  };
  if (!allowTerminal && isTerminalAccount(account)) return route(accountEgressUnavailableFetch);
  if (!getConfiguredSubscription()) return route(accountEgressUnavailableFetch);
  const identity = accountEgressIdentity(account);
  const fetchForLane = getAccountUpstreamFetch(account.egressLane, { identity });
  if (account.egressMode === 'manual') {
    const ready = Boolean(fetchForLane && account.egressNode
      && getAccountProxyNode(account.egressLane) === account.egressNode);
    if (ready) return route(fetchForLane);
  } else {
    const freshFetch = getAccountAutoUpstreamFetch(account.egressLane, { identity });
    if (freshFetch) return route(freshFetch);
    const staleFetch = getAccountAutoUpstreamFetch(account.egressLane, { allowStale: true, identity });
    if (staleFetch) {
      if (schedule) scheduleAccountEgress(account, { force: false });
      return route(staleFetch);
    }
  }
  if (schedule) scheduleAccountEgress(account, { force: false });
  return route(accountEgressUnavailableFetch);
}

function accountEgressStatus(account) {
  const terminal = accountTerminalState(account);
  const currentNode = Number.isInteger(account?.egressLane)
    ? getAccountProxyNode(account.egressLane) || null : null;
  const reject = Number.isInteger(account?.egressLane)
    ? getAccountEgressReject(account.egressLane) : null;
  const identity = accountEgressIdentity(account);
  const fetchForLane = Number.isInteger(account?.egressLane)
    ? getAccountUpstreamFetch(account.egressLane, { identity }) : null;
  const autoVerifiedFetch = account?.egressMode === 'auto' && Number.isInteger(account?.egressLane)
    ? getAccountAutoUpstreamFetch(account.egressLane, { allowStale: true, identity }) : null;
  const verified = account?.egressMode === 'manual'
    ? Boolean(fetchForLane && currentNode && currentNode === account.egressNode)
    : Boolean(autoVerifiedFetch);
  let state = 'unavailable';
  let error = null;
  if (terminal) {
    state = 'terminal';
    error = TERMINAL_ACCOUNT_STATE_LABELS[terminal.state] || '账号已隔离';
  } else if (!getConfiguredSubscription()) {
    state = 'proxy_offline';
    error = '尚未配置出口代理订阅';
  } else if (!Number.isInteger(account?.egressLane)) {
    state = 'unavailable';
    error = `账号出站通道已满（最多 ${ACCOUNT_EGRESS_LANE_COUNT} 个账号）`;
  } else if (reject) {
    state = 'rejected';
    error = `节点被上游拒绝（${reject.state || 'blocked'}）`;
  } else if (verified) {
    state = 'ready';
  } else if (accountEgressTaskActive(account)) {
    state = 'probing';
  } else if (account.egressMode === 'manual' && !account.egressNode) {
    error = '尚未选择手动节点';
  } else {
    error = account.egressMode === 'auto'
      ? '尚未找到具备可用高级或 Free 授权的 US/SG 节点'
      : '手动节点尚未就绪';
  }
  return {
    state,
    currentNode,
    region: inferNodeRegion(currentNode),
    verified,
    reject,
    terminal: terminal ? { state: terminal.state, reason: terminal.reason || null } : null,
    error,
  };
}

async function configureAccountEgress(account, {
  mode = account?.egressMode,
  node = account?.egressNode,
  force = false,
  persist = true,
  allowTerminal = false,
} = {}) {
  if (!account || !account.hasToken) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
  if (!Number.isInteger(account.egressLane)) {
    throw Object.assign(new Error(`账号出站通道已满（最多 ${ACCOUNT_EGRESS_LANE_COUNT} 个账号）`), { code: 'ACCOUNT_LANE_EXHAUSTED' });
  }
  const normalizedMode = mode === 'manual' ? 'manual' : mode === 'auto' ? 'auto' : '';
  if (!normalizedMode) throw new Error('节点模式必须是 auto 或 manual');

  let selected;
  const expectedIdentity = accountEgressIdentity(account);
  if (normalizedMode === 'manual') {
    const selectedNode = String(node || '').trim();
    if (!selectedNode) throw new Error('手动模式必须选择节点');
    selected = await setAccountProxyNode({ lane: account.egressLane, node: selectedNode, identity: expectedIdentity });
  } else {
    selected = await selectAccountProxyNodeAuto({
      lane: account.egressLane,
      identity: expectedIdentity,
      force,
      verify: async ({ fetch: fetchForLane }) => {
        if (!allowTerminal && isTerminalAccount(account)) {
          throw Object.assign(new Error('账号已进入终态'), { code: 'ACCOUNT_EGRESS_TERMINAL' });
        }
        const probe = await probeAccount(account.token, {
          upstreamFetch: fetchForLane,
          updateIsolation: false,
          timeoutMs: ACCOUNT_EGRESS_PROBE_TIMEOUT_MS,
          queueKey: account.key,
        });
        // allowTerminal 的整个意义就是「明知是终态也要探一次上游」——管理面板要看真实状态，
        // 也是上游解封后自动恢复的唯一路径。这里漏了这个守卫，banned 号的管理探测会被自己挡回 503。
        if (!allowTerminal && ['banned', 'token_invalid', 'manual_disabled'].includes(probe.state)) {
          throw Object.assign(new Error('账号已进入终态'), { code: 'ACCOUNT_EGRESS_TERMINAL' });
        }
        if (!allowTerminal && isTerminalAccount(account)) {
          throw Object.assign(new Error('账号已进入终态'), { code: 'ACCOUNT_EGRESS_TERMINAL' });
        }
        return classifyAccountProbeAuthorization(probe);
      },
    });
  }

  if (persist) {
    const obj = loadAccounts();
    const stored = obj.accounts?.[account.key];
    if (!stored) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
    if (accountEgressIdentity(stored) !== expectedIdentity || stored.egressLane !== account.egressLane) {
      throw Object.assign(new Error('账号凭据或出站通道已变更'), { code: 'ACCOUNT_CHANGED' });
    }
    stored.egressMode = normalizedMode;
    // egressNode 只保存手动选择；自动模式的实时节点属于运行态，见 egress.currentNode。
    stored.egressNode = normalizedMode === 'manual' ? selected.node : '';
    saveAccounts(obj);
  }
  return { mode: normalizedMode, node: selected.node, cached: Boolean(selected.cached) };
}

function scheduleAccountEgress(account, { force = false } = {}) {
  if (isTerminalAccount(account)) return null;
  if (!account || !getConfiguredSubscription() || accountEgressMutationActive(account.key)) return null;
  const identity = accountEgressIdentity(account);
  const taskKey = accountEgressTaskKey(account);
  const existing = accountEgressTasks.get(taskKey);
  if (existing) {
    if (force) existing.pendingForce = true;
    return existing.task;
  }
  const record = { task: null, pendingForce: Boolean(force), cancelled: false };
  record.task = (async () => {
    do {
      const runForce = record.pendingForce;
      record.pendingForce = false;
      if (record.cancelled) return null;
      const current = accountByKey(account.key);
      if (!current || isTerminalAccount(current) || accountEgressIdentity(current) !== identity || accountEgressMutationActive(account.key)) return null;
      try {
        await configureAccountEgress(current, { force: runForce, persist: false });
      } catch (error) {
        // 终态号（ACCOUNT_EGRESS_TERMINAL）没有重试意义：账号已被封禁/停用，
        // 出站配置永远不可能成功。直接终止任务，否则 force 轮询会把它无限拉起
        // （实测 15 分钟刷几十条「账号已进入终态」，纯浪费）。
        if (error?.code === 'ACCOUNT_EGRESS_TERMINAL' || error?.code === 'ACCOUNT_CHANGED') return null;
        console.error(`[server] 账号 ${account.key} 出站配置失败: ${String(error?.message || error).slice(0, 180)}`);
      }
    } while (!record.cancelled && record.pendingForce);
    return null;
  })().finally(() => {
    if (accountEgressTasks.get(taskKey) === record) accountEgressTasks.delete(taskKey);
  });
  accountEgressTasks.set(taskKey, record);
  return record.task;
}

async function initializeAccountEgress({ force = false, serial = false, autoOnly = false, skipActive = false } = {}) {
  if (!getConfiguredSubscription()) return 0;
  const accounts = listAccounts().filter((account) => account.hasToken
    && Number.isInteger(account.egressLane)
    && (!autoOnly || account.egressMode === 'auto')
    && !isTerminalAccount(account));
  let refreshed = 0;
  const run = async (account) => {
    try {
      const active = skipActive && typeof accountEgressTaskActive === 'function' && accountEgressTaskActive(account);
      const task = scheduleAccountEgress(account, { force });
      if (task) {
        if (!active || force) refreshed++;
        await task;
      }
    } catch (error) {
      console.error(`[server] 账号 ${account.key} 出站初始化失败: ${String(error?.message || error).slice(0, 180)}`);
    }
  };
  if (serial) {
    for (const account of accounts) await run(account);
  } else {
    await Promise.all(accounts.map(run));
  }
  return refreshed;
}

const ACCOUNT_EGRESS_REFRESH_COOLDOWN_MS = 60 * 1000;
let accountEgressRefreshTask = null;
let accountEgressRefreshAt = 0;

async function refreshAccountEgressNow() {
  if (!getConfiguredSubscription()) {
    throw Object.assign(new Error('未配置订阅，无法刷新出站'), { code: 'ACCOUNT_EGRESS_REFRESH_UNAVAILABLE' });
  }
  if (accountEgressRefreshTask) {
    throw Object.assign(new Error('已有一轮出站刷新正在进行'), { code: 'ACCOUNT_EGRESS_REFRESH_IN_PROGRESS' });
  }
  const retryAfterMs = ACCOUNT_EGRESS_REFRESH_COOLDOWN_MS - (Date.now() - accountEgressRefreshAt);
  if (accountEgressRefreshAt && retryAfterMs > 0) {
    throw Object.assign(new Error('出站刚刚刷新过，请稍后重试'), {
      code: 'ACCOUNT_EGRESS_REFRESH_COOLDOWN', retryAfterMs,
    });
  }
  const run = (async () => {
    const refreshed = await refreshSubscription();
    if (refreshed && refreshed.ok === false) {
      throw Object.assign(new Error(refreshed.error || '订阅刷新失败'), { code: 'ACCOUNT_EGRESS_REFRESH_FAILED' });
    }
    const refreshedAccounts = await initializeAccountEgress({ force: true, serial: true, autoOnly: true, skipActive: true });
    accountEgressRefreshAt = Date.now();
    const proxy = await getProxyStatus();
    return { proxy, refreshedAccounts };
  })();
  accountEgressRefreshTask = run;
  try {
    return await run;
  } finally {
    if (accountEgressRefreshTask === run) accountEgressRefreshTask = null;
  }
}

function handleEgressReject(info = {}) {
  const account = info.token ? accountByToken(info.token) : null;
  if (Number.isInteger(info.lane)) {
    if (!account || account.egressLane !== info.lane) return;
    noteEgressReject(info);
    if (isTerminalAccount(account)) return;
    if (account?.egressMode === 'auto') scheduleAccountEgress(account, { force: true });
    return;
  }
  if (!account || !Number.isInteger(account.egressLane)) {
    noteEgressReject(info);
    return;
  }
  noteEgressReject({ ...info, lane: account.egressLane });
  if (isTerminalAccount(account)) return;
  if (account.egressMode === 'auto') scheduleAccountEgress(account, { force: true });
}

async function ensureAccountEgressForAdminProbe(account) {
  let upstreamFetch = accountEgressFetch(account, { schedule: false, allowTerminal: true });
  if (upstreamFetch !== accountEgressUnavailableFetch) return upstreamFetch;
  if (!account || account.egressMode !== 'auto' || !Number.isInteger(account.egressLane)) return upstreamFetch;
  try {
    await configureAccountEgress(account, { force: true, persist: false, allowTerminal: true });
  } catch {
    // The caller will return the normal egress_unavailable response.
  }
  upstreamFetch = accountEgressFetch(account, { schedule: false, allowTerminal: true });
  return upstreamFetch;
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
  // 面板资源随构建更新,且都是小文件、每次从磁盘现读;用 no-store 保证前端改动
  // 部署后立即生效。no-cache 不带校验器(ETag/Last-Modified)时,个别浏览器软刷新
  // 仍会复用旧 app.js —— 会出现"改了却没生效"(新 index.html + 旧 app.js)的错觉。
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
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
    const workerEnv = buildWorkerEnv();
    await forwardWorkerRequest(nodeReq, nodeRes, handler, workerEnv);
  } catch (e) {
    console.error('[server] request error:', e.message);
    if (!nodeRes.headersSent && !nodeRes.destroyed) {
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

const HISTORICAL_DEFAULT_MODEL_ALIASES = {
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro',
  'mimo-v2.5': 'mimo/mimo-v2.5',
};

// 旧镜像曾把三条示例映射复制进持久化目录。只删除键和值都完全匹配的
// 历史默认项，用户修改过目标或自行添加的映射一律保留。
function removeHistoricalDefaultModelAliases() {
  if (!existsSync(CFG.aliasFile)) return;
  try {
    const obj = JSON.parse(readFileSync(CFG.aliasFile, 'utf-8'));
    if (!obj || typeof obj !== 'object') return;
    const src = obj.aliases && typeof obj.aliases === 'object' ? obj.aliases : obj;
    const next = Object.create(null);
    let changed = false;
    for (const [alias, modelId] of Object.entries(src)) {
      if (HISTORICAL_DEFAULT_MODEL_ALIASES[alias] === modelId) {
        changed = true;
        continue;
      }
      next[alias] = modelId;
    }
    if (!changed) return;
    mkdirSync(dirname(CFG.aliasFile), { recursive: true });
    const tmp = CFG.aliasFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ aliases: next }, null, 2) + '\n', 'utf-8');
    writeFileSync(CFG.aliasFile, readFileSync(tmp, 'utf-8'), 'utf-8');
    console.log('[server] 已移除历史默认模型映射');
  } catch (e) {
    console.error('[server] 清理历史默认模型映射失败（忽略）:', e.message);
  }
}

// 代理管理接口的错误只返回可操作的中文提示；订阅 URL、控制器响应等内部
// 细节不能从管理面板泄漏。proxy service 本身也会对启动/刷新错误脱敏，
// 这里再做一层边界保护，避免未来新增实现把原始异常直接吐给浏览器。
function proxyApiError(res, error) {
  const code = error?.code || '';
  const raw = String(error?.message || '代理操作失败');
  if (code === 'ENV_LOCKED') return err(res, 409, 'SUBSCRIPTION_URL 由环境变量配置，面板不可覆盖', 'env_locked');
  if (code === 'ACCOUNT_EGRESS_REFRESH_UNAVAILABLE') {
    return err(res, 409, '未配置订阅，无法刷新出站', 'egress_refresh_unavailable');
  }
  if (code === 'ACCOUNT_EGRESS_REFRESH_IN_PROGRESS') {
    return err(res, 409, '已有一轮出站刷新正在进行', 'egress_refresh_in_progress');
  }
  if (code === 'ACCOUNT_EGRESS_REFRESH_COOLDOWN') {
    const retryAfterMs = Math.max(1000, Number(error?.retryAfterMs) || 0);
    return err(res, 429, '出站刚刚刷新过，请稍后重试', 'egress_refresh_cooldown', {
      'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
    });
  }
  if (code === 'ACCOUNT_EGRESS_REFRESH_FAILED') {
    return err(res, 503, '出站刷新失败，请稍后重试', 'egress_refresh_failed');
  }
  if (/订阅地址|必须以|必须是|模式|间隔|整数|节点不存在|选择节点|优先级|enabled/i.test(raw)) {
    return err(res, 400, raw.slice(0, 180), 'invalid_proxy_config');
  }
  if (/mihomo 未运行|内核未运行/i.test(raw)) {
    return err(res, 409, 'mihomo 尚未运行，请先配置并刷新订阅', 'proxy_not_ready');
  }
  return err(res, 503, '代理暂不可用，请稍后重试', 'proxy_unavailable');
}

function accountEgressApiError(res, error) {
  const code = String(error?.code || '');
  const raw = String(error?.message || '账号出站配置失败');
  if (code === 'ACCOUNT_NOT_FOUND') return err(res, 404, '账号不存在', 'not_found');
  if (code === 'ACCOUNT_CHANGED') return err(res, 409, '账号配置已变更，请刷新后重试', 'account_changed');
  if (code === 'ACCOUNT_LANE_EXHAUSTED') return err(res, 409, raw, 'egress_capacity');
  if (code === 'ACCOUNT_EGRESS_SUPERSEDED') return err(res, 409, '账号出站配置已被更新的操作取代', 'account_changed');
  // 终态号（banned / token_invalid / manual_disabled）不是「暂时不可用」：configureAccountEgress
  // 的 verify 会直接拒绝给它配出站，重试到上游解封之前永远不会成功。落到下面那条兜底
  // 503「请稍后重试」等于把永久状态说成抖动，用户只会一直点保存（2026-08-29 手动改自动实测）。
  if (code === 'ACCOUNT_EGRESS_TERMINAL') {
    return err(res, 409, '账号已被上游永久隔离，出站模式改不动；等状态恢复后再改，或更换账号', 'account_terminal');
  }
  if (code === 'ACCOUNT_EGRESS_UNAVAILABLE') return err(res, 503, raw, 'egress_unavailable');
  if (/mihomo 未运行|内核未运行/i.test(raw)) {
    return err(res, 409, 'mihomo 尚未运行，请先配置并刷新订阅', 'proxy_not_ready');
  }
  if (/节点模式必须|手动模式必须|节点不存在|lane 必须/i.test(raw)) {
    return err(res, 400, raw.slice(0, 180), 'invalid_egress_config');
  }
  return err(res, 503, '账号出站配置暂不可用，请稍后重试', 'egress_unavailable');
}

async function readJsonObject(req) {
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'INVALID_JSON' });
  }
  return body;
}

// worker.js 读取的 env（含动态账号池 → FREEBUFF_TOKEN）
function buildWorkerEnv() {
  const tokens = allTokens();
  for (const account of listAccounts()) {
    if (account.hasToken) managedAccountTokenHistory.add(normalizeAccountToken(account.token));
  }
  const envTokens = (env.FREEBUFF_TOKEN || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  for (const t of envTokens) if (!tokens.includes(t)) tokens.push(t);
  const stateTokens = tokens.map((token) => {
    const idx = token.indexOf(':');
    return idx > 0 ? token.slice(0, idx).trim() : token;
  });
  // 模型映射序列化（worker.js parseModelAliases 逆解析）
  const aliasStr = [...loadModelAliases().entries()].map(([k, v]) => `${k}=${v}`).join(',');
  return {
    FREEBUFF_TOKEN: tokens.join(','),
    FREEBUFF_API_KEY: currentApiKey(),
    API_KEY: env.API_KEY || '',
    FREEBUFF_DEBUG: env.FREEBUFF_DEBUG || 'false',
    CODEBUFF_API: env.CODEBUFF_API || '',
    MODEL_ALIASES: aliasStr,
    // 分享给别人的那些 key（主 Key 走 FREEBUFF_API_KEY，不在这份表里）。
    // 每条各自限并发/模型/每日上限，worker 只读。
    FREEBUFF_API_KEYS: apiKeyStore.descriptors(),
    // 调用日志的"调度的账号名"：token→展示名映射，worker 记录时解析。
    FREEBUFF_ACCOUNT_LABELS: accountLabels(),
    // 出口代理注入（有订阅且 mihomo 就绪时返回走代理的 fetch；否则 undefined → worker 直连）
    FREEBUFF_UPSTREAM_FETCH: getUpstreamFetch() || undefined,
    // 账号池里的 token 优先走自己的固定 lane；lane 验证/切换期间显式返回 503，
    // 不能悄悄回落到全局 selector，否则两个账号会串用同一个出口。
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT: resolveAccountUpstreamRoute,
    // 上游拒绝出站 IP（地区封禁/IP 触顶/裸 403）时回调，由代理服务归因到当前节点并进面板。
    FREEBUFF_ON_EGRESS_REJECT: handleEgressReject,
    // worker 只拿当前账号的内存快照；落盘始终由 server 负责哈希 token。
    FREEBUFF_ACCOUNT_STATE: accountStateStore.snapshot(stateTokens),
    FREEBUFF_ACCOUNT_STATE_REVISION: accountStateStore.revision(),
    FREEBUFF_ACCOUNT_STATE_SET: (token, state) => {
      const normalized = normalizeAccountToken(token);
      const result = accountStateStore.set(normalized, state);
      cancelAccountEgressTasksForToken(normalized);
      return result;
    },
    FREEBUFF_ACCOUNT_STATE_CLEAR: (token) => accountStateStore.clear(normalizeAccountToken(token)),
    FREEBUFF_ACCOUNT_STATE_GET: (token) => {
      const normalized = normalizeAccountToken(token);
      return accountStateStore.snapshot([normalized])[normalized] || null;
    },
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

  // ---------- 出口代理订阅 / 节点 ----------
  // GET /_api/proxy
  // PUT /_api/proxy[/subscription] { url }
  // POST /_api/proxy/refresh
  // PUT /_api/proxy/node { mode: auto|manual, node? }
  // PUT /_api/proxy/account-priority { priority: advanced|unused }
  // PUT /_api/proxy/health { enabled, interval }
  // PUT /_api/proxy/update { enabled, interval }
  // 旧面板曾使用 PUT /_api/proxy，保留为订阅设置的兼容入口。
  if (seg === 'proxy') {
    if (method === 'GET' && !sub) {
      try {
        const proxy = await getProxyStatus();
        return json(res, 200, { ...proxy, envLocked: proxy.envLocked ?? isProxyEnvLocked() });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'POST' && sub === 'refresh') {
      try {
        const proxy = await refreshSubscription();
        if (proxy.ok) void initializeAccountEgress();
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'POST' && sub === 'refresh-egress') {
      try {
        const result = await refreshAccountEgressNow();
        return json(res, 200, result);
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'PUT' && (!sub || sub === 'subscription')) {
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return e.code === 'INVALID_JSON' ? err(res, 400, e.message) : proxyApiError(res, e);
      }
      const value = body.url ?? body.subscriptionUrl;
      if (value === undefined) return err(res, 400, '缺少订阅地址字段 url', 'invalid_proxy_config');
      try {
        const proxy = await setProxySubscription(value);
        CFG.subscriptionUrl = getConfiguredSubscription();
        if (proxy.ok) void initializeAccountEgress();
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'PUT' && sub === 'node') {
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return e.code === 'INVALID_JSON' ? err(res, 400, e.message) : proxyApiError(res, e);
      }
      const mode = body.mode ?? body.nodeMode;
      const node = body.node ?? body.selectedNode;
      try {
        const proxy = await setProxyNode({ mode, node });
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'PUT' && sub === 'account-priority') {
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return e.code === 'INVALID_JSON' ? err(res, 400, e.message) : proxyApiError(res, e);
      }
      try {
        const proxy = await setAccountProxySelectionPriority(body.priority);
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'PUT' && sub === 'health') {
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return e.code === 'INVALID_JSON' ? err(res, 400, e.message) : proxyApiError(res, e);
      }
      try {
        const proxy = await setProxyHealth({
          enabled: body.enabled,
          interval: body.interval ?? body.healthCheckInterval,
        });
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    if (method === 'PUT' && sub === 'update') {
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return e.code === 'INVALID_JSON' ? err(res, 400, e.message) : proxyApiError(res, e);
      }
      try {
        const proxy = await setProxyUpdate({
          enabled: body.enabled,
          interval: body.interval ?? body.autoUpdateInterval,
        });
        return json(res, 200, { ok: proxy.ok, proxy });
      } catch (e) {
        return proxyApiError(res, e);
      }
    }

    return err(res, 405, 'method not allowed');
  }

  // 账号池
  if (seg === 'accounts') {
    if (method === 'GET' && !sub) {
      const accounts = listAccounts();
      const health = {};
      const egress = {};
      const results = await Promise.all(accounts.map(async (acct) => {
        if (!acct.hasToken) {
          return { key: acct.key, egress: accountEgressStatus(acct), probe: null };
        }
        const terminalProbe = terminalAccountProbe(acct);
        if (terminalProbe) {
          return { key: acct.key, egress: accountEgressStatus(acct), probe: terminalProbe };
        }
        const upstreamFetch = accountEgressFetch(acct);
        const accountEgress = accountEgressStatus(acct);
        try {
          const probe = await probeAccount(acct.token, {
            upstreamFetch,
            queueKey: acct.key,
          });
          return { key: acct.key, egress: accountEgress, probe };
        } catch (error) {
          if (error?.code !== 'ACCOUNT_EGRESS_UNAVAILABLE') throw error;
          return {
            key: acct.key,
            egress: accountEgress,
            probe: { state: 'egress_unavailable', label: '出站节点尚未就绪' },
          };
        }
      }));
      for (const result of results) {
        egress[result.key] = result.egress;
        if (result.probe) health[result.key] = result.probe;
      }
      return json(res, 200, { accounts: accounts.map(publicAccountDto), health, egress, readonly: CFG.readonlyAccounts });
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
      const key = existingAccountKey(obj, authToken)
        || accountKey({ id: body.id, email: email || undefined, authToken });
      const existing = obj.accounts[key] || {};
      const egressLane = Number.isInteger(existing.egressLane)
        ? existing.egressLane : nextAccountEgressLane(obj.accounts, key);
      if (!Number.isInteger(egressLane)) {
        return err(res, 409, `账号出站通道已满（最多 ${ACCOUNT_EGRESS_LANE_COUNT} 个账号）`, 'egress_capacity');
      }
      obj.accounts[key] = {
        ...(body.extra && typeof body.extra === 'object' ? body.extra : {}),
        id: body.id || existing.id || key,
        name: name || existing.name || '',
        email: email || existing.email || '',
        authToken,
        fingerprintId: body.fingerprintId || existing.fingerprintId || '',
        egressMode: existing.egressMode === 'manual' ? 'manual' : 'auto',
        egressNode: String(existing.egressNode || ''),
        egressLane,
      };
      cancelAccountEgressTasks(key);
      saveAccounts(obj);
      const account = accountByKey(key);
      const upstreamFetch = accountEgressFetch(account);
      const probe = upstreamFetch === accountEgressUnavailableFetch
        ? { state: 'egress_unavailable', label: '出站节点尚未就绪' }
        : await probeAccount(authToken, { upstreamFetch, queueKey: key });
      return json(res, 200, { ok: true, key, probe });
    }
    if (method === 'PATCH' && sub) {
      if (CFG.readonlyAccounts) return err(res, 403, '账号池为只读模式', 'readonly');
      let body;
      try { body = await readJsonObject(req); } catch (e) {
        return err(res, 400, e.message, 'invalid_egress_config');
      }
      const key = decodeURIComponent(sub);
      const account = accountByKey(key);
      if (!account || !account.hasToken) return err(res, 404, '账号不存在', 'not_found');
      const mode = body.egressMode;
      const node = body.egressNode;
      if (!['auto', 'manual'].includes(mode)) {
        return err(res, 400, '节点模式必须是 auto 或 manual', 'invalid_egress_config');
      }
      if (mode === 'manual' && !String(node || '').trim()) {
        return err(res, 400, '手动模式必须选择节点', 'invalid_egress_config');
      }
      beginAccountEgressMutation(key);
      cancelAccountEgressTasks(key);
      try {
        await configureAccountEgress(account, { mode, node, force: mode === 'auto' });
        const updated = accountByKey(key);
        return json(res, 200, {
          ok: true,
          account: publicAccountDto(updated),
          egress: accountEgressStatus(updated),
        });
      } catch (error) {
        return accountEgressApiError(res, error);
      } finally {
        endAccountEgressMutation(key);
      }
    }
    if (method === 'DELETE' && sub) {
      if (CFG.readonlyAccounts) return err(res, 403, '账号池为只读模式', 'readonly');
      const obj = loadAccounts();
      const key = decodeURIComponent(sub);
      if (!obj.accounts[key]) return err(res, 404, '账号不存在', 'not_found');
      const lane = obj.accounts[key].egressLane;
      delete obj.accounts[key];
      saveAccounts(obj);
      cancelAccountEgressTasks(key);
      if (Number.isInteger(lane)) await releaseAccountProxyLane(lane);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && sub) {
      // 探测单个账号
      const accounts = listAccounts();
      const acct = accounts.find((a) => a.key === decodeURIComponent(sub));
      if (!acct || !acct.hasToken) return err(res, 404, '账号不存在', 'not_found');
      try {
        const upstreamFetch = await ensureAccountEgressForAdminProbe(acct);
        return json(res, 200, await probeAccount(acct.token, {
          upstreamFetch,
          queueKey: acct.key,
        }));
      } catch (error) {
        if (error?.code === 'ACCOUNT_EGRESS_UNAVAILABLE') {
          return err(res, 503, '账号出站节点尚未就绪', 'egress_unavailable');
        }
        throw error;
      }
    }
    return err(res, 405, 'method not allowed');
  }

  // ---------- 调用日志（成功调用的环形缓冲 + 失败累计计数） ----------
  // 数据仅存在于 worker 进程内存中，不落盘；来源为 handler.getCallLog()。
  // 例外：byKey 里每把 Key 的会话/token 归账始终落盘并在重启后恢复；概况开关
  // 只控制总量与模型统计，避免分享 Key 的限额账因管理员关闭概况统计而丢失。
  if (seg === 'usage' && method === 'GET') {
    const snapshot = typeof handler.getCallLog === 'function' ? handler.getCallLog() : { calls: [], totals: {} };
    return json(res, 200, snapshot);
  }

  // ---------- 概况统计持久化开关 ----------
  // GET  /_api/usage-persistence → { enabled }
  // PUT  /_api/usage-persistence { enabled: boolean } → 切换开关；开启时立即保存当前快照。
  // 统计文件在数据目录（DATA_DIR），不落仓库根；损坏/缺失按空统计启动，不阻断服务。
  if (seg === 'usage-persistence') {
    if (method === 'GET') {
      return json(res, 200, { enabled: usageStore.enabled() });
    }
    if (method === 'PUT') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf-8') || '{}'); } catch { return err(res, 400, 'Invalid JSON'); }
      if (typeof body.enabled !== 'boolean') return err(res, 400, 'enabled 必须是布尔值', 'invalid_enabled');
      try {
        if (body.enabled) {
          // 开启时立即把当前内存快照写进文件（避免下次重启前丢失已累计数据）。
          await usageStore.setEnabled(true);
          const snap = typeof handler.usageSnapshot === 'function'
            ? handler.usageSnapshot()
            : typeof handler.getCallLog === 'function' ? handler.getCallLog() : {};
          await usageStore.save(snap);
        } else {
          await usageStore.setEnabled(false);
        }
        return json(res, 200, { enabled: usageStore.enabled() });
      } catch (e) {
        return err(res, 500, '写入统计失败: ' + e.message, 'io_error');
      }
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
          const key = existingAccountKey(obj, user.authToken) || accountKey(user);
          const existing = obj.accounts[key] || {};
          const egressLane = Number.isInteger(existing.egressLane)
            ? existing.egressLane : nextAccountEgressLane(obj.accounts, key);
          if (!Number.isInteger(egressLane)) {
            job.done = false;
            return err(res, 409, `账号出站通道已满（最多 ${ACCOUNT_EGRESS_LANE_COUNT} 个账号）`, 'egress_capacity');
          }
          obj.accounts[key] = {
            id: user.id || key,
            name: user.name || '',
            email: user.email || '',
            authToken: user.authToken,
            fingerprintId,
            egressMode: existing.egressMode === 'manual' ? 'manual' : 'auto',
            egressNode: String(existing.egressNode || ''),
            egressLane,
          };
          cancelAccountEgressTasks(key);
          saveAccounts(obj);
          scheduleAccountEgress(accountByKey(key));
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
      // 服务专用模型：面板拿它过滤账号额度行（快照里仍会返回这些调不通的模型）
      serviceOnlyModels: typeof handler.serviceOnlyModels === 'function' ? handler.serviceOnlyModels() : [],
      // 官方暂停模型：同上，面板据此隐藏停用模型；官方重新启用后名单自动变短
      pausedModels: typeof handler.pausedModels === 'function' ? handler.pausedModels() : [],
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

  // ---------- 分享 Key 管理（写入 credentials/api-keys.json，热生效） ----------
  // GET    /_api/keys            → { keys, stats, ownerName, locked }
  // POST   /_api/keys            { name, concurrency, models, dailyLimit } → 新发一把（dailyLimit = 每日 session 数）
  // PATCH  /_api/keys/:key       同上字段，传哪个改哪个（含 disabled）
  // DELETE /_api/keys/:key
  // 热生效同 aliases.json：buildWorkerEnv() 每次请求重读文件，改完立刻作用于下一个请求。
  if (seg === 'keys') {
    if (method === 'GET') {
      // 归账优先按 worker 提供的稳定指纹 join 回当前明文 Key；旧 worker 没有
      // fingerprint 字段时回退按备注名，保持滚动升级期间的兼容性。
      const byKey = (typeof handler.getCallLog === 'function' ? handler.getCallLog().byKey : null) || [];
      // 备注名来自配置文件，可能是 __proto__/constructor 等原型属性名；
      // 无原型对象才能把这些名字当普通 Key 返回给面板。
      const stats = Object.create(null);
      const keyed = new Map();
      const legacy = [];
      for (const row of byKey) {
        if (!row) continue;
        if (row.fingerprint) keyed.set(String(row.fingerprint), row);
        else if (row.name) legacy.push(row);
      }
      const publicStats = (row, name) => {
        if (!row) return null;
        const out = { ...row, name: name || row.name };
        delete out.fingerprint;
        return out;
      };
      for (const key of apiKeyStore.list()) {
        const fp = apiKeyStore.fingerprint(key.key);
        const row = fp ? keyed.get(fp) : null;
        if (row) stats[key.name] = publicStats(row, key.name);
      }
      // 旧 worker 的行没有指纹，只能暂按备注名兼容；不能覆盖已经按指纹匹配的行。
      for (const row of legacy) if (row.name && !stats[row.name]) stats[row.name] = publicStats(row);
      return json(res, 200, {
        keys: apiKeyStore.list(),
        stats,
        ownerName: OWNER_KEY_NAME,
        // 没设面板密码时不许发新 key：分享出去就等于把「能发 key 的面板」也分享了。
        locked: !CFG.adminPassword,
        file: apiKeyStore.file,
      });
    }
    if (method === 'POST' && !sub) {
      if (!CFG.adminPassword) {
        return err(res, 403, '请先设置 ADMIN_PASSWORD 再发新 Key —— 否则拿到地址的人都能打开面板发 Key', 'admin_password_required');
      }
      let body;
      try { body = await readJsonObject(req); } catch (e) { return err(res, 400, e.message); }
      try {
        return json(res, 200, { ok: true, key: apiKeyStore.add(body) });
      } catch (e) { return keyStoreError(res, e); }
    }
    if (method === 'PATCH' && sub) {
      let body;
      try { body = await readJsonObject(req); } catch (e) { return err(res, 400, e.message); }
      try {
        return json(res, 200, { ok: true, key: apiKeyStore.update(decodeURIComponent(sub), body) });
      } catch (e) { return keyStoreError(res, e); }
    }
    if (method === 'DELETE' && sub) {
      try {
        apiKeyStore.remove(decodeURIComponent(sub));
        return json(res, 200, { ok: true });
      } catch (e) { return keyStoreError(res, e); }
    }
    return err(res, 405, 'method not allowed');
  }

  return err(res, 404, 'not found');
}

// key 存储的错误 → HTTP：配置不合法 400，key 不存在 404，其余（写盘失败）500。
function keyStoreError(res, e) {
  if (e.code === 'INVALID_KEY_CONFIG') return err(res, 400, e.message, 'invalid_key_config');
  if (e.code === 'KEY_NOT_FOUND') return err(res, 404, e.message, 'not_found');
  return err(res, 500, '写入 api-keys.json 失败: ' + e.message, 'io_error');
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id || '',
    name: user.name || '',
    email: user.email || '',
    credits: user.credits ?? null,
  };
}

// ===========================================================================
// 启动
// ===========================================================================
ensureCredDir();

// 一次性迁移：老版本 aliases.json 在项目根（/app/aliases.json），
// 现在默认读到数据目录。若数据目录还没有、项目根却有（用户加过映射），
// 复制过去，避免面板「模型映射」丢失用户配置。容器里 /app 只读，
// 复制到 /data 后 /app 那份就不用再动了。
if (!env.MODEL_ALIASES_FILE) {
  try {
    const legacyAliases = resolve(__dirname, 'aliases.json');
    if (existsSync(legacyAliases) && !existsSync(CFG.aliasFile)) {
      mkdirSync(dirname(CFG.aliasFile), { recursive: true });
      writeFileSync(CFG.aliasFile, readFileSync(legacyAliases, 'utf-8'), 'utf-8');
      console.log('[server] 迁移 aliases.json → ' + CFG.aliasFile);
    }
  } catch (e) {
    console.error('[server] 迁移 aliases.json 失败（忽略）:', e.message);
  }
  removeHistoricalDefaultModelAliases();
}

// 出口代理（可选）：订阅既可以来自 SUBSCRIPTION_URL，也可以来自
// data/.mihomo/proxy-settings.json。环境变量非空时由 proxy service 锁定，
// 面板不能覆盖；内核/订阅失败则保持 getUpstreamFetch() 为空，上游直连。
setAccountAutoRefreshHandler((options) => { void initializeAccountEgress(options); });
const startupSubscription = getConfiguredSubscription();
if (startupSubscription) {
  setLogger((level, msg) => console.log(`[${level}] ${msg}`));
  try {
    const proxyFetch = await initProxy();
    const proxyStatus = await getProxyStatus();
    CFG.subscriptionUrl = getConfiguredSubscription();
    if (proxyFetch && proxyStatus.ok) {
      console.log(`[ciallo] proxy: mihomo @ mixed-port ${mihomo.mixedPort} (ctrl ${mihomo.ctrlPort})`);
      void initializeAccountEgress();
    } else {
      console.error(`[ciallo] proxy 初始化失败(保持直连): ${proxyStatus.error || 'mihomo 未就绪'}`);
    }
  } catch (e) {
    // 初始化异常不能阻止主服务启动；代理服务内部会尽量清理内核并回落直连。
    console.error(`[ciallo] proxy 初始化失败(保持直连): ${String(e?.message || e).slice(0, 180)}`);
  }
} else {
  console.log('[ciallo] proxy: 未配置订阅，上游直连');
}

// 加载 worker（顶层 await，Node 20+ 支持）
const worker = await import('./worker.js');
const handler = worker.default;
handler.configureUpstreamRouting?.({
  getUpstreamFetch,
  resolveAccountFetch: resolveAccountUpstreamRoute,
  isAccountRouteReady: isAccountUpstreamRouteReady,
  onReject: handleEgressReject,
});

// 概况统计持久化：开关与累计文件在数据目录。默认关闭；损坏/缺失回退空统计。
// store 只在 server 侧持有；worker 通过注入的适配器在每次 recordRequest 后触发 save。
const usageStore = createUsagePersistence(dataFile('usage-stats.json'));
function keyUsageSnapshotForWorker(snapshot) {
  const byKey = { ...(snapshot?.byKey || {}) };
  // 兼容尚未发布版本热写入的旧 FNV 指纹；新写入只使用服务端 SHA-256 指纹。
  if (typeof handler.keyFingerprint === 'function') {
    for (const key of apiKeyStore.list()) {
      const current = apiKeyStore.fingerprint(key.key);
      const legacy = handler.keyFingerprint(key.key);
      if (!byKey[current] && byKey[legacy]) byKey[current] = byKey[legacy];
      if (legacy !== current) delete byKey[legacy];
    }
  }
  return { ...(snapshot || {}), byKey };
}
const restoredUsageSnapshot = keyUsageSnapshotForWorker(usageStore.load());
if (typeof handler.configureUsagePersistence === 'function') {
  handler.configureUsagePersistence({
    load: () => usageStore.load(),
    save: (snapshot) => usageStore.save(snapshot),
    saveKey: (byKey) => usageStore.saveByKey(byKey),
    enabled: () => usageStore.enabled(),
  });
}
if (typeof handler.restoreKeyUsageSnapshot === 'function') {
  // 分享 Key 统计始终恢复；概况总量是否恢复仍由面板开关控制。
  handler.restoreKeyUsageSnapshot(restoredUsageSnapshot);
}
if (usageStore.enabled() && typeof handler.restoreUsageSnapshot === 'function') {
  handler.restoreUsageSnapshot(restoredUsageSnapshot);
  console.log('[server] 概况统计持久化已开启，恢复累计: ' + JSON.stringify(usageStore.load().total));
}

server.listen(CFG.port, CFG.host, () => {
  const n = listAccounts().length;
  console.log(`[ciallo] listening on http://${CFG.host}:${CFG.port}`);
  console.log(`[ciallo] web panel: http://localhost:${CFG.port}/  (admin password: ${CFG.adminPassword ? 'set' : 'NOT SET (内网建议设置)'})`);
  console.log(`[ciallo] accounts: ${n} (file: ${CFG.credFile})`);
});

// 优雅退出：先等统计写队列排空，再停 mihomo。usageSaveHook 为了不阻塞请求而
// 异步保存；不 flush 的话，SIGTERM 紧跟在一次调用结束时会把最后的 Key 统计丢掉。
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) console.log(`[ciallo] ${signal}, 正在退出...`);
  try { await usageStore.flush?.(); } catch (e) {
    console.error('[server] 统计持久化 flush 失败:', e.message);
  }
  // 先停止接收新请求并等在途请求收尾；它们可能在第一次 flush 之后才把
  // 最终 usage 写入队列，所以关服后再 flush 一次。
  try {
    await closeHttpServer(server);
  } catch (e) {
    console.error('[server] HTTP 服务关闭失败:', e.message);
  }
  await new Promise((resolve) => setImmediate(resolve));
  try { await usageStore.flush?.(); } catch (e) {
    console.error('[server] 统计持久化 flush 失败:', e.message);
  }
  try { await stopProxy(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
