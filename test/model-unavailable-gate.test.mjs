// 官方 FREEBUFF_GATE_CODES 的 `model_unavailable`（410，endsTheSession: false）。
//
// 语义是「模型本身现在不可选」——已从 free mode 撤下，或只在某些时段开放
// （session 联合体那一支还带 `availableHours`，V4 Pro 就有 00:00-10:00 UTC 的关闭窗口）。
// 这是**全局**结果：换账号拿到的还是同一个答案。
//
// 官方注释写明 endsTheSession 为什么必须是 false：已发布客户端的编译期目录里还留着
// 被下线的 id，下次发送还会再问一次；置 true 会让每次重发都变成一次新 admission ——
// 就是 #1801 里让 limited tier admissions 涨 2.5 倍的循环。
//
// 所以这组测试锁三件事：不冷却账号、不换号、不删/重建会话，并且把原因原样回给客户端。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__gateTestApi__ = { executeChat, createSession, cooldownInfo, '
  + 'scopedCooldownInfo, isModelUnavailableGate, isStaleSessionGate, sessCache };\n';

const LUNA = 'openai/gpt-5.6-luna';
const DS4P = 'deepseek/deepseek-v4-pro';

function createWorkerVm({ now = Date.UTC(2030, 0, 1), fetchImpl } = {}) {
  let clock = now;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let uuid = 0;
  const sandbox = {
    console, TextEncoder, TextDecoder, Set, Map, Date: FakeDate,
    Math, Number, String, JSON, Uint8Array, Object, URL, setTimeout, clearTimeout,
    AbortController, ReadableStream, TransformStream, Response, Request, Headers,
    fetch: async (url, init = {}) => fetchImpl(url, init),
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => `gate-test-uuid-${++uuid}` },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return { worker: sandbox.__workerDefault__, api: sandbox.__gateTestApi__ };
}

function upstreamResponse(status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return { status, ok: status >= 200 && status < 300, headers, text: async () => body };
}

function sseResponse() {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

// 忠实模拟 CLI 通道：一号一会话，chat 的回答由 chatResponder 决定。
function createFakeUpstream({ start, log, chatResponder, sessionResponder = null }) {
  const state = new Map();
  let created = 0;
  return {
    state,
    get created() { return created; },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const token = String(init.headers?.Authorization || '').replace(/^Bearer\s+/, '');
      const model = init.headers?.['x-freebuff-model'] || null;
      log.push({ token, method, path, model });
      if (path === '/api/v1/ads' || path.includes('/impression') || path.includes('/api/v1/usage')) {
        return upstreamResponse(200, {});
      }
      if (path === '/api/v1/freebuff/session') {
        const cur = state.get(token) || null;
        if (method === 'DELETE') { state.delete(token); return upstreamResponse(200, { status: 'ended' }); }
        if (method === 'GET') {
          return cur
            ? upstreamResponse(200, {
                status: 'active', accessTier: 'full', instanceId: cur.instanceId, model: cur.model,
                expiresAt: new Date(start + 3600 * 1000).toISOString(), remainingMs: 3600 * 1000,
              })
            : upstreamResponse(200, { status: 'none', accessTier: 'full' });
        }
        const custom = sessionResponder?.({ token, model });
        if (custom) return custom;
        created += 1;
        state.set(token, { instanceId: init.headers?.['x-freebuff-instance-id'] || `inst-${created}`, model });
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full', instanceId: state.get(token).instanceId, model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(), remainingMs: 3600 * 1000,
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `run-${token.slice(-4)}` });
      if (path === '/api/v1/chat/completions') return chatResponder({ token, log });
      return upstreamResponse(200, {});
    },
  };
}

function envFor(tokens) {
  return { FREEBUFF_TOKEN: tokens.join(','), FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
}
function modelCfg(id, agent) { return { id, session: id, upstream: id, agent }; }
function chatParams(id) {
  return { model: id, messages: [{ role: 'user', content: 'gate test' }], stream: true };
}

// 官方 wire shape：`{error: 'model_unavailable', statusCode: 410}`
// （getFreebuffGateCode 读的就是 error + statusCode 这一对）。
const GATE_BODY = JSON.stringify({
  error: 'model_unavailable',
  statusCode: 410,
  message: 'DeepSeek V4 Pro is not selectable right now.',
});

test('chat 410 model_unavailable：立刻回客户端，不换号、不冷却、不重建会话', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['gate-unavail-token-aaaaaaaaaaaaaa', 'gate-unavail-token-bbbbbbbbbbbbbb'];
  const log = [];
  const upstream = createFakeUpstream({
    start, log, chatResponder: () => upstreamResponse(410, GATE_BODY),
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });

  const response = await workerVm.api.executeChat(
    envFor(tokens), chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), true, 'chat',
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.type, 'model_unavailable', '必须原样告知原因，不能伪装成 502/无可用账号');
  assert.equal(body.error.requestedModel, DS4P);
  const chatTokens = new Set(log.filter((e) => e.path === '/api/v1/chat/completions').map((e) => e.token));
  assert.equal(chatTokens.size, 1, '模型全局不可用，换号只是把同一个答案再要一遍');
  assert.deepEqual(log.filter((e) => e.method === 'DELETE'), [],
    'endsTheSession:false —— 会话是好的，绝不能删');
  assert.equal(upstream.created, 1, '不得重建会话白扣 admission（#1801 的循环）');
  for (const token of tokens) {
    assert.equal(workerVm.api.cooldownInfo(token), null, `${token} 不该被冷却`);
    assert.equal(workerVm.api.scopedCooldownInfo(token, DS4P), null, `${token}:DS4P 不该被冷却`);
  }
});

test('POST /session 回 model_unavailable：带上 availableHours 告诉客户端什么时候能用', async () => {
  const start = Date.UTC(2030, 0, 1, 3, 0, 0); // V4 Pro 的关闭窗口内
  const tokens = ['gate-session-token-aaaaaaaaaaaaa', 'gate-session-token-bbbbbbbbbbbbb'];
  const log = [];
  const upstream = createFakeUpstream({
    start, log,
    sessionResponder: ({ model }) => upstreamResponse(200, {
      status: 'model_unavailable', accessTier: 'full',
      requestedModel: model, availableHours: '10:00-24:00 UTC',
    }),
    chatResponder: () => sseResponse(),
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });

  const response = await workerVm.api.executeChat(
    envFor(tokens), chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), true, 'chat',
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.type, 'model_unavailable');
  assert.equal(body.error.availableHours, '10:00-24:00 UTC');
  assert.match(body.error.message, /10:00-24:00 UTC/);
  const sessionPosts = log.filter((e) => e.path === '/api/v1/freebuff/session' && e.method === 'POST');
  assert.equal(sessionPosts.length, 1, '第一个号就该终止，不能把整池 POST 一遍');
  for (const token of tokens) {
    assert.equal(workerVm.api.cooldownInfo(token), null);
    assert.equal(workerVm.api.scopedCooldownInfo(token, DS4P), null);
  }
});

// 回归锁：410 上还有 session_expired，它 endsTheSession:true，必须继续走
// 「删会话 → 重建 → 重试」。判定必须 code + status 同时匹配，不能把所有 410 都当成
// model_unavailable（那会让过期会话再也恢复不了）。
test('同样是 410 的 session_expired 仍走重建重试，不被 model_unavailable 吞掉', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'gate-expired-token-aaaaaaaaaaaaaa';
  const log = [];
  let chatCalls = 0;
  const upstream = createFakeUpstream({
    start, log,
    chatResponder: () => {
      chatCalls += 1;
      return chatCalls === 1
        ? upstreamResponse(410, JSON.stringify({ error: 'session_expired', statusCode: 410 }))
        : sseResponse();
    },
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });

  const response = await workerVm.api.executeChat(
    envFor([token]), chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );

  assert.equal(response.status, 200, 'session_expired 应当重建会话后成功');
  await response.text();
  assert.equal(chatCalls, 2, '必须重试一次');
  assert.equal(log.filter((e) => e.method === 'DELETE').length, 1, '过期会话要删掉再重建');
  assert.equal(upstream.created, 2);
});

test('gate 判定必须 code + HTTP status 同时匹配', () => {
  const { api } = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  assert.equal(api.isModelUnavailableGate(410, GATE_BODY), true);
  assert.equal(api.isModelUnavailableGate(409, GATE_BODY), false,
    '同名 code 挂在别的 status 上不算 gate（官方注释：无关故障会冒充 gate）');
  assert.equal(api.isModelUnavailableGate(410, JSON.stringify({ error: 'session_expired', statusCode: 410 })), false);
  assert.equal(api.isModelUnavailableGate(410, 'not json'), false);
  assert.equal(api.isStaleSessionGate(410, GATE_BODY), false,
    'model_unavailable 不是失效会话，不能触发删除/重建');
});

