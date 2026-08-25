// 复现「调用 A 模型后立刻换 B 模型开新会话就卡住」的链路。
//
// 上游硬约束（官方 common/src/types/freebuff-session.ts）：CLI/web 通道
// **一个账号同时只能有一个会话**，且会话绑死一个模型；带着别的模型 POST /session
// 会拿到 `model_locked`（携带 currentModel / requestedModel），正确处置是
// DELETE 掉旧会话再 POST。`premium_slot_taken` 的注释明说多会话只给 Desktop，
// "Never returned to CLI/web, which run one session per user."
//
// 所以「两个模型并行」只能靠**两个账号**，不可能在同一个账号上做到。这组测试
// 锁定的就是这件事：换模型时必须优先挑没有会话冲突的空闲账号，而不是把当前
// 账号的会话删了重建（那会白烧 premium admission 额度），更不该在 model_locked
// 上退化成「全池 60s 冷却 + 慢速轮询」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 解锁时间点按进程时区渲染（部署固定 Asia/Shanghai：镜像 ENV + server.js 默认）。
// 这里也钉住，断言才不会随跑测试的机器时区飘。
process.env.TZ = 'Asia/Shanghai';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n'
  + 'globalThis.__accountSafetyTestApi__ = { pickToken, pickTokenWithSessionWait, '
  + 'releaseToken, invalidateSessionCache, createSession, executeChat, scopedCooldownInfo, '
  + 'accountPoolExhaustion, sessCache, clientModelLock };\n';

const DS4P = 'deepseek/deepseek-v4-pro';
const LUNA = 'openai/gpt-5.6-luna';

function createWorkerVm({ now, fetchImpl, consoleImpl = console, random = null } = {}) {
  let clock = now ?? Date.UTC(2030, 0, 1);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const upstreamCalls = [];
  let uuid = 0;
  const fakeFetch = async (url, init = {}) => {
    upstreamCalls.push({ url: String(url), init });
    if (fetchImpl) return fetchImpl(url, init);
    throw new Error('unexpected upstream request');
  };
  const sandbox = {
    console: consoleImpl, TextEncoder, TextDecoder, Set, Map, Date: FakeDate,
    // random 可注入：up() 每次出站都调 jitterMs()（100-400ms 随机），一条链上好几次，
    // 墙钟差值天然带 ±600ms 噪声。要断言「这段等待来自换号抖动」就得把无关的随机
    // 源钉死，否则阈值只能靠猜（CI 上实测抖出过 4226ms vs 3626ms）。
    Math: random ? Object.assign(Object.create(Math), { random }) : Math,
    Number, String, JSON, Uint8Array, Object, URL, setTimeout, clearTimeout,
    AbortController, ReadableStream, TransformStream, Response, Request, Headers,
    fetch: fakeFetch,
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => `switch-test-uuid-${++uuid}` },
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
// 忠实模拟 CLI 通道：每个账号最多一个会话，会话绑死一个模型。
// 带别的模型 POST → model_locked（HTTP 200，与官方联合体一致）；DELETE 才释放槽位。
function createFakeUpstream({ start, sessions = {}, log, lockStatus = 200 }) {
  const state = new Map(Object.entries(sessions));
  let created = 0;
  const tokenOf = (init) => String(init.headers?.Authorization || '').replace(/^Bearer\s+/, '');
  const active = (token, model) => ({
    status: 'active',
    accessTier: 'full',
    instanceId: state.get(token).instanceId,
    model,
    expiresAt: new Date(start + 3600 * 1000).toISOString(),
    remainingMs: 3600 * 1000,
  });
  return {
    state,
    get created() { return created; },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const token = tokenOf(init);
      const model = init.headers?.['x-freebuff-model'] || null;
      log?.push({ token, method, path, model });
      if (path === '/api/v1/ads' || path.includes('/impression') || path.includes('/api/v1/usage')) {
        return upstreamResponse(200, {});
      }
      if (path === '/api/v1/freebuff/session') {
        const cur = state.get(token) || null;
        if (method === 'GET') {
          return cur ? upstreamResponse(200, active(token, cur.model)) : upstreamResponse(200, { status: 'none', accessTier: 'full' });
        }
        if (method === 'DELETE') { state.delete(token); return upstreamResponse(200, { status: 'none' }); }
        if (method === 'POST') {
          if (cur && cur.model !== model) {
            return upstreamResponse(lockStatus, {
              status: 'model_locked', accessTier: 'full',
              currentModel: cur.model, requestedModel: model,
            });
          }
          created += 1;
          state.set(token, { instanceId: init.headers?.['x-freebuff-instance-id'] || `inst-${created}`, model });
          return upstreamResponse(200, active(token, model));
        }
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
  return { model: id, messages: [{ role: 'user', content: 'switch test' }], stream: true };
}

// 分享 Key 与 Master Key。concurrency 给 4：这组测试要连着发好几个请求，
// 用默认 1 会被流式槽位的异步释放搞成偶发 429，测不到模型锁本身。
function sharedKey(name) {
  return { key: `fbk-${name}`, fingerprint: '', name, concurrency: 4, models: [], dailyLimit: 0, owner: false };
}
const MASTER = { key: 'fbk-master-key', name: 'Master Key', concurrency: 0, models: [], dailyLimit: 0, owner: true };
// === 单请求内换号预算 + 换号抖动 ===
//
// 为什么要有这组测试（实测 2026-08-24）：
// 旧上界是 pool.length，一条失败请求能连着换 18 个号，每换一个号都要 createSession
// —— 那是真扣 admission 的动作。当天 07:02Z / 08:45:59Z / 08:46:10Z 三笔封禁里，
// 后两笔相隔 11 秒，正是这个循环在跑。上游把「秒级跨账号会话爆发」判成滥用，一次封一串。
//
// 这里锁三件事：
//   1) 单请求内最多换 MAX_ACCOUNT_SWITCHES(=2) 个号，即使池子远大于它；
//   2) 换号之间有随机间隔（抹掉时间特征），但第一个号不等；
//   3) 同号原地重试（retakeToken）不占换号预算、不等抖动 —— 它复用已有会话，不烧 admission。

// 每次 chat 都 500：强制外层一路换号，用来数「到底建了几个会话」。
function createAlwaysFailingUpstream({ start, log }) {
  const state = new Map();
  let created = 0;
  const createdAt = [];
  const tokenOf = (init) => String(init.headers?.Authorization || '').replace(/^Bearer\s+/, '');
  return {
    get created() { return created; },
    get createdAt() { return createdAt; },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method || 'GET').toUpperCase();
      const token = tokenOf(init);
      log?.push({ token, method, path, at: Date.now() });
      if (path === '/api/v1/ads' || path.includes('/impression') || path.includes('/api/v1/usage')) {
        return upstreamResponse(200, {});
      }
      if (path === '/api/v1/freebuff/session') {
        if (method === 'DELETE') { state.delete(token); return upstreamResponse(200, { status: 'none' }); }
        if (method === 'GET') return upstreamResponse(200, { status: 'none', accessTier: 'full' });
        created += 1;
        createdAt.push({ token, at: Date.now() });
        state.set(token, { instanceId: `inst-${created}` });
        return upstreamResponse(200, {
          status: 'active', accessTier: 'full',
          instanceId: init.headers?.['x-freebuff-instance-id'] || `inst-${created}`,
          model: init.headers?.['x-freebuff-model'] || null,
          expiresAt: new Date(start + 3600 * 1000).toISOString(),
          remainingMs: 3600 * 1000,
        });
      }
      if (path === '/api/v1/agent-runs') return upstreamResponse(200, { runId: `run-${token.slice(-4)}` });
      // chat 永远 500：不是 400、不是 free_mode gate，所以会走「换号继续」那条路径。
      if (path === '/api/v1/chat/completions') return upstreamResponse(500, { error: 'upstream boom' });
      return upstreamResponse(200, {});
    },
  };
}

const POOL8 = Array.from({ length: 8 }, (_, i) => `switch-budget-token-${String(i).padStart(18, 'x')}`);

test('单请求内换号有上限：8 个号的池子最多只建 2 个会话', async () => {
  const start = Date.UTC(2030, 0, 1);
  const log = [];
  const upstream = createAlwaysFailingUpstream({ start, log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(POOL8);

  const response = await workerVm.api.executeChat(
    env, chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 502, 'chat 一直 500，最终应该把失败回给客户端');
  assert.equal(upstream.created, 2,
    '换号预算是 2：池子有 8 个号也只许建 2 个会话（每个会话 = 一次 admission）');
  const touched = new Set(log.filter((e) => e.path === '/api/v1/freebuff/session' && e.method === 'POST')
    .map((e) => e.token));
  assert.equal(touched.size, 2, '只应碰到 2 个不同账号，其余 6 个不许被牵连');
});

test('换号预算可配，且不会超过池子大小', async () => {
  const start = Date.UTC(2030, 0, 1);
  const upstream = createAlwaysFailingUpstream({ start });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  // 只有 1 个号时，预算 2 也只能试 1 次 —— Math.min(budget, pool.length)。
  const env = envFor([POOL8[0]], { FREEBUFF_MAX_ACCOUNT_SWITCHES: '2' });

  const response = await workerVm.api.executeChat(
    env, chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), false, 'chat',
  );

  // 池子只有 1 个号，它失败后被冷却 => 整池不可用，poolExhaustionResponse 走 503。
  // 这里要的是「预算不会超过池子大小」，用 created 数断言，状态码按真实行为记 503。
  assert.equal(response.status, 503);
  assert.equal(upstream.created, 1, '池子只有 1 个号，预算再大也只能建 1 个会话');
});

test('空的 FREEBUFF_MAX_ACCOUNT_SWITCHES 不会静默变成 0（Number("") 陷阱）', async () => {
  const start = Date.UTC(2030, 0, 1);
  const upstream = createAlwaysFailingUpstream({ start });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  // docker-compose 里写 `FREEBUFF_MAX_ACCOUNT_SWITCHES=` 会传进来空串。
  // 若按 Number("")===0 处理，会变成一个号都不许试，请求必然失败。
  const env = envFor(POOL8, { FREEBUFF_MAX_ACCOUNT_SWITCHES: '' });

  const response = await workerVm.api.executeChat(
    env, chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 502);
  assert.equal(upstream.created, 2, '空串应回落到默认值 2，而不是 0');
});

test('换号之间有间隔：第一个号不等，之后每次换号前等一段', async () => {
  const start = Date.UTC(2030, 0, 1);
  const upstream = createAlwaysFailingUpstream({ start });
  // 两侧用同一个固定 random：up() 里的出站抖动（jitterMs 100-400ms）在两次运行中
  // 完全一致，差值里就只剩换号抖动本身。
  const fixedRandom = () => 0.5;
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch, random: fixedRandom });
  // 抖动钉成固定 1200ms，断言才不靠墙钟猜。真实运行是 800-2500ms 随机。
  const env = envFor(POOL8, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '1200' });

  const response = await workerVm.api.executeChat(
    env, chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), false, 'chat',
  );

  assert.equal(response.status, 502);
  assert.equal(upstream.created, 2, '预算 2：只建 2 个会话');

  // 只量「两次建会话之间」的间隔，且只取下界。两次之间除了换号抖动，还夹着
  // run/chat 各自的出站抖动（up() 里的 jitterMs 100-400ms）和 CHAIN_GAP_MS，
  // 所以墙钟上界不是可靠口径 —— 用「拿掉抖动会明显变短」来证明它生效。
  const gap = upstream.createdAt[1].at - upstream.createdAt[0].at;
  assert.ok(gap >= 1200,
    `换号前应至少等一段固定抖动 1200ms，实际两次建会话只隔了 ${gap}ms`);

  // 对照组：抖动设 0，同样的链路间隔必须明显更短。这才真正锁住「那段等待
  // 来自换号抖动」，而不是来自别处本来就有的延迟。
  const bare = createAlwaysFailingUpstream({ start });
  const bareVm = createWorkerVm({ now: start, fetchImpl: bare.fetch, random: fixedRandom });
  const bareResp = await bareVm.api.executeChat(
    envFor(POOL8, { FREEBUFF_ACCOUNT_SWITCH_JITTER_MS: '0' }),
    chatParams(DS4P), modelCfg(DS4P, 'base2-free-deepseek'), false, 'chat',
  );
  assert.equal(bareResp.status, 502);
  assert.equal(bare.created, 2);
  const bareGap = bare.createdAt[1].at - bare.createdAt[0].at;
  assert.ok(gap - bareGap >= 900,
    `换号抖动应让间隔多出约 1200ms（有抖动 ${gap}ms vs 无抖动 ${bareGap}ms）`);
});
