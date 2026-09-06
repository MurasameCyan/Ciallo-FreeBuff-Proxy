import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const wrapper = source.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__catalogTestApi__ = {\n'
  + '  modelCatalogVisible, overloadedErrorResponse, normalizeReasoningEffort, executeChat, handleAnthropicMessages, cooldownInfo,\n'
  + '  anthropicToChat, responsesToChatParams, buildUpstreamPayload, isOverloadedFailure,\n'
  + '  setAccountCatalogProbes, handleModels, recordAccountObservation,\n'
  + '  seedModels(models) { dynamicModelsCache = { fetchedAt: Date.now(), models, pool: { premium: new Set(), standard: new Set(), glm: new Set(), perModelCaps: {}, paused: new Set(), serviceOnly: new Set() } }; },\n'
  + '};\n';

function createVm(fetchImpl = async () => new Response('{}'), now = () => Date.now()) {
  class ClockDate extends Date { static now() { return now(); } }
  const sandbox = {
    console, TextEncoder, TextDecoder, Set, Map, Date: ClockDate, Math, Number, String, JSON,
    Uint8Array, Object, URL, setTimeout, clearTimeout, AbortController,
    ReadableStream, TransformStream, Response, Request, Headers,
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => 'catalog-test-uuid' },
    fetch: fetchImpl,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(wrapper, sandbox);
  return sandbox.__catalogTestApi__;
}

const api = createVm();
const limited = (id, extra = {}) => ({ id, tier: 'limited', ...extra });
const probe = (extra = {}) => ({ state: 'ok', accessTier: null, quota: null, ...extra });

// The first test must fail until the worker applies account-backed catalog gating.
test('限定模型无高级访问或独立可用额度时不进入模型目录', () => {
  assert.equal(api.modelCatalogVisible(limited('anthropic/claude-fable-5'), []), false);
  assert.equal(api.modelCatalogVisible(
    limited('anthropic/claude-fable-5'),
    [probe({ accessTier: 'limited', quota: [{ model: 'anthropic/claude-fable-5', pool: 'standard', limit: 6, recentCount: 0 }] })],
  ), false);
});

test('账号高级访问不等于模型进入高级池，必须有该模型的 Premium 归属', () => {
  assert.equal(api.modelCatalogVisible(limited('anthropic/claude-fable-5'), [probe({ accessTier: 'full' })]), false);
  assert.equal(api.modelCatalogVisible(limited('anthropic/claude-fable-5', { pool: 'premium' }), []), true);
  assert.equal(api.modelCatalogVisible(
    limited('anthropic/claude-fable-5'),
    [probe({ quota: [{ model: 'anthropic/claude-fable-5', pool: 'premium', limit: 5, recentCount: 1 }] })],
  ), true);
});

test('无额度、失效账号或过期观测不能放出限定模型', () => {
  const model = limited('z-ai/glm-5.2');
  const quota = [{ model: model.id, pool: 'glm', limit: 2, used: 0 }];
  assert.equal(api.modelCatalogVisible(model, [probe({ state: 'banned', quota })]), false);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota, observedAt: Date.now() - 11 * 60 * 1000 })]), false);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ ...quota[0], used: null }] })]), false);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ ...quota[0], remaining: null }] })]), true);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ ...quota[0], remaining: 0 }] })]), false);
});

test('同账号较新的额度、封禁和删除快照覆盖旧业务正额度', () => {
  let time = Date.now();
  const vmApi = createVm(undefined, () => time);
  const token = 'catalog-observed-token';
  const model = limited('z-ai/glm-5.2');
  const positive = { [model.id]: { pool: 'glm', limit: 2, recentCount: 0 } };
  vmApi.recordAccountObservation(token, 200, {}, { quota: positive });
  assert.equal(vmApi.modelCatalogVisible(model), true);
  time += 10;
  vmApi.setAccountCatalogProbes({ [token]: { state: 'ok', quota: [{ model: model.id, pool: 'glm', limit: 2, used: 2 }] } });
  assert.equal(vmApi.modelCatalogVisible(model), false);
  time += 10;
  vmApi.recordAccountObservation(token, 200, {});
  assert.equal(vmApi.modelCatalogVisible(model), false, '没有新额度的普通成功请求不能恢复旧余额');
  time += 10;
  vmApi.setAccountCatalogProbes({ [token]: { state: 'banned', quota: [{ model: model.id, pool: 'glm', remaining: 2 }] } });
  assert.equal(vmApi.modelCatalogVisible(model), false);
  vmApi.setAccountCatalogProbes({});
  assert.equal(vmApi.modelCatalogVisible(model), false, '已从账号池移除的账号不得继续提供准入证据');
});

test('较早完成的管理探测不能覆盖整批等待期间的新业务额度', () => {
  let time = Date.now();
  const vmApi = createVm(undefined, () => time);
  const token = 'catalog-delayed-token';
  const model = limited('z-ai/glm-5.2');
  const earlyProbe = { state: 'ok', observedAt: time, quota: [{ model: model.id, pool: 'glm', limit: 2, used: 0 }] };
  time += 10;
  vmApi.recordAccountObservation(token, 200, {}, { quota: { [model.id]: { pool: 'glm', limit: 2, recentCount: 2 } } });
  time += 10;
  vmApi.setAccountCatalogProbes({ [token]: earlyProbe });
  assert.equal(vmApi.modelCatalogVisible(model), false);
});

test('Gemini 的 max/xhigh/ultra 下取 high，已支持档位保持原值', () => {
  for (const effort of ['max', 'xhigh', 'ultra']) {
    assert.equal(api.normalizeReasoningEffort('google/gemini-3.8-flash', effort), 'high');
  }
  for (const effort of ['low', 'medium', 'high']) {
    assert.equal(api.normalizeReasoningEffort('google/gemini-3.8-flash', effort), effort);
  }
  assert.equal(api.normalizeReasoningEffort('meta/muse-spark-1.2-contributor', 'max'), 'xhigh');
  assert.equal(api.normalizeReasoningEffort('openai/gpt-5.6-luna', 'max'), 'high');
});

test('三种入站协议的 Gemini max 最终都发送 high，不改变所选模型', () => {
  const model = { id: 'google/gemini-3.8-flash', upstream: 'google/gemini-3.8-flash' };
  const inputs = [
    { model: model.id, messages: [{ role: 'user', content: 'test' }], reasoning_effort: 'max' },
    api.responsesToChatParams({ model: model.id, input: 'test', reasoning: { effort: 'max' } }, model),
    api.anthropicToChat({ model: model.id, messages: [{ role: 'user', content: 'test' }], thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }, model),
  ];
  for (const input of inputs) {
    const payload = api.buildUpstreamPayload(input, model, { instanceId: 'test-instance' }, 'test-run');
    assert.equal(payload.reasoning_effort, 'high');
    assert.equal(payload.model, model.id);
  }
});

test('过载分类不吞掉 400 参数错误或 429 额度限制', () => {
  assert.equal(api.isOverloadedFailure(529, ''), true);
  assert.equal(api.isOverloadedFailure(503, '{"error":{"type":"overloaded_error"}}'), true);
  assert.equal(api.isOverloadedFailure(502, 'Repeated 529 Overloaded errors'), true);
  assert.equal(api.isOverloadedFailure(400, 'invalid input: at capacity'), false);
  assert.equal(api.isOverloadedFailure(429, 'quota at capacity'), false);
  assert.equal(api.isOverloadedFailure(503, 'waiting_room_required'), false);
});

function overloadUpstream() {
  let chatCalls = 0;
  return {
    get chatCalls() { return chatCalls; },
    async fetch(url) {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/v1/freebuff/session') {
        return new Response(JSON.stringify({ status: 'active', accessTier: 'full', instanceId: 'catalog-instance', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
      }
      if (pathname === '/api/v1/agent-runs') return new Response(JSON.stringify({ runId: 'catalog-run' }));
      if (pathname === '/api/v1/chat/completions') {
        chatCalls++;
        return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Repeated 529 Overloaded errors. The API is at capacity.' } }), { status: 529, headers: { 'retry-after': '7' } });
      }
      return new Response('{}');
    },
  };
}

for (const mode of ['chat', 'responses', 'anthropic', 'review']) {
  test(`${mode} 的真实错误路径返回中文过载，保留重试提示且不冷却换号`, async () => {
    const upstream = overloadUpstream();
    const vmApi = createVm(upstream.fetch);
    const model = 'deepseek/deepseek-v4-flash';
    const tokens = ['overload-test-aaaaaaaaaaaa', 'overload-test-bbbbbbbbbbbb'];
    const env = { FREEBUFF_TOKEN: tokens.join(','), FREEBUFF_ACCOUNT_STATE: {} };
    const params = { model, messages: [{ role: 'user', content: 'test' }], stream: true };
    const config = { id: model, session: model, upstream: model, agent: 'base3-free-deepseek', reviewer_agent: 'code-reviewer' };
    vmApi.seedModels([config]);
    let response;
    if (mode === 'anthropic') {
      response = await vmApi.handleAnthropicMessages(new Request('http://localhost/v1/messages', { method: 'POST', body: JSON.stringify({ ...params, max_tokens: 10 }) }), env);
    } else {
      if (mode === 'review') params.metadata = { freebuff_mode: 'code_review' };
      response = await vmApi.executeChat(env, params, config, true, mode === 'responses' ? mode : 'chat');
    }
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '7');
    const body = await response.json();
    assert.equal(body.error.type, 'overloaded_error');
    assert.match(body.error.message, /上游.*繁忙|容量|过载/);
    assert.doesNotMatch(body.error.message, /Repeated|Overloaded|at capacity/);
    assert.equal(upstream.chatCalls, 1);
    for (const token of tokens) assert.equal(vmApi.cooldownInfo(token), null);
  });
}

for (const stage of ['session', 'run']) {
  for (const review of [false, true]) {
    test(`${review ? 'review' : 'chat'} ${stage} 阶段的 529 也不重试或换号`, async () => {
      const underlying = overloadUpstream();
      const route = stage === 'session' ? '/api/v1/freebuff/session' : '/api/v1/agent-runs';
      let attempts = 0;
      const vmApi = createVm(async url => {
        if (new URL(url).pathname === route) {
          attempts++;
          return new Response('{"error":{"type":"overloaded_error"}}', { status: 529, headers: { 'retry-after': '7' } });
        }
        return underlying.fetch(url);
      });
      const id = 'deepseek/deepseek-v4-flash';
      const env = { FREEBUFF_TOKEN: 'stage-overload-token-aaaa,stage-overload-token-bbbb', FREEBUFF_ACCOUNT_STATE: {} };
      const config = { id, session: id, upstream: id, agent: 'base3-free-deepseek', reviewer_agent: 'code-reviewer' };
      const params = { messages: [{ role: 'user', content: 'test' }], ...(review ? { metadata: { freebuff_mode: 'code_review' } } : {}) };
      const response = await vmApi.executeChat(env, params, config, true, 'chat');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.type, 'overloaded_error');
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal(attempts, 1);
    });
  }
}

test('独立额度池有剩余可显示，打满或未确认额度仍隐藏', () => {
  const model = limited('z-ai/glm-5.2');
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ model: model.id, pool: 'glm', limit: 2, recentCount: 1 }] })]), true);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ model: model.id, pool: 'glm', limit: 2, recentCount: 2 }] })]), false);
  assert.equal(api.modelCatalogVisible(model, [probe({ quota: [{ model: model.id, pool: 'glm', limit: 2 }] })]), false);
});

test('非限定模型不受账号准入快照影响', () => {
  assert.equal(api.modelCatalogVisible({ id: 'mimo/mimo-v2.5', tier: 'free' }, []), true);
});

test('API 目录同步返回隐藏名单，模型进入 Premium 或独立池有余额后恢复', async () => {
  const vmApi = createVm();
  const id = 'anthropic/claude-fable-5';
  vmApi.seedModels([{ id, upstream: id, session: id, agent: 'base3-test', pool: 'standard' }]);
  let body = await (await vmApi.handleModels()).json();
  assert.ok(body.hidden_models.includes(id));
  assert.ok(!body.data.some(m => m.id === id));
  vmApi.setAccountCatalogProbes({ example: { state: 'ok', quota: [{ model: id, pool: 'premium', limit: 3, used: 3 }] } });
  body = await (await vmApi.handleModels()).json();
  assert.ok(!body.hidden_models.includes(id));
  assert.equal(body.data.find(m => m.id === id)?.pool, 'premium');
  assert.equal(body.data.find(m => m.id === id)?.tier, 'us_sg');
  vmApi.setAccountCatalogProbes({ example: { state: 'ok', quota: [{ model: id, pool: 'fable_only', limit: 2, used: 1 }] } });
  body = await (await vmApi.handleModels()).json();
  assert.equal(body.data.find(m => m.id === id)?.pool, 'fable_only');
  vmApi.setAccountCatalogProbes({ example: { state: 'ok', quota: [{ model: id, pool: 'fable_only', limit: 2, used: 2 }] } });
  body = await (await vmApi.handleModels()).json();
  assert.ok(body.hidden_models.includes(id));
});

test('限定型号从当前目录消失时，隐藏名单仍挡住旧额度行和旧 Key', async () => {
  const vmApi = createVm();
  vmApi.seedModels([{ id: 'mimo/mimo-v2.5', upstream: 'mimo/mimo-v2.5', session: 'mimo/mimo-v2.5', agent: 'base3-test' }]);
  const body = await (await vmApi.handleModels()).json();
  assert.ok(body.hidden_models.includes('anthropic/claude-fable-5'));
  assert.ok(body.hidden_models.includes('z-ai/glm-5.2'));
});

test('模型目录携带同一快照的服务专用和暂停名单，Muse 1.3 不受旧 config 影响', async () => {
  const vmApi = createVm();
  const id = 'meta/muse-spark-1.3-contributor';
  vmApi.seedModels([{ id, session: id, upstream: id, agent: 'base3-free-muse-spark-1-3', pool: 'standard' }]);
  const body = await (await vmApi.handleModels()).json();
  assert.ok(body.data.some(model => model.id === id));
  assert.deepEqual(body.serviceOnlyModels, []);
  assert.deepEqual(body.pausedModels, []);
  assert.ok(!body.hidden_models.includes(id));
});

test('529/Overloaded 返回中文且保留 overloaded_error 类型', async () => {
  const response = api.overloadedErrorResponse('529 Overloaded: API is at capacity');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.type, 'overloaded_error');
  assert.match(body.error.message, /上游.*容量|繁忙|过载/);
  assert.doesNotMatch(body.error.message, /Overloaded|at capacity/);
  assert.equal(response.headers.get('retry-after'), '30');
});
