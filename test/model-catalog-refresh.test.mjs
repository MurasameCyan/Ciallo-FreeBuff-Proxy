import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
function createApi(fetchImpl = async () => new Response('{}')) {
  const sandbox = {
    console, TextEncoder, TextDecoder, Set, Map, Date, Math, Number, String, JSON,
    Uint8Array, Object, URL, setTimeout, clearTimeout, AbortController, AbortSignal,
    ReadableStream, TransformStream, Response, Request, Headers,
    crypto: { randomUUID: () => 'catalog-refresh-test' }, fetch: fetchImpl,
  };
  vm.runInNewContext(source.replace('export default {', 'const workerDefault = {') + `
    globalThis.api = { parseModelPools, parseModelIdConstants, isHiddenModelId, handleModels,
      DYNAMIC_MODELS_REFRESH_MS,
      seed(models, pool = {}) { dynamicModelsCache = { fetchedAt: Date.now() - 3600000, models,
        pool: { premium: new Set(), standard: null, glm: new Set(), perModelCaps: {},
          paused: new Set(), serviceOnly: new Set(), godOnly: new Set(), ...pool } }; },
    };`, sandbox);
  return sandbox.api;
}
const muse = { id: 'meta/muse-spark-1.3-contributor', session: 'meta/muse-spark-1.3-contributor', upstream: 'meta/muse-spark-1.3-contributor', agent: 'base3-muse', pool: 'standard' };

test('模型及控制名单的缓存周期为五分钟', () => {
  assert.equal(createApi().DYNAMIC_MODELS_REFRESH_MS, 300000);
});

test('God-only 名单解析模型对象引用，撤销限制时允许恢复', () => {
  const api = createApi();
  const text = `
    export const PRIVATE_ID = 'vendor/private';
    const PRIVATE_MODEL = { id: PRIVATE_ID, displayName: 'Private' };
    export const FREEBUFF_WEB_GOD_ONLY_MODELS = [PRIVATE_MODEL] as const;
  `;
  const pools = api.parseModelPools(text, api.parseModelIdConstants(text));
  assert.deepEqual([...pools.godOnly], ['vendor/private']);
  assert.equal(api.isHiddenModelId('vendor/private', { pool: { godOnly: new Set(pools.godOnly), serviceOnly: new Set() } }), true);
  assert.equal(api.isHiddenModelId('crof/kimi-k3-eco', { pool: { godOnly: new Set(), serviceOnly: new Set() } }), false);
  assert.equal(api.isHiddenModelId('openai/gpt-5.6-luna-es', { pool: { godOnly: new Set(), serviceOnly: new Set() } }), false);
});

test('God-only 名单存在未解析的引用时不能伪装成空名单', () => {
  const api = createApi();
  const pools = api.parseModelPools('export const FREEBUFF_WEB_GOD_ONLY_MODELS = [UNRESOLVED_MODEL] as const;', {});
  assert.equal(pools.godOnly, null);
});

test('暂停和服务专用名单中的未知引用不能被静默当作空名单', () => {
  const api = createApi();
  const pools = api.parseModelPools(`
    export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [UNKNOWN_ID] as const;
    export const FREEBUFF_SERVICE_ONLY_MODEL_IDS = [...MISSING_LIST] as const;
  `, {});
  assert.equal(pools.paused, null);
  assert.equal(pools.serviceOnly, null);
  const expression = api.parseModelPools(`
    export const FREEBUFF_PAUSED_FREE_MODEL_IDS = getPausedModels();
    export const OTHER_ARRAY = [] as const;
  `, {});
  assert.equal(expression.paused, null, '不能拿下一条声明的数组作为当前名单');
});

test('冷启动全源失败后也退避一分钟，不反复请求所有源', async () => {
  let requests = 0;
  const api = createApi(async () => { requests++; return new Response('', { status: 503 }); });
  await api.handleModels();
  const first = requests;
  assert.ok(first > 0);
  await api.handleModels();
  assert.equal(requests, first);
  await api.handleModels(null, { forceRefresh: true });
  assert.ok(requests > first, '显式强刷仍能立即重试');
});

test('源站故障不能拿旧 Release 替换仍可用的缓存', async () => {
  const calls = [];
  const api = createApi(async url => {
    calls.push(String(url));
    if (String(url).includes('/releases/')) {
      return new Response(JSON.stringify({ models: [{ id: 'outdated/only', session: 'outdated/only', agent: 'old' }] }));
    }
    return new Response('unavailable', { status: 503 });
  });
  api.seed([muse]);
  const result = await (await api.handleModels(null, { forceRefresh: true })).json();
  assert.ok(result.data.some(model => model.id === muse.id));
  assert.equal(result.refresh.updated, false);
  assert.equal(result.catalog.stale, true);
  assert.ok(!calls.some(url => url.includes('/releases/')));
  const before = calls.length;
  await api.handleModels();
  assert.equal(calls.length, before, '失败后一分钟内的普通查询应沿用缓存');
});

test('名单解析缺失时完整保留上一份成功快照', async () => {
  const api = createApi(async url => {
    if (String(url).includes('free-agents.ts')) return new Response(`/* Source-length fixture padding for a complete agent map. */ export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL = { [MODEL_ID]: 'base3-new' }`);
    if (String(url).includes('freebuff-models.ts')) return new Response(`/* Control lists intentionally absent in this fixture. */ export const MODEL_ID = 'vendor/new'; export const FREEBUFF_PREMIUM_MODEL_IDS = [] as const;`);
    return new Response('', { status: 404 });
  });
  api.seed([muse]);
  const result = await (await api.handleModels(null, { forceRefresh: true })).json();
  assert.equal(result.refresh.updated, false);
  assert.ok(result.data.some(model => model.id === muse.id));
  assert.deepEqual(result.serviceOnlyModels, []);
});

test('同一成功快照的响应版本递增，名单与模型结果保持一致', async () => {
  const api = createApi(async () => new Response('', { status: 503 }));
  api.seed([muse], { godOnly: new Set(['vendor/private']) });
  const response = await api.handleModels(null, { forceRefresh: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json();
  const second = await (await api.handleModels()).json();
  assert.ok(second.catalog.revision > first.catalog.revision);
  assert.equal(second.catalog.updatedAt, first.catalog.updatedAt);
  assert.deepEqual(second.godOnlyModels, ['vendor/private']);
  assert.ok(second.data.some(model => model.id === muse.id));
});
