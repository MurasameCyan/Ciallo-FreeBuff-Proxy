import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createAccountStateStore } from '../server/account-state.mjs';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

function workerFingerprint(token) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = 'freebuff-fp-v2:' + token;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return 'enhanced-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// 找一个空闲端口，避免和宿主 8787 冲突。
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv = {}, prepare = null) {
  const dir = await mkdtemp(join(tmpdir(), 'fbp-server-api-'));
  if (prepare) await prepare(dir);
  const port = await freePort();
  const childEnv = { ...process.env };
  for (const name of [
    'FREEBUFF_TOKEN', 'FREEBUFF_API_KEY', 'FREEBUFF_CREDENTIALS_FILE', 'FREEBUFF_ACCOUNT_STATE_FILE', 'CODEBUFF_API',
    'SUBSCRIPTION_URL', 'MIHOMO_BIN', 'MIHOMO_DATA_DIR', 'MIHOMO_HEALTH_URL',
    'MIHOMO_MIXED_PORT', 'MIHOMO_CTRL_PORT', 'MIHOMO_ACCOUNT_PORT_BASE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
  ]) delete childEnv[name];
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...childEnv,
      FREEBUFF_DATA_DIR: dir,
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: '',
      FREEBUFF_TOKEN: '',
      API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  // 等 /healthz 可访问（worker 无需账号也返回 ok）。
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) break;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error('server 未在期限内就绪: ' + (lastErr?.message || '') + '\n' + logs);
  }
  return { child, dir, base, port };
}

async function startFakeProbeUpstream(getMode, onRequest = () => {}) {
  const upstream = createHttpServer((req, res) => {
    onRequest(req);
    if (req.url !== '/api/v1/freebuff/session') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const mode = getMode();
    if (mode === 'banned') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'banned' }));
      return;
    }
    if (mode === 'nested-banned') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { status: 'banned' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'active', uid: 'local-probe-user' }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const { port } = upstream.address();
  return { upstream, url: `http://127.0.0.1:${port}` };
}

async function startFakeOauthUpstream(user) {
  const upstream = createHttpServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/auth/cli/code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        loginUrl: 'http://127.0.0.1/oauth-complete',
        fingerprintHash: 'local-fingerprint-hash',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/auth/cli/status?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const { port } = upstream.address();
  return { upstream, url: `http://127.0.0.1:${port}` };
}

async function stopServer(s) {
  s.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { s.child.kill('SIGKILL'); } catch {}
  await rm(s.dir, { recursive: true, force: true });
}

test('启动时移除三个历史默认模型映射并保留用户自定义映射', async (t) => {
  const s = await startServer({}, async (dir) => {
    await writeFile(join(dir, 'aliases.json'), JSON.stringify({
      aliases: {
        'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash',
        'deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro',
        'mimo-v2.5': 'mimo/mimo-v2.5',
        custom: 'openai/gpt-5.6-luna',
      },
    }, null, 2));
  });
  t.after(() => stopServer(s));

  const response = await fetch(s.base + '/_api/config');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).aliases, {
    custom: 'openai/gpt-5.6-luna',
  });
  assert.deepEqual(JSON.parse(await readFile(join(s.dir, 'aliases.json'), 'utf8')), {
    aliases: { custom: 'openai/gpt-5.6-luna' },
  });
});

test('历史默认映射迁移保留同名自定义目标并规范旧对象格式', async (t) => {
  const s = await startServer({}, async (dir) => {
    await writeFile(join(dir, 'aliases.json'), JSON.stringify({
      'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash',
      'deepseek-v4-pro-0813': 'custom/deepseek-v4-pro',
    }, null, 2));
  });
  t.after(() => stopServer(s));

  const response = await fetch(s.base + '/_api/config');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).aliases, {
    'deepseek-v4-pro-0813': 'custom/deepseek-v4-pro',
  });
  assert.deepEqual(JSON.parse(await readFile(join(s.dir, 'aliases.json'), 'utf8')), {
    aliases: { 'deepseek-v4-pro-0813': 'custom/deepseek-v4-pro' },
  });
});

test('显式 MODEL_ALIASES_FILE 属于用户配置，启动时不得清理', async (t) => {
  const managedDir = await mkdtemp(join(tmpdir(), 'fbp-managed-aliases-'));
  const aliasFile = join(managedDir, 'aliases.json');
  const configured = {
    aliases: {
      'deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro',
      custom: 'openai/gpt-5.6-luna',
    },
  };
  await writeFile(aliasFile, JSON.stringify(configured, null, 2));
  t.after(() => rm(managedDir, { recursive: true, force: true }));

  const s = await startServer({ MODEL_ALIASES_FILE: aliasFile });
  t.after(() => stopServer(s));

  const response = await fetch(s.base + '/_api/config');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).aliases, configured.aliases);
  assert.deepEqual(JSON.parse(await readFile(aliasFile, 'utf8')), configured);
});

test('概况统计持久化 API 契约', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));

  await t.test('GET 默认返回 { enabled: false }', async () => {
    const r = await fetch(s.base + '/_api/usage-persistence');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { enabled: false });
  });

  await t.test('PUT 非布尔 body 返回 400', async () => {
    const r = await fetch(s.base + '/_api/usage-persistence', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(r.status, 400);
  });

  await t.test('PUT enabled:true 返回开启并落盘统计文件', async () => {
    const r = await fetch(s.base + '/_api/usage-persistence', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { enabled: true });
    // 开启时应立即写入当前快照 → usage-stats.json 出现且 enabled:true。
    const raw = JSON.parse(await readFile(join(s.dir, 'usage-stats.json'), 'utf8'));
    assert.equal(raw.enabled, true);
    assert.ok(raw.snapshot && typeof raw.snapshot.total === 'object');
  });

  await t.test('PUT enabled:false 关闭但保留文件', async () => {
    const r = await fetch(s.base + '/_api/usage-persistence', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { enabled: false });
    // 关闭不删文件：再读仍是旧内容（enabled 已翻回 false）。
    const raw = JSON.parse(await readFile(join(s.dir, 'usage-stats.json'), 'utf8'));
    assert.equal(raw.enabled, false);
  });
});

test('账号自动出站优先级 API 可切换并持久化', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));

  const switched = await fetch(s.base + '/_api/proxy/account-priority', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ priority: 'unused' }),
  });
  assert.equal(switched.status, 200);
  const switchedBody = await switched.json();
  assert.equal(switchedBody.proxy.accountSelectionPriority, 'unused');

  const current = await fetch(s.base + '/_api/proxy');
  assert.equal(current.status, 200);
  assert.equal((await current.json()).accountSelectionPriority, 'unused');

  const invalid = await fetch(s.base + '/_api/proxy/account-priority', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ priority: 'random' }),
  });
  assert.equal(invalid.status, 400);
});

test('概况开关关闭时，分享 Key 统计仍从 usage-stats.json 恢复到面板', async (t) => {
  const key = 'fbk-server-key-stats-restore';
  const fingerprint = workerFingerprint(key);
  const s = await startServer({}, async (dir) => {
    await mkdir(join(dir, 'credentials'), { recursive: true });
    await writeFile(join(dir, 'credentials', 'api-keys.json'), JSON.stringify({ keys: [{
      key, name: '持久 Key', concurrency: 1, models: [], dailyLimit: 5, disabled: false,
    }] }));
    await writeFile(join(dir, 'usage-stats.json'), JSON.stringify({
      enabled: false,
      snapshot: {
        total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0,
          reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byModel: {},
        byKey: { [fingerprint]: { name: '持久 Key', totalTokens: 88, day: '2030-01-01',
          daySessions: ['enhanced-session'], total: 3, lastAt: 1893456000000 } },
        startTime: 123, lastRequest: null,
      },
    }));
  });
  t.after(() => stopServer(s));
  const r = await fetch(s.base + '/_api/keys');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.stats['持久 Key']?.totalTokens, 88);
  assert.equal(body.stats['持久 Key']?.total, 3);
  assert.equal(body.stats['持久 Key']?.dayCount, 0,
    '非当天的会话统计只保留累计，不应伪装成今日使用');
});

test('API 契约静态标记（服务端路由已注册）', () => {
  const src = readFileSync(SERVER, 'utf8');
  for (const marker of ["seg === 'usage-persistence'", "createUsagePersistence(dataFile('usage-stats.json'))", "saveKey", "restoreKeyUsageSnapshot", "configureUsagePersistence"]) {
    assert.ok(src.includes(marker), `server.js 缺少持久化接线: ${marker}`);
  }
  for (const marker of ["seg === 'keys'", "createApiKeyStore(dataFile('credentials', 'api-keys.json'))", 'FREEBUFF_API_KEYS: apiKeyStore.descriptors()']) {
    assert.ok(src.includes(marker), `server.js 缺少分享 Key 接线: ${marker}`);
  }
  assert.equal(src.includes('RELAY_KEY'), false, '死配置 RELAY_KEY 已移除（worker.js 从来没读它）');
});

test('优雅关停强制断开长流后要给清理回调留窗口', () => {
  const src = readFileSync(SERVER, 'utf8');
  const shutdown = src.slice(src.indexOf('async function shutdown'));
  assert.match(shutdown, /closeHttpServer\(server\)/,
    '生产关停必须使用经过真实 socket 时序测试的 closeHttpServer');
  assert.match(shutdown, /await new Promise\(\(resolve\) => setImmediate\(resolve\)\)/,
    '第二次 flush 前必须让 close/onDone 回调入队');
});

test('强制断开最后一个 socket 后仍等待清理窗口', async (t) => {
  const { closeHttpServer } = await import('../server/graceful-shutdown.mjs');
  let cleanupDone = false;
  const open = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('open');
  });
  open.on('connection', (socket) => {
    socket.once('close', () => {
      setTimeout(() => { cleanupDone = true; }, 40);
    });
  });
  await new Promise((resolve, reject) => {
    open.once('error', reject);
    open.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => { try { open.closeAllConnections?.(); open.close(); } catch {} });
  const response = await fetch(`http://127.0.0.1:${open.address().port}`);
  const startedAt = Date.now();
  await closeHttpServer(open, { forceAfterMs: 20, cleanupGraceMs: 80 });
  assert.ok(Date.now() - startedAt >= 80,
    'closeAllConnections 触发 close 回调后不能绕过清理窗口');
  assert.equal(cleanupDone, true, '最终 flush 前必须给 socket/流清理回调入队机会');
  await response.body?.cancel().catch(() => {});
});

// 分享 Key 的两条硬约束：没设面板密码不许发 key（发出去等于把面板也发出去了），
// 以及发/改/删必须对下一个客户端请求立刻生效（不重启）。
test('分享 Key：未设 ADMIN_PASSWORD 时锁定发放', async (t) => {
  const s = await startServer();
  t.after(() => stopServer(s));

  const r = await fetch(s.base + '/_api/keys');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.keys, []);
  assert.deepEqual(body.stats, {});
  assert.equal(body.ownerName, '主 Key');
  assert.equal(body.locked, true, '没设密码必须自报锁定，面板据此提示');

  const post = await fetch(s.base + '/_api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '小明' }),
  });
  assert.equal(post.status, 403);
  assert.equal((await post.json()).error.type, 'admin_password_required');
});

test('分享 Key 持久化统计按 key 指纹关联，改备注名后仍显示在当前 Key', async (t) => {
  const key = 'fbk-persist-rename-key-123456789';
  const replacementKey = 'fbk-reissued-old-name-987654321';
  const fp = workerFingerprint(key);
  const s = await startServer({}, async (dir) => {
    await mkdir(join(dir, 'credentials'), { recursive: true });
    await writeFile(join(dir, 'credentials', 'api-keys.json'), JSON.stringify({ keys: [
      { key, name: '新备注', concurrency: 1, models: [], dailyLimit: 0, disabled: false, createdAt: 1 },
      { key: replacementKey, name: '旧备注', concurrency: 1, models: [], dailyLimit: 0, disabled: false, createdAt: 2 },
    ] }));
    await writeFile(join(dir, 'usage-stats.json'), JSON.stringify({
      enabled: true,
      snapshot: {
        total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byModel: {},
        byKey: { [fp]: { name: '旧备注', totalTokens: 77 } },
        startTime: 1,
        lastRequest: null,
      },
    }));
  });
  t.after(() => stopServer(s));

  const body = await (await fetch(s.base + '/_api/keys')).json();
  assert.equal(body.stats['新备注']?.totalTokens, 77,
    '同一明文 Key 改备注名后，历史统计必须跟着 Key 而不是留在旧备注名下');
  assert.equal(body.stats['旧备注'], undefined,
    '删除旧 Key 后把原备注给新 Key，也不能把旧指纹统计错挂到新 Key');
});

test('分享 Key 备注为原型属性名时统计仍能按 Key 返回', async (t) => {
  const key = 'fbk-proto-name-test';
  const fingerprint = workerFingerprint(key);
  const s = await startServer({}, async (dir) => {
    await mkdir(join(dir, 'credentials'), { recursive: true });
    await writeFile(join(dir, 'credentials', 'api-keys.json'), JSON.stringify({ keys: [
      { key, name: '__proto__', concurrency: 1, models: [], dailyLimit: 0, disabled: false },
    ] }));
    await writeFile(join(dir, 'usage-stats.json'), JSON.stringify({
      enabled: false,
      snapshot: {
        total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0,
          reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byModel: {}, byKey: { [fingerprint]: { name: '__proto__', totalTokens: 7 } },
        startTime: 1, lastRequest: null,
      },
    }));
  });
  t.after(() => stopServer(s));
  const body = await (await fetch(s.base + '/_api/keys')).json();
  assert.equal(Object.prototype.hasOwnProperty.call(body.stats, '__proto__'), true);
  assert.equal(body.stats['__proto__']?.totalTokens, 7);
});

test('分享 Key：发/改/删对下一个客户端请求立刻生效', async (t) => {
  const s = await startServer({ ADMIN_PASSWORD: 'panel-pw', API_KEY: 'owner-key-for-server-test' });
  t.after(() => stopServer(s));
  const admin = { 'content-type': 'application/json', Authorization: 'Basic ' + Buffer.from('x:panel-pw').toString('base64') };
  // 鉴权只看 key 能不能过：随便挑一条 worker 认得 key 但没有的路由，
  // 有效 key → 404，无效 key → 401。不碰模型/上游，测试全程离线。
  const authProbe = (key) => fetch(s.base + '/v1/no-such-route', { headers: { Authorization: 'Bearer ' + key } });

  assert.equal((await fetch(s.base + '/_api/keys')).status, 401, '设了密码后管理接口必须鉴权');
  assert.equal((await authProbe('owner-key-for-server-test')).status, 404, '主 Key 照常可用');
  assert.equal((await authProbe('fbk-never-issued')).status, 401);

  const post = await fetch(s.base + '/_api/keys', {
    method: 'POST', headers: admin,
    body: JSON.stringify({ name: '小明', concurrency: 2, dailyLimit: 6, models: ['mimo/mimo-v2.5'] }),
  });
  assert.equal(post.status, 200);
  const issued = (await post.json()).key;
  assert.match(issued.key, /^fbk-/);
  assert.equal(issued.concurrency, 2);
  assert.equal((await authProbe(issued.key)).status, 404, '新发的 key 必须立刻能用（无需重启）');

  const stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'api-keys.json'), 'utf8'));
  assert.deepEqual(stored.keys.map((k) => k.name), ['小明']);

  const dup = await fetch(s.base + '/_api/keys', {
    method: 'POST', headers: admin, body: JSON.stringify({ name: '小明' }),
  });
  assert.equal(dup.status, 400);
  assert.equal((await dup.json()).error.type, 'invalid_key_config');

  const off = await fetch(s.base + '/_api/keys/' + encodeURIComponent(issued.key), {
    method: 'PATCH', headers: admin, body: JSON.stringify({ disabled: true }),
  });
  assert.equal(off.status, 200);
  assert.equal((await authProbe(issued.key)).status, 401, '停用必须立刻失效');

  const on = await fetch(s.base + '/_api/keys/' + encodeURIComponent(issued.key), {
    method: 'PATCH', headers: admin, body: JSON.stringify({ disabled: false, concurrency: 5 }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).key.concurrency, 5);
  assert.equal((await authProbe(issued.key)).status, 404, '重新启用后立刻可用');

  const missing = await fetch(s.base + '/_api/keys/fbk-nope', {
    method: 'PATCH', headers: admin, body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.type, 'not_found');

  const del = await fetch(s.base + '/_api/keys/' + encodeURIComponent(issued.key), { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  assert.equal((await authProbe(issued.key)).status, 401, '删除必须立刻失效');

  const list = await fetch(s.base + '/_api/keys', { headers: admin });
  const body = await list.json();
  assert.deepEqual(body.keys, []);
  assert.equal(body.locked, false);
});

test('未配置订阅时托管账号禁止携 Bearer 回落宿主直连', async (t) => {
  const observedBearer = [];
  const fake = await startFakeProbeUpstream(() => 'ok', (req) => {
    if (req.headers.authorization) observedBearer.push(req.headers.authorization);
  });
  const s = await startServer({ CODEBUFF_API: fake.url });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const token = 'managed-no-proxy-token-12345678901234567890';
  const add = await fetch(s.base + '/_api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authToken: token, email: 'no-proxy@example.test' }),
  });
  assert.equal(add.status, 200, '账号应保存成功，但不得直连探测');
  assert.equal((await add.json()).probe?.state, 'egress_unavailable');

  const config = await fetch(s.base + '/_api/config');
  assert.equal(config.status, 200);
  const masterKey = (await config.json()).apiKey;

  const chat = await fetch(s.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${masterKey}` },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    }),
  });
  assert.equal(chat.status, 503);
  assert.equal((await chat.json()).error?.type, 'egress_unavailable');

  const accounts = await fetch(s.base + '/_api/accounts');
  const account = (await accounts.json()).accounts[0];
  assert.equal('token' in account, false, '账号列表 DTO 不得返回 token');
  assert.equal('authToken' in account, false, '账号列表 DTO 不得返回 authToken');
  assert.equal('tokenShort' in account, false, '账号列表 DTO 不得返回 token 前缀');
  const probe = await fetch(s.base + '/_api/accounts/' + encodeURIComponent(account.key));
  assert.equal(probe.status, 503, '管理员探测也不得绕过账号出站哨兵');
  assert.equal((await probe.json()).error?.type, 'egress_unavailable');
  assert.deepEqual(observedBearer, [], '托管账号没有独立出口时不得暴露宿主真实出口');
});

test('管理员探测按明确结果持久隔离，自动候选验证不修改隔离', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fbp-probe-account-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'account-state.json');
  const accountStateStore = createAccountStateStore(file);
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function findProbeState(');
  const end = source.indexOf('\nconst accountEgressTasks =', start);
  assert.ok(start >= 0 && end > start, '应能隔离账号探测分类与持久化逻辑');

  let upstreamResult = { status: 403, data: { status: 'banned' } };
  const expectedFetch = async () => new Response();
  const enqueueUpstream = async (method, path, token, body, headers, timeout, fetchOverride) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/v1/freebuff/session');
    assert.equal(fetchOverride, expectedFetch, '管理员探测必须使用调用方给定的账号 lane fetch');
    assert.equal(timeout, expectedTimeout, '账号探测必须使用调用方指定的超时');
    return { ...upstreamResult, text: JSON.stringify(upstreamResult.data), headers: new Headers() };
  };
  const probeAccount = new Function(
    'enqueueUpstream',
    'accountStateStore',
    'normalizeAccountToken',
    'cancelAccountEgressTasksForToken',
    `${source.slice(start, end)}; return probeAccount;`,
  )(
    enqueueUpstream,
    accountStateStore,
    (value) => String(value || '').trim().split(':', 1)[0],
    (value) => cancelledTokens.push(value),
  );
  const bearerToken = 'server-probe-terminal-token-123456';
  const token = `${bearerToken}:uid-value`;
  const cancelledTokens = [];
  let expectedTimeout = 15000;

  const banned = await probeAccount(token, { upstreamFetch: expectedFetch });
  assert.equal(banned.state, 'banned');
  assert.equal(banned.isolatedPermanent, true);
  assert.equal(accountStateStore.snapshot([bearerToken])[bearerToken]?.state, 'banned',
    'token:uid 管理探测必须把终态写到裸 Bearer token');
  assert.deepEqual(accountStateStore.snapshot([token]), {},
    '不能把带 uid 的展示凭据另存成无法被 worker 命中的终态');
  assert.deepEqual(cancelledTokens, [bearerToken], '终态持久化后必须取消该 Bearer 的后台出站任务');
  assert.equal(Object.hasOwn(banned, 'raw'), false);
  const bannedRaw = await readFile(file, 'utf8');
  assert.match(bannedRaw, /"state":\s*"banned"/);
  assert.match(bannedRaw, /"until":\s*null/);
  assert.doesNotMatch(bannedRaw, new RegExp(token));

  upstreamResult = {
    status: 200,
    data: {
      status: 'active',
      rateLimitsByModel: {
        'openai/gpt-5.6-luna': { limit: 1, remaining: 0, pool: 'luna', poolLabel: 'Luna' },
        'mimo/mimo-v2.5': { limit: 6, pool: 'standard', poolLabel: 'Standard' },
      },
    },
  };
  const healthy = await probeAccount(token, { upstreamFetch: expectedFetch });
  assert.equal(healthy.state, 'ok');
  assert.equal(healthy.isolatedPermanent, false);
  assert.deepEqual(accountStateStore.snapshot([bearerToken]), {},
    '管理员成功探测必须清除裸 Bearer token 的终态');
  assert.doesNotMatch(await readFile(file, 'utf8'), /"state":\s*"banned"/);

  upstreamResult = { status: 403, data: { error: { status: 'banned' } } };
  const nested = await probeAccount(token, { upstreamFetch: expectedFetch });
  assert.equal(nested.state, 'banned');
  assert.equal(nested.isolatedPermanent, true);

  upstreamResult = {
    status: 200,
    data: {
      status: 'active',
      rateLimitsByModel: {
        'openai/gpt-5.6-luna': { limit: 1, remaining: 0, pool: 'luna', poolLabel: 'Luna' },
        'mimo/mimo-v2.5': { limit: 6, pool: 'standard', poolLabel: 'Standard' },
      },
    },
  };
  expectedTimeout = 5000;
  const verification = await probeAccount(token, {
    upstreamFetch: expectedFetch,
    updateIsolation: false,
    timeoutMs: 5000,
  });
  assert.equal(verification.state, 'ok');
  assert.deepEqual(verification.quota, [
    {
      model: 'openai/gpt-5.6-luna', used: null, limit: 1, remaining: 0, resetAt: null,
      pool: 'luna', poolLabel: 'Luna',
    },
    {
      model: 'mimo/mimo-v2.5', used: null, limit: 6, remaining: null, resetAt: null,
      pool: 'standard', poolLabel: 'Standard',
    },
  ], '模型行必须保留上游池标识，面板才能按 D/L/P 聚合而不混淆独立额度池');
  assert.equal(verification.isolatedPermanent, true,
    '自动选点模型验证成功不能清除管理员持久隔离');
});

test('自动节点授权探测使用五秒超时，避免坏节点长时间阻塞队列', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /const ACCOUNT_EGRESS_PROBE_TIMEOUT_MS = 5000;/);
  const start = source.indexOf('async function configureAccountEgress(');
  const end = source.indexOf('\nfunction scheduleAccountEgress(', start);
  const body = source.slice(start, end);
  assert.match(body,
    /probeAccount\(account\.token, \{[\s\S]*?timeoutMs: ACCOUNT_EGRESS_PROBE_TIMEOUT_MS[\s\S]*?\}\)/,
    '自动候选验证必须显式使用短超时');
});

test('账号探测同账号串行、不同账号并发且总并发有界', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const ACCOUNT_EGRESS_PROBE_CONCURRENCY');
  const end = source.indexOf('\nasync function upstreamJson(', start);
  assert.ok(start >= 0 && end > start, '应存在账号探测有限并发队列');
  const { enqueueAccountProbe, limit } = new Function(
    `${source.slice(start, end)}; return { enqueueAccountProbe, limit: ACCOUNT_EGRESS_PROBE_CONCURRENCY };`,
  )();
  assert.equal(limit, 8);

  const releases = [];
  const started = [];
  const blocked = (name) => enqueueAccountProbe(name, async () => {
    started.push(name);
    await new Promise((resolve) => { releases.push({ name, resolve }); });
  });
  const firstA = blocked('a');
  const secondA = blocked('a');
  const firstB = blocked('b');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ['a', 'b'], '同账号必须排队，不同账号必须立即并发');
  releases.find((entry) => entry.name === 'a').resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ['a', 'b', 'a'], '前一项完成后同账号下一项才可开始');
  for (const entry of releases) entry.resolve();
  await Promise.all([firstA, secondA, firstB]);

  let active = 0;
  let peak = 0;
  let releaseWave;
  const wave = new Promise((resolve) => { releaseWave = resolve; });
  const tasks = Array.from({ length: 9 }, (_, index) => enqueueAccountProbe(`lane-${index}`, async () => {
    active++;
    peak = Math.max(peak, active);
    await wave;
    active--;
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(peak, 8, '账号探测总并发不得超过八路');
  releaseWave();
  await Promise.all(tasks);
});

test('OAuth poll 不返回 authToken，token-only 账号使用 opaque key', async (t) => {
  const token = 'oauth-token-only-account-1234567890';
  const fake = await startFakeOauthUpstream({ authToken: token, name: 'OAuth Only' });
  const s = await startServer({ CODEBUFF_API: fake.url });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const started = await fetch(s.base + '/_api/login/start', { method: 'POST' });
  assert.equal(started.status, 200);
  const { fingerprintId } = await started.json();
  const poll = await fetch(s.base + '/_api/login/poll?fingerprintId=' + encodeURIComponent(fingerprintId));
  assert.equal(poll.status, 200);
  const pollBody = await poll.json();
  assert.equal(pollBody.state, 'done');
  assert.equal(Object.hasOwn(pollBody.user, 'authToken'), false, 'OAuth 响应不得把凭据发到浏览器');

  const accounts = await fetch(s.base + '/_api/accounts');
  assert.equal(accounts.status, 200);
  const account = (await accounts.json()).accounts[0];
  assert.match(account.key, /^acct-[0-9a-f-]+$/i);
  assert.equal(account.key.includes(token.slice(0, 12)), false);
  const stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.accounts), [account.key], 'opaque key 必须持久化');
});

test('OAuth 更新同一 token 时复用原账号和 lane，不创建重复路由', async (t) => {
  const token = 'oauth-existing-token-12345678901234567890';
  const fake = await startFakeOauthUpstream({
    id: 'oauth-new-id',
    email: 'oauth-new@example.test',
    authToken: token,
  });
  const s = await startServer({ CODEBUFF_API: fake.url }, async (dir) => {
    const credentialsDir = join(dir, 'credentials');
    await mkdir(credentialsDir, { recursive: true });
    await writeFile(join(credentialsDir, 'freebuff_credentials.json'), JSON.stringify({
      accounts: {
        original: {
          id: 'original',
          email: 'original@example.test',
          authToken: token,
          egressMode: 'manual',
          egressNode: 'US-A',
          egressLane: 9,
        },
      },
    }, null, 2));
  });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const started = await fetch(s.base + '/_api/login/start', { method: 'POST' });
  const { fingerprintId } = await started.json();
  const poll = await fetch(s.base + '/_api/login/poll?fingerprintId=' + encodeURIComponent(fingerprintId));
  assert.equal(poll.status, 200);

  const stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.accounts), ['original']);
  assert.equal(stored.accounts.original.egressLane, 9);
  assert.equal(stored.accounts.original.egressMode, 'manual');
  assert.equal(stored.accounts.original.egressNode, 'US-A');
});

test('历史 token 前缀账号 key 会迁移为持久 opaque key', async (t) => {
  const token = 'legacy-token-only-account-1234567890';
  const legacyKey = 'token-' + token.slice(0, 12);
  const fake = await startFakeProbeUpstream(() => 'ok');
  const s = await startServer({ CODEBUFF_API: fake.url }, async (dir) => {
    const credentialsDir = join(dir, 'credentials');
    await mkdir(credentialsDir, { recursive: true });
    await writeFile(join(credentialsDir, 'freebuff_credentials.json'), JSON.stringify({
      accounts: {
        [legacyKey]: { id: legacyKey, name: '', email: '', authToken: token },
      },
    }, null, 2));
  });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const response = await fetch(s.base + '/_api/accounts');
  assert.equal(response.status, 200);
  const account = (await response.json()).accounts[0];
  assert.match(account.key, /^acct-[0-9a-f-]+$/i);
  assert.notEqual(account.key, legacyKey);
  assert.equal(account.id, account.key, '泄露 token 前缀的旧 id 也必须同步迁移');
  const stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.accounts), [account.key]);
  assert.equal(JSON.stringify(stored).includes(legacyKey), false);
});

test('同一 Bearer 的历史 token:uid 只保留首个账号和 lane，新增时继续复用', async (t) => {
  const token = 'duplicate-account-token-12345678901234567890';
  const fake = await startFakeProbeUpstream(() => 'ok');
  const s = await startServer({ CODEBUFF_API: fake.url }, async (dir) => {
    const credentialsDir = join(dir, 'credentials');
    await mkdir(credentialsDir, { recursive: true });
    await writeFile(join(credentialsDir, 'freebuff_credentials.json'), JSON.stringify({
      accounts: {
        primary: {
          id: 'primary',
          name: 'Primary',
          email: '',
          authToken: `  ${token}:uid-primary  `,
          egressMode: 'manual',
          egressNode: 'US-A',
          egressLane: 7,
        },
        duplicate: {
          id: 'duplicate',
          name: 'Duplicate',
          email: 'duplicate@example.test',
          authToken: `${token}:uid-duplicate`,
          egressMode: 'auto',
          egressNode: '',
          egressLane: 11,
        },
      },
    }, null, 2));
  });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const response = await fetch(s.base + '/_api/accounts');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.accounts.map((account) => account.key), ['primary']);

  let stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.accounts), ['primary']);
  assert.equal(stored.accounts.primary.authToken, `${token}:uid-primary`);
  assert.equal(stored.accounts.primary.egressLane, 7);
  assert.equal(stored.accounts.primary.egressMode, 'manual');
  assert.equal(stored.accounts.primary.egressNode, 'US-A');

  const update = await fetch(s.base + '/_api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authToken: `${token}:uid-new`, name: 'Updated' }),
  });
  assert.equal(update.status, 200);
  stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored.accounts), ['primary'], '新增同 Bearer 凭据不得再占一个 lane');
  assert.equal(stored.accounts.primary.authToken, `${token}:uid-new`);
  assert.equal(stored.accounts.primary.egressLane, 7);
});

test('账号出站配置持久化且内部 lane 不暴露给管理 API', async (t) => {
  const tokens = ['egress-account-a-123456789012345', 'egress-account-b-123456789012345'];
  const fake = await startFakeProbeUpstream(() => 'ok');
  const s = await startServer({ CODEBUFF_API: fake.url }, async (dir) => {
    const credentialsDir = join(dir, 'credentials');
    await mkdir(credentialsDir, { recursive: true });
    await writeFile(join(credentialsDir, 'freebuff_credentials.json'), JSON.stringify({
      accounts: {
        'account-a': { id: 'account-a', email: 'a@example.test', authToken: tokens[0] },
        'account-b': { id: 'account-b', email: 'b@example.test', authToken: tokens[1] },
      },
    }, null, 2));
  });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const response = await fetch(s.base + '/_api/accounts');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accounts.length, 2);
  for (const account of body.accounts) {
    assert.equal(account.egressMode, 'auto');
    assert.equal(account.egressNode, '');
    assert.equal(Object.hasOwn(account, 'egressLane'), false, '内部 lane 不得暴露到浏览器');
  }
  assert.deepEqual(Object.keys(body.egress).sort(), body.accounts.map((account) => account.key).sort());
  assert.ok(Object.values(body.egress).every((entry) => entry.state === 'proxy_offline'));

  const credentialsFile = join(s.dir, 'credentials', 'freebuff_credentials.json');
  const stored = JSON.parse(await readFile(credentialsFile, 'utf8'));
  const rows = Object.values(stored.accounts);
  assert.deepEqual(rows.map((row) => row.egressMode), ['auto', 'auto']);
  assert.deepEqual(rows.map((row) => row.egressNode), ['', '']);
  assert.equal(new Set(rows.map((row) => row.egressLane)).size, 2, '两个账号必须持久化不同 lane');
  assert.ok(rows.every((row) => Number.isInteger(row.egressLane) && row.egressLane >= 0));

  const patchResponse = await fetch(s.base + '/_api/accounts/account-a', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ egressMode: 'manual', egressNode: 'US-A' }),
  });
  assert.equal(patchResponse.status, 409, '无订阅时不能保存一个实际未生效的手动节点');
  assert.equal((await patchResponse.json()).error.type, 'proxy_not_ready');
  const after = JSON.parse(await readFile(credentialsFile, 'utf8'));
  assert.equal(after.accounts['account-a'].egressMode, 'auto', '失败配置必须保持原值');
  assert.equal(after.accounts['account-a'].egressNode, '');

  const invalidMode = await fetch(s.base + '/_api/accounts/account-a', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ egressMode: 'random', egressNode: 'US-A' }),
  });
  assert.equal(invalidMode.status, 400);
  assert.equal((await invalidMode.json()).error.type, 'invalid_egress_config');

  const missingManualNode = await fetch(s.base + '/_api/accounts/account-a', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ egressMode: 'manual', egressNode: '' }),
  });
  assert.equal(missingManualNode.status, 400);
  assert.equal((await missingManualNode.json()).error.type, 'invalid_egress_config');
});

test('账号出站 lane 用尽时新增账号返回明确容量错误', async (t) => {
  const fake = await startFakeProbeUpstream(() => 'ok');
  const s = await startServer({ CODEBUFF_API: fake.url }, async (dir) => {
    const credentialsDir = join(dir, 'credentials');
    await mkdir(credentialsDir, { recursive: true });
    const accounts = {};
    for (let lane = 0; lane < 64; lane++) {
      accounts[`account-${lane}`] = {
        id: `account-${lane}`,
        email: `account-${lane}@example.test`,
        authToken: `lane-${lane}-token-12345678901234567890`,
        egressMode: 'auto',
        egressNode: '',
        egressLane: lane,
      };
    }
    await writeFile(join(credentialsDir, 'freebuff_credentials.json'), JSON.stringify({ accounts }, null, 2));
  });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const response = await fetch(s.base + '/_api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'overflow@example.test',
      authToken: 'overflow-account-token-12345678901234567890',
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.type, 'egress_capacity');

  const stored = JSON.parse(await readFile(join(s.dir, 'credentials', 'freebuff_credentials.json'), 'utf8'));
  assert.equal(Object.keys(stored.accounts).length, 64, '容量错误不得写入一个没有 lane 的账号');
});

test('自动节点验证过期时沿用已验证 lane 并后台刷新，不中断当前请求', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function accountEgressFetch(');
  const end = source.indexOf('\nfunction accountEgressStatus(', start);
  assert.ok(start >= 0 && end > start, '应存在账号出站 fetch 选择函数');
  const body = source.slice(start, end);
  assert.match(body, /getAccountAutoUpstreamFetch\(account\.egressLane, \{ allowStale: true, identity \}\)/,
    '自动模式应识别上次已验证但过期的 lane');
  assert.match(body, /if \(staleFetch\)[\s\S]*?scheduleAccountEgress\(account, \{ force: false \}\)[\s\S]*?return route\(staleFetch\)/,
    '缓存过期应后台重验并继续使用上次已验证 fetch');
});

test('账号出口初始化并发启动全部有效账号，不被首个慢任务阻塞', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function initializeAccountEgress(');
  const end = source.indexOf('\nfunction handleEgressReject(', start);
  assert.ok(start >= 0 && end > start, '应存在可隔离验证的账号出口初始化函数');
  const initializeAccountEgress = new Function(
    'getConfiguredSubscription',
    'listAccounts',
    'scheduleAccountEgress',
    'isTerminalAccount',
    `${source.slice(start, end)}; return initializeAccountEgress;`,
  )(
    () => 'https://subscription.example.test',
    () => [
      { key: 'slow', hasToken: true, egressLane: 1 },
      { key: 'without-token', hasToken: false, egressLane: 2 },
      { key: 'fast', hasToken: true, egressLane: 3 },
    ],
    (account) => {
      started.push(account.key);
      return account.key === 'slow' ? slowTask : Promise.resolve();
    },
    () => false,
  );
  const started = [];
  let releaseSlow;
  const slowTask = new Promise((resolve) => { releaseSlow = resolve; });

  const initialization = initializeAccountEgress();
  await Promise.resolve();
  assert.deepEqual(started, ['slow', 'fast'],
    '慢账号的后台验证不得延迟后续有效账号的启动');
  releaseSlow();
  await initialization;
});

test('手动刷新出站只串行强制重验自动账号，手动绑定账号保持不变', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function initializeAccountEgress(');
  const end = source.indexOf('\nconst ACCOUNT_EGRESS_REFRESH_COOLDOWN_MS', start);
  assert.ok(start >= 0 && end > start, '账号出口初始化后应定义手动刷新冷却器');
  const initializeAccountEgress = new Function(
    'getConfiguredSubscription',
    'listAccounts',
    'scheduleAccountEgress',
    'isTerminalAccount',
    `${source.slice(start, end)}; return initializeAccountEgress;`,
  )(
    () => 'https://subscription.example.test',
    () => [
      { key: 'auto-slow', hasToken: true, egressLane: 1, egressMode: 'auto' },
      { key: 'manual', hasToken: true, egressLane: 2, egressMode: 'manual' },
      { key: 'auto-fast', hasToken: true, egressLane: 3, egressMode: 'auto' },
    ],
    (account, options) => {
      started.push({ key: account.key, options });
      return account.key === 'auto-slow' ? slowTask : Promise.resolve();
    },
    () => false,
  );
  const started = [];
  let releaseSlow;
  const slowTask = new Promise((resolve) => { releaseSlow = resolve; });

  const refresh = initializeAccountEgress({ force: true, serial: true, autoOnly: true });
  await Promise.resolve();
  assert.deepEqual(started.map((entry) => entry.key), ['auto-slow'],
    '串行刷新不得在首个账号完成前启动下一个账号探测');
  releaseSlow();
  const refreshed = await refresh;
  assert.deepEqual(started.map((entry) => entry.key), ['auto-slow', 'auto-fast']);
  assert.ok(started.every((entry) => entry.options.force === true), '手动刷新必须强制重新验证缓存');
  assert.equal(refreshed, 2, '返回值应为实际发起重验的自动账号数');
});

test('自动出口初始化跳过终态账号，批量刷新合并已有任务后强制重测', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function scheduleAccountEgress(');
  const end = source.indexOf('\nconst ACCOUNT_EGRESS_REFRESH_COOLDOWN_MS', start);
  assert.ok(start >= 0 && end > start, '应能隔离后台调度与批量初始化逻辑');
  const terminal = new Map([
    ['banned-token', { state: 'banned', until: null }],
    ['invalid-token', { state: 'token_invalid', until: null }],
    ['disabled-token', { state: 'manual_disabled', until: null }],
  ]);
  const accountStateStore = {
    snapshot(tokens) {
      return Object.fromEntries(tokens.flatMap((token) => terminal.has(token) ? [[token, terminal.get(token)]] : []));
    },
  };
  const accounts = [
    { key: 'banned', token: 'banned-token', hasToken: true, egressLane: 1, egressMode: 'auto' },
    { key: 'invalid', token: 'invalid-token', hasToken: true, egressLane: 2, egressMode: 'auto' },
    { key: 'disabled', token: 'disabled-token', hasToken: true, egressLane: 3, egressMode: 'auto' },
    { key: 'healthy', token: 'healthy-token', hasToken: true, egressLane: 4, egressMode: 'auto' },
  ];
  const configured = [];
  const api = new Function(
    'getConfiguredSubscription',
    'accountEgressMutationActive',
    'accountEgressIdentity',
    'accountEgressTaskKey',
    'accountEgressTasks',
    'accountEgressTaskActive',
    'accountByKey',
    'configureAccountEgress',
    'listAccounts',
    'accountStateStore',
    'isTerminalAccount',
    `${source.slice(start, end)}; return { scheduleAccountEgress, initializeAccountEgress };`,
  )(
    () => 'https://subscription.example.test',
    () => false,
    (account) => account.token,
    (account) => `${account.key}\0${account.token}`,
    new Map(),
    () => false,
    (key) => accounts.find((account) => account.key === key) || null,
    async (account, options) => { configured.push({ key: account.key, options }); },
    () => accounts,
    accountStateStore,
    (account) => Boolean(account?.token && accountStateStore.snapshot([account.token])[account.token]),
  );

  assert.equal(api.scheduleAccountEgress(accounts[0], { force: true }), null,
    '后台调度入口不得触碰 banned 账号');
  const refreshed = await api.initializeAccountEgress({ force: true, serial: true, autoOnly: true });
  assert.deepEqual(configured.map((entry) => entry.key), ['healthy']);
  assert.equal(refreshed, 1);

  let release;
  const active = new Promise((resolve) => { release = resolve; });
  const activeAccounts = [{ key: 'active', token: 'active-token', hasToken: true, egressLane: 5, egressMode: 'auto' }];
  let runs = 0;
  const tasks = new Map();
  const activeApi = new Function(
    'getConfiguredSubscription',
    'accountEgressMutationActive',
    'accountEgressIdentity',
    'accountEgressTaskKey',
    'accountEgressTasks',
    'accountEgressTaskActive',
    'accountByKey',
    'configureAccountEgress',
    'listAccounts',
    'accountStateStore',
    'isTerminalAccount',
    `${source.slice(start, end)}; return { scheduleAccountEgress, initializeAccountEgress };`,
  )(
    () => 'https://subscription.example.test',
    () => false,
    (account) => account.token,
    (account) => `${account.key}\0${account.token}`,
    tasks,
    (account) => tasks.has(`${account.key}\0${account.token}`),
    () => activeAccounts[0],
    async () => { runs++; await active; },
    () => activeAccounts,
    { snapshot: () => ({}) },
    () => false,
  );
  const first = activeApi.scheduleAccountEgress(activeAccounts[0], { force: false });
  await Promise.resolve();
  const duplicateRefresh = activeApi.initializeAccountEgress({
    force: true, serial: true, autoOnly: true, skipActive: true,
  });
  await Promise.resolve();
  release();
  const duplicateCount = await duplicateRefresh;
  assert.equal(duplicateCount, 1, '批量刷新应把已有任务合并为一次强制重测');
  await first;
  assert.equal(runs, 2, '批量刷新必须在已有任务完成后追加一次 force 探测');
});

test('账号进入终态后停止后台节点验证并取消同账号任务', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const configureStart = source.indexOf('async function configureAccountEgress(');
  const configureEnd = source.indexOf('\nfunction scheduleAccountEgress(', configureStart);
  assert.ok(configureStart >= 0 && configureEnd > configureStart);
  const configure = source.slice(configureStart, configureEnd);
  assert.match(configure, /verify: async \(\{ fetch: fetchForLane \}\) => \{[\s\S]*?isTerminalAccount\(account\)[\s\S]*?probeAccount\([\s\S]*?isTerminalAccount\(account\)/,
    '每次后台账号探测前后都必须检查持久终态，不能继续探测后续节点');
  assert.match(source, /cancelAccountEgressTasksForToken\(normalized\)/,
    '持久化终态时必须取消同账号后台出站任务');
});

test('worker 写入终态时取消 token:uid 账号任务，普通账号也保持原 token 语义', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildWorkerEnv(');
  const end = source.indexOf('\n// === Web 管理 API 路由', start);
  assert.ok(start >= 0 && end > start);
  const accountStateStore = {
    set(token, state) { writes.push({ token, state }); return { revision: writes.length }; },
    clear() {},
    snapshot() { return {}; },
    revision() { return 0; },
  };
  const writes = [];
  const cancelled = [];
  const buildWorkerEnv = new Function(
    'allTokens', 'listAccounts', 'managedAccountTokenHistory', 'normalizeAccountToken', 'env',
    'loadModelAliases', 'currentApiKey', 'apiKeyStore', 'accountLabels', 'getUpstreamFetch',
    'resolveAccountUpstreamRoute', 'handleEgressReject', 'accountStateStore', 'cancelAccountEgressTasksForToken',
    `${source.slice(start, end)}; return buildWorkerEnv;`,
  )(
    () => ['bearer-token:uid-value', 'plain-token'],
    () => [],
    new Set(),
    (value) => String(value || '').trim().split(':', 1)[0],
    {},
    () => new Map(),
    () => 'master-key',
    { descriptors: () => [] },
    () => ({}),
    () => null,
    () => null,
    () => {},
    accountStateStore,
    (token) => cancelled.push(token),
  );
  const workerEnv = buildWorkerEnv();

  workerEnv.FREEBUFF_ACCOUNT_STATE_SET('bearer-token:uid-value', { state: 'banned' });
  workerEnv.FREEBUFF_ACCOUNT_STATE_SET('plain-token', { state: 'token_invalid' });
  assert.deepEqual(writes.map((entry) => entry.token), ['bearer-token', 'plain-token']);
  assert.deepEqual(cancelled, ['bearer-token', 'plain-token']);
});

test('手动刷新出站单飞且完成后 60 秒内拒绝重复批量探测', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const ACCOUNT_EGRESS_REFRESH_COOLDOWN_MS');
  const end = source.indexOf('\nfunction handleEgressReject(', start);
  assert.ok(start >= 0 && end > start, '应存在可隔离验证的手动出站刷新函数');
  let now = 1_000_000;
  class FakeDate extends Date { static now() { return now; } }
  let releaseSubscription;
  const subscription = new Promise((resolve) => { releaseSubscription = resolve; });
  const initCalls = [];
  const refreshAccountEgressNow = new Function(
    'Date',
    'getConfiguredSubscription',
    'refreshSubscription',
    'initializeAccountEgress',
    'getProxyStatus',
    `${source.slice(start, end)}; return refreshAccountEgressNow;`,
  )(
    FakeDate,
    () => 'https://subscription.example.test',
    () => subscription,
    async (options) => { initCalls.push(options); return 3; },
    async () => ({ ok: true, state: 'ready' }),
  );

  const first = refreshAccountEgressNow();
  await assert.rejects(
    () => refreshAccountEgressNow(),
    (error) => error?.code === 'ACCOUNT_EGRESS_REFRESH_IN_PROGRESS',
    '已有一轮刷新时不能并发启动第二轮',
  );
  releaseSubscription({ ok: true });
  const result = await first;
  assert.equal(result.refreshedAccounts, 3);
  assert.deepEqual(initCalls, [{ force: true, serial: true, autoOnly: true, skipActive: true }]);

  await assert.rejects(
    () => refreshAccountEgressNow(),
    (error) => error?.code === 'ACCOUNT_EGRESS_REFRESH_COOLDOWN' && error.retryAfterMs > 0,
    '完成后冷却期内不能再次批量探测',
  );
  now += 60_000;
  const afterCooldown = await new Function(
    'refreshSubscription',
    'run',
    'return async () => { refreshSubscription(); return run(); };',
  )(() => {}, refreshAccountEgressNow)();
  assert.equal(afterCooldown.refreshedAccounts, 3);
});

test('刷新出站管理 API 等待节点测活与账号重验完成', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.slice(
    source.indexOf("if (seg === 'proxy')"),
    source.indexOf("if (method === 'PUT' && (!sub || sub === 'subscription'))"),
  );
  assert.match(route,
    /method === 'POST' && sub === 'refresh-egress'[\s\S]*?await refreshAccountEgressNow\(\)/,
    '刷新出站 API 必须等待完整重验，不能只丢一个后台任务就返回成功');
  assert.match(source, /ACCOUNT_EGRESS_REFRESH_COOLDOWN[\s\S]*?Retry-After/,
    '批量刷新冷却响应必须告诉面板可重试时间');
});

test('stale 自动验证路由在后台复验期间仍显示 ready', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function accountEgressStatus(');
  const end = source.indexOf('\nasync function configureAccountEgress(', start);
  assert.ok(start >= 0 && end > start, '应存在可隔离验证的账号出口状态函数');
  const accountEgressStatus = new Function(
    'accountTerminalState',
    'getAccountProxyNode',
    'getAccountEgressReject',
    'accountEgressIdentity',
    'getAccountUpstreamFetch',
    'getAccountAutoUpstreamFetch',
    'getConfiguredSubscription',
    'ACCOUNT_EGRESS_LANE_COUNT',
    'accountEgressTaskActive',
    'inferNodeRegion',
    `${source.slice(start, end)}; return accountEgressStatus;`,
  )(
    () => null,
    () => 'US-A',
    () => null,
    () => 'account-identity',
    () => () => {},
    (_lane, options) => options.allowStale ? (() => {}) : null,
    () => 'https://subscription.example.test',
    64,
    () => true,
    () => 'US',
  );

  const status = accountEgressStatus({ egressLane: 1, egressMode: 'auto', token: 'token' });
  assert.equal(status.state, 'ready');
  assert.equal(status.verified, true);
});

test('后台账号出站刷新只更新运行态，不能用旧快照覆盖持久化配置', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function scheduleAccountEgress(');
  const end = source.indexOf('\nasync function initializeAccountEgress(', start);
  assert.ok(start >= 0 && end > start, '应存在后台账号出站调度函数');
  const body = source.slice(start, end);
  assert.match(body, /configureAccountEgress\(current, \{ force: runForce, persist: false \}\)/,
    '后台重验不得重写账号凭据或覆盖用户刚保存的出站配置');
});

test('旧 token 的 lane 拒绝回调不得触碰已复用账号', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function handleEgressReject(');
  const end = source.indexOf('\n// === Freebuff 授权码登录', start);
  assert.ok(start >= 0 && end > start, '应存在可隔离验证的出口拒绝回调');
  const factory = new Function(
    'accountByToken',
    'noteEgressReject',
    'scheduleAccountEgress',
    'isTerminalAccount',
    `${source.slice(start, end)}; return handleEgressReject;`,
  );
  const noted = [];
  const scheduled = [];
  const accounts = new Map([
    ['current-token', { key: 'current', egressLane: 4, egressMode: 'auto' }],
  ]);
  const handler = factory(
    (token) => accounts.get(token) || null,
    (info) => noted.push(info),
    (account) => scheduled.push(account.key),
    () => false,
  );

  handler({ token: 'deleted-token', lane: 4, node: 'US-A', generation: 1 });
  handler({ token: 'current-token', lane: 5, node: 'SG-B', generation: 2 });
  assert.deepEqual(noted, [], 'token 不存在或 lane 不匹配时不得修改当前代理 lane');
  assert.deepEqual(scheduled, [], '无效回调不得触发当前账号后台重选');

  handler({ token: 'current-token', lane: 4, node: 'US-A', generation: 3 });
  assert.equal(noted.length, 1);
  assert.deepEqual(scheduled, ['current'], '只有 token 与 lane 同时匹配才允许归因和重选');
});

test('出口拒绝回调记录终态账号的节点错误但不再自动重调度', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function handleEgressReject(');
  const end = source.indexOf('\n// === Freebuff 授权码登录', start);
  const terminal = { key: 'banned', token: 'banned-token', egressLane: 4, egressMode: 'auto' };
  const noted = [];
  const scheduled = [];
  const handler = new Function(
    'accountByToken', 'noteEgressReject', 'scheduleAccountEgress', 'isTerminalAccount',
    `${source.slice(start, end)}; return handleEgressReject;`,
  )(
    () => terminal,
    (info) => noted.push(info),
    (account) => scheduled.push(account.key),
    () => true,
  );

  handler({ token: terminal.token, lane: terminal.egressLane, state: 'blocked' });
  assert.equal(noted.length, 1, '节点拒绝仍需记录供管理员诊断');
  assert.deepEqual(scheduled, [], '终态账号不得因出口拒绝继续切换和探测节点');
});

test('账号列表对终态账号只返回持久状态，单账号显式探测仍允许恢复', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const listRoute = source.slice(
    source.indexOf("if (method === 'GET' && !sub)"),
    source.indexOf("if (method === 'POST' && !sub)"),
  );
  const singleRoute = source.slice(
    source.indexOf("if (method === 'GET' && sub)"),
    source.indexOf("return err(res, 405, 'method not allowed');", source.indexOf("if (method === 'GET' && sub)")),
  );
  assert.match(listRoute, /terminalAccountProbe\(acct\)/,
    '账号列表必须直接使用持久终态，不能每次刷新都向上游探测封禁账号');
  assert.match(listRoute, /if \(terminalProbe\)[\s\S]*?probe:\s*terminalProbe/,
    '终态账号应在调用 accountEgressFetch/probeAccount 前短路');
  assert.match(singleRoute, /ensureAccountEgressForAdminProbe\(acct\)/,
    '管理员单账号探测必须走显式恢复准备路径');
  assert.match(singleRoute, /ensureAccountEgressForAdminProbe\(acct\)/,
    '管理员显式探测应允许为终态账号主动准备 lane 以验证恢复');
  assert.match(singleRoute, /probeAccount\(acct\.token,[\s\S]*?upstreamFetch/,
    '管理员显式探测必须继续调用真实上游探测');
  assert.doesNotMatch(singleRoute, /updateIsolation:\s*false/,
    '管理员探测不得关闭默认的终态清除逻辑');
});

test('token:uid 账号按 Bearer token 命中持久终态，不能绕过后台短路', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const TERMINAL_ACCOUNT_STATE_LABELS');
  const end = source.indexOf('\nfunction accountEgressUnavailableFetch(', start);
  assert.ok(start >= 0 && end > start, '应能隔离终态账号判定逻辑');
  const bearer = 'terminal-bearer-token-1234567890';
  const state = { state: 'banned', until: null, reason: 'upstream_banned' };
  const accountStateStore = {
    snapshot(tokens) {
      assert.deepEqual(tokens, [bearer], '持久状态必须按上游实际 Bearer token 查询');
      return { [bearer]: state };
    },
  };
  const api = new Function(
    'accountStateStore',
    'normalizeAccountToken',
    `${source.slice(start, end)}; return { accountTerminalState, isTerminalAccount, terminalAccountProbe };`,
  )(
    accountStateStore,
    (value) => String(value || '').trim().split(':', 1)[0],
  );
  const account = { token: `${bearer}:uid-value` };

  assert.deepEqual(api.accountTerminalState(account), state);
  assert.equal(api.isTerminalAccount(account), true);
  assert.equal(api.terminalAccountProbe(account)?.state, 'banned');
});

test('同账号重叠写操作结束一项后仍保持后台任务门闩', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const accountEgressMutations =');
  const end = source.indexOf('const managedAccountTokenHistory', start);
  const block = source.slice(start, end);
  for (const marker of [
    'beginAccountEgressMutation',
    'endAccountEgressMutation',
    'accountEgressMutationActive',
  ]) {
    assert.ok(block.includes(marker), `账号出站写门闩缺少 ${marker}`);
  }
  const gate = new Function(
    `${block}; return { beginAccountEgressMutation, endAccountEgressMutation, accountEgressMutationActive };`,
  )();

  gate.beginAccountEgressMutation('same-account');
  gate.beginAccountEgressMutation('same-account');
  assert.equal(gate.accountEgressMutationActive('same-account'), true);
  gate.endAccountEgressMutation('same-account');
  assert.equal(gate.accountEgressMutationActive('same-account'), true,
    '第一个 PATCH 完成时不能解除第二个 PATCH 仍持有的门闩');
  gate.endAccountEgressMutation('same-account');
  assert.equal(gate.accountEgressMutationActive('same-account'), false);

  const scheduler = source.slice(
    source.indexOf('function scheduleAccountEgress('),
    source.indexOf('\nasync function initializeAccountEgress(', source.indexOf('function scheduleAccountEgress(')),
  );
  assert.match(scheduler, /accountEgressMutationActive\(account\.key\)/,
    '后台调度入口和执行前都必须读取引用计数门闩');
  const patch = source.slice(source.indexOf("if (method === 'PATCH' && sub)"), source.indexOf("if (method === 'DELETE' && sub)"));
  assert.match(patch, /beginAccountEgressMutation\(key\)/);
  assert.match(patch, /endAccountEgressMutation\(key\)/);
});

test('新增账号首次凭据探测显式使用账号 lane，禁止回落共享出口', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const post = source.slice(source.indexOf("if (method === 'POST' && !sub)"), source.indexOf("if (method === 'PATCH' && sub)"));
  assert.match(post, /const account = accountByKey\(key\)/,
    '保存后必须重新读取带 lane 的账号');
  assert.match(post, /const upstreamFetch = accountEgressFetch\(account\)/,
    '首次探测必须取得该账号专属 fetch；未就绪时由该 fetch fail closed');
  assert.match(post, /probeAccount\(authToken, \{\s*upstreamFetch,\s*queueKey:\s*key\s*\}\)/,
    'Bearer 凭据必须走账号专属 fetch 和账号级探测队列，不得回落共享出口');
  assert.match(post, /upstreamFetch === accountEgressUnavailableFetch[\s\S]*?state:\s*'egress_unavailable'/,
    '账号已保存但 lane 尚未就绪时应返回可识别状态，不能把成功保存伪装成 502');
  assert.doesNotMatch(post, /probeAccount\(authToken\)\s*;/,
    '订阅存在时裸 probeAccount 会经全局 selector 泄漏账号隔离');
});

test('账号 lane 未就绪哨兵必须穿透上游 JSON 适配层', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function upstreamJson(');
  const end = source.indexOf('\nfunction enqueueUpstream(', start);
  assert.ok(start >= 0 && end > start, '应存在可隔离验证的上游 JSON 适配层');
  const upstreamJson = new Function(
    'CFG',
    'getUpstreamFetch',
    'normalizeAccountToken',
    `${source.slice(start, end)}; return upstreamJson;`,
  )(
    { codebuffApi: 'https://upstream.invalid' },
    () => null,
    (value) => String(value || '').trim().split(':', 1)[0],
  );
  const sentinel = Object.assign(new Error('账号出站节点尚未就绪'), {
    code: 'ACCOUNT_EGRESS_UNAVAILABLE',
  });

  await assert.rejects(
    () => upstreamJson('GET', '/api/v1/freebuff/session', 'secret', undefined, {}, 100,
      async () => { throw sentinel; }),
    (error) => error === sentinel,
    '哨兵若被转换为 status:0，账号探测路由的 503 分支永远无法执行',
  );
});

test('后台出站任务每轮重读账号，账号写操作会取消旧任务', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const scheduler = source.slice(
    source.indexOf('function scheduleAccountEgress('),
    source.indexOf('\nasync function initializeAccountEgress(', source.indexOf('function scheduleAccountEgress(')),
  );
  assert.match(scheduler, /const current = accountByKey\(account\.key\)/,
    '后台任务每轮必须重读当前账号，不能继续使用旧 token/模式快照');
  assert.match(scheduler, /accountEgressIdentity\(current\) !== identity/,
    'token 换代后旧后台任务必须停止');

  const post = source.slice(source.indexOf("if (method === 'POST' && !sub)"), source.indexOf("if (method === 'PATCH' && sub)"));
  assert.ok(post.indexOf('cancelAccountEgressTasks(key)') >= 0
    && post.indexOf('cancelAccountEgressTasks(key)') < post.indexOf('saveAccounts(obj)'),
  '手动写入新 token 前必须取消旧后台任务');

  const patch = source.slice(source.indexOf("if (method === 'PATCH' && sub)"), source.indexOf("if (method === 'DELETE' && sub)"));
  assert.ok(patch.indexOf('cancelAccountEgressTasks(key)') >= 0
    && patch.indexOf('cancelAccountEgressTasks(key)') < patch.indexOf('configureAccountEgress('),
  '修改出站模式前必须取消旧后台任务');
});

test('异步出站配置不得跨 token 或 lane 换代写入新账号', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function configureAccountEgress(');
  const end = source.indexOf('\nfunction scheduleAccountEgress(', start);
  const body = source.slice(start, end);
  assert.match(body, /const expectedIdentity = accountEgressIdentity\(account\)/);
  assert.match(body, /accountEgressIdentity\(stored\) !== expectedIdentity/);
  assert.match(body, /stored\.egressLane !== account\.egressLane/);
});

test('worker 账号路由动态解析，已删除托管 token 必须 fail closed', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function resolveAccountUpstreamRoute(');
  const end = source.indexOf('\nfunction buildWorkerEnv(', start);
  assert.ok(start >= 0 && end > start, '服务端应提供稳定的动态账号路由解析器');
  const body = source.slice(start, end);
  assert.match(body, /accountByToken\(wanted\)/, '每次上游调用必须读取当前账号，而不是请求开始时的快照');
  assert.match(body, /managedAccountTokenHistory\.has\(wanted\)/,
    '曾受 lane 管理的 token 删除或轮换后必须仍能识别');
  assert.match(body, /accountEgressUnavailableFetch/,
    '已删除托管 token 不得回落全局出口');
});

test('server 向 worker 注入账号 lane 就绪判定，选号阶段可跳过 probing lane', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source,
    /function isAccountUpstreamRouteReady\(token\)[\s\S]*?accountEgressFetch\(account, \{ schedule: false \}\)[\s\S]*?selectedFetch !== accountEgressUnavailableFetch/,
    'lane 就绪判定必须与实际账号路由使用同一份 fetch 结果');
  assert.match(source,
    /configureUpstreamRouting\?\.\(\{[\s\S]*?isAccountRouteReady:\s*isAccountUpstreamRouteReady/,
    'server 必须把 lane 就绪判定注入 worker 选号器');
});

test('token:uid 账号按 Bearer token 命中专属 lane，删除后仍 fail closed', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function accountByToken(');
  const end = source.indexOf('\nfunction accountEgressFetch(', start);
  assert.ok(start >= 0 && end > start, '应能隔离账号 token 路由实现');
  const factory = new Function(
    'listAccounts',
    'accountEgressFetch',
    'env',
    'managedAccountTokenHistory',
    'normalizeAccountToken',
    `${source.slice(start, end)}; return {
      accountByToken, resolveAccountUpstreamRoute, accountEgressUnavailableFetch,
    };`,
  );
  const bearerToken = 'managed-bearer-token-1234567890';
  const pureToken = 'pure-managed-token-1234567890';
  const envToken = 'env-only-token-1234567890';
  const accounts = [{
    key: 'managed-account',
    token: `${bearerToken}:uid-value`,
    egressLane: 7,
  }, {
    key: 'pure-account',
    token: pureToken,
    egressLane: 3,
  }];
  const routed = [];
  const history = new Set();
  const normalizeAccountToken = (value) => {
    const token = String(value || '').trim();
    const colon = token.indexOf(':');
    return colon > 0 ? token.slice(0, colon).trim() : token;
  };
  const route = factory(
    () => accounts,
    (account) => {
      routed.push(account.key);
      return { lane: account.egressLane };
    },
    { FREEBUFF_TOKEN: `${bearerToken}:env-uid,${envToken}:env-uid` },
    history,
    normalizeAccountToken,
  );

  assert.deepEqual(route.resolveAccountUpstreamRoute(bearerToken), { lane: 7 },
    'worker 传入冒号前 Bearer token 时必须命中账号专属 lane');
  assert.deepEqual(routed, ['managed-account']);
  assert.equal(history.has(bearerToken), true, '托管历史必须保存规范化 Bearer token');
  assert.deepEqual(route.resolveAccountUpstreamRoute(pureToken), { lane: 3 },
    '纯 token 账号的既有路由行为必须保持不变');

  accounts.length = 0;
  assert.equal(route.resolveAccountUpstreamRoute(bearerToken), route.accountEgressUnavailableFetch,
    '账号删除后不得把旧 Bearer token 回落到共享出口');
  assert.equal(route.resolveAccountUpstreamRoute(pureToken), route.accountEgressUnavailableFetch,
    '纯 token 托管账号删除后同样必须 fail closed');
  assert.equal(route.resolveAccountUpstreamRoute(envToken), null,
    '非托管环境 token:uid 仍应沿用全局出口');
});

test('服务端账号探测发送 token:uid 时只把 Bearer 部分写入 Authorization', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function upstreamJson(');
  const end = source.indexOf('\nfunction enqueueUpstream(', start);
  assert.ok(start >= 0 && end > start, '应能隔离上游 JSON 请求实现');
  const upstreamJson = new Function(
    'CFG',
    'getUpstreamFetch',
    'normalizeAccountToken',
    `${source.slice(start, end)}; return upstreamJson;`,
  )(
    { codebuffApi: 'https://upstream.example.test' },
    () => null,
    (value) => String(value || '').trim().split(':', 1)[0],
  );
  let authorization = '';
  const token = 'probe-bearer-token-1234567890';
  const result = await upstreamJson('GET', '/api/v1/freebuff/session', `${token}:uid-value`, undefined, {}, 1000,
    async (_url, init) => {
      authorization = init.headers.Authorization;
      return new Response('{}', { status: 200 });
    });
  assert.equal(result.status, 200);
  assert.equal(authorization, `Bearer ${token}`);
});

test('账号端口范围拒绝越界及 mixed/controller 冲突', () => {
  const moduleUrl = new URL('../server/proxy.mjs', import.meta.url).href;
  for (const accountBase of ['17897', '19090', '65500', 'not-a-port']) {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(moduleUrl + `?port=${accountBase}`)})`,
    ], {
      env: {
        ...process.env,
        MIHOMO_MIXED_PORT: '17897',
        MIHOMO_CTRL_PORT: '19090',
        MIHOMO_ACCOUNT_PORT_BASE: accountBase,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `非法账号端口 ${accountBase} 不得加载成功`);
    assert.match(result.stderr, /MIHOMO_ACCOUNT_PORT_BASE|账号出站端口/,
      `非法账号端口 ${accountBase} 应返回明确错误`);
  }
});
