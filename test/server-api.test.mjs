import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

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

async function startFakeProbeUpstream(getMode) {
  const upstream = createHttpServer((req, res) => {
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

test('管理员探测将 banned 持久化为永久状态，并由成功探测清除', async (t) => {
  let mode = 'banned';
  const fake = await startFakeProbeUpstream(() => mode);
  const s = await startServer({ CODEBUFF_API: fake.url });
  t.after(async () => {
    await stopServer(s);
    await new Promise((resolve) => fake.upstream.close(resolve));
  });

  const token = 'server-probe-terminal-token-123456';
  const add = await fetch(s.base + '/_api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authToken: token, email: 'probe@example.test' }),
  });
  assert.equal(add.status, 200);
  const stateFile = join(s.dir, 'credentials', 'account-state.json');
  const bannedRaw = await readFile(stateFile, 'utf8');
  assert.match(bannedRaw, /"state":\s*"banned"/);
  assert.match(bannedRaw, /"until":\s*null/);
  assert.doesNotMatch(bannedRaw, new RegExp(token));
  assert.deepEqual((await add.json()).probe, {
    state: 'banned',
    label: '已被封禁',
    quota: null,
    retryAfterMs: null,
    uid: null,
    accessTier: null,
    model: null,
    statusCode: 403,
    isolatedUntil: null,
    isolatedPermanent: true,
  });

  const accounts = await fetch(s.base + '/_api/accounts');
  assert.equal(accounts.status, 200);
  const account = (await accounts.json()).accounts[0];
  for (const forbidden of ['token', 'authToken', 'tokenShort']) {
    assert.equal(Object.hasOwn(account, forbidden), false, `账号列表不得返回 ${forbidden}`);
  }

  mode = 'ok';
  const probe = await fetch(s.base + '/_api/accounts/probe%40example.test');
  assert.equal(probe.status, 200);
  const probeBody = await probe.json();
  assert.equal(probeBody.state, 'ok');
  assert.equal(probeBody.isolatedPermanent, false);
  const clearedRaw = await readFile(stateFile, 'utf8');
  assert.doesNotMatch(clearedRaw, /"state":\s*"banned"/);

  mode = 'nested-banned';
  const nested = await fetch(s.base + '/_api/accounts/probe%40example.test');
  assert.equal(nested.status, 200);
  const nestedBody = await nested.json();
  assert.equal(nestedBody.state, 'banned');
  assert.equal(nestedBody.isolatedPermanent, true);
  assert.equal(Object.hasOwn(nestedBody, 'raw'), false, 'probe 不得回传上游原始响应');
  const nestedRaw = await readFile(stateFile, 'utf8');
  assert.match(nestedRaw, /"state":\s*"banned"/);
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
