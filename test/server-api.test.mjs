import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

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

async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), 'fbp-server-api-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      FREEBUFF_DATA_DIR: dir,
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: '',
      FREEBUFF_TOKEN: '',
      API_KEY: '',
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

test('API 契约静态标记（服务端路由已注册）', () => {
  const src = readFileSync(SERVER, 'utf8');
  for (const marker of ["seg === 'usage-persistence'", "createUsagePersistence(dataFile('usage-stats.json'))", "configureUsagePersistence"]) {
    assert.ok(src.includes(marker), `server.js 缺少持久化接线: ${marker}`);
  }
});
