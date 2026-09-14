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
      modelPoolCategory,
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

// 2026-09-14 线上回归：上游把 FREEBUFF_PREMIUM_MODEL_IDS 从字面量名单改成
// `Object.freeze(FREEBUFF_MODELS.filter(m => m.premium).map(m => m.id))` 之后，
// 只认 `= [ … ]` 的解析器读到空池 —— 于是 luna 被判 standard，额度记错池。
// 空池不会报错，只会静默降级，所以这条断言必须钉住「派生写法也要读出 premium」。
test('premium 池改成从目录成员派生后仍能解析（空池不是合法结果）', () => {
  const api = createApi();
  const text = `
    export const LUNA_ID = 'openai/gpt-5.6-luna';
    export const FLASH_ID = 'z-ai/glm-5.3-flash';
    export const FABLE_ID = 'anthropic/claude-fable-5';
    const GPT_5_6_LUNA_MODEL = {
      id: LUNA_ID,
      displayName: 'Luna',
      premium: true,
      availability: 'always',
    };
    const GLM_V53_FLASH_MODEL = {
      id: FLASH_ID,
      displayName: 'GLM 5.3 Flash',
      premium: false,
      availability: 'always',
    };
    const FABLE_5_MODEL = {
      id: FABLE_ID,
      displayName: 'Fable 5',
      premium: true,
      availability: 'always',
    };
    export const FREEBUFF_MODELS = [GLM_V53_FLASH_MODEL, GPT_5_6_LUNA_MODEL] as const;
    export const FREEBUFF_PREMIUM_MODEL_IDS = Object.freeze(
      FREEBUFF_MODELS.filter((model) => model.premium).map((model) => model.id),
    );
  `;
  const pools = api.parseModelPools(text, api.parseModelIdConstants(text));
  assert.deepEqual([...pools.premium], ['openai/gpt-5.6-luna'],
    'premium:true 的行要进池，premium:false 的不进');
  // 判据是「进了目录数组」而不是「文件里写了 premium: true」。fable-5 这种
  // 白名单模型在源里就是 premium: true，但不在任何目录数组里：把它算进 premium
  // 会让 modelCatalogAccess 的 `pool === "premium"` 短路，/v1/models 放出账号
  // 开不了的行，客户端每选一次白扣一个 admission（上游 #1801 的循环）。
  assert.ok(![...pools.premium].includes('anthropic/claude-fable-5'),
    '没进目录数组的 premium:true 模型不得进 premium 池');
  // 分类是真正的消费点：premium 空集会让所有模型退化成 standard。
  const cache = {
    models: [{ id: 'openai/gpt-5.6-luna' }, { id: 'z-ai/glm-5.3-flash' }],
    pool: {
      premium: new Set(pools.premium), glm: new Set(pools.glm),
      paused: new Set(), serviceOnly: new Set(), godOnly: new Set(),
    },
  };
  assert.equal(api.modelPoolCategory('openai/gpt-5.6-luna', null, cache), 'premium');
  assert.equal(api.modelPoolCategory('z-ai/glm-5.3-flash', null, cache), 'standard');
});

// Releases JSON 兜底与历史快照仍是旧的字面量写法，派生逻辑不能把它顶掉。
test('旧的字面量 premium 名单优先于目录派生', () => {
  const api = createApi();
  const text = `
    export const LUNA_ID = 'openai/gpt-5.6-luna';
    export const PRO_ID = 'deepseek/deepseek-v4-pro';
    const OTHER_MODEL = { id: PRO_ID, premium: true };
    export const FREEBUFF_PREMIUM_MODEL_IDS = [LUNA_ID] as const;
  `;
  const pools = api.parseModelPools(text, api.parseModelIdConstants(text));
  assert.deepEqual([...pools.premium], ['openai/gpt-5.6-luna'],
    '读到字面量名单就以它为准，不再按 premium 字段派生');
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
