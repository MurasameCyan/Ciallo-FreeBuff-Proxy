import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createAccountStateStore } from '../server/account-state.mjs';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__accountSafetyTestApi__ = { pickToken, pickTokenWithSessionWait, sessionLeaseWaitMs, releaseToken, recordAccountObservation, cooldown, parseCooldown, accountPoolExhaustion, classifyRateLimit, quotaScopeForModel, freshQuotaProbe, startRun, executeChat, executeCodeReview, createSession };\n';

const TOKEN = 'permanent-banned-account-token-123456';
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

function createWorkerVm({ now, fetchImpl, consoleImpl = console } = {}) {
  let clock = now ?? Date.UTC(2030, 0, 1);
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() { return clock; }
  }
  const upstreamCalls = [];
  const fakeFetch = async (url, init = {}) => {
    upstreamCalls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(url, init);
    throw new Error('unexpected upstream request');
  };
  const sandbox = {
    console: consoleImpl,
    TextEncoder,
    TextDecoder,
    Set,
    Map,
    Date: FakeDate,
    Math,
    Number,
    String,
    JSON,
    Uint8Array,
    Object,
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    ReadableStream,
    TransformStream,
    Response,
    Request,
    Headers,
    fetch: fakeFetch,
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => 'account-safety-test-uuid' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return {
    worker: sandbox.__workerDefault__,
    api: sandbox.__accountSafetyTestApi__,
    upstreamCalls,
    setNow(value) { clock = value; },
  };
}

function envFor(store, token = TOKEN) {
  return {
    API_KEY: 'account-safety-test-key',
    FREEBUFF_TOKEN: token,
    FREEBUFF_DEBUG: 'false',
    FREEBUFF_ACCOUNT_STATE: store.snapshot([token]),
    FREEBUFF_ACCOUNT_STATE_REVISION: store.revision(),
    FREEBUFF_ACCOUNT_STATE_SET: (accountToken, state) => store.set(accountToken, state),
    FREEBUFF_ACCOUNT_STATE_CLEAR: (accountToken) => store.clear(accountToken),
  };
}

function releaseIfSelected(vmInstance, selected) {
  if (selected) vmInstance.api.releaseToken(selected.token);
}

test('外部旧 banned snapshot 在 worker 同步时提升为永久隔离', () => {
  const start = Date.UTC(2030, 0, 1);
  for (const elapsed of [DAY_MS, 100 * YEAR_MS]) {
    const workerVm = createWorkerVm({ now: start });
    const env = {
      FREEBUFF_TOKEN: TOKEN,
      FREEBUFF_ACCOUNT_STATE: {
        [TOKEN]: { state: 'banned', until: start + DAY_MS, reason: 'upstream_banned' },
      },
    };
    workerVm.setNow(start + elapsed);
    assert.equal(workerVm.api.pickToken(env, null, new Set()), null, `${elapsed}ms 后不应重新选中 banned 账号`);
  }
});

test('新 banned 写成 until:null，推进 24h 和 100y 仍不可选，clear 后恢复', () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const writes = [];
  const env = {
    FREEBUFF_TOKEN: TOKEN,
    FREEBUFF_ACCOUNT_STATE: {},
    FREEBUFF_ACCOUNT_STATE_REVISION: 0,
    FREEBUFF_ACCOUNT_STATE_SET: (token, state) => {
      writes.push({ token, state: { ...state } });
      return { ...state, revision: 1 };
    },
    FREEBUFF_ACCOUNT_STATE_CLEAR: () => ({ removed: true, revision: 2 }),
  };

  const initial = workerVm.api.pickToken(env, null, new Set());
  assert.equal(initial?.token, TOKEN);
  releaseIfSelected(workerVm, initial);
  workerVm.api.recordAccountObservation(TOKEN, 403, { status: 'banned' });
  assert.deepEqual(writes, [{
    token: TOKEN,
    state: { state: 'banned', until: null, reason: 'upstream_banned' },
  }]);

  for (const elapsed of [DAY_MS, 100 * YEAR_MS]) {
    workerVm.setNow(start + elapsed);
    assert.equal(workerVm.api.pickToken(env, null, new Set()), null, `${elapsed}ms 后不应重新选中 banned 账号`);
  }

  const clearedEnv = { ...env, FREEBUFF_ACCOUNT_STATE: {}, FREEBUFF_ACCOUNT_STATE_REVISION: 2 };
  const recovered = workerVm.api.pickToken(clearedEnv, null, new Set());
  assert.equal(recovered?.token, TOKEN);
  releaseIfSelected(workerVm, recovered);
});

test('新 store 与新 VM 重载后仍永久隔离且不请求上游，管理员 clear 后恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-permanent-ban-worker-'));
  const file = join(dir, 'account-state.json');
  const start = Date.UTC(2030, 0, 1);
  try {
    const writerStore = createAccountStateStore(file);
    writerStore.set(TOKEN, { state: 'banned', until: start + DAY_MS, reason: 'upstream_banned' });

    const restoredStore = createAccountStateStore(file);
    const restoredVm = createWorkerVm({ now: start + 100 * YEAR_MS });
    const blockedEnv = envFor(restoredStore);
    assert.equal(restoredVm.api.pickToken(blockedEnv, null, new Set()), null);

    const request = new Request('http://worker.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer account-safety-test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mimo/mimo-v2.5',
        messages: [{ role: 'user', content: 'must remain local' }],
      }),
    });
    const response = await restoredVm.worker.fetch(request, blockedEnv);
    assert.equal(response.status, 403);
    assert.equal(restoredVm.upstreamCalls.length, 0);

    assert.deepEqual(restoredStore.clear(TOKEN), { removed: true, revision: 1 });
    const clearReloadStore = createAccountStateStore(file);
    const clearReloadVm = createWorkerVm({ now: start + 100 * YEAR_MS });
    const recovered = clearReloadVm.api.pickToken(envFor(clearReloadStore), null, new Set());
    assert.equal(recovered?.token, TOKEN);
    releaseIfSelected(clearReloadVm, recovered);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('一个模型的 SDK/会话冷却不应阻塞同账号的其他模型', () => {
  const workerVm = createWorkerVm();
  const tokenA = 'model-scope-account-a-123456';
  const tokenB = 'model-scope-account-b-123456';
  const env = { FREEBUFF_TOKEN: `${tokenA},${tokenB}`, FREEBUFF_ACCOUNT_STATE: {} };

  workerVm.api.cooldown(tokenA, 60 * 1000, { reason: 'error', model: 'model-a' });
  workerVm.api.cooldown(tokenB, 60 * 1000, { reason: 'error', model: 'model-a' });

  const selected = workerVm.api.pickToken(env, 'model-b', new Set());
  assert.ok(selected, 'model-b 应仍能从有额度的账号中选号');
  workerVm.api.releaseToken(selected.token);
});

test('Premium quota 冷却按已确认共池传播，GLM 与其他模型不受影响', () => {
  const workerVm = createWorkerVm();
  const token = 'quota-scope-account-123456';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {} };

  workerVm.api.cooldown(token, 60 * 1000, {
    reason: 'quota',
    retryAfterMs: 60 * 1000,
    model: 'deepseek/deepseek-v4-pro',
  });

  assert.equal(workerVm.api.pickToken(env, 'minimax/minimax-m3', new Set()), null,
    'Premium 共池模型应共享 quota 冷却');
  const glm = workerVm.api.pickToken(env, 'z-ai/glm-5.2', new Set());
  assert.equal(glm?.token, token, 'GLM 独立池不应被 Premium 冷却阻塞');
  workerVm.api.releaseToken(token);
  const standard = workerVm.api.pickToken(env, 'mimo/mimo-v2.5', new Set());
  assert.equal(standard?.token, token, 'Standard 模型不应被 Premium 冷却阻塞');
  workerVm.api.releaseToken(token);
});

test('无 typed 429 提示时使用有界短退避，不跳到太平洋午夜', () => {
  const workerVm = createWorkerVm();
  const delay = workerVm.api.parseCooldown('{}', 429, {}, Date.UTC(2030, 0, 1, 16, 0, 0));
  assert.ok(delay > 0 && delay <= 60 * 1000, `generic 429 delay=${delay}`);
});

test('typed 429 按上游状态选择正确作用域', () => {
  const workerVm = createWorkerVm();
  const model = 'mimo/mimo-v2.5';
  const ip = workerVm.api.classifyRateLimit(JSON.stringify({ status: 'ip_capped' }), 429, {}, model);
  assert.equal(ip.reason, 'egress');
  assert.equal(ip.scope, 'egress');
  const spend = workerVm.api.classifyRateLimit(JSON.stringify({ status: 'spend_limited' }), 429, {}, model);
  assert.equal(spend.reason, 'quota');
  assert.equal(spend.scope, 'account');
  const waiting = workerVm.api.classifyRateLimit(JSON.stringify({ status: 'waiting_room_queued' }), 429, {}, model);
  assert.equal(waiting.reason, 'waiting_room');
  assert.equal(waiting.scope, 'waiting_room');
  const generic = workerVm.api.classifyRateLimit('{}', 429, {}, model);
  assert.equal(generic.reason, 'quota');
  assert.equal(generic.scope, workerVm.api.quotaScopeForModel(model));

  const premium = 'deepseek/deepseek-v4-pro';
  const genericPremium = workerVm.api.classifyRateLimit('{}', 429, {}, premium);
  assert.equal(genericPremium.scope, `model:${premium}`, '无 typed status 时不得扩大到整个 Premium 池');
  const typedPremium = workerVm.api.classifyRateLimit(
    JSON.stringify({ status: 'rate_limited' }), 429, {}, premium,
  );
  assert.equal(typedPremium.scope, 'pool:premium', '明确 rate_limited 才使用已确认的 Premium 共池');
  assert.equal(workerVm.api.quotaScopeForModel('z-ai/glm-5.2'), 'pool:glm', 'GLM 静态兜底必须保持独立池');
  assert.equal(workerVm.api.quotaScopeForModel('mimo/mimo-v2.5'), 'model:mimo/mimo-v2.5');
  assert.equal(workerVm.api.quotaScopeForModel('anthropic/claude-fable-5'), 'model:anthropic/claude-fable-5');
});

test('generic 429 按 Retry-After 锁定当前模型并在到期时恢复', () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const token = 'generic-retry-after-account-123456';
  const model = 'deepseek/deepseek-v4-pro';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {} };
  const decision = workerVm.api.classifyRateLimit('{}', 429, { 'Retry-After': '7' }, model, start);
  assert.equal(decision.retryAfterMs, 7000);
  assert.equal(decision.scope, `model:${model}`);
  workerVm.api.cooldown(token, decision.retryAfterMs, {
    reason: decision.reason,
    retryAfterMs: decision.retryAfterMs,
    model,
    scope: decision.scope,
  });
  assert.equal(workerVm.api.pickToken(env, model, new Set()), null);
  workerVm.setNow(start + 6999);
  assert.equal(workerVm.api.pickToken(env, model, new Set()), null);
  workerVm.setNow(start + 7000);
  const recovered = workerVm.api.pickToken(env, model, new Set());
  assert.equal(recovered?.token, token);
  workerVm.api.releaseToken(token);
});

test('缓存中的 generic 429 只影响原模型，不中止同池其他模型的长流', async () => {
  const workerVm = createWorkerVm();
  const token = 'generic-premium-cache-account-123456';
  const sourceModel = 'deepseek/deepseek-v4-pro';
  const peerModel = 'minimax/minimax-m3';
  workerVm.api.recordAccountObservation(token, 429, {}, { model: sourceModel });

  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, peerModel));
  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, sourceModel),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === `model:${sourceModel}`,
  );
});

test('健康快照中的 Retry-After 到期后不再中止长流', async () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const token = 'retry-after-health-deadline-account-123456';
  const model = 'deepseek/deepseek-v4-pro';

  workerVm.api.recordAccountObservation(token, 429, {}, {
    model,
    headers: { 'Retry-After': '7' },
  });

  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, model),
    (error) => error?.name === 'QuotaExhaustedError',
  );
  workerVm.setNow(start + 6999);
  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, model),
    (error) => error?.name === 'QuotaExhaustedError',
  );
  workerVm.setNow(start + 7000);
  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, model));
});

test('新鲜额度快照不被旧的 Retry-After 截止时间遮蔽', async () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const token = 'retry-after-fresh-quota-account-123456';
  const model = 'deepseek/deepseek-v4-pro';

  workerVm.api.recordAccountObservation(token, 429, {}, {
    model,
    headers: { 'Retry-After': '7' },
  });
  workerVm.setNow(start + 7000);
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, {
    model,
    quota: { [model]: { recentCount: 6, limit: 6 } },
  });

  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, model),
    (error) => error?.name === 'QuotaExhaustedError',
  );
});

test('startRun 的 typed 429 只锁定对应 quota pool，不污染异池模型', async () => {
  const token = 'start-run-rate-limit-account-123456';
  const sourceModel = 'deepseek/deepseek-v4-pro';
  const otherPoolModel = 'z-ai/glm-5.2';
  const workerVm = createWorkerVm({
    fetchImpl: async (url) => {
      if (new URL(String(url)).pathname === '/api/v1/agent-runs') {
        return upstreamResponse(429, { status: 'rate_limited' });
      }
      return upstreamResponse(200, {});
    },
  });

  await assert.rejects(
    workerVm.api.startRun(token, 'base-agent', [], sourceModel),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:premium',
  );
  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, sourceModel),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:premium',
  );
  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, otherPoolModel));
});

test('普通成功观测不应续命已过期的 quota 快照', async () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const token = 'stale-quota-observation-account-123456';
  const model = 'deepseek/deepseek-v4-pro';
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, {
    model,
    quota: { [model]: { recentCount: 6, limit: 6 } },
  });
  workerVm.setNow(start + 11 * 60 * 1000);
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, { model });
  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, model));
});

function upstreamResponse(status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => body,
  };
}

function hasBearer(init = {}) {
  const headers = init.headers || {};
  if (typeof headers.get === 'function') return Boolean(headers.get('Authorization'));
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' && headers[key]);
}

const terminalChatParams = {
  model: 'mimo/mimo-v2.5',
  messages: [{ role: 'user', content: 'terminal test' }],
  stream: false,
};
const terminalModel = {
  id: 'mimo/mimo-v2.5',
  session: 'mimo/mimo-v2.5',
  upstream: 'mimo/mimo-v2.5',
  agent: 'base2-free-mimo',
};

function terminalFetch({
  sessionTerminal = false,
  chatTerminal = false,
  chatEmptyStatus = 0,
  chatEmptyHeaders = {},
  adsTerminal = false,
} = {}) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/v1/ads') {
      if (adsTerminal === 'token_invalid') return upstreamResponse(401, {});
      if (adsTerminal) return upstreamResponse(403, { status: 'banned' });
      return upstreamResponse(200, {});
    }
    if (path.includes('/api/v1/ads/impression') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
    if (path === '/api/v1/freebuff/session' && method === 'GET') {
      if (sessionTerminal === 'token_invalid') return upstreamResponse(401, {});
      if (sessionTerminal === 'nested_banned') return upstreamResponse(403, { error: { status: 'banned' } });
      if (sessionTerminal) return upstreamResponse(403, { status: 'banned' });
      if (adsTerminal === 'token_invalid') return upstreamResponse(401, {});
      return upstreamResponse(200, {
        status: 'active',
        instanceId: 'terminal-test-instance',
        model: 'mimo/mimo-v2.5',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
    }
    if (path === '/api/v1/freebuff/session' && method === 'POST') {
      return upstreamResponse(200, {
        status: 'active',
        instanceId: 'terminal-test-created',
        model: 'mimo/mimo-v2.5',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
    }
    if (path === '/api/v1/agent-runs') {
      return upstreamResponse(200, { runId: 'terminal-test-run' });
    }
    if (path === '/api/v1/chat/completions' && chatEmptyStatus) {
      return new Response(null, { status: chatEmptyStatus, headers: chatEmptyHeaders });
    }
    if (path === '/api/v1/chat/completions' && chatTerminal) {
      return upstreamResponse(403, { status: 'banned' });
    }
    return upstreamResponse(200, {});
  };
}

function terminalEnv(token, extra = {}) {
  return {
    FREEBUFF_TOKEN: token,
    FREEBUFF_DEBUG: 'false',
    FREEBUFF_ACCOUNT_STATE: {},
    ...extra,
  };
}

test('预置 terminal 账号整条请求链不发送 Bearer', async () => {
  const token = 'preexisting-terminal-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: terminalFetch() });
  const response = await workerVm.api.executeChat(
    terminalEnv(token, {
      FREEBUFF_ACCOUNT_STATE: { [token]: { state: 'banned', until: null, reason: 'upstream_banned' } },
    }),
    terminalChatParams,
    terminalModel,
    false,
    'chat',
  );
  assert.equal(response.status, 403);
  assert.equal(workerVm.upstreamCalls.filter(({ init }) => hasBearer(init)).length, 0);
});

test('session GET 观察到 terminal 后不再 POST/START/chat', async () => {
  const token = 'session-terminal-account-123456';
  const errors = [];
  const workerVm = createWorkerVm({
    fetchImpl: terminalFetch({ sessionTerminal: true }),
    consoleImpl: { ...console, error: (...args) => errors.push(args) },
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat',
  );
  assert.equal(response.status, 403);
  const terminalIndex = workerVm.upstreamCalls.findIndex(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.ok(terminalIndex >= 0);
  assert.equal(workerVm.upstreamCalls.slice(terminalIndex + 1).filter(({ init }) => hasBearer(init)).length, 0);
  assert.equal(errors.length, 0, '预期内 terminal 状态不应打印成 SDK/未处理异常');
});

test('session GET 观察到 401 后不再 POST/START/chat', async () => {
  const token = 'session-token-invalid-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: terminalFetch({ sessionTerminal: 'token_invalid' }) });
  const response = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat',
  );
  assert.equal(response.status, 403);
  const terminalIndex = workerVm.upstreamCalls.findIndex(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.ok(terminalIndex >= 0);
  assert.equal(workerVm.upstreamCalls.slice(terminalIndex + 1).filter(({ init }) => hasBearer(init)).length, 0);
});

test('业务请求执行期间外部 terminal 状态变化会阻止后续 Bearer', async () => {
  const token = 'concurrent-terminal-account-123456';
  let liveState = null;
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') {
        liveState = { state: 'banned', until: null, reason: 'admin_probe' };
        return upstreamResponse(404, {});
      }
      return upstreamResponse(200, { runId: 'should-not-be-reached' });
    },
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(token, { FREEBUFF_ACCOUNT_STATE_GET: () => liveState }),
    terminalChatParams,
    terminalModel,
    false,
    'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error?.type, 'account_banned');
  const sessionGetIndex = workerVm.upstreamCalls.findIndex(
    ({ url, init }) => String(url).endsWith('/api/v1/freebuff/session')
      && String(init.method || 'GET').toUpperCase() === 'GET',
  );
  assert.ok(sessionGetIndex >= 0);
  assert.equal(
    workerVm.upstreamCalls.slice(sessionGetIndex + 1).filter(({ init }) => hasBearer(init)).length,
    0,
    '外部 terminal 写入后不得继续 POST/START/chat',
  );
});

test('嵌套 terminal 状态会持久化并阻止后续请求', async () => {
  const token = 'nested-terminal-account-123456';
  const writes = [];
  const env = terminalEnv(token, {
    FREEBUFF_ACCOUNT_STATE_SET: (accountToken, state) => {
      writes.push({ accountToken, state: { ...state } });
      return { revision: writes.length };
    },
    FREEBUFF_ACCOUNT_STATE_REVISION: 0,
  });
  const workerVm = createWorkerVm({ fetchImpl: terminalFetch({ sessionTerminal: 'nested_banned' }) });
  const first = await workerVm.api.executeChat(env, terminalChatParams, terminalModel, false, 'chat');
  assert.equal(first.status, 403);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state.state, 'banned');
  const callsAfterFirst = workerVm.upstreamCalls.length;
  const second = await workerVm.api.executeChat(env, terminalChatParams, terminalModel, false, 'chat');
  assert.equal(second.status, 403);
  assert.equal(workerVm.upstreamCalls.length, callsAfterFirst, '持久化 terminal 后不得再次发送 Bearer');
});

test('业务 endpoint 瞬时 401 且独立 session 探测成功时不得永久隔离账号', async () => {
  const token = 'transient-auth-rejection-account-123456';
  const writes = [];
  let chatCalls = 0;
  let sessionProbeCalls = 0;
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') {
        sessionProbeCalls += 1;
        return upstreamResponse(200, {
          status: 'active', instanceId: 'transient-session', model: terminalModel.session,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'transient-run' });
      if (path === '/api/v1/chat/completions') {
        chatCalls += 1;
        return upstreamResponse(401, { error: 'temporary upstream auth rejection' });
      }
      return upstreamResponse(200, {});
    },
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(token, {
      FREEBUFF_ACCOUNT_STATE_SET: (accountToken, state) => writes.push({ accountToken, state }),
    }),
    terminalChatParams,
    terminalModel,
    false,
    'chat',
  );
  assert.equal(response.status, 503);
  assert.equal(chatCalls, 1);
  assert.equal(sessionProbeCalls, 2, '401 后应进行一次独立 session 确认');
  assert.equal(writes.length, 0, '确认 session 仍存活时不得写 token_invalid');
  const bearerPaths = workerVm.upstreamCalls
    .filter(({ init }) => hasBearer(init))
    .map(({ url }) => new URL(String(url)).pathname);
  assert.deepEqual(bearerPaths, [
    '/api/v1/ads',
    '/api/v1/usage',
    '/api/v1/freebuff/session',
    '/api/v1/agent-runs',
    '/api/v1/agent-runs',
    '/api/v1/chat/completions',
    '/api/v1/freebuff/session',
  ]);
});

test('独立 session 二次确认仍为 401 才永久隔离凭据', async () => {
  const token = 'confirmed-auth-rejection-account-123456';
  const writes = [];
  let sessionCalls = 0;
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return upstreamResponse(200, {
            status: 'active', instanceId: 'confirmed-session', model: terminalModel.session,
            expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          });
        }
        return upstreamResponse(401, {});
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'confirmed-run' });
      if (path === '/api/v1/chat/completions') return upstreamResponse(401, {});
      return upstreamResponse(200, {});
    },
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(token, {
      FREEBUFF_ACCOUNT_STATE_SET: (accountToken, state) => writes.push({ accountToken, state }),
    }),
    terminalChatParams,
    terminalModel,
    false,
    'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error?.type, 'account_terminal');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state.state, 'token_invalid');
  const sessionIndexes = workerVm.upstreamCalls
    .map(({ url }, index) => String(url).endsWith('/api/v1/freebuff/session') ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(sessionIndexes.length, 2, '应先建 session，再对业务 401 复核一次');
  assert.equal(
    workerVm.upstreamCalls.slice(sessionIndexes[1] + 1).filter(({ init }) => hasBearer(init)).length,
    0,
    '确认 terminal 后不得继续发送 Bearer',
  );
});

test('ads 观察到 401 且 session 复核仍为 401 后永久隔离并停止当前账号链', async () => {
  const token = 'ads-token-invalid-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: terminalFetch({ adsTerminal: 'token_invalid' }) });
  const response = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error?.type, 'account_terminal');
  const sessionIndex = workerVm.upstreamCalls.findIndex(
    ({ url }) => String(url).endsWith('/api/v1/freebuff/session'),
  );
  assert.ok(sessionIndex >= 0, 'ads 401 后应进行一次独立 session 复核');
  assert.equal(
    workerVm.upstreamCalls.slice(sessionIndex + 1).filter(({ init }) => hasBearer(init)).length,
    0,
    'session 确认终态后不得继续 usage/START/chat',
  );
});

test('Reviewer 业务 401 经 session 复核成功时不永久隔离账号', async () => {
  const token = 'reviewer-transient-auth-account-123456';
  const writes = [];
  let chatCalls = 0;
  let sessionCalls = 0;
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') {
        sessionCalls += 1;
        return upstreamResponse(200, {
          status: 'active', instanceId: 'reviewer-transient-session', model: terminalModel.session,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'reviewer-transient-run' });
      if (path === '/api/v1/chat/completions') {
        chatCalls += 1;
        return upstreamResponse(401, { error: 'temporary reviewer auth rejection' });
      }
      return upstreamResponse(200, {});
    },
  });
  const reviewParams = {
    ...terminalChatParams,
    metadata: { freebuff_mode: 'code_review' },
  };
  const reviewModel = { ...terminalModel, root_agent: terminalModel.agent, reviewer_agent: 'code-reviewer' };
  const response = await workerVm.api.executeChat(
    terminalEnv(token, {
      FREEBUFF_ACCOUNT_STATE_SET: (accountToken, state) => writes.push({ accountToken, state }),
    }),
    reviewParams,
    reviewModel,
    false,
    'chat',
  );
  assert.equal(response.status, 503);
  assert.equal(chatCalls, 1);
  assert.equal(sessionCalls, 2, 'Reviewer 401 后应进行一次独立 session 复核');
  assert.equal(writes.length, 0, '复核成功时不得永久隔离 Reviewer 账号');
});

test('Reviewer chat 观察到 terminal 后不再 FINISH/DELETE', async () => {
  const token = 'reviewer-terminal-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: terminalFetch({ chatTerminal: true }) });
  const reviewParams = {
    ...terminalChatParams,
    metadata: { freebuff_mode: 'code_review' },
  };
  const reviewModel = { ...terminalModel, root_agent: terminalModel.agent, reviewer_agent: 'code-reviewer' };
  const response = await workerVm.api.executeChat(
    terminalEnv(token), reviewParams, reviewModel, false, 'chat',
  );
  assert.equal(response.status, 403);
  const terminalIndex = workerVm.upstreamCalls.findIndex(({ url }) => String(url).endsWith('/api/v1/chat/completions'));
  assert.ok(terminalIndex >= 0);
  assert.equal(workerVm.upstreamCalls.slice(terminalIndex + 1).filter(({ init }) => hasBearer(init)).length, 0);
});

for (const scenario of [
  { status: 401, expectedStatus: 503, expectedType: 'upstream_session_unavailable', headers: {} },
  { status: 403, expectedStatus: 503, expectedType: 'egress_unavailable', headers: {} },
  { status: 429, expectedStatus: 429, expectedType: 'rate_limit_exceeded', headers: { 'Retry-After': '7' } },
]) {
  test(`流式 chat 空体 ${scenario.status} 先按 HTTP 错误分类且不再发送 Bearer`, async () => {
    const token = `empty-stream-${scenario.status}-account-123456`;
    const workerVm = createWorkerVm({
      fetchImpl: terminalFetch({
        chatEmptyStatus: scenario.status,
        chatEmptyHeaders: scenario.headers,
      }),
    });
    const response = await workerVm.api.executeChat(
      terminalEnv(token),
      { ...terminalChatParams, stream: true },
      terminalModel,
      true,
      'chat',
    );
    const body = await response.json();
    assert.equal(response.status, scenario.expectedStatus);
    assert.equal(body.error?.type, scenario.expectedType);
    const errorIndex = workerVm.upstreamCalls.findIndex(
      ({ url }) => String(url).endsWith('/api/v1/chat/completions'),
    );
    assert.ok(errorIndex >= 0);
    const afterErrorBearerPaths = workerVm.upstreamCalls
      .slice(errorIndex + 1)
      .filter(({ init }) => hasBearer(init))
      .map(({ url }) => new URL(String(url)).pathname);
    if (scenario.status === 401) {
      assert.deepEqual(afterErrorBearerPaths, ['/api/v1/freebuff/session'],
        '401 后只允许一次独立 session 复核');
    } else {
      assert.deepEqual(afterErrorBearerPaths, [],
        'HTTP 错误之后不得 DELETE、重建 session 或重试 chat');
    }
  });
}

test('新鲜已知 quota 按剩余额度降序选号，过期快照回到轮询', () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const model = 'deepseek/deepseek-v4-pro';
  const tokenA = 'quota-picker-account-a-123456';
  const tokenB = 'quota-picker-account-b-123456';
  const tokenC = 'quota-picker-account-c-123456';
  const env = { FREEBUFF_TOKEN: `${tokenA}\n${tokenB}\n${tokenC}`, FREEBUFF_ACCOUNT_STATE: {} };
  const quota = (remaining) => ({ [model]: { recentCount: 6 - remaining, limit: 6 } });
  workerVm.api.recordAccountObservation(tokenA, 200, { status: 'ok' }, { quota: quota(1) });
  workerVm.api.recordAccountObservation(tokenB, 200, { status: 'ok' }, { quota: quota(5) });
  workerVm.api.recordAccountObservation(tokenC, 200, { status: 'ok' }, { quota: quota(3) });

  const first = workerVm.api.pickToken(env, model, new Set());
  assert.equal(first?.token, tokenB);
  workerVm.api.releaseToken(first.token);

  workerVm.setNow(start + 10 * 60 * 1000 + 1);
  const afterExpiry = workerVm.api.pickToken(env, model, new Set());
  assert.equal(afterExpiry?.token, tokenA);
  workerVm.api.releaseToken(afterExpiry.token);
});

function sessionAdmissionFetch(payload, status = 429) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
    if (path === '/api/v1/freebuff/session') return upstreamResponse(status, payload);
    return upstreamResponse(200, { runId: 'unexpected-admission-run' });
  };
}

test('session ip_capped 立即停止链路且不写账号或模型冷却', async () => {
  const token = 'session-ip-capped-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ status: 'ip_capped' }) });
  await workerVm.api.executeChat(terminalEnv(token), terminalChatParams, terminalModel, false, 'chat');
  const sessionCalls = workerVm.upstreamCalls.filter(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.equal(sessionCalls.length, 1);
  const selected = workerVm.api.pickToken(terminalEnv(token), terminalModel.session, new Set());
  assert.equal(selected?.token, token);
  workerVm.api.releaseToken(token);
});

test('session 403 country_blocked 立即停止链路且不继续 POST 或换号', async () => {
  const tokenA = 'session-country-blocked-a-123456';
  const tokenB = 'session-country-blocked-b-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ status: 'country_blocked' }, 403) });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error?.type, 'egress_unavailable');
  const sessionCalls = workerVm.upstreamCalls.filter(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.equal(sessionCalls.length, 1, '出口拒绝后不得继续 POST session 或换账号重试');
});

test('session 裸 403 视为出口拒绝且不继续换账号', async () => {
  const tokenA = 'session-bare-403-a-123456';
  const tokenB = 'session-bare-403-b-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ error: 'edge rejected' }, 403) });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error?.type, 'egress_unavailable');
  const sessionCalls = workerVm.upstreamCalls.filter(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.equal(sessionCalls.length, 1, '裸 403 后不得继续换账号重试');
});

test('显式非出口 403 状态不归类为出口拒绝', () => {
  const workerVm = createWorkerVm();
  const decision = workerVm.api.classifyRateLimit(
    { status: 'free_mode_cli_required' }, 403, {}, terminalModel.session,
  );
  assert.equal(decision.reason, 'error');
});

test('session typed quota 429 只锁当前作用域且不继续 POST', async () => {
  const token = 'session-quota-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ status: 'rate_limited', retryAfterMs: 7000 }) });
  const response = await workerVm.api.executeChat(terminalEnv(token), terminalChatParams, terminalModel, false, 'chat');
  assert.equal(response.status, 429);
  const sessionCalls = workerVm.upstreamCalls.filter(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.equal(sessionCalls.length, 1);
  assert.equal(workerVm.api.pickToken(terminalEnv(token), terminalModel.session, new Set()), null);
  const other = workerVm.api.pickToken(terminalEnv(token), 'deepseek/deepseek-v4-flash', new Set());
  assert.equal(other?.token, token);
  workerVm.api.releaseToken(token);
});

test('session spend_limited 按账号级隔离所有模型', async () => {
  const token = 'session-spend-limited-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ status: 'spend_limited', retryAfterMs: 7000 }) });
  const response = await workerVm.api.executeChat(terminalEnv(token), terminalChatParams, terminalModel, false, 'chat');
  assert.equal(response.status, 429);
  assert.equal(workerVm.api.pickToken(terminalEnv(token), terminalModel.session, new Set()), null);
  assert.equal(workerVm.api.pickToken(terminalEnv(token), 'deepseek/deepseek-v4-flash', new Set()), null);
});

test('session waiting_room_queued 返回等待态且不写 quota 冷却', async () => {
  const token = 'session-waiting-account-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ status: 'waiting_room_queued', retryAfterMs: 5000 }) });
  const response = await workerVm.api.executeChat(terminalEnv(token), terminalChatParams, terminalModel, false, 'chat');
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error?.type, 'waiting_room');
  const sessionCalls = workerVm.upstreamCalls.filter(({ url }) => String(url).endsWith('/api/v1/freebuff/session'));
  assert.equal(sessionCalls.length, 1);
  const selected = workerVm.api.pickToken(terminalEnv(token), terminalModel.session, new Set());
  assert.equal(selected?.token, token);
  workerVm.api.releaseToken(token);
});

test('全池 SDK/会话冷却明确报告模型暂不可用，不伪装成无账号或额度耗尽', () => {
  const workerVm = createWorkerVm();
  const model = 'mimo/mimo-v2.5';
  const tokenA = 'sdk-error-account-a-123456';
  const tokenB = 'sdk-error-account-b-123456';
  const env = { FREEBUFF_TOKEN: `${tokenA}\n${tokenB}`, FREEBUFF_ACCOUNT_STATE: {} };
  workerVm.api.cooldown(tokenA, 30 * 1000, { reason: 'error', model });
  workerVm.api.cooldown(tokenB, 45 * 1000, { reason: 'invalidation', model });
  const exhausted = workerVm.api.accountPoolExhaustion(env, model);
  assert.equal(exhausted.status, 503);
  assert.equal(exhausted.type, 'upstream_session_unavailable');
  assert.ok(exhausted.retryAfterMs > 0 && exhausted.retryAfterMs <= 30 * 1000);
});

test('所有账号 session 阶段短暂失败时返回 upstream_session_unavailable', async () => {
  const tokenA = 'sdk-flow-account-a-123456';
  const tokenB = 'sdk-flow-account-b-123456';
  const workerVm = createWorkerVm({ fetchImpl: sessionAdmissionFetch({ error: 'temporary sdk failure' }, 500) });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error?.type, 'upstream_session_unavailable');
  assert.notEqual(body.error?.type, 'account_pool_unavailable');
  assert.ok(Number(body.error?.retryAfterMs) > 0);
  assert.ok(response.headers.get('Retry-After'));
});

test('生产 createSession 顺序调用复用一小时缓存且不再请求 session 接口', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'create-session-sequential-reuse-account-123456';
  const model = terminalModel.session;
  let sessionCalls = 0;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session') {
        sessionCalls += 1;
        if (String(init.method || 'GET').toUpperCase() === 'GET') return upstreamResponse(404, {});
        return upstreamResponse(200, {
          status: 'active',
          instanceId: 'sequential-reuse-instance',
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });

  const first = await workerVm.api.createSession(token, model);
  const callsAfterCreate = sessionCalls;
  const second = await workerVm.api.createSession(token, model);

  assert.equal(first.instanceId, 'sequential-reuse-instance');
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(sessionCalls, callsAfterCreate, '缓存命中后不得新增 session GET/POST');
});

test('同模型 active session 忙时并发请求依次等待原账号，不在其他账号创建新 session', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'active-session-wait-account-a-123456';
  const tokenB = 'active-session-wait-account-b-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB}`);
  const sessionPosts = [];
  let releaseFirstChat;
  const firstChatGate = new Promise((resolve) => { releaseFirstChat = resolve; });
  let chatCalls = 0;
  let firstChatStarted;
  const firstChatStartedPromise = new Promise((resolve) => { firstChatStarted = resolve; });
  const successStream = () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const auth = init.headers?.Authorization || init.headers?.authorization || '';
      const slot = auth.endsWith(tokenA) ? 'A' : auth.endsWith(tokenB) ? 'B' : '?';
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        sessionPosts.push(slot);
        return upstreamResponse(200, {
          status: 'active',
          instanceId: `active-wait-${slot}`,
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `active-wait-run-${slot}` });
      if (path === '/api/v1/chat/completions') {
        chatCalls += 1;
        if (chatCalls === 1) {
          firstChatStarted();
          await firstChatGate;
        }
        return successStream();
      }
      return upstreamResponse(200, {});
    },
  });

  await workerVm.api.createSession(tokenA, model);
  sessionPosts.length = 0;
  const first = workerVm.api.executeChat(env, terminalChatParams, terminalModel, false, 'chat');
  await firstChatStartedPromise;
  const second = workerVm.api.executeChat(env, terminalChatParams, terminalModel, false, 'chat');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(sessionPosts, [], 'A 忙时第二个请求不应立即在 B 创建 session');
  releaseFirstChat();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(sessionPosts, [], 'A 释放后第二个请求应复用 A 的 active session');
});

test('等待 active session 租约时客户端取消会立即停止且不改选其他账号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'active-session-abort-account-a-123456';
  const tokenB = 'active-session-abort-account-b-123456';
  const model = terminalModel.session;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && String(init.method || 'GET').toUpperCase() === 'GET') {
        return upstreamResponse(200, {
          status: 'active',
          instanceId: 'active-abort-A',
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.api.createSession(tokenA, model);
  const leased = workerVm.api.pickToken(terminalEnv(`${tokenA},${tokenB}`), model, new Set());
  assert.equal(leased?.token, tokenA);
  const controller = new AbortController();
  const waiting = workerVm.api.pickTokenWithSessionWait(
    terminalEnv(`${tokenA},${tokenB}`), model, new Set(), controller.signal,
  );
  controller.abort(new Error('client disconnected'));

  await assert.rejects(waiting, /request aborted/);
  workerVm.api.releaseToken(tokenA);
  const recovered = workerVm.api.pickToken(terminalEnv(`${tokenA},${tokenB}`), model, new Set());
  assert.equal(recovered?.token, tokenA, '取消的 waiter 不得残留或吞掉后续 release');
  workerVm.api.releaseToken(tokenA);
  assert.equal(workerVm.upstreamCalls.some(({ init }) =>
    String(init.headers?.Authorization || '').endsWith(tokenB)), false);
});

test('active session 等待超时后才回退其他账号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'active-session-timeout-account-a-123456';
  const tokenB = 'active-session-timeout-account-b-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB}`);
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && String(init.method || 'GET').toUpperCase() === 'GET') {
        return upstreamResponse(200, {
          status: 'active',
          instanceId: 'active-timeout-A',
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.api.createSession(tokenA, model);
  const leased = workerVm.api.pickToken(env, model, new Set());
  assert.equal(leased?.token, tokenA);

  const selected = await workerVm.api.pickTokenWithSessionWait(env, model, new Set(), null, 10);
  assert.equal(selected?.token, tokenB);
  workerVm.api.releaseToken(tokenB);
  workerVm.api.releaseToken(tokenA);
});

test('生产 createSession 复用 singleFlight，失败后允许下一次重试', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'create-session-singleflight-account-123456';
  const model = terminalModel.session;
  let postCalls = 0;
  let failFirstPost = false;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session') {
        if (String(init.method || 'GET').toUpperCase() === 'GET') return upstreamResponse(404, {});
        postCalls += 1;
        if (failFirstPost) {
          failFirstPost = false;
          return upstreamResponse(500, { error: 'temporary create failure' });
        }
        return upstreamResponse(200, {
          status: 'active',
          instanceId: `singleflight-${postCalls}`,
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });

  const [first, second] = await Promise.all([
    workerVm.api.createSession(token, model),
    workerVm.api.createSession(token, model),
  ]);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(postCalls, 1, '同 token:model 并发只能发一个 session POST');

  const retryToken = 'create-session-retry-account-123456';
  failFirstPost = true;
  postCalls = 0;
  await assert.rejects(workerVm.api.createSession(retryToken, model), /create session failed: 500/);
  const retried = await workerVm.api.createSession(retryToken, model);
  assert.equal(retried.instanceId, 'singleflight-2');
  assert.equal(postCalls, 2, '失败 promise 必须从 singleFlight 清理，下一次可重试');
});

// 换号会在新账号上再建一个 session，而免费额度按账号每天只有几次创建机会。
// 因此「上游抖动」必须重试同一个号，只有账号自身出问题（额度耗尽/终态/
// 复核失败）才允许换号。以下三个用例锁定这条边界。
function flakySessionFetch({ failToken, failStatus = 500, failTimes = Infinity, posts = [] }) {
  const start = Date.UTC(2030, 0, 1);
  let failed = 0;
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = String(init.method || 'GET').toUpperCase();
    const auth = String(init.headers?.Authorization || init.headers?.authorization || '');
    const isFailing = auth.endsWith(failToken);
    if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
    if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
    if (path === '/api/v1/freebuff/session' && method === 'POST') {
      posts.push(auth.slice(-12));
      if (isFailing && failed < failTimes) {
        failed += 1;
        return upstreamResponse(failStatus, failStatus === 429
          ? { status: 'rate_limited', retryAfterMs: 60000 }
          : { error: 'temporary sdk failure' });
      }
      return upstreamResponse(200, {
        status: 'active',
        instanceId: 'flaky-' + auth.slice(-6),
        model: terminalModel.session,
        expiresAt: new Date(start + 3600 * 1000).toISOString(),
      });
    }
    if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: 'flaky-run' });
    if (path === '/api/v1/chat/completions') {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return upstreamResponse(200, {});
  };
}

test('session 创建遇上游 5xx 抖动时重试同一账号，不在其他账号建 session', async () => {
  const tokenA = 'flaky-session-retry-same-a-123456';
  const tokenB = 'flaky-session-retry-same-b-123456';
  const posts = [];
  const workerVm = createWorkerVm({
    now: Date.UTC(2030, 0, 1),
    fetchImpl: flakySessionFetch({ failToken: tokenA, failTimes: 1, posts }),
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  assert.equal(response.status, 200);
  assert.equal(posts.length, 2, 'A 应被重试一次');
  assert.ok(posts.every((slot) => tokenA.endsWith(slot)), `session POST 不应落到 B：${JSON.stringify(posts)}`);
  assert.equal(
    workerVm.upstreamCalls.some(({ init }) =>
      String(init.headers?.Authorization || '').endsWith(tokenB)), false, 'B 完全不应被使用');
});

test('同账号重试用尽后仍换号，保留跨账号故障转移', async () => {
  const tokenA = 'flaky-session-failover-a-123456';
  const tokenB = 'flaky-session-failover-b-123456';
  const posts = [];
  const workerVm = createWorkerVm({
    now: Date.UTC(2030, 0, 1),
    fetchImpl: flakySessionFetch({ failToken: tokenA, posts }),
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  assert.equal(response.status, 200);
  assert.ok(posts.length >= 3, `A 重试用尽后应换到 B：${JSON.stringify(posts)}`);
  assert.ok(tokenB.endsWith(posts[posts.length - 1]), '最后一次 session POST 应在 B');
});

test('额度耗尽属账号自身问题，立即换号且不重试同账号', async () => {
  const tokenA = 'flaky-session-quota-a-123456';
  const tokenB = 'flaky-session-quota-b-123456';
  const posts = [];
  const workerVm = createWorkerVm({
    now: Date.UTC(2030, 0, 1),
    fetchImpl: flakySessionFetch({ failToken: tokenA, failStatus: 429, posts }),
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(`${tokenA},${tokenB}`), terminalChatParams, terminalModel, false, 'chat',
  );
  assert.equal(response.status, 200);
  assert.equal(posts.length, 2, `429 不应重试同号：${JSON.stringify(posts)}`);
  assert.ok(tokenA.endsWith(posts[0]) && tokenB.endsWith(posts[1]));
});

test('FREEBUFF_SESSION_WAIT_MS 可调等待上限，非法值回落默认', () => {
  const { api } = createWorkerVm();
  assert.equal(api.sessionLeaseWaitMs({}), 120 * 1000);
  assert.equal(api.sessionLeaseWaitMs({ FREEBUFF_SESSION_WAIT_MS: '0' }), 0, '设 0 应表示忙时立刻换号');
  assert.equal(api.sessionLeaseWaitMs({ FREEBUFF_SESSION_WAIT_MS: '600000' }), 600 * 1000);
  for (const bad of ['', 'abc', '-1', null]) {
    assert.equal(api.sessionLeaseWaitMs({ FREEBUFF_SESSION_WAIT_MS: bad }), 120 * 1000, `非法值 ${bad} 应回落默认`);
  }
});
