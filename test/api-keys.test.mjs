// 多 key（分享给别人用的那些 key）契约：
//   前半段 —— server/api-keys.mjs 的存储与校验（默认并发 1、备注名唯一、手改文件也得能用）
//   后半段 —— worker.js 的鉴权与闸门（白名单 / 并发 / 每日上限 / 归账不泄露明文 key）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createApiKeyStore, OWNER_KEY_NAME } from '../server/api-keys.mjs';

// ── 存储 ────────────────────────────────────────────────

async function withStore(fn, seed = null) {
  const dir = await mkdtemp(join(tmpdir(), 'fbp-api-keys-'));
  const file = join(dir, 'credentials', 'api-keys.json');
  try {
    if (seed !== null) {
      await mkdir(join(dir, 'credentials'), { recursive: true });
      await writeFile(file, seed);
    }
    await fn(createApiKeyStore(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('新发 key：默认并发 1、不限模型、不限每日，落盘可再读', async () => {
  await withStore(async (store, file) => {
    const k = store.add({ name: '小明' });
    assert.match(k.key, /^fbk-[\w-]{20,}$/, 'key 必须是带前缀的随机串');
    assert.equal(k.concurrency, 1, '并发默认 1（免费通道同号并发 >1 就出问题）');
    assert.deepEqual(k.models, [], '默认不限模型');
    assert.equal(k.dailyLimit, 0, '默认不限每日请求数');
    assert.equal(k.disabled, false);
    assert.ok(k.createdAt > 0);

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(onDisk.keys, [k], '重新读盘必须拿到同一条');
    assert.deepEqual(store.list(), [k]);
  });
});

test('备注名校验：必填、去重（大小写不敏感）、不许占用主 Key 的名字', async () => {
  await withStore(async (store) => {
    store.add({ name: '小明' });
    for (const [patch, why] of [
      [{ name: '   ' }, '空白名'],
      [{}, '缺 name'],
      [{ name: '小明' }, '同名'],
      [{ name: 'ABC' }, null],
      [{ name: 'abc' }, '大小写不同但仍是同名'],
      [{ name: OWNER_KEY_NAME }, '主 Key 的显示名'],
      [{ name: 'x'.repeat(41) }, '超长'],
    ]) {
      if (why === null) { store.add(patch); continue; }
      assert.throws(() => store.add(patch), (e) => e.code === 'INVALID_KEY_CONFIG', `应拒绝：${why}`);
    }
    assert.equal(store.list().length, 2, '被拒的都不该落盘');
  });
});

test('并发/每日/模型三项都做区间收敛，非法值回落默认而不是写进文件', async () => {
  await withStore(async (store) => {
    const k = store.add({
      name: '边界',
      concurrency: 0,            // < 1 → 1
      dailyLimit: -5,            // < 0 → 0（不限）
      models: [' a ', 'a', '', null, 'b'],  // 去空去重保序
    });
    assert.equal(k.concurrency, 1);
    assert.equal(k.dailyLimit, 0);
    assert.deepEqual(k.models, ['a', 'b']);

    const big = store.add({ name: '上限', concurrency: 999, dailyLimit: 10 ** 9 });
    assert.equal(big.concurrency, 32);
    assert.equal(big.dailyLimit, 100000);

    const junk = store.add({ name: '脏值', concurrency: 'abc', dailyLimit: 'abc' });
    assert.equal(junk.concurrency, 1);
    assert.equal(junk.dailyLimit, 0);

    assert.throws(() => store.add({ name: '错类型', models: 'a,b' }),
      (e) => e.code === 'INVALID_KEY_CONFIG', 'models 不是数组必须报错，不能静默丢配置');
  });
});

test('改配置：只动传进来的字段，key 本身不可改；不存在的 key 报 KEY_NOT_FOUND', async () => {
  await withStore(async (store) => {
    const k = store.add({ name: '小明', concurrency: 3, dailyLimit: 20, models: ['m1'] });
    const only = store.update(k.key, { concurrency: 5 });
    assert.equal(only.concurrency, 5);
    assert.equal(only.name, '小明');
    assert.equal(only.dailyLimit, 20);
    assert.deepEqual(only.models, ['m1'], '没传 models 就不该被清空');
    assert.equal(only.key, k.key, 'key 不可改');
    assert.equal(only.createdAt, k.createdAt);

    assert.deepEqual(store.update(k.key, { models: [] }).models, [], '显式传空数组 = 改成不限');
    assert.equal(store.update(k.key, { disabled: true }).disabled, true);

    const other = store.add({ name: '小红' });
    assert.throws(() => store.update(other.key, { name: '小明' }),
      (e) => e.code === 'INVALID_KEY_CONFIG', '改名撞别人也要拦');
    assert.equal(store.update(k.key, { name: '小明' }).name, '小明', '改成自己原来的名字不算撞名');

    for (const call of [() => store.update('fbk-nope', { name: 'x' }), () => store.remove('fbk-nope')]) {
      assert.throws(call, (e) => e.code === 'KEY_NOT_FOUND');
    }
    store.remove(other.key);
    assert.deepEqual(store.list().map((x) => x.key), [k.key]);
  });
});

test('手改过/旧版本写的文件也能用：缺字段补默认值，坏 JSON 当空池而不是打不开面板', async () => {
  await withStore(async (store) => {
    const list = store.list();
    assert.equal(list.length, 2, '缺字段的两条都要留下，只有没 key 的那条丢掉');
    assert.deepEqual(list[0], {
      key: 'fbk-hand-written', name: '手写', concurrency: 1, models: [], dailyLimit: 0,
      disabled: false, createdAt: 0,
    });
    assert.equal(list[1].concurrency, 32, '手填的超大并发也要收进区间');
    assert.equal(list[1].name, 'fbk-noname', '没备注名时用 key 前缀兜底，不能是空字符串');
  }, JSON.stringify({
    keys: [
      { key: 'fbk-hand-written', name: '手写' },
      { key: 'fbk-noname-tail', concurrency: 500, models: 'not-an-array' },
      { name: '没有 key 的脏行' },
    ],
  }));

  await withStore(async (store) => {
    assert.deepEqual(store.list(), [], '坏 JSON 必须当空池启动');
    assert.ok(store.add({ name: '新的' }), '坏文件之后还能正常发 key');
  }, '{ this is not json');
});

test('喂给 worker 的鉴权表只带闸门要用的字段', async () => {
  await withStore(async (store) => {
    store.add({ name: '小明', concurrency: 2, dailyLimit: 6, models: ['m1'] });
    assert.deepEqual(Object.keys(store.descriptors()[0]).sort(),
      ['concurrency', 'dailyLimit', 'disabled', 'key', 'models', 'name']);
  });
});

// ── worker 侧：鉴权 + 闸门 ───────────────────────────────

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__keyTestApi__ = { resolveClient, openClientGate, clientStatsSnapshot, releaseOnStreamEnd,'
  + ' quotaDay, secondsToNextQuotaDay, CLIENT_SLOT_STALE_MS, OWNER_KEY_NAME };\n';

const OWNER_KEY = 'owner-key-for-multi-key-test';
const MODEL = { id: 'mimo/mimo-v2.5' };   // 静态兜底模型表里唯一那个

function createWorkerVm({ now = Date.UTC(2030, 0, 1, 12) } = {}) {
  let clock = now;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const sandbox = {
    console, TextEncoder, TextDecoder, Set, Map, Date: FakeDate, Math, Number, String, JSON,
    Uint8Array, Object, URL, setTimeout, clearTimeout, AbortController, ReadableStream,
    TransformStream, Response, Request, Headers, Promise, Error, Array, Boolean, isNaN,
    // 动态模型表要联网，这里一律失败 → handleModels 回落静态兜底表（离线可跑）
    fetch: async () => { throw new Error('offline'); },
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => 'multi-key-test-uuid' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return { worker: sandbox.__workerDefault__, api: sandbox.__keyTestApi__, setNow(v) { clock = v; } };
}

function envWith(keys = []) {
  return { API_KEY: OWNER_KEY, FREEBUFF_TOKEN: '', FREEBUFF_API_KEYS: keys };
}

// vm 里造出来的数组/对象跨 realm，原型和宿主的不是同一个 —— 比结构前先摊平成宿主值。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function req(key, path = '/v1/models', headerName = 'Authorization') {
  const headers = headerName === 'Authorization' ? { Authorization: 'Bearer ' + key } : { 'x-api-key': key };
  return new Request('http://127.0.0.1' + path, { headers });
}

const SHARED = {
  key: 'fbk-shared-1', name: '小明', concurrency: 1, models: [], dailyLimit: 0, disabled: false,
};

test('鉴权：主 Key 与共享 key 都放行，停用/未知/空 key 一律 401', async () => {
  const { worker, api } = createWorkerVm();
  const env = envWith([SHARED, { ...SHARED, key: 'fbk-off', name: '停用的', disabled: true }]);

  const owner = api.resolveClient(req(OWNER_KEY), env);
  assert.equal(owner.name, api.OWNER_KEY_NAME);
  assert.equal(owner.owner, true);
  assert.deepEqual(plain([owner.concurrency, owner.dailyLimit, owner.models]), [0, 0, []],
    '主 Key 三项全不限（走同一条闸门代码路径）');

  const shared = api.resolveClient(req(SHARED.key), env);
  assert.equal(shared.name, '小明');
  assert.equal(shared.owner, false);
  assert.equal(shared.concurrency, 1);
  assert.deepEqual(plain(api.resolveClient(req(SHARED.key, '/v1/models', 'x-api-key'), env)), plain(shared),
    'x-api-key 与 Bearer 等价');

  for (const bad of ['fbk-off', 'fbk-never-issued', '']) {
    assert.equal(api.resolveClient(req(bad), env), null, `无效 key 必须是 null：${bad || '(空)'}`);
  }
  // 停用的 key 与不存在的 key 回同一个 401，不透露"这把存在但被停了"
  for (const [key, status] of [[OWNER_KEY, 404], [SHARED.key, 404], ['fbk-off', 401], ['fbk-nope', 401]]) {
    const r = await worker.fetch(new Request('http://127.0.0.1/v1/no-such-route', {
      headers: { Authorization: 'Bearer ' + key },
    }), env);
    assert.equal(r.status, status, `${key} 应得 ${status}`);
  }
});

test('/v1/models 只列白名单里的模型：客户端选不到就少一轮 403 往返', async () => {
  const { worker } = createWorkerVm();
  const env = envWith([
    SHARED,
    { ...SHARED, key: 'fbk-only-mimo', models: [MODEL.id] },
    { ...SHARED, key: 'fbk-other', models: ['deepseek/deepseek-v4-flash'] },
  ]);
  const ids = async (key) => {
    const r = await worker.fetch(req(key), env);
    assert.equal(r.status, 200);
    return (await r.json()).data.map((m) => m.id);
  };
  assert.deepEqual(await ids('fbk-only-mimo'), [MODEL.id]);
  assert.deepEqual(await ids('fbk-other'), [], '白名单外的模型不许露出来');
  assert.deepEqual(await ids(OWNER_KEY), [MODEL.id], '主 Key 不受白名单影响');
  assert.deepEqual(await ids(SHARED.key), [MODEL.id], '空白名单 = 不限');
});

test('闸门：白名单外的模型 403，不占槽位也不计每日', async () => {
  const { worker, api } = createWorkerVm();
  const env = envWith([{ ...SHARED, models: ['some/other-model'], dailyLimit: 5 }]);
  const client = api.resolveClient(req(SHARED.key), env);

  const denied = api.openClientGate(client, MODEL);
  assert.equal(denied.release, undefined, '被拒时不该拿到 release');
  assert.equal(denied.error.status, 403);
  const body = await denied.error.json();
  assert.equal(body.error.type, 'model_not_allowed');
  assert.match(body.error.message, /some\/other-model/, '要告诉客户端它能用什么');
  assert.equal(api.clientStatsSnapshot().length, 0, '被白名单拦下的请求不该记进归账');

  assert.equal(api.openClientGate(client, { id: 'some/other-model' }).error, undefined,
    '白名单内的模型照常放行');
  assert.equal(api.openClientGate(null, MODEL).error, undefined, '无 key 上下文（内部调用）不设限');
});

test('闸门：并发按 key 计，默认 1；上一个放了才让下一个进', async () => {
  const { worker, api } = createWorkerVm();
  const env = envWith([SHARED, { ...SHARED, key: 'fbk-c2', name: '双并发', concurrency: 2 }]);
  const one = api.resolveClient(req(SHARED.key), env);

  const first = api.openClientGate(one, MODEL);
  assert.equal(first.error, undefined);
  const second = api.openClientGate(one, MODEL);
  assert.equal(second.error.status, 429);
  const body = await second.error.json();
  assert.equal(body.error.type, 'key_concurrency_exceeded');
  assert.equal(second.error.headers.get('X-RateLimit-Scope'), 'api-key',
    '要让客户端分得清是被自己的 key 限住，还是上游账号池 429');
  assert.equal(api.clientStatsSnapshot()[0].inFlight, 1, '被拒的那个不该也占一格');

  first.release();
  first.release();   // 幂等：流式路径上 flush 与 cancel 都可能来
  assert.equal(api.clientStatsSnapshot()[0].inFlight, 0);
  const third = api.openClientGate(one, MODEL);
  assert.equal(third.error, undefined, '放完槽位后必须能再进');
  third.release();

  const two = api.resolveClient(req('fbk-c2'), env);
  const gates = [api.openClientGate(two, MODEL), api.openClientGate(two, MODEL)];
  assert.deepEqual(gates.map((g) => g.error), [undefined, undefined], 'concurrency:2 允许两个同时在跑');
  assert.equal(api.openClientGate(two, MODEL).error.status, 429, '第三个才拒');
  gates.forEach((g) => g.release());

  // 主 Key 不限并发：连开 5 个都不该被拦
  const owner = api.resolveClient(req(OWNER_KEY), env);
  const many = Array.from({ length: 5 }, () => api.openClientGate(owner, MODEL));
  assert.deepEqual(many.map((g) => g.error), Array(5).fill(undefined));
  many.forEach((g) => g.release());
});

test('闸门：每日上限按上游的洛杉矶日历日翻页，不是 UTC 日', async () => {
  const start = Date.UTC(2030, 0, 1, 12);          // LA 2030-01-01 04:00
  const { api, setNow } = createWorkerVm({ now: start });
  const env = envWith([{ ...SHARED, concurrency: 4, dailyLimit: 2 }]);
  const client = api.resolveClient(req(SHARED.key), env);

  for (const i of [1, 2]) {
    const g = api.openClientGate(client, MODEL);
    assert.equal(g.error, undefined, `第 ${i} 个应放行`);
    g.release();
  }
  const over = api.openClientGate(client, MODEL);
  assert.equal(over.error.status, 429);
  const body = await over.error.json();
  assert.equal(body.error.type, 'key_daily_limit_exceeded');
  assert.match(body.error.message, /2 次/);
  const retry = Number(over.error.headers.get('Retry-After'));
  assert.ok(retry > 0 && retry <= 26 * 3600, `Retry-After 要指向下一个重置点，实得 ${retry}`);
  assert.equal(api.clientStatsSnapshot()[0].dayCount, 2, '被拒的不计数');

  // UTC 已经翻到 1/2，洛杉矶还是 1/1 16:30 —— 此时不能重置，否则白送一轮预算
  setNow(Date.UTC(2030, 0, 2, 0, 30));
  assert.equal(api.quotaDay(Date.UTC(2030, 0, 2, 0, 30)), '2030-01-01');
  assert.equal(api.openClientGate(client, MODEL).error.status, 429, 'UTC 翻页不算翻页');

  // 洛杉矶 1/2 00:30 —— 这才是新的一天
  setNow(Date.UTC(2030, 0, 2, 8, 30));
  assert.equal(api.quotaDay(Date.UTC(2030, 0, 2, 8, 30)), '2030-01-02');
  const next = api.openClientGate(client, MODEL);
  assert.equal(next.error, undefined, '上游额度重置点一到，每日预算跟着翻页');
  next.release();
  const snap = api.clientStatsSnapshot()[0];
  assert.equal(snap.dayCount, 1, '新的一天从 1 开始');
  assert.equal(snap.total, 3, '累计不清零');
});

test('归账快照只出备注名，绝不出明文 key（GET /_api/usage 会整份回给面板）', () => {
  const { api } = createWorkerVm();
  const env = envWith([SHARED]);
  const gate = api.openClientGate(api.resolveClient(req(SHARED.key), env), MODEL);
  gate.release();
  api.openClientGate(api.resolveClient(req(OWNER_KEY), env), MODEL).release();

  const snap = plain(api.clientStatsSnapshot());
  assert.equal(JSON.stringify(snap).includes(SHARED.key), false, '快照里不许出现明文 key');
  assert.deepEqual(snap.map((s) => s.name).sort(), [api.OWNER_KEY_NAME, '小明'].sort());
  assert.deepEqual(Object.keys(snap[0]).sort(), ['dayCount', 'inFlight', 'lastAt', 'name', 'owner', 'total']);
});

test('流式：槽位等 body 到终态才放（正常收尾走 flush，客户端断开走 cancel）', async () => {
  const { api } = createWorkerVm();
  for (const mode of ['flush', 'cancel']) {
    let released = 0;
    const src = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1])); if (mode === 'flush') c.close(); },
    });
    const reader = src.pipeThrough(api.releaseOnStreamEnd(() => { released++; })).getReader();
    await reader.read();
    assert.equal(released, 0, `${mode}: body 还在写时不能提前放槽位`);
    if (mode === 'flush') await reader.read(); else await reader.cancel();
    // 流的终态回调是微任务，让它跑完
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(released, 1, `${mode}: body 到终态必须放槽位`);
  }
});

test('槽位兜底回收：任何一条释放路径漏了，也不会把 key 永久卡死', () => {
  const start = Date.UTC(2030, 0, 1, 12);
  const { api, setNow } = createWorkerVm({ now: start });
  const client = api.resolveClient(req(SHARED.key), envWith([SHARED]));

  api.openClientGate(client, MODEL);   // 故意不 release，模拟漏掉的释放路径
  assert.equal(api.openClientGate(client, MODEL).error.status, 429);
  setNow(start + api.CLIENT_SLOT_STALE_MS + 1);
  const after = api.openClientGate(client, MODEL);
  assert.equal(after.error, undefined, '超过兜底窗口后必须能回收');
  after.release();
  assert.equal(api.clientStatsSnapshot()[0].inFlight, 0, '回收后计数不能变负数或残留');
});
