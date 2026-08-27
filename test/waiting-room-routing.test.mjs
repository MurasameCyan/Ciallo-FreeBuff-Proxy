// === 上游 waiting room 的选号与预算 ===
//
// 实测背景（2026-08-25 03:17 北京时间，Master Key 调 ds4p 收到 503）：
// createSession 拿到 queued 后轮询 8×1.5s 仍未 active 就抛 WaitingRoomError。排队不是
// 这个号的错，所以刻意不冷却、不摘号 —— 但 acctHealth 里的 waiting_room_required 也
// 没有失效时间，只能等下一次真实请求撞上才被覆盖。低流量时段那份旧观测一直挂着，
// 配合换号预算 2，轮询前两位撞上就必然 503（当时 healthz: alive_accounts=0）。
//
// 这里锁三件事：
//   1) 新鲜的排队观测在 pickToken 里降权到候选末尾，但不摘号（池子容量不变）；
//   2) 过期的排队观测自动回到正常轮询顺序 —— 不能让旧状态永久压着一个号；
//   3) 因排队而换号走独立预算，不占 MAX_ACCOUNT_SWITCHES，否则整池排队就直接 503。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'Asia/Shanghai';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__waitingRoomTestApi__ = { pickToken, releaseToken, executeChat, '
  + 'recentlyWaitingRoom, maxWaitingRoomSwitches, waitingRoomDeprioritizeMs, '
  + 'retryChainBudgetMs, recordAccountObservation, acctHealth };\n';

// 主体必须是未被官方 paused 的模型：paused 闸门在排队/换号逻辑之前就返回。
const MODEL = 'deepseek/deepseek-v4-flash';

function createWorkerVm({ now, fetchImpl } = {}) {
  let clock = now ?? Date.UTC(2030, 0, 1);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let uuid = 0;
  const sandbox = {
    console, TextEncoder, TextDecoder, Set, Map, Date: FakeDate,
    Math, Number, String, JSON, Uint8Array, Object, URL, setTimeout, clearTimeout,
    AbortController, ReadableStream, TransformStream, Response, Request, Headers,
    fetch: async (url, init = {}) => {
      if (fetchImpl) return fetchImpl(url, init);
      throw new Error('unexpected upstream request');
    },
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => `waiting-room-uuid-${++uuid}` },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return {
    worker: sandbox.__workerDefault__,
    api: sandbox.__waitingRoomTestApi__,
    setNow(value) { clock = value; },
  };
}

function upstreamResponse(status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return { status, ok: status >= 200 && status < 300, headers, text: async () => body };
}

function envFor(tokens, extra = {}) {
  return { FREEBUFF_TOKEN: tokens.join(','), FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {}, ...extra };
}

function modelCfg(id, agent) {
  return { id, session: id, upstream: id, agent };
}

function chatParams(id) {
  return { model: id, messages: [{ role: 'user', content: 'waiting room test' }], stream: true };
}

// `queuedTokens` 里的号在 POST /session 上返回 428 waiting_room_required。
// 用 typed 状态而不是 200 + status:"queued"：后者要轮询 8×1.5s 真等 12 秒，
// 测试里没必要 —— 两条路最终都抛同一个 WaitingRoomError，外层处置完全一致。
function createQueueingUpstream({ start, queuedTokens = new Set(), log }) {
  let created = 0;
  const createdOrder = [];
  const tokenOf = (init) => String(init.headers?.Authorization || '').replace(/^Bearer\s+/, '');
  return {
    get created() { return created; },
    get createdOrder() { return createdOrder; },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const token = tokenOf(init);
      log?.push({ token, method, path });
      if (path === '/api/v1/ads' || path.includes('/impression') || path.includes('/api/v1/usage')) {
        return upstreamResponse(200, {});
      }
      if (path === '/api/v1/freebuff/session') {
        if (method === 'DELETE') return upstreamResponse(200, { status: 'none' });
        if (method === 'GET') return upstreamResponse(200, { status: 'none', accessTier: 'full' });
        if (queuedTokens.has(token)) {
          return upstreamResponse(428, { status: 'waiting_room_required', accessTier: 'full' });
        }
        created += 1;
        createdOrder.push(token);
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full',
          instanceId: init.headers?.['x-freebuff-instance-id'] || `inst-${created}`,
          model: init.headers?.['x-freebuff-model'] || null,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
          remainingMs: 3600 * 1000,
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `run-${token.slice(-4)}` });
      if (path === '/api/v1/chat/completions') {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return upstreamResponse(200, {});
    },
  };
}

// 8 个号：默认排队预算 2+4=6 时，「预算封顶」与「不许试完整池」两个不变量才有区分度。
const POOL = Array.from({ length: 8 }, (_, i) => `waiting-room-token-${String(i).padStart(18, 'w')}`);

test('排队号不占换号预算：前 3 个号排队，第 4 个号仍能成功', async () => {
  const start = Date.UTC(2030, 0, 1);
  const log = [];
  // 轮询会从 POOL[0] 开始，前 3 个都在队列里。旧行为：换号预算 2 用完就 503。
  const queued = new Set([POOL[0], POOL[1], POOL[2]]);
  const upstream = createQueueingUpstream({ start, queuedTokens: queued, log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(POOL, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '0' });

  const response = await workerVm.api.executeChat(
    env, chatParams(MODEL), modelCfg(MODEL, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 200,
    '排队走独立预算（2 换号 + 2 排队），前 3 个号排队后仍应找到可用号');
  assert.equal(upstream.created, 1, '只有真正拿到会话的那个号建了会话');
  assert.ok(!queued.has(upstream.createdOrder[0]), '成功的号不能是排队中的号');
});

test('排队预算也有上限：整池排队时不会退化成全池轮询', async () => {
  const start = Date.UTC(2030, 0, 1);
  const log = [];
  const upstream = createQueueingUpstream({ start, queuedTokens: new Set(POOL), log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(POOL, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '0' });

  const response = await workerVm.api.executeChat(
    env, chatParams(MODEL), modelCfg(MODEL, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 503, '整池排队最终仍应返回 waiting_room 503');
  const body = JSON.parse(await response.text());
  assert.equal(body.error.type, 'waiting_room');
  // 关键：不能因为「排队不计预算」就把上周堵住的全池轮询放大器又放开。
  // 默认排队预算 4（2026-08-26 从 2 上调）：最多碰 2 换号 + 4 排队 = 6 个号。
  const posts = log.filter((e) => e.path === '/api/v1/freebuff/session' && e.method === 'POST');
  assert.ok(posts.length <= 6,
    `排队换号有独立上限，最多碰 2+4 个号，实际 POST /session ${posts.length} 次`);
  assert.ok(posts.length < POOL.length, '不许试完整个 6 号池子');
});

test('新鲜的排队观测把号降权到候选末尾，但不摘号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(POOL);
  const { api } = workerVm;

  // 把 POOL[0] 标成刚刚排队过（428 waiting_room_required）。
  api.recordAccountObservation(POOL[0], 428, { status: 'waiting_room_required' }, { model: MODEL });
  assert.equal(api.recentlyWaitingRoom(POOL[0], env, start), true);

  // 连着选 6 次（每次选完释放），排队号不该出现在第一位。
  const picked = [];
  for (let i = 0; i < POOL.length; i++) {
    const acct = api.pickToken(env, MODEL, new Set(picked), null);
    assert.ok(acct, '降权不等于摘号：池子容量不变，6 个号都还能被选到');
    picked.push(acct.token);
    api.releaseToken(acct.token);
  }
  assert.equal(picked.length, POOL.length, '所有号最终都可选（只是顺序靠后）');
  assert.equal(picked[picked.length - 1], POOL[0], '排队号应排到候选末尾');
});

test('过期的排队观测自动失效，不再压着这个号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(POOL);
  const { api } = workerVm;

  api.recordAccountObservation(POOL[0], 428, { status: 'waiting_room_required' }, { model: MODEL });
  assert.equal(api.recentlyWaitingRoom(POOL[0], env, start), true);

  // 默认窗口 60s：超过就视同未知，回到正常轮询。这正是线上那份几小时前的
  // 旧状态一直挂着、把号永久压在末尾的病根。
  const windowMs = api.waitingRoomDeprioritizeMs(env);
  assert.equal(windowMs, 60 * 1000);
  assert.equal(api.recentlyWaitingRoom(POOL[0], env, start + windowMs + 1), false,
    '窗口外的旧观测必须失效');
});

test('两个环境变量都不会被空串静默关掉（Number("") 陷阱）', async () => {
  const workerVm = createWorkerVm({ now: Date.UTC(2030, 0, 1) });
  const { api } = workerVm;
  // docker-compose 里写 `FREEBUFF_MAX_WAITING_ROOM_SWITCHES=` 传进来是空串。
  // 默认 4（2026-08-26：排队是模型后端级波次，多试几个空闲号常能捡到没被排队的）。
  assert.equal(api.maxWaitingRoomSwitches({ FREEBUFF_MAX_WAITING_ROOM_SWITCHES: '' }), 4);
  assert.equal(api.maxWaitingRoomSwitches({}), 4);
  assert.equal(api.waitingRoomDeprioritizeMs({ FREEBUFF_WAITING_ROOM_DEPRIORITIZE_MS: '' }), 60 * 1000);
  // 显式 0 是合法的关闭意图，必须被尊重。
  assert.equal(api.maxWaitingRoomSwitches({ FREEBUFF_MAX_WAITING_ROOM_SWITCHES: '0' }), 0);
  assert.equal(api.waitingRoomDeprioritizeMs({ FREEBUFF_WAITING_ROOM_DEPRIORITIZE_MS: '0' }), 0);
  // 显式覆盖生效。
  assert.equal(api.maxWaitingRoomSwitches({ FREEBUFF_MAX_WAITING_ROOM_SWITCHES: '5' }), 5);
  assert.equal(api.waitingRoomDeprioritizeMs({ FREEBUFF_WAITING_ROOM_DEPRIORITIZE_MS: '90000' }), 90000);
});

// 实测背景（2026-08-25 20:38 北京时间）：整池排队时重试链烧了 74.7s 颗粒无收，
// 客户端首字超时约 75s —— 差 1s 被 499 掐断，错误和 Retry-After 都没送到。
// 预算到顶就停手，让循环后的兜底分支回 503 waiting_room。
test('重试链时间预算到顶就停手，不再起新号的尝试', async () => {
  const start = Date.UTC(2030, 0, 1);
  const log = [];
  const upstream = createQueueingUpstream({ start, queuedTokens: new Set(POOL), log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  // 沙箱时钟钉死 → 预算判定里的 Date.now() 不走。用预算 0（「第一个号之后立即停手」）
  // 确定性等价于「时间到顶」：同一个 break 分支，不依赖时钟推进。
  const env = envFor(POOL, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '0', FREEBUFF_RETRY_CHAIN_BUDGET_MS: '0' });

  const response = await workerVm.api.executeChat(
    env, chatParams(MODEL), modelCfg(MODEL, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 503, '预算耗尽后仍应回 waiting_room 503（兜底分支）');
  const body = JSON.parse(await response.text());
  assert.equal(body.error.type, 'waiting_room');
  const posts = log.filter((e) => e.path === '/api/v1/freebuff/session' && e.method === 'POST');
  assert.equal(posts.length, 1, `预算 0 = 只试第一个号，实际 POST /session ${posts.length} 次`);
  assert.ok(posts.length < POOL.length);
});

test('预算 0 也不拦第一个号：单号可用时请求照常成功', async () => {
  const start = Date.UTC(2030, 0, 1);
  const upstream = createQueueingUpstream({ start, queuedTokens: new Set() });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(POOL, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '0', FREEBUFF_RETRY_CHAIN_BUDGET_MS: '0' });

  const response = await workerVm.api.executeChat(
    env, chatParams(MODEL), modelCfg(MODEL, 'base2-free-deepseek'), false, 'chat',
  );
  assert.equal(response.status, 200, '预算只拦换号链，不拦首个尝试');
  assert.equal(upstream.created, 1);
});

test('retryChainBudgetMs 的空串陷阱与显式覆盖', async () => {
  const workerVm = createWorkerVm({ now: Date.UTC(2030, 0, 1) });
  const { api } = workerVm;
  assert.equal(api.retryChainBudgetMs({ FREEBUFF_RETRY_CHAIN_BUDGET_MS: '' }), 45 * 1000,
    '空串必须当「没设」处理，不能静默变成 0');
  assert.equal(api.retryChainBudgetMs({}), 45 * 1000);
  assert.equal(api.retryChainBudgetMs({ FREEBUFF_RETRY_CHAIN_BUDGET_MS: '0' }), 0,
    '显式 0 = 只试第一个号，是合法意图');
  assert.equal(api.retryChainBudgetMs({ FREEBUFF_RETRY_CHAIN_BUDGET_MS: '30000' }), 30000);
  assert.equal(api.retryChainBudgetMs({ FREEBUFF_RETRY_CHAIN_BUDGET_MS: 'abc' }), 45 * 1000,
    '非数字同样当「没设」');
});
