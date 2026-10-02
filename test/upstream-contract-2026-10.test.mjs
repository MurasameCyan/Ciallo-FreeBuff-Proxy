// 2026-10-03 上游契约对齐的新行为覆盖：
//   - finishRun FINISH body 形状（UUID step / failed 空 steps / errorMessage）
//   - first_tab_discount_changed 单次重发（第二次才 surface 409）
//   - chat 404「No endpoints found」带 tools 时去掉 tools 重发一次
//   - 429 waiting_room_queued 同会话等待一次（快定时器）
//   - x-fb-timezone 头的存在/缺失
//   - 退款收据 freebucksRefund / freebucksRefundPending 的 park + 同 instanceId 重放 + 结算
//   - 客户端行为链（ads/usage）默认关闭、显式开关才发
//   - freebucksGate 的 plan_required / monthly_exhausted 两条新闸
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__contractTestApi__ = { finishRun, createSession, deleteUpstreamSession, '
  + 'replayPendingRefunds, pendingRefunds, freebucksGate, recordAccountObservation, '
  + 'acctHealth, executeChat, accountPoolExhaustion, clientBehaviorEnabled, '
  + 'cooldownInfo, scopedCooldownInfo };\n';

function createWorkerVm({ now, fetchImpl, intlZone = 'UTC', fastTimers = false } = {}) {
  let clock = now ?? Date.UTC(2030, 0, 1);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const upstreamCalls = [];
  let uuid = 0;
  const fakeFetch = async (url, init = {}) => {
    upstreamCalls.push({ url: String(url), init });
    return fetchImpl(url, init);
  };
  const sandbox = {
    console,
    TextEncoder, TextDecoder, Set, Map, Date: FakeDate, Math, Number, String, JSON,
    Uint8Array, Object, URL, WeakMap, Promise, Error,
    setTimeout: fastTimers ? ((fn) => { Promise.resolve().then(fn); return 0; }) : setTimeout,
    clearTimeout,
    AbortController, ReadableStream, TransformStream, Response, Request, Headers,
    fetch: fakeFetch,
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => `11111111-2222-4333-8444-${String(++uuid).padStart(12, '0')}` },
    // 固定解析时区，避免测试随跑测机器/CI 的 TZ 漂移。
    Intl: { DateTimeFormat: class { resolvedOptions() { return { timeZone: intlZone }; } } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return {
    worker: sandbox.__workerDefault__,
    api: sandbox.__contractTestApi__,
    upstreamCalls,
    setNow(value) { clock = value; },
  };
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

function pathOf(entry) { return new URL(entry.url).pathname; }
function methodOf(entry) { return String(entry.init?.method || 'GET').toUpperCase(); }
function headerOf(entry, name) {
  const headers = entry.init?.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}
function bodyOf(entry) { return JSON.parse(entry.init.body); }
// vm 沙箱里 new 出来的对象原型属于另一个 realm，深比较前先 JSON 归一。
function plain(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

// CLI 通道的忠实最小模拟：一号一会话，chat 由 chatResponder 决定。
function fakeCliUpstream({ start = Date.UTC(2030, 0, 1), chat }) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/v1/freebuff/session') {
      if (method === 'GET') return upstreamResponse(404, {});
      if (method === 'POST') {
        return upstreamResponse(200, {
          status: 'active',
          accessTier: 'full',
          instanceId: 'cli-instance-1',
          model: init.headers?.['x-freebuff-model'] || null,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      if (method === 'DELETE') return upstreamResponse(200, { status: 'none' });
    }
    if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'cli-run-1' });
    if (path === '/api/v1/chat/completions') return chat(init);
    return upstreamResponse(200, {});
  };
}

const CHAT_MODEL = 'mimo/mimo-v2.5';
function modelCfg(id = CHAT_MODEL, agent = 'base2-free-mimo') {
  return { id, session: id, upstream: id, agent };
}
function chatParams(id = CHAT_MODEL, extra = {}) {
  return { model: id, messages: [{ role: 'user', content: 'contract test' }], stream: true, ...extra };
}
function envFor(token, extra = {}) {
  return { FREEBUFF_TOKEN: token, FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {}, ...extra };
}

// ---------------------------------------------------------------------------
// finishRun FINISH body
// ---------------------------------------------------------------------------
test('finishRun 成功的 FINISH body 带一个 UUID step 且 totalSteps=1', async () => {
  const token = 'finish-run-ok-token-123456';
  const workerVm = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, { runId: 'x' }) });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.finishRun(token, 'run-ok', {});
  const body = bodyOf(workerVm.upstreamCalls.at(-1));
  assert.equal(body.action, 'FINISH');
  assert.equal(body.runId, 'run-ok');
  assert.equal(body.status, 'completed');
  assert.equal(body.totalSteps, 1);
  assert.equal(body.directCredits, 0);
  assert.equal(body.totalCredits, 0);
  assert.equal(body.steps.length, 1);
  assert.match(body.steps[0].id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'steps[].id 必须是 UUID（上游 pendingAgentStepSchema z.string().uuid()）');
  assert.equal(body.steps[0].stepNumber, 1);
  assert.equal(body.steps[0].status, 'completed');
  assert.match(body.steps[0].startTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal('errorMessage' in body, false, '成功时不带 errorMessage');
});

test('finishRun 失败时 status=failed、steps 为空、errorMessage 截到 5000', async () => {
  const token = 'finish-run-fail-token-123456';
  const workerVm = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, { runId: 'x' }) });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.finishRun(token, 'run-bad', { status: 'failed', errorMessage: 'boom' });
  const body = bodyOf(workerVm.upstreamCalls.at(-1));
  assert.equal(body.status, 'failed');
  assert.deepEqual(body.steps, [], '失败态写在 run 级 status，steps 必须为空');
  assert.equal(body.totalSteps, 0);
  assert.equal(body.errorMessage, 'boom');

  await workerVm.api.finishRun(token, 'run-long', { status: 'failed', errorMessage: 'x'.repeat(6000) });
  const long = bodyOf(workerVm.upstreamCalls.at(-1));
  assert.equal(long.errorMessage.length, 5000, 'errorMessage 按上游口径截到 5000');
});

// ---------------------------------------------------------------------------
// first_tab_discount_changed
// ---------------------------------------------------------------------------
test('first_tab_discount_changed 只重发一次同一个 POST，第二次拿到 active', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'discount-retry-token-123456';
  const model = 'openai/gpt-6-luna';
  let posts = 0;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/freebuff/session' && String(init.method).toUpperCase() === 'POST') {
        posts += 1;
        if (posts === 1) {
          return upstreamResponse(200, {
            status: 'first_tab_discount_changed',
            requestedModel: model,
            freebucks: { daily: { remaining: 50 }, prices: { [model]: 20 } },
          });
        }
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full', instanceId: 'discount-instance',
          model, expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  const sess = await workerVm.api.createSession(token, model, true);
  assert.equal(sess.instanceId, 'discount-instance');
  assert.equal(posts, 2, '改价后必须重发一次同一个 POST');
});

test('first_tab_discount_changed 连续两次才 surface 409，且不冷却不换号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'discount-surface-token-123456';
  const model = 'openai/gpt-6-luna';
  let posts = 0;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/freebuff/session' && String(init.method).toUpperCase() === 'POST') {
        posts += 1;
        return upstreamResponse(200, { status: 'first_tab_discount_changed', requestedModel: model });
      }
      if (path === '/api/v1/freebuff/session') return upstreamResponse(404, {});
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'discount-run' });
      return upstreamResponse(200, {});
    },
  });
  const env = envFor(token);
  await workerVm.worker.fetch(new Request('http://local/healthz'), env);

  const response = await workerVm.api.executeChat(
    env, chatParams(model), modelCfg(model, 'base2-free-luna'), true, 'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error?.type, 'first_tab_discount_changed');
  assert.equal(posts, 2, '整个请求最多重发一次');
  assert.equal(workerVm.api.cooldownInfo(token), null, '改价不是账号故障，不得冷却');
  assert.equal(workerVm.api.scopedCooldownInfo(token, model), null);
});

// ---------------------------------------------------------------------------
// chat 404 「No endpoints found」+ tools → 去掉 tools 重发一次
// ---------------------------------------------------------------------------
test('chat 404 No endpoints found 且带 tools 时去掉 tools 重发一次', async () => {
  const token = 'tools-404-fallback-token-123456';
  const chatCalls = [];
  const workerVm = createWorkerVm({
    fetchImpl: fakeCliUpstream({
      chat: (init) => {
        const body = JSON.parse(init.body);
        chatCalls.push(body);
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          return upstreamResponse(404, { error: { message: `No endpoints found for ${CHAT_MODEL}` } });
        }
        return sseResponse();
      },
    }),
  });
  const env = envFor(token);
  await workerVm.worker.fetch(new Request('http://local/healthz'), env);

  const response = await workerVm.api.executeChat(
    env,
    chatParams(CHAT_MODEL, { tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: 'auto' }),
    modelCfg(), true, 'chat',
  );
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(chatCalls.length, 2, '只重发一次');
  assert.equal(chatCalls[0].tools.some((t) => t.function?.name === 'lookup'), true,
    '第一次仍带原始 tools（buildUpstreamPayload 另会混入 end_turn 签名工具）');
  assert.equal(chatCalls[1].tools, undefined, '重发必须去掉 tools');
  assert.equal(chatCalls[1].tool_choice, undefined, '重发必须去掉 tool_choice');
});

test('不带 tools 的普通 404 原样走错误路径，不触发重发', async () => {
  const token = 'plain-404-no-retry-token-123456';
  let chatCalls = 0;
  const workerVm = createWorkerVm({
    fetchImpl: fakeCliUpstream({
      chat: () => {
        chatCalls += 1;
        return upstreamResponse(404, { error: { message: `No endpoints found for ${CHAT_MODEL}` } });
      },
    }),
  });
  const env = envFor(token);
  await workerVm.worker.fetch(new Request('http://local/healthz'), env);

  const response = await workerVm.api.executeChat(env, chatParams(), modelCfg(), false, 'chat');
  assert.notEqual(response.status, 200);
  assert.equal(chatCalls, 1, '没有 tools 就没有可去掉的东西，不得重发');
});

// ---------------------------------------------------------------------------
// 429 waiting_room_queued 同会话等待一次
// ---------------------------------------------------------------------------
test('429 waiting_room_queued 同会话等待一次后成功，不换号不冷却', async () => {
  const token = 'waiting-queued-retry-token-123456';
  let chatCalls = 0;
  const chatInstances = [];
  const workerVm = createWorkerVm({
    fastTimers: true,
    fetchImpl: fakeCliUpstream({
      chat: (init) => {
        chatCalls += 1;
        chatInstances.push(init.headers?.['x-freebuff-instance-id']);
        if (chatCalls === 1) {
          return upstreamResponse(429, { status: 'waiting_room_queued', retryAfterMs: 10000 },
            { 'Retry-After': '10' });
        }
        return sseResponse();
      },
    }),
  });
  const env = envFor(token);
  await workerVm.worker.fetch(new Request('http://local/healthz'), env);

  const response = await workerVm.api.executeChat(env, chatParams(), modelCfg(), true, 'chat');
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(chatCalls, 2);
  assert.equal(chatInstances[0], chatInstances[1], '必须用同一个会话重试，换会话问到的是同一个队列');
  assert.equal(workerVm.api.cooldownInfo(token), null, '等待室不是账号故障，不得冷却');
  assert.equal(workerVm.api.scopedCooldownInfo(token, CHAT_MODEL), null);
  const sessionPosts = workerVm.upstreamCalls
    .filter((e) => pathOf(e) === '/api/v1/freebuff/session' && methodOf(e) === 'POST');
  assert.equal(sessionPosts.length, 1, '不得重建会话');
});

// ---------------------------------------------------------------------------
// x-fb-timezone
// ---------------------------------------------------------------------------
test('显式 FREEBUFF_TIMEZONE 时 session 调用带 x-fb-timezone', async () => {
  const token = 'timezone-present-token-123456';
  const model = 'mimo/mimo-v2.5';
  const workerVm = createWorkerVm({
    fetchImpl: fakeCliUpstream({ chat: () => sseResponse() }),
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'),
    envFor(token, { FREEBUFF_TIMEZONE: 'Asia/Tokyo' }));

  await workerVm.api.createSession(token, model, false);
  await workerVm.api.deleteUpstreamSession(token, 'cli-instance-1', model, { force: true });

  const sessionCalls = workerVm.upstreamCalls
    .filter((e) => pathOf(e) === '/api/v1/freebuff/session');
  assert.ok(sessionCalls.length >= 3);
  for (const call of sessionCalls) {
    assert.equal(headerOf(call, 'x-fb-timezone'), 'Asia/Tokyo',
      `${methodOf(call)} /session 必须带时区头`);
  }
});

test('无可解析时区（boring 值）时 session 调用不带 x-fb-timezone', async () => {
  const token = 'timezone-absent-token-123456';
  const workerVm = createWorkerVm({
    intlZone: 'UTC',
    fetchImpl: fakeCliUpstream({ chat: () => sseResponse() }),
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.createSession(token, 'mimo/mimo-v2.5', false);
  const sessionCalls = workerVm.upstreamCalls
    .filter((e) => pathOf(e) === '/api/v1/freebuff/session');
  assert.ok(sessionCalls.length >= 2);
  for (const call of sessionCalls) {
    assert.equal(headerOf(call, 'x-fb-timezone'), undefined);
  }
});

// ---------------------------------------------------------------------------
// 退款收据
// ---------------------------------------------------------------------------
test('freebucksRefundPending 先 park，30s 后同 instanceId 重放并结算', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'refund-replay-token-123456';
  const model = 'openai/gpt-6-luna';
  const deletes = [];
  let firstDelete = true;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/freebuff/session' && String(init.method).toUpperCase() === 'DELETE') {
        deletes.push(init.headers?.['x-freebuff-instance-id']);
        if (firstDelete) { firstDelete = false; return upstreamResponse(200, { freebucksRefundPending: true }); }
        return upstreamResponse(200, { freebucksRefund: 20 });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.deleteUpstreamSession(token, 'inst-refund', model, { force: true });
  assert.equal(workerVm.api.pendingRefunds.has(`${token}:inst-refund`), true, 'pending 收据要 park');

  workerVm.setNow(start + 30 * 1000 + 1);
  await workerVm.api.replayPendingRefunds(token);
  assert.equal(workerVm.api.pendingRefunds.has(`${token}:inst-refund`), false, '结算后不再 park');
  assert.deepEqual(deletes, ['inst-refund', 'inst-refund'], '重放必须用同一个 instanceId');
  const lastRefund = workerVm.api.acctHealth.get(token)?.lastRefund;
  assert.equal(lastRefund?.amount, 20);
  assert.equal(lastRefund?.model, model);
});

test('createSession 冷路径惰性驱动 pending 退款重放', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'refund-lazy-token-123456';
  const model = 'openai/gpt-6-luna';
  const deletes = [];
  let firstDelete = true;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path === '/api/v1/freebuff/session' && method === 'DELETE') {
        deletes.push(init.headers?.['x-freebuff-instance-id']);
        if (firstDelete) { firstDelete = false; return upstreamResponse(200, { freebucksRefundPending: true }); }
        return upstreamResponse(200, { freebucksRefund: 5 });
      }
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full', instanceId: 'fresh-instance',
          model, expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.deleteUpstreamSession(token, 'inst-lazy', model, { force: true });
  assert.equal(workerVm.api.pendingRefunds.has(`${token}:inst-lazy`), true);

  workerVm.setNow(start + 30 * 1000 + 1);
  const sess = await workerVm.api.createSession(token, model, true);
  assert.equal(sess.instanceId, 'fresh-instance');
  assert.deepEqual(deletes, ['inst-lazy', 'inst-lazy']);
  assert.equal(workerVm.api.acctHealth.get(token)?.lastRefund?.amount, 5);
});

test('freebucksRefund=0 视为已结算（0 也是结算结果），不进 pending', async () => {
  const token = 'refund-zero-token-123456';
  const model = 'openai/gpt-6-luna';
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/freebuff/session' && String(init.method).toUpperCase() === 'DELETE') {
        return upstreamResponse(200, { freebucksRefund: 0 });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.deleteUpstreamSession(token, 'inst-zero', model, { force: true });
  assert.equal(workerVm.api.pendingRefunds.has(`${token}:inst-zero`), false);
  assert.equal(workerVm.api.acctHealth.get(token)?.lastRefund?.amount, 0);
});

test('重放拿到 404/non-200 时清掉 parked 收据，不再重放', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'refund-404-token-123456';
  const model = 'openai/gpt-6-luna';
  const deletes = [];
  let firstDelete = true;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/freebuff/session' && String(init.method).toUpperCase() === 'DELETE') {
        deletes.push(init.headers?.['x-freebuff-instance-id']);
        if (firstDelete) { firstDelete = false; return upstreamResponse(200, { freebucksRefundPending: true }); }
        return upstreamResponse(404, {});
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.worker.fetch(new Request('http://local/healthz'), envFor(token));

  await workerVm.api.deleteUpstreamSession(token, 'inst-404', model, { force: true });
  workerVm.setNow(start + 30 * 1000 + 1);
  await workerVm.api.replayPendingRefunds(token);
  assert.equal(workerVm.api.pendingRefunds.has(`${token}:inst-404`), false, '404 = 实例已不存在，收据作废');
  assert.equal(workerVm.api.acctHealth.get(token)?.lastRefund, undefined);

  // 再推进一轮也不应再发 DELETE。
  workerVm.setNow(start + 120 * 1000);
  await workerVm.api.replayPendingRefunds(token);
  assert.deepEqual(deletes, ['inst-404', 'inst-404']);
});

// ---------------------------------------------------------------------------
// 客户端行为链默认关闭
// ---------------------------------------------------------------------------
function behaviorFetch(seen) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    if (path === '/api/v1/ads') return upstreamResponse(200, { ads: [{ impUrl: 'https://ads.test/imp' }] });
    if (path === '/api/v1/ads/impression') return upstreamResponse(200, {});
    if (path === '/api/v1/usage') return upstreamResponse(200, {});
    if (path === '/api/v1/freebuff/session') {
      if (String(init.method || 'GET').toUpperCase() === 'POST') {
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full', instanceId: 'behavior-instance',
          model: 'mimo/mimo-v2.5', expiresAt: new Date(Date.UTC(2030, 0, 1) + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(404, {});
    }
    return upstreamResponse(200, {});
  };
}

test('clientBehaviorEnabled 只认 1/true/yes', () => {
  const workerVm = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  for (const raw of ['1', 'true', 'TRUE', ' yes ']) {
    assert.equal(workerVm.api.clientBehaviorEnabled({ FREEBUFF_CLIENT_BEHAVIOR: raw }), true, raw);
  }
  for (const raw of [undefined, '', '0', 'false', 'no', 'on']) {
    assert.equal(workerVm.api.clientBehaviorEnabled({ FREEBUFF_CLIENT_BEHAVIOR: raw }), false, String(raw));
  }
});

test('默认不发 ads/usage；显式 FREEBUFF_CLIENT_BEHAVIOR=true 才发', async () => {
  const token = 'client-behavior-token-123456';
  const model = 'mimo/mimo-v2.5';

  const offSeen = [];
  const offVm = createWorkerVm({ fetchImpl: behaviorFetch(offSeen) });
  await offVm.worker.fetch(new Request('http://local/healthz'), envFor(token));
  await offVm.api.createSession(token, model, true, null, envFor(token));
  assert.equal(offSeen.some((p) => p === '/api/v1/ads'), false, '默认不得拉广告');
  assert.equal(offSeen.some((p) => p === '/api/v1/usage'), false, '默认不得 touch usage');

  const onSeen = [];
  const onVm = createWorkerVm({ fetchImpl: behaviorFetch(onSeen) });
  await onVm.worker.fetch(new Request('http://local/healthz'), envFor(token));
  await onVm.api.createSession(token, model, true, null,
    envFor(token, { FREEBUFF_CLIENT_BEHAVIOR: 'true' }));
  assert.equal(onSeen.includes('/api/v1/ads'), true, '开启后要拉广告');
  assert.equal(onSeen.includes('/api/v1/ads/impression'), true, '广告带 impUrl 时要上报曝光');
  assert.equal(onSeen.includes('/api/v1/usage'), true, '开启后要 touch usage');
});

// ---------------------------------------------------------------------------
// freebucksGate 计划门 / 月额度
// ---------------------------------------------------------------------------
test('freebucksGate：plan_required 与 monthly_exhausted 都算 left=0', async () => {
  const workerVm = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  const model = 'openai/gpt-6-luna';

  const planToken = 'freebucks-plan-required-token';
  workerVm.api.recordAccountObservation(planToken, 200, { status: 'ok' }, {
    model,
    freebucks: {
      planRequiredModelIds: [model],
      daily: { remaining: 100 },
      monthly: { limitUsd: 20, remainingUsd: 10 },
      prices: { [model]: 10 },
    },
  });
  assert.deepEqual(plain(workerVm.api.freebucksGate(planToken, model)), {
    left: 0, reason: 'plan_required', resetAtMs: null,
  });

  const monthlyToken = 'freebucks-monthly-exhausted-token';
  workerVm.api.recordAccountObservation(monthlyToken, 200, { status: 'ok' }, {
    model,
    freebucks: {
      daily: { remaining: 100 },
      monthly: { limitUsd: 20, remainingUsd: 0 },
      prices: { [model]: 10 },
    },
  });
  assert.deepEqual(plain(workerVm.api.freebucksGate(monthlyToken, model)), {
    left: 0, reason: 'monthly_exhausted', resetAtMs: null,
  });

  // 原有日额度/报价逻辑保持不变。
  const dailyToken = 'freebucks-daily-exhausted-token';
  workerVm.api.recordAccountObservation(dailyToken, 200, { status: 'ok' }, {
    model,
    freebucks: { daily: { remaining: 10, resetAt: '2030-01-02T00:00:00Z' }, prices: { [model]: 20 } },
  });
  assert.deepEqual(plain(workerVm.api.freebucksGate(dailyToken, model)), {
    left: 0, reason: 'daily_exhausted', resetAtMs: Date.parse('2030-01-02T00:00:00Z'),
  });

  const richToken = 'freebucks-affordable-token';
  workerVm.api.recordAccountObservation(richToken, 200, { status: 'ok' }, {
    model,
    freebucks: { daily: { remaining: 100 }, prices: { [model]: 20 } },
  });
  assert.deepEqual(plain(workerVm.api.freebucksGate(richToken, model)), {
    left: 5, reason: null, resetAtMs: null,
  });

  const unpricedToken = 'freebucks-unpriced-token';
  workerVm.api.recordAccountObservation(unpricedToken, 200, { status: 'ok' }, {
    model,
    freebucks: { daily: { remaining: 0 }, prices: {} },
  });
  assert.equal(workerVm.api.freebucksGate(unpricedToken, model), null, '不在报价表里不受约束');

  const exemptToken = 'freebucks-exempt-token';
  workerVm.api.recordAccountObservation(exemptToken, 200, { status: 'ok' }, {
    model,
    freebucks: { quotaExempt: true, daily: { remaining: 0 }, prices: { [model]: 20 } },
  });
  assert.equal(workerVm.api.freebucksGate(exemptToken, model), null, 'quotaExempt 不受约束');
});

test('全池都被 freebucks 计划门挡住时返回 429 freebucks_exhausted', async () => {
  const workerVm = createWorkerVm({ fetchImpl: async () => upstreamResponse(200, {}) });
  const token = 'freebucks-pool-plan-token-123456';
  const model = 'openai/gpt-6-luna';
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, {
    model,
    freebucks: { planRequiredModelIds: [model], daily: { remaining: 100 }, prices: { [model]: 10 } },
  });

  const info = workerVm.api.accountPoolExhaustion(envFor(token), model);
  assert.equal(info.status, 429);
  assert.equal(info.type, 'freebucks_exhausted');
  assert.equal(info.reason, 'plan_required');
});
