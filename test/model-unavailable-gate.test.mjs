// 官方 FREEBUFF_GATE_CODES 的 `model_unavailable`（410，endsTheSession: false）。
//
// 语义是「模型本身现在不可选」——已从 free mode 撤下，或只在某些时段开放
// （session 联合体那一支还带 `availableHours`，峰时关闭的模型就有这种时段窗口）。
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
  + 'scopedCooldownInfo, isModelUnavailableGate, isStaleSessionGate, isFreeModeGate, '
  + 'classifyRateLimit, buildDynamicModelTable, startRunChain, acctHealth, sessCache };\n';

const LUNA = 'openai/gpt-5.6-luna';
// 被测主体必须是**当前未被官方 paused 的**模型：paused 闸门在 gate 归类之前就短路
// （回 account_pool_unavailable），拿 D4P 这种已撤下的当样本只会测到 paused 闸门。
// model_unavailable 是上游对在售模型的实时回答，任何活模型都可能收到。
const GATED = 'z-ai/glm-5.3-flash';

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
  message: 'GLM 5.3 Flash is not selectable right now.',
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
    envFor(tokens), chatParams(GATED), modelCfg(GATED, 'base2-free-deepseek'), true, 'chat',
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error.type, 'model_unavailable', '必须原样告知原因，不能伪装成 502/无可用账号');
  assert.equal(body.error.requestedModel, GATED);
  const chatTokens = new Set(log.filter((e) => e.path === '/api/v1/chat/completions').map((e) => e.token));
  assert.equal(chatTokens.size, 1, '模型全局不可用，换号只是把同一个答案再要一遍');
  assert.deepEqual(log.filter((e) => e.method === 'DELETE'), [],
    'endsTheSession:false —— 会话是好的，绝不能删');
  assert.equal(upstream.created, 1, '不得重建会话白扣 admission（#1801 的循环）');
  for (const token of tokens) {
    assert.equal(workerVm.api.cooldownInfo(token), null, `${token} 不该被冷却`);
    assert.equal(workerVm.api.scopedCooldownInfo(token, GATED), null, `${token}:GATED 不该被冷却`);
  }
});

test('POST /session 回 model_unavailable：带上 availableHours 告诉客户端什么时候能用', async () => {
  const start = Date.UTC(2030, 0, 1, 3, 0, 0); // 上游给出的关闭窗口内
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
    envFor(tokens), chatParams(GATED), modelCfg(GATED, 'base2-free-deepseek'), true, 'chat',
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
    assert.equal(workerVm.api.scopedCooldownInfo(token, GATED), null);
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

// ---------------------------------------------------------------------------
// 403 free_mode_* gate（2026-08-23 实测）：上游把 luna 的 base2 root agent 下线了，
// session 200、agent-runs 200，只有 chat 回
//   {"error":"free_mode_legacy_luna_agent","message":"This conversation uses a retired
//    Luna agent. Update Freebuff if needed, then start a new conversation."}
// 换成 base3-free-luna（且不挂 context-pruner 子 run）同一条链路就是 200 SSE。
// ---------------------------------------------------------------------------
const LEGACY_LUNA_BODY = JSON.stringify({
  error: 'free_mode_legacy_luna_agent',
  message: 'This conversation uses a retired Luna agent. Update Freebuff if needed, then start a new conversation.',
});
// Cloudflare/WAF 那种不解释的拦截：403 + 非 JSON，没有任何名字。
const WAF_BODY = '<html><head><title>403 Forbidden</title></head></html>';

test('报了名字的 403 是模型/模式问题，不能算到出口节点头上', () => {
  const { api } = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  assert.equal(api.isFreeModeGate(403, LEGACY_LUNA_BODY), true);
  assert.equal(api.isFreeModeGate(410, LEGACY_LUNA_BODY), false, 'gate 必须 code + status 同时匹配');
  assert.equal(api.isFreeModeGate(403, WAF_BODY), false);
  assert.equal(api.classifyRateLimit(LEGACY_LUNA_BODY, 403).reason, 'error',
    'free_mode_* 走普通错误路径，绝不能是 egress —— 那会把节点拉黑 10 分钟并雪崩成 503');
  assert.equal(api.classifyRateLimit(WAF_BODY, 403).reason, 'egress',
    '没名字的 403 仍要判定为 IP 级拦截，换节点才有用');
  assert.equal(api.classifyRateLimit(JSON.stringify({ error: 'edge rejected' }), 403).reason, 'egress',
    'error 里是自由文本（带空格）就还是 message 不是 code，裸 403 的判定不能被它顶掉');
});

test('luna 的 root agent 走 base3（上游已下线 base2-free-luna）', () => {
  const { api } = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  const table = api.buildDynamicModelTable({
    root: { [LUNA]: 'base2-free-luna', [GATED]: 'base2-free-deepseek' },
    base3: { [LUNA]: 'base3-free-luna', [GATED]: 'base3-free-deepseek' },
    reviewer: {},
  });
  const luna = table.find((m) => m.id === LUNA);
  assert.equal(luna.agent, 'base3-free-luna', '普通 chat 必须用 base3 root');
  assert.equal(luna.root_agent, 'base3-free-luna');
  const ds4p = table.find((m) => m.id === GATED);
  assert.equal(ds4p.agent, 'base2-free-deepseek', '只改被下线的那个，别的模型不动');
});

test('base3 root 不 spawn context-pruner 子 run', async () => {
  const log = [];
  const { api } = createWorkerVm({
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/agent-runs') {
        log.push(JSON.parse(init.body).agentId);
        return upstreamResponse(200, { runId: 'run-1' });
      }
      return upstreamResponse(200, {});
    },
  });

  const base3 = await api.startRunChain('run-chain-token-base3-aaaa', 'base3-free-luna', LUNA);
  assert.deepEqual(log, ['base3-free-luna'], 'base3 harness 自带机械压缩，不需要 pruner 子 run');
  assert.equal(base3.childRunId, null);

  log.length = 0;
  await api.startRunChain('run-chain-token-base2-aaaa', 'base2-free-deepseek', GATED);
  assert.deepEqual(log, ['base2-free-deepseek', 'context-pruner'], 'base2 链路保持原样');
});

test('chat 403 free_mode_legacy_luna_agent：原文回客户端，不换号、不冷却、不拉黑节点', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['gate-legacy-token-aaaaaaaaaaaaaa', 'gate-legacy-token-bbbbbbbbbbbbbb'];
  const log = [];
  const rejects = [];
  const upstream = createFakeUpstream({
    start, log, chatResponder: () => upstreamResponse(403, LEGACY_LUNA_BODY),
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  workerVm.worker.configureUpstreamRouting({ onReject: (info) => rejects.push(info) });

  const response = await workerVm.api.executeChat(
    envFor(tokens), chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );
  const body = await response.json();

  assert.equal(response.status, 403, '不能伪装成 503「当前出口被上游拒绝」');
  assert.match(body.error.message, /free_mode_legacy_luna_agent/, '上游原文必须透出去');
  assert.equal(body.error.type, 'permission_error');
  assert.deepEqual(rejects, [],
    '报了名字的 403 不得触发 onEgressReject —— 那会把节点拉黑 10 分钟，逐个节点重试到耗尽再回 503');
  const chatTokens = new Set(log.filter((e) => e.path === '/api/v1/chat/completions').map((e) => e.token));
  assert.equal(chatTokens.size, 1, '全池答案一致，换号只是把同一句话再要一遍');
  assert.equal(upstream.created, 1, '每换一个号都要先建会话：luna 一天只有 3 次 admission');
  for (const token of tokens) {
    assert.equal(workerVm.api.cooldownInfo(token), null, `${token} 不该被冷却`);
    assert.equal(workerVm.api.scopedCooldownInfo(token, LUNA), null, `${token}:LUNA 不该被冷却`);
  }
});

