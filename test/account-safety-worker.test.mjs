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
  + 'globalThis.__accountSafetyTestApi__ = { pickToken, pickTokenWithSessionWait, waitForAnyTokenRelease, sessionLeaseWaitMs, releaseToken, invalidateSessionCache, recordAccountObservation, cooldown, parseCooldown, accountPoolExhaustion, classifyRateLimit, quotaScopeForModel, freshQuotaProbe, startRun, executeChat, executeCodeReview, createSession, clientStatsSnapshot, recordRequest, usageSnapshot, restoreUsageSnapshot, restoreKeyUsageSnapshot, authenticatedUpstreamFetch };\n';

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

test('上游 fetch 按账号 token 选择独立出站', async () => {
  const workerVm = createWorkerVm();
  const routed = [];
  const env = {
    FREEBUFF_TOKEN: 'token-a-12345678901234567890,token-b-12345678901234567890',
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT(token) {
      return async (url) => {
        routed.push({ token, url: String(url) });
        return new Response(token, { status: 200 });
      };
    },
  };
  await workerVm.worker.fetch(new Request('http://local/healthz'), env);
  const a = await workerVm.api.authenticatedUpstreamFetch('token-a-12345678901234567890', 'https://upstream.test/a');
  const b = await workerVm.api.authenticatedUpstreamFetch('token-b-12345678901234567890', 'https://upstream.test/b');
  assert.equal(await a.text(), 'token-a-12345678901234567890');
  assert.equal(await b.text(), 'token-b-12345678901234567890');
  assert.deepEqual(routed.map((entry) => entry.token), [
    'token-a-12345678901234567890',
    'token-b-12345678901234567890',
  ]);
});

test('一个账号的本地出站不可用时继续使用下一个账号', async () => {
  const tokenA = 'egress-fallback-account-a-123456';
  const tokenB = 'egress-fallback-account-b-123456';
  const routed = [];
  const workerVm = createWorkerVm({
    fetchImpl: flakySessionFetch({ failToken: 'unused-egress-fallback-token' }),
  });
  const env = terminalEnv(`${tokenA},${tokenB}`, {
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT(token) {
      if (token !== tokenA) return null;
      return async () => {
        routed.push(token);
        const error = new Error('account egress is unavailable');
        error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
        throw error;
      };
    },
  });

  await workerVm.worker.fetch(new Request('http://local/healthz'), env);
  const response = await workerVm.api.executeChat(
    env, terminalChatParams, terminalModel, false, 'chat',
  );

  assert.equal(response.status, 200);
  assert.ok(routed.length > 0 && routed.every((token) => token === tokenA));
  assert.equal(workerVm.upstreamCalls.some(({ init }) =>
    String(init.headers?.Authorization || '').endsWith(tokenB)), true);
});

test('Code review 首账号本地出站不可用时继续使用下一个账号', async () => {
  const tokenA = 'review-egress-fallback-account-a-123456';
  const tokenB = 'review-egress-fallback-account-b-123456';
  const routed = [];
  const workerVm = createWorkerVm({
    fetchImpl: flakySessionFetch({ failToken: 'unused-review-egress-fallback-token' }),
  });
  const env = terminalEnv(`${tokenA},${tokenB}`, {
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT(token) {
      if (token !== tokenA) return null;
      return async () => {
        routed.push(token);
        const error = new Error('account egress is unavailable');
        error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
        throw error;
      };
    },
  });

  await workerVm.worker.fetch(new Request('http://local/healthz'), env);
  const response = await workerVm.api.executeChat(
    env,
    { ...terminalChatParams, metadata: { freebuff_mode: 'code_review' } },
    { ...terminalModel, root_agent: terminalModel.agent, reviewer_agent: 'code-reviewer' },
    false,
    'chat',
  );

  assert.equal(response.status, 200);
  assert.ok(routed.length > 0 && routed.every((token) => token === tokenA));
  assert.equal(workerVm.upstreamCalls.some(({ init }) =>
    String(init.headers?.Authorization || '').endsWith(tokenB)), true);
});

test('服务端固定账号路由器不被另一个并发请求的 env 覆盖', async () => {
  const workerVm = createWorkerVm();
  const token = 'stable-managed-route-token-1234567890';
  const routed = [];
  workerVm.worker.configureUpstreamRouting({
    getUpstreamFetch: () => async () => new Response('configured-global', { status: 200 }),
    resolveAccountFetch(accountToken) {
      return async () => {
        routed.push(accountToken);
        return new Response('configured-account', { status: 200 });
      };
    },
  });

  await workerVm.worker.fetch(new Request('http://local/healthz'), {
    FREEBUFF_TOKEN: token,
    FREEBUFF_UPSTREAM_FETCH: async () => new Response('request-global', { status: 200 }),
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT: () => async () => new Response('request-account', { status: 200 }),
  });
  const response = await workerVm.api.authenticatedUpstreamFetch(token, 'https://upstream.test/stable');
  assert.equal(await response.text(), 'configured-account');
  assert.deepEqual(routed, [token]);
});

test('移除代理注入后全局上游 fetch 回落直连', async () => {
  const workerVm = createWorkerVm({
    fetchImpl: async () => new Response('direct', { status: 200 }),
  });
  const proxyFetch = async () => new Response('proxy', { status: 200 });
  await workerVm.worker.fetch(new Request('http://local/healthz'), {
    FREEBUFF_UPSTREAM_FETCH: proxyFetch,
  });
  assert.equal(await (await workerVm.api.authenticatedUpstreamFetch('', 'https://upstream.test/proxy')).text(), 'proxy');

  await workerVm.worker.fetch(new Request('http://local/healthz'), {});
  assert.equal(await (await workerVm.api.authenticatedUpstreamFetch('', 'https://upstream.test/direct')).text(), 'direct');
  assert.equal(workerVm.upstreamCalls.at(-1).url, 'https://upstream.test/direct');
});

test('出站拒绝回调携带账号 token 供服务端归因 lane', async () => {
  const workerVm = createWorkerVm();
  const rejects = [];
  const token = 'egress-reject-token-123456789012345';
  await workerVm.worker.fetch(new Request('http://local/healthz'), {
    FREEBUFF_TOKEN: token,
    FREEBUFF_ON_EGRESS_REJECT: (info) => rejects.push(info),
  });
  workerVm.api.recordAccountObservation(token, 403, {});
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].token, token);
  assert.equal(rejects[0].state, 'blocked');
});

test('出站拒绝回调携带请求开始时的节点代际，切换后不误伤新节点', async () => {
  const workerVm = createWorkerVm();
  const rejects = [];
  const token = 'egress-generation-token-123456789012345';
  await workerVm.worker.fetch(new Request('http://local/healthz'), {
    FREEBUFF_TOKEN: token,
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT() {
      return {
        fetch: async () => new Response('{}', { status: 403 }),
        egress: { lane: 2, node: 'US-A', generation: 7 },
      };
    },
    FREEBUFF_ON_EGRESS_REJECT: (info) => rejects.push(info),
  });
  const response = await workerVm.api.authenticatedUpstreamFetch(token, 'https://upstream.test/rejected');
  workerVm.api.recordAccountObservation(token, response.status, {}, { headers: response.headers });
  assert.deepEqual(rejects.map(({ token: seenToken, state, status, lane, node, generation }) => ({
    token: seenToken, state, status, lane, node, generation,
  })), [{ token, state: 'blocked', status: 403, lane: 2, node: 'US-A', generation: 7 }]);
});

test('一个账号出站不可用不会污染另一账号的独立 fetch', async () => {
  const workerVm = createWorkerVm();
  const badToken = 'bad-egress-account-token-1234567890';
  const goodToken = 'good-egress-account-token-123456789';
  await workerVm.worker.fetch(new Request('http://local/healthz'), {
    FREEBUFF_TOKEN: `${badToken},${goodToken}`,
    FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT(token) {
      if (token === badToken) return async () => {
        const error = new Error('account lane is unavailable');
        error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
        throw error;
      };
      if (token === goodToken) return async () => new Response('good', { status: 200 });
      return null;
    },
  });

  await assert.rejects(
    () => workerVm.api.authenticatedUpstreamFetch(badToken, 'https://upstream.test/bad'),
    (error) => error?.name === 'EgressRejectedError' && error?.state === 'egress_unavailable',
  );
  const response = await workerVm.api.authenticatedUpstreamFetch(goodToken, 'https://upstream.test/good');
  assert.equal(await response.text(), 'good');
});

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

test('quota 冷却按 D4P、Luna 独立池和当前 Premium 共池传播', () => {
  const workerVm = createWorkerVm();
  const token = 'quota-scope-account-123456';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {} };

  workerVm.api.cooldown(token, 60 * 1000, {
    reason: 'quota',
    retryAfterMs: 60 * 1000,
    model: 'deepseek/deepseek-v4-pro',
  });

  assert.equal(workerVm.api.pickToken(env, 'deepseek/deepseek-v4-pro', new Set()), null,
    'D4P 必须被自己的 deepseek_pro 池冷却');
  for (const model of [
    'openai/gpt-5.6-luna',
    'deepseek/deepseek-v4-flash',
    'z-ai/glm-5.2',
    'mimo/mimo-v2.5',
  ]) {
    const available = workerVm.api.pickToken(env, model, new Set());
    assert.equal(available?.token, token, `D4P 独立池不应阻塞 ${model}`);
    workerVm.api.releaseToken(token);
  }

  workerVm.api.cooldown(token, 60 * 1000, {
    reason: 'quota',
    retryAfterMs: 60 * 1000,
    model: 'deepseek/deepseek-v4-flash',
  });
  for (const model of ['crof/kimi-k3-eco', 'meta/muse-spark-1.2-contributor']) {
    assert.equal(workerVm.api.pickToken(env, model, new Set()), null,
      `DS4F 与 ${model} 必须共享 Premium quota 冷却`);
  }
  assert.equal(workerVm.api.pickToken(env, 'minimax/minimax-m3', new Set()), null,
    'M3 当前已暂停，不得进入正常账号调度');
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
  assert.equal(typedPremium.scope, 'pool:deepseek_pro', 'D4P typed quota 必须锁独立池');
  assert.equal(workerVm.api.quotaScopeForModel('openai/gpt-5.6-luna'), 'pool:luna',
    'Luna 必须使用独立池');
  assert.equal(workerVm.api.quotaScopeForModel('z-ai/glm-5.2'), 'pool:glm', 'GLM 静态兜底必须保持独立池');
  assert.equal(workerVm.api.quotaScopeForModel('deepseek/deepseek-v4-flash'), 'pool:premium',
    'DS4F 当前属于共享 Premium 池');
  assert.equal(workerVm.api.quotaScopeForModel('crof/kimi-k3-eco'), 'pool:premium');
  assert.equal(workerVm.api.quotaScopeForModel('meta/muse-spark-1.2-contributor'), 'pool:premium');
  assert.equal(workerVm.api.quotaScopeForModel('minimax/minimax-m3'), 'model:minimax/minimax-m3',
    'M3 已暂停，静态兜底不得继续声称它占当前 Premium 池');
  assert.equal(workerVm.api.quotaScopeForModel('mimo/mimo-v2.5'), 'model:mimo/mimo-v2.5');
  assert.equal(workerVm.api.quotaScopeForModel('anthropic/claude-fable-5'), 'model:anthropic/claude-fable-5');
});

test('额度快照按上游 pool 选择，不再取任意 Premium 模型行', async () => {
  const workerVm = createWorkerVm();
  const token = 'pool-quota-snapshot-account-123456';
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, {
    quota: {
      'deepseek/deepseek-v4-pro': { recentCount: 1, limit: 1, pool: 'deepseek_pro' },
      'openai/gpt-5.6-luna': { recentCount: 0, limit: 1, pool: 'luna' },
      'deepseek/deepseek-v4-flash': { recentCount: 5, limit: 5, pool: 'premium' },
      'mimo/mimo-v2.5': { recentCount: 6, limit: 6, pool: 'standard' },
    },
  });

  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, 'deepseek/deepseek-v4-pro'),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:deepseek_pro',
  );
  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, 'openai/gpt-5.6-luna'));
  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, 'crof/kimi-k3-eco'),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:premium',
  );
  await assert.doesNotReject(workerVm.api.freshQuotaProbe(token, 'mimo/mimo-v2.5'));
});

test('Premium 快照异常不一致时各模型使用同一保守池结论并忽略暂停 M3', async () => {
  const workerVm = createWorkerVm();
  const token = 'premium-inconsistent-snapshot-account-123456';
  workerVm.api.recordAccountObservation(token, 200, { status: 'ok' }, {
    quota: {
      'deepseek/deepseek-v4-flash': { recentCount: 2, limit: 7, pool: 'premium' },
      'crof/kimi-k3-eco': { recentCount: 5, limit: 5, pool: 'premium' },
      'minimax/minimax-m3': { recentCount: 0, limit: 99, pool: 'premium' },
    },
  });

  for (const model of ['deepseek/deepseek-v4-flash', 'crof/kimi-k3-eco', 'meta/muse-spark-1.2-contributor']) {
    await assert.rejects(
      workerVm.api.freshQuotaProbe(token, model),
      (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:premium',
      `${model} 必须使用同一保守 Premium 池结论`,
    );
  }
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
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:deepseek_pro',
  );
  await assert.rejects(
    workerVm.api.freshQuotaProbe(token, sourceModel),
    (error) => error?.name === 'QuotaExhaustedError' && error.scope === 'pool:deepseek_pro',
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

test('Key 每日上限按新建上游 session 计数，同一小时 session 内重复调用不递增', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'client-session-budget-account-123456';
  const model = terminalModel.session;
  const client = { key: 'fbk-session-budget', name: '会话预算', concurrency: 4, models: [], dailyLimit: 2, owner: false };
  let postCalls = 0;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        postCalls += 1;
        return upstreamResponse(200, {
          status: 'active', instanceId: `budget-session-${postCalls}`, model,
          remainingMs: 3600 * 1000,
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `budget-run-${postCalls}` });
      if (path === '/api/v1/chat/completions') {
        return new Response(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n'
            + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return upstreamResponse(200, {});
    },
  });
  const first = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  const second = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(postCalls, 1, '同一个缓存 session 内重复请求不得创建第二个 session');
  let stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.dayCount, 1, '同一个上游 instance 当天只计一次');
  assert.equal(stats.total, 1, '累计也按新建 session 计数');

  // session 过期后允许再创建一个新实例；第三个 fresh session 在达到 2/2 后必须在 POST 前被拒。
  workerVm.setNow(start + 3600 * 1000);
  const third = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  assert.equal(third.status, 200);
  assert.equal(postCalls, 2);
  stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.dayCount, 2);

  workerVm.setNow(start + 2 * 3600 * 1000);
  const over = await workerVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  const body = await over.json();
  assert.equal(over.status, 429);
  assert.equal(body.error?.type, 'key_daily_limit_exceeded');
  assert.equal(postCalls, 2, '达到每日新会话上限后不得再发 session POST');
});

test('Key 历史 token 只累计成功请求，并兼容两套 usage 字段', () => {
  const workerVm = createWorkerVm();
  const client = { key: 'fbk-token-stats-secret', name: 'Token 统计', concurrency: 1, models: [], dailyLimit: 0, owner: false };

  workerVm.api.recordRequest(terminalModel.id, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 18,
  }, true, client);
  workerVm.api.recordRequest(terminalModel.id, {
    input_tokens: 2,
    output_tokens: 3,
  }, true, client);
  workerVm.api.recordRequest(terminalModel.id, { total_tokens: 99 }, false, client);

  const stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.totalTokens, 23, '优先累计 total_tokens，缺失时回退输入 + 输出，失败不累计');
  assert.ok(!JSON.stringify(workerVm.api.usageSnapshot()).includes(client.key), '持久化快照不得包含明文 Key');
});

test('Key 历史 token 随概况快照恢复', () => {
  const client = { key: 'fbk-token-stats-restore-secret', name: '恢复统计', concurrency: 1, models: [], dailyLimit: 0, owner: false };
  const firstVm = createWorkerVm();
  firstVm.api.recordRequest(terminalModel.id, { total_tokens: 42 }, true, client);
  const snapshot = firstVm.api.usageSnapshot();

  const restoredVm = createWorkerVm();
  restoredVm.api.restoreUsageSnapshot(snapshot);
  const stats = restoredVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.totalTokens, 42);
});

test('概况开关关闭时也能单独恢复分享 Key 统计', () => {
  const client = { key: 'fbk-key-only-restore-secret', name: 'Key 独立恢复', concurrency: 1, models: [], dailyLimit: 0, owner: false };
  const firstVm = createWorkerVm();
  firstVm.api.recordRequest(terminalModel.id, { total_tokens: 17 }, true, client);
  const keySnapshot = { byKey: firstVm.api.usageSnapshot().byKey };

  const restoredVm = createWorkerVm();
  restoredVm.api.restoreKeyUsageSnapshot(keySnapshot);
  const stats = restoredVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.totalTokens, 17);
  assert.equal(restoredVm.api.usageSnapshot().total.totalTokens, 0,
    '独立恢复 Key 统计不能顺带恢复概况总量');
});

test('Key 会话归账（今日 / 累计）随概况快照跨重启恢复，预算不被重启白送', async () => {
  const start = Date.UTC(2030, 0, 1, 12);          // LA 2030-01-01 04:00
  const token = 'client-session-persist-account-123456';
  const model = terminalModel.session;
  const client = { key: 'fbk-session-persist', name: '持久归账', concurrency: 4, models: [], dailyLimit: 1, owner: false };
  let postCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = String(init.method || 'GET').toUpperCase();
    if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
    if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
    if (path === '/api/v1/freebuff/session' && method === 'POST') {
      postCalls += 1;
      return upstreamResponse(200, {
        status: 'active', instanceId: `persist-session-${postCalls}`, model, remainingMs: 3600 * 1000,
      });
    }
    if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `persist-run-${postCalls}` });
    if (path === '/api/v1/chat/completions') {
      return new Response(
        'data: ' + JSON.stringify({
          choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { total_tokens: 12 },
        }) + '\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return upstreamResponse(200, {});
  };

  const firstVm = createWorkerVm({ now: start, fetchImpl });
  // 新建 session 就要落一次盘：不能等这把 key 下一次成功请求才写，中途重启会丢一整天的账。
  const saved = [];
  firstVm.worker.configureUsagePersistence({
    load: () => null, save: (snap) => { saved.push(snap); }, enabled: () => true,
  });
  const first = await firstVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  assert.equal(first.status, 200);
  assert.ok(saved.length > 0, '认领新会话后必须触发一次持久化保存');
  const snapshot = JSON.parse(JSON.stringify(firstVm.api.usageSnapshot()));
  assert.equal(JSON.stringify(snapshot).includes(token), false,
    '落盘的会话身份必须是指纹：上游账号 token 不许出现在统计文件里');

  // 重启：新进程只有磁盘快照，连明文 key 都还没见过。
  // instanceId 继续往上编号（真实上游每个新 session 都是新 id），否则新建的会话会撞上
  // 恢复进来的旧身份、被当成同一个 session 而不计数。
  const postsBeforeRestart = postCalls;
  const restoredVm = createWorkerVm({ now: start + 2 * 3600 * 1000, fetchImpl });
  restoredVm.api.restoreUsageSnapshot(snapshot);
  const restored = restoredVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(restored.dayCount, 1, '重启后不用等这把 key 再被用一次就该看到今日会话');
  assert.equal(restored.total, 1, '累计会话跨重启保留');
  assert.equal(restored.totalTokens, 12, '历史 token 同一行一起恢复');

  // 上一个 session 早过期了，这里必然要新建 —— 但今日预算 1/1 已经用掉，重启不该退还。
  const over = await restoredVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error?.type, 'key_daily_limit_exceeded');
  assert.equal(postCalls, postsBeforeRestart, '预算已用尽时不得再发 session POST');

  // 洛杉矶翻页后预算重新给，累计继续往上加。
  restoredVm.setNow(Date.UTC(2030, 0, 2, 12));
  const nextDay = await restoredVm.api.executeChat(
    terminalEnv(token), terminalChatParams, terminalModel, false, 'chat', null, client,
  );
  assert.equal(nextDay.status, 200);
  const after = restoredVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(after.dayCount, 1, '新的一天今日会话从这次新建开始算');
  assert.equal(after.total, 2, '累计会话接着昨天往上加');
});

test('跨洛杉矶午夜重启且上游 session 仍存活时，不重复占用新日会话预算', async () => {
  const beforeMidnight = Date.UTC(2030, 0, 2, 7, 30); // LA 01/01 23:30
  const afterMidnight = beforeMidnight + 2 * 3600 * 1000; // LA 01/02 01:30
  const token = 'client-session-midnight-account-123456';
  const model = terminalModel.session;
  const client = { key: 'fbk-session-midnight', name: '跨午夜', concurrency: 1, models: [], dailyLimit: 1, owner: false };
  const instanceId = 'midnight-live-session';
  const expiresAt = new Date(afterMidnight + 2 * 3600 * 1000).toISOString();
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = String(init.method || 'GET').toUpperCase();
    if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
    if (path === '/api/v1/freebuff/session' && method === 'POST') {
      return upstreamResponse(200, { status: 'active', instanceId, model, expiresAt });
    }
    return upstreamResponse(200, {});
  };

  const firstVm = createWorkerVm({ now: beforeMidnight, fetchImpl });
  await firstVm.api.createSession(token, model, false, client);
  const snapshot = JSON.parse(JSON.stringify(firstVm.api.usageSnapshot()));
  const restoredVm = createWorkerVm({ now: afterMidnight, fetchImpl });
  restoredVm.api.restoreUsageSnapshot(snapshot);

  await restoredVm.api.createSession(token, model, false, client);
  const stats = restoredVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.total, 1, '同一仍存活 session 跨日不应重复累计');
  assert.equal(stats.dayCount, 0, '同一仍存活 session 不应占用新日会话额度');
});

test('queued session 在变为 active 前不计入会话，active 后同一 instance 只计一次', async () => {
  const start = Date.UTC(2030, 0, 1, 12);
  const token = 'queued-session-budget-account-123456';
  const model = terminalModel.session;
  const client = {
    key: 'fbk-queued-session-budget', name: '排队会话预算', concurrency: 2,
    models: [], dailyLimit: 1, owner: false,
  };
  let postCalls = 0;
  let phase = 'queued';
  let firstGet = true;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') {
        if (firstGet) {
          firstGet = false;
          return upstreamResponse(404, {});
        }
        if (phase === 'queued') return upstreamResponse(200, { status: 'queued', instanceId: 'queued-budget-instance', model });
        return upstreamResponse(200, {
          status: 'active', instanceId: 'queued-budget-instance', model,
          expiresAt: new Date(start + 3600_000).toISOString(),
        });
      }
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        postCalls += 1;
        return upstreamResponse(200, { status: 'queued', instanceId: 'queued-budget-instance', model });
      }
      return upstreamResponse(200, {});
    },
  });

  const firstAttempt = workerVm.api.createSession(token, model, false, client);
  await assert.rejects(
    firstAttempt,
    /session stayed queued|waiting room/i,
  );
  let stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats?.dayCount || 0, 0, 'queued 尚未 active 时不得占用今日会话额度');
  assert.equal(stats?.total || 0, 0, 'queued 尚未 active 时不得增加累计会话');

  phase = 'active';
  const active = await workerVm.api.createSession(token, model, false, client);
  assert.equal(active.instanceId, 'queued-budget-instance');
  stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.dayCount, 1, 'queued→active 只在 active 时计一次');
  assert.equal(stats.total, 1, '同一 queued instance active 后累计只加一次');
  assert.equal(postCalls, 1, '排队结束后应由 GET 接管同一 session，不再重复 POST');
});

test('流式空 DONE 不应成功收尾，应重建同账号 session 后再记最终输出', async () => {
  const token = 'empty-stream-recovery-account-123456';
  const client = {
    key: 'fbk-empty-stream-recovery', name: '空流恢复', concurrency: 2,
    models: [], dailyLimit: 20, owner: false,
  };
  let sessionPosts = 0;
  let sessionDeletes = 0;
  let chatCalls = 0;
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
      if (path === '/api/v1/freebuff/session' && method === 'DELETE') {
        sessionDeletes += 1;
        return upstreamResponse(204, '');
      }
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        sessionPosts += 1;
        return upstreamResponse(200, {
          status: 'active',
          instanceId: `empty-stream-session-${sessionPosts}`,
          model: terminalModel.session,
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `empty-stream-run-${sessionPosts}` });
      if (path.includes('/api/v1/agent-runs/')) return upstreamResponse(200, {});
      if (path === '/api/v1/chat/completions') {
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        const chunk = {
          choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return upstreamResponse(200, {});
    },
  });

  const response = await workerVm.api.executeChat(
    terminalEnv(token),
    { ...terminalChatParams, stream: true },
    terminalModel,
    true,
    'chat',
    null,
    client,
  );
  const body = await response.text();
  const usage = workerVm.worker.getCallLog();

  assert.equal(response.status, 200);
  assert.match(body, /recovered/, '空流后应返回重建 session 的有效内容');
  assert.equal(chatCalls, 2, '空流后应在同一账号重试一次 chat');
  assert.equal(sessionPosts, 2, '空流后应重建同账号 session');
  assert.equal(sessionDeletes, 1, '重建前应删除空流对应的旧 session');
  assert.equal(usage.total.success, 1, '只记录最终有输出的一次成功请求');
  assert.equal(usage.total.fail, 0, '已在同账号恢复的空流不应额外记录失败终态');
  assert.equal(usage.calls.length, 1, '空流不得写入成功调用日志');
  assert.ok(usage.calls[0].out > 0, '成功调用日志必须包含有效输出 token');
});

test('code review 成功入口把上游 usage 归到分享 Key', async () => {
  const token = 'reviewer-token-stats-account-123456';
  const client = { key: 'fbk-reviewer-token-stats', name: '审计统计', concurrency: 1, models: [], dailyLimit: 0, owner: false };
  const baseFetch = terminalFetch();
  const workerVm = createWorkerVm({
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/chat/completions') {
        const chunk = {
          choices: [{ delta: { content: 'reviewed' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        };
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return baseFetch(url, init);
    },
  });
  const response = await workerVm.api.executeChat(
    terminalEnv(token),
    { ...terminalChatParams, metadata: { freebuff_mode: 'code_review' } },
    { ...terminalModel, root_agent: terminalModel.agent, reviewer_agent: 'code-reviewer' },
    false,
    'chat',
    null,
    client,
  );

  assert.equal(response.status, 200);
  const stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.totalTokens, 11, 'code review 成功也必须累计上游 usage');
});

test('Key 新 session POST 失败不消耗每日会话预算，singleFlight 并发只计一次', async () => {
  const start = Date.UTC(2030, 0, 1);
  const token = 'client-session-budget-retry-account-123456';
  const model = terminalModel.session;
  const client = { key: 'fbk-session-retry', name: '重试预算', concurrency: 4, models: [], dailyLimit: 1, owner: false };
  let postCalls = 0;
  let fail = true;
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET') return upstreamResponse(404, {});
      if (path === '/api/v1/freebuff/session' && method === 'POST') {
        postCalls += 1;
        if (fail) return upstreamResponse(500, { error: 'temporary create failure' });
        return upstreamResponse(200, {
          status: 'active', instanceId: 'retry-budget-session', model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await assert.rejects(workerVm.api.createSession(token, model, false, client), /create session failed: 500/);
  let stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats?.dayCount || 0, 0, '失败的 session 创建不应消耗今日会话预算');
  assert.equal(stats?.total || 0, 0, '失败的 session 创建不应增加累计会话数');

  fail = false;
  const [first, second] = await Promise.all([
    workerVm.api.createSession(token, model, false, client),
    workerVm.api.createSession(token, model, false, client),
  ]);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(postCalls, 2, '失败后重试一次，成功并发调用仍只发一个 POST');
  stats = workerVm.api.clientStatsSnapshot().find((s) => s.name === client.name);
  assert.equal(stats.dayCount, 1);
  assert.equal(stats.total, 1);
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

test('受限 Key 已有 active session 的账号忙时，应立即选择空闲无 session 账号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'limited-busy-active-account-a-123456';
  const tokenB = 'limited-busy-active-account-b-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB}`);
  const client = {
    key: 'fbk-limited-busy-fallback', name: '忙账号回落', concurrency: 3,
    models: [], dailyLimit: 20, owner: false,
  };
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const auth = String(init.headers?.Authorization || '');
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && method === 'GET' && auth.endsWith(tokenA)) {
        return upstreamResponse(200, {
          status: 'active', instanceId: 'limited-busy-active-A', model,
          expiresAt: new Date(start + 3600_000).toISOString(),
        });
      }
      return upstreamResponse(404, {});
    },
  });
  await workerVm.api.createSession(tokenA, model, false, client);
  const leased = workerVm.api.pickToken(env, model, new Set());
  assert.equal(leased?.token, tokenA);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('test timeout')), 80);
  let selected = null;
  try {
    selected = await workerVm.api.pickTokenWithSessionWait(
      env, model, new Set(), controller.signal, 10, client,
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(selected?.token, tokenB,
    'A 的 active session 被占用时，B 空闲且无 session，不应等待 A 到期');
  workerVm.api.releaseToken(tokenA);
  workerVm.api.releaseToken(tokenB);
});

test('受限 Key 等待任意 active session，先释放的账号立即接管请求', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'limited-any-active-account-a-123456';
  const tokenB = 'limited-any-active-account-b-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB}`);
  const client = {
    key: 'fbk-limited-any-active', name: '受限 Key', concurrency: 3,
    models: [], dailyLimit: 20, owner: false,
  };
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session' && String(init.method || 'GET').toUpperCase() === 'GET') {
        const token = String(init.headers?.Authorization || '').slice('Bearer '.length);
        return upstreamResponse(200, {
          status: 'active',
          instanceId: token === tokenA ? 'limited-any-A' : 'limited-any-B',
          model,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
        });
      }
      return upstreamResponse(200, {});
    },
  });
  await workerVm.api.createSession(tokenA, model, false, client);
  await workerVm.api.createSession(tokenB, model, false, client);
  const leaseA = workerVm.api.pickToken(env, model, new Set());
  const leaseB = workerVm.api.pickToken(env, model, new Set());
  assert.equal(leaseA?.token, tokenA);
  assert.equal(leaseB?.token, tokenB);

  const controller = new AbortController();
  const waiting = workerVm.api.pickTokenWithSessionWait(
    env, model, new Set(), controller.signal, 10, client,
  );
  setTimeout(() => workerVm.api.releaseToken(tokenB), 10);
  const outcome = await Promise.race([
    waiting.then((selected) => selected?.token || null),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);
  if (outcome === 'timeout') {
    controller.abort(new Error('test cleanup'));
    await assert.rejects(waiting, /request aborted/);
  }
  workerVm.api.releaseToken(tokenA);
  workerVm.api.releaseToken(tokenB);
  assert.equal(outcome, tokenB, '不应只等待 A；B 先释放就应立即复用 B 的 active session');
});

test('session 失效后一次租约释放会唤醒全部受限 Key 等待者重新选号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'limited-broadcast-account-a-123456';
  const tokenB = 'limited-broadcast-account-b-123456';
  const tokenC = 'limited-broadcast-account-c-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB},${tokenC}`);
  const client = {
    key: 'fbk-limited-broadcast', name: '广播唤醒 Key', concurrency: 3,
    models: [], dailyLimit: 20, owner: false,
  };
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session') return upstreamResponse(200, {
        status: 'active', instanceId: 'limited-broadcast-A', model,
        expiresAt: new Date(start + 3600_000).toISOString(),
      });
      return upstreamResponse(200, {});
    },
  });
  await workerVm.api.createSession(tokenA, model, false, client);
  const leased = workerVm.api.pickToken(env, model, new Set());
  assert.equal(leased?.token, tokenA);

  const first = workerVm.api.pickTokenWithSessionWait(env, model, new Set(), null, 10, client);
  const second = workerVm.api.pickTokenWithSessionWait(env, model, new Set(), null, 10, client);
  await new Promise((resolve) => setTimeout(resolve, 10));
  workerVm.api.invalidateSessionCache(tokenA);
  workerVm.api.releaseToken(tokenA);

  const selected = await Promise.race([
    Promise.all([first, second]),
    new Promise((resolve) => setTimeout(() => resolve(null), 80)),
  ]);
  assert.ok(selected, '全部等待者都应被同一次状态变化唤醒');
  assert.equal(new Set(selected.map((item) => item?.token)).size, 2);
  for (const item of selected) workerVm.api.releaseToken(item?.token);
});

test('同一账号释放租约会广播全部等待者，而不是只唤醒队首一个', async () => {
  const token = 'limited-release-broadcast-account-123456';
  const workerVm = createWorkerVm();
  const leased = workerVm.api.pickToken(terminalEnv(token), terminalModel.session, new Set());
  assert.equal(leased?.token, token);
  const first = workerVm.api.waitForAnyTokenRelease([token], 1000);
  const second = workerVm.api.waitForAnyTokenRelease([token], 1000);
  workerVm.api.releaseToken(token);
  const result = await Promise.race([
    Promise.all([first, second]).then(() => 'all'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 80)),
  ]);
  assert.equal(result, 'all');
});

test('等待期间其他忙账号新建同模型 session 后释放会立即被受限 Key 复用', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'limited-new-active-account-a-123456';
  const tokenB = 'limited-new-active-account-b-123456';
  const model = terminalModel.session;
  const env = terminalEnv(`${tokenA},${tokenB}`);
  const client = {
    key: 'fbk-limited-new-active', name: '新 active Key', concurrency: 3,
    models: [], dailyLimit: 20, owner: false,
  };
  const workerVm = createWorkerVm({
    now: start,
    fetchImpl: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const auth = String(init.headers?.Authorization || '');
      const slot = auth.endsWith(tokenA) ? 'A' : 'B';
      if (path.includes('/api/v1/ads') || path.includes('/api/v1/usage')) return upstreamResponse(200, {});
      if (path === '/api/v1/freebuff/session') return upstreamResponse(200, {
        status: 'active', instanceId: `limited-new-active-${slot}`, model,
        expiresAt: new Date(start + 3600_000).toISOString(),
      });
      return upstreamResponse(200, {});
    },
  });
  await workerVm.api.createSession(tokenA, model, false, client);
  const leaseA = workerVm.api.pickToken(env, model, new Set());
  const leaseB = workerVm.api.pickToken(env, model, new Set());
  assert.equal(leaseA?.token, tokenA);
  assert.equal(leaseB?.token, tokenB);

  const waiting = workerVm.api.pickTokenWithSessionWait(env, model, new Set(), null, 10, client);
  await workerVm.api.createSession(tokenB, model, false, client);
  workerVm.api.releaseToken(tokenB);
  const selected = await Promise.race([
    waiting,
    new Promise((resolve) => setTimeout(() => resolve(null), 80)),
  ]);
  assert.equal(selected?.token, tokenB, 'B 变为 active 并释放后应唤醒等待者');
  workerVm.api.releaseToken(tokenA);
  workerVm.api.releaseToken(tokenB);
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
