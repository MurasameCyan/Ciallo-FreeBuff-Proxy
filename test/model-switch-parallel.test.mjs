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
  + 'releaseToken, acquireToken, tokenBusy, invalidateSessionCache, createSession, executeChat, '
  + 'scopedCooldownInfo, accountPoolExhaustion, sessCache, clientModelLock, clientStat, '
  + 'clientSessionIdentity };\n';

// 这组测的是「同一 Key 在会话期内换模型」，需要两个互不相同且都未被官方 paused
// 的模型。D4P 已撤下（paused 闸门会在换模型逻辑之前就返回），改用 DS4F。
const DS4F = 'deepseek/deepseek-v4-flash';
const LUNA = 'openai/gpt-5.6-luna';

function createWorkerVm({ now, fetchImpl, consoleImpl = console } = {}) {
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
    Math, Number, String, JSON, Uint8Array, Object, URL, setTimeout, clearTimeout,
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
test('同一账号换模型：只能删旧会话重建，会白烧一次 admission 额度', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'switch-single-account-token-aaaaaa';
  const log = [];
  const upstream = createFakeUpstream({
    start, log, sessions: { [tokenA]: { instanceId: 'inst-ds4f', model: DS4F } },
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA]);

  const response = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );

  assert.equal(response.status, 200, 'model_locked 前的 DELETE 生效后 luna 应该能开起来');
  assert.equal(upstream.state.get(tokenA)?.model, LUNA);
  assert.equal(log.filter((e) => e.method === 'DELETE').length, 1,
    '换模型必须删掉上游 ds4f 会话 —— 这就是「并行不可能」的上游硬约束');
  assert.equal(upstream.created, 1, '重建 luna 会话消耗一次 admission');
});

test('ds4f 调用完立刻换 luna：应落到另一个空闲账号，两个会话并行', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'switch-parallel-token-aaaaaaaaaaaa';
  const tokenB = 'switch-parallel-token-bbbbbbbbbbbb';
  const log = [];
  const upstream = createFakeUpstream({ start, log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA, tokenB]);

  // 1) 先跑一次 ds4f（用户的第一步），会在某个号上留下 ds4f 会话。
  const ds4f = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat',
  );
  assert.equal(ds4f.status, 200);
  await ds4f.text();
  const ds4pHost = [...upstream.state.entries()].find(([, s]) => s.model === DS4F)?.[0];
  assert.ok(ds4pHost, 'ds4f 会话应该建立在某个账号上');
  log.length = 0;

  // 2) 立刻要 luna（用户的第二步）。
  const luna = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );

  assert.equal(luna.status, 200, '有空闲账号时换模型不该失败');
  await luna.text();
  assert.deepEqual(log.filter((e) => e.method === 'DELETE').map((e) => e.token), [],
    '不得为了开 luna 删掉 ds4f 会话 —— 重建要再扣一份 premium admission');
  assert.equal(upstream.state.get(ds4pHost)?.model, DS4F, 'ds4f 会话必须原封不动地活着');
  const lunaHost = [...upstream.state.entries()].find(([, s]) => s.model === LUNA)?.[0];
  assert.ok(lunaHost && lunaHost !== ds4pHost, 'luna 必须落在另一个账号上，形成两个并行会话');
});
test('model_locked 在失效窗口内被跳过 DELETE 时，不得把全池冷却成「luna 完全不可用」', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['switch-lock-token-aaaaaaaaaaaaaaaa', 'switch-lock-token-bbbbbbbbbbbbbbbb'];
  const log = [];
  const upstream = createFakeUpstream({
    start, log,
    sessions: {
      [tokens[0]]: { instanceId: 'inst-a-ds4f', model: DS4F },
      [tokens[1]]: { instanceId: 'inst-b-ds4f', model: DS4F },
    },
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(tokens);
  // 真实触发条件：30s 内在同一个号上 luna → ds4f → luna 来回切。
  // deleteUpstreamSession 的失效窗口 key 用的是「要建的模型」而不是「被删的会话」，
  // 所以第二次要 luna 时 DELETE 会被当成重复调用直接跳过，POST 必然再 model_locked。
  for (const token of tokens) {
    await workerVm.api.createSession(token, LUNA).catch(() => {});
    await workerVm.api.createSession(token, DS4F).catch(() => {});
    workerVm.api.invalidateSessionCache(token); // 只清本地缓存，上游仍是 ds4f 会话
  }
  log.length = 0;

  const response = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );

  const cooled = tokens.filter((t) => workerVm.api.scopedCooldownInfo(t, LUNA));
  assert.equal(response.status, 200, 'model_locked 必须按契约「DELETE 再 POST」恢复，而不是耗尽全池');
  assert.deepEqual(cooled, [], `失效窗口内的 model_locked 不该把 ${cooled.length} 个账号冷却掉`);
});

// POST /session 的响应是 FreebuffSessionServerResponse 联合体，判别式是 body 的
// `status`；私有服务端把 model_locked 挂在 409 上也必须走同一条恢复路径，
// 不能被 session_model_mismatch 分支吞掉（那条会写 60s 按模型冷却）。
test('model_locked 挂在 HTTP 409 上时同样要 DELETE 再 POST，且不写冷却', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'switch-409-lock-token-aaaaaaaaaaaa';
  const log = [];
  const upstream = createFakeUpstream({
    start, log, lockStatus: 409,
    sessions: { [tokenA]: { instanceId: 'inst-409-ds4f', model: DS4F } },
  });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA]);
  // 让 A:DS4F 落进失效窗口，逼 GET 分支的 DELETE 走 force 之外的路径都失败。
  workerVm.api.sessCache.set(`${tokenA}:${DS4F}`, {
    instanceId: 'inst-409-ds4f', model: DS4F,
    expiresAt: new Date(start + 3600 * 1000).toISOString(),
  });

  const response = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat',
  );

  assert.equal(response.status, 200, '409 形态的 model_locked 也必须恢复成功');
  assert.equal(upstream.state.get(tokenA)?.model, LUNA);
  assert.equal(workerVm.api.scopedCooldownInfo(tokenA, LUNA), null,
    'model_locked 不是这个号的问题，不得写冷却');
});

// ---- 单 Key 会话期内锁模型（Master Key 不受限）----------------------------
// 上面四个用例说明「换模型」在上游一定是删会话重建，白扣一份 premium admission。
// 所以对分享出去的 Key 收口：会话还活着就只能用同一个模型，换模型给中文提示，
// 让用户自己决定是等会话到期还是用 Master Key。锁只对这把 Key 生效。

test('分享 Key 会话期内换模型：回中文 409 key_model_locked，且完全不碰上游', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'keylock-single-token-aaaaaaaaaaaa';
  const log = [];
  const upstream = createFakeUpstream({ start, log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA]);
  const keyA = sharedKey('lock-a');

  const first = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, keyA,
  );
  assert.equal(first.status, 200);
  await first.text();
  log.length = 0;

  const second = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat', null, keyA,
  );

  assert.equal(second.status, 409);
  const body = JSON.parse(await second.text());
  assert.equal(body.error.type, 'key_model_locked');
  assert.equal(body.error.currentModel, DS4F);
  assert.equal(body.error.requestedModel, LUNA);
  assert.match(body.error.message, /只能用这一个模型/, '提示必须是中文');
  assert.match(body.error.message, new RegExp(`· 锁定模型: ${DS4F}`), '要写明当前锁在哪个模型上');
  assert.match(body.error.message, new RegExp(`· 本次请求: ${LUNA}（已拒绝）`));
  assert.match(body.error.message, /· 解锁时间: 2030-01-01 09:00:00 \(UTC\+8\),还需 1 小时（3600s）/,
    '解锁时间点按 UTC\+8 写清楚，容器时区是 UTC，不能直接写本地时间');
  assert.match(body.error.message, /Master Key/, '要告诉用户 Master Key 不受限');
  assert.equal(body.error.retryAfterSec, 3600);
  assert.equal(body.error.unlockAt, new Date(start + 3600 * 1000).toISOString());
  assert.equal(second.headers.get('Retry-After'), '3600');
  assert.deepEqual(log, [], '被 Key 挡住就不该发任何上游请求，更不该删会话重建');
  assert.equal(upstream.state.get(tokenA)?.model, DS4F, 'ds4f 会话原封不动');

  // 剩余时间是真倒计时（解锁时间点不动），顺便钉住「分 + 秒」这一档的说法。
  workerVm.setNow(start + 3600 * 1000 - 90 * 1000);
  const third = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat', null, keyA,
  );
  assert.equal(third.status, 409);
  const late = JSON.parse(await third.text());
  assert.match(late.error.message, /· 解锁时间: 2030-01-01 09:00:00 \(UTC\+8\),还需 1 分 30 秒（90s）/);
  assert.equal(late.error.retryAfterSec, 90);
});

test('keyA 锁在 ds4f 上，不影响 keyB 用另一个账号开 luna', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['keylock-pair-token-aaaaaaaaaaaa', 'keylock-pair-token-bbbbbbbbbbbb'];
  const log = [];
  const upstream = createFakeUpstream({ start, log });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(tokens);

  const ds4f = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, sharedKey('pair-a'),
  );
  assert.equal(ds4f.status, 200);
  await ds4f.text();
  const ds4pHost = [...upstream.state.entries()].find(([, s]) => s.model === DS4F)?.[0];
  log.length = 0;

  const luna = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat', null, sharedKey('pair-b'),
  );

  assert.equal(luna.status, 200, 'keyA 的锁是 Key 级的，不能挡住 keyB');
  await luna.text();
  assert.deepEqual(log.filter((e) => e.method === 'DELETE').map((e) => e.token), [],
    'keyB 该落到空闲号上，不该删 keyA 的会话');
  assert.equal(upstream.state.get(ds4pHost)?.model, DS4F);
  const lunaHost = [...upstream.state.entries()].find(([, s]) => s.model === LUNA)?.[0];
  assert.ok(lunaHost && lunaHost !== ds4pHost, '两把 Key 两个号，两个会话并行');
});

test('Master Key 不受锁限制：同一个号上也能立刻换模型', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'keylock-master-token-aaaaaaaaaaaa';
  const upstream = createFakeUpstream({ start });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA]);

  const ds4f = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, MASTER,
  );
  assert.equal(ds4f.status, 200);
  await ds4f.text();
  assert.equal(workerVm.api.clientModelLock(MASTER), null, 'Master Key 不写锁');

  const luna = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat', null, MASTER,
  );

  assert.equal(luna.status, 200, 'Master Key 换模型走上游那条 DELETE+POST 路，不该被 409 挡住');
  await luna.text();
  assert.equal(upstream.state.get(tokenA)?.model, LUNA);
});

test('同模型第二把 Key：换个干净账号新建会话，不共用别人的 instanceId', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['keylock-same-token-aaaaaaaaaaaa', 'keylock-same-token-bbbbbbbbbbbb'];
  const upstream = createFakeUpstream({ start });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor(tokens);

  const a = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, sharedKey('same-a'),
  );
  assert.equal(a.status, 200);
  await a.text();

  const b = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, sharedKey('same-b'),
  );
  assert.equal(b.status, 200);
  await b.text();

  const hosts = [...upstream.state.entries()].filter(([, s]) => s.model === DS4F);
  assert.equal(hosts.length, 2, '两把 Key 各自开会话，不落在同一个号上');
  assert.notEqual(hosts[0][1].instanceId, hosts[1][1].instanceId,
    '共用 instanceId 会串上下文 —— 宁可多花一份 admission');
});

test('会话缓存没了就解锁：不把 Key 锁在一条已经不存在的会话上', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokenA = 'keylock-release-token-aaaaaaaaaa';
  const upstream = createFakeUpstream({ start });
  const workerVm = createWorkerVm({ now: start, fetchImpl: upstream.fetch });
  const env = envFor([tokenA]);
  const keyA = sharedKey('release-a');

  const ds4f = await workerVm.api.executeChat(
    env, chatParams(DS4F), modelCfg(DS4F, 'base2-free-deepseek'), true, 'chat', null, keyA,
  );
  assert.equal(ds4f.status, 200);
  await ds4f.text();
  assert.equal(workerVm.api.clientModelLock(keyA)?.model, DS4F);

  workerVm.api.invalidateSessionCache(tokenA);   // 会话被顶替/删掉/进程重启后的本地状态
  assert.equal(workerVm.api.clientModelLock(keyA), null, '缓存里那条会话没了就该放开');

  const luna = await workerVm.api.executeChat(
    env, chatParams(LUNA), modelCfg(LUNA, 'base2-free-luna'), true, 'chat', null, keyA,
  );
  assert.equal(luna.status, 200, '解锁后照常按上游契约删旧会话重建 luna');
  await luna.text();
  assert.equal(upstream.state.get(tokenA)?.model, LUNA);
});

// ---- 多人同时用：有空闲号就不许排到 120s ---------------------------------------
// 上游一个号只能有一个会话，所以并发只能靠账号数扩展。原实现里「不等待、直接换个
// 空闲号」这条路被 preserveBudget 挡着，只有**有每日 session 预算**的分享 Key 走得到；
// Master Key 和不限额分享 Key（多人同时用最常见的两种）反而会等满
// ACTIVE_SESSION_LEASE_WAIT_MS(120s)，期间还占着自己 Key 的并发槽位 —— 而池里的号全空闲。
//
// 等待本身要保留：它省的是一份 admission（每天只有 4~7 份），而且占用多半是上一笔
// 请求正在收尾。所以是「先等 SESSION_REUSE_GRACE_MS，等不到再看池里有没有空闲号」：
// 分界线是**池里还有没有空闲号**，不是「这把 Key 有没有预算」。
const GRACE_MS = 500;   // worker.js 的 SESSION_REUSE_GRACE_MS

// 会话对象够用就好：pickTokenWithSessionWait 只看 instanceId/expiresAt/remainingMs。
function liveSessionAt(start, model, instanceId = 'inst-live') {
  return {
    instanceId, model,
    expiresAt: new Date(start + 3600 * 1000).toISOString(),
    remainingMs: 3600 * 1000,
  };
}

// 让这把 Key「认领」这条会话，否则 sessionOwnedByClient 会判成别人的会话，
// 走不到等待那条路（那是另一个用例的行为）。
function claimSession(api, client, token, model, session, start) {
  if (!client) return;
  api.clientStat(client).seenSessions
    .set(api.clientSessionIdentity(token, model, session), start + 3600 * 1000);
}

for (const [label, client] of [
  ['Master Key', MASTER],
  ['不限每日额度的分享 Key', sharedKey('idle-unlimited')],
  ['有每日额度的分享 Key', { ...sharedKey('idle-budget'), dailyLimit: 5 }],
  ['无 Key 上下文（内部调用）', null],
]) {
  test(`${label}：自己的会话被长时间占用且池里有空闲号时，让出 grace 就换号，不等满 120s`, async () => {
    const start = Date.UTC(2030, 0, 1);
    const tokens = ['idle-pick-token-aaaaaaaaaaaaaa', 'idle-pick-token-bbbbbbbbbbbbbb'];
    const workerVm = createWorkerVm({ now: start });
    const env = envFor(tokens);
    const api = workerVm.api;

    const session = liveSessionAt(start, DS4F);
    api.sessCache.set(`${tokens[0]}:${DS4F}`, session);
    claimSession(api, client, tokens[0], DS4F, session, start);
    assert.ok(api.acquireToken(tokens[0]), '模拟第一个请求正在跑，占住 A 号租约');

    // A 号整程不释放，模拟一笔长流式请求。waitMs 给足 60s：真排队的话这个 await
    // 会挂到 race 的计时器先到。计时器留足 grace 的余量，别把 CI 抖动当成回归。
    const began = Date.now();
    const picked = await Promise.race([
      api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, client),
      new Promise((resolve) => setTimeout(() => resolve('QUEUED'), GRACE_MS + 2_500)),
    ]);
    const waited = Date.now() - began;

    assert.notEqual(picked, 'QUEUED',
      `${label} 排队了：A 号一直在忙但 B 号空闲，不该等满租约上限`);
    assert.equal(picked?.token, tokens[1], '应该拿到空闲的 B 号');
    assert.ok(waited >= GRACE_MS - 50,
      `不该跳过 grace 直接换号（实测只等了 ${waited}ms）：短暂占用等一下就能复用，省一份 admission`);
    assert.ok(api.tokenBusy(tokens[1]), '拿到的号必须已上租约，否则会被并发请求重复选中');
    assert.ok(api.tokenBusy(tokens[0]), 'A 号的租约不受影响');
  });
}

// 换号的硬约束：空闲不等于可用。挂着别的 Key 同模型活跃会话的号一律不碰 ——
// createSession 缓存命中不查归属，换过去就直接复用那个 instanceId，两边上下文串在一起。
// pickToken 只把这种号排到候选末尾（foreign 排序键），没有排除它，所以这条得自己兜。
test('唯一空闲号挂着别的 Key 的同模型会话：宁可继续等，也不换过去串上下文', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['foreign-only-token-aaaaaaaaaa', 'foreign-only-token-bbbbbbbbbb'];
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(tokens);
  const api = workerVm.api;

  const mine = liveSessionAt(start, DS4F, 'inst-mine');
  api.sessCache.set(`${tokens[0]}:${DS4F}`, mine);
  claimSession(api, MASTER, tokens[0], DS4F, mine, start);
  assert.ok(api.acquireToken(tokens[0]), 'A 号：自己的会话正在跑');

  // B 号空闲，但那条 DS4F 会话是别的 Key 开的（不给 MASTER 认领）。
  api.sessCache.set(`${tokens[1]}:${DS4F}`, liveSessionAt(start, DS4F, 'inst-someone-else'));

  const pending = api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, MASTER);
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ stillWaiting: true }), GRACE_MS + 300)),
  ]);

  assert.deepEqual(outcome, { stillWaiting: true },
    '换到了 B 号：那条会话是别人的，复用它会把两把 Key 的上下文串起来');
  assert.ok(!api.tokenBusy(tokens[1]), 'B 号的租约必须还回去，不能被这次挑选占着');

  // 收尾：放掉租约让那条 await 结束，顺便钉住释放后仍然复用自己的会话。
  api.releaseToken(tokens[0]);
  assert.equal((await pending)?.token, tokens[0], '释放后应复用自己那条会话');
});

test('空闲号里既有别人的会话又有干净号：跳过别人的会话，落到干净号上', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = [
    'foreign-skip-token-aaaaaaaaaaaa',
    'foreign-skip-token-bbbbbbbbbbbb',
    'foreign-skip-token-cccccccccccc',
  ];
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(tokens);
  const api = workerVm.api;

  const mine = liveSessionAt(start, DS4F, 'inst-mine');
  api.sessCache.set(`${tokens[0]}:${DS4F}`, mine);
  claimSession(api, MASTER, tokens[0], DS4F, mine, start);
  assert.ok(api.acquireToken(tokens[0]), 'A 号：自己的会话正在跑');

  // B：别的 Key 的 DS4F 会话（conflict=0 / foreign=1）。
  // C：只有一条 luna 会话，对 DS4F 算 conflict=1 —— pickToken 会把 B 排在 C 前面，
  //    所以这个用例真正走的是「排除 B 之后重问」那条路，而不是碰巧先挑到 C。
  api.sessCache.set(`${tokens[1]}:${DS4F}`, liveSessionAt(start, DS4F, 'inst-someone-else'));
  api.sessCache.set(`${tokens[2]}:${LUNA}`, liveSessionAt(start, LUNA, 'inst-other-model'));

  const picked = await api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, MASTER);

  assert.equal(picked?.token, tokens[2], '应该落到 C 号：B 号挂着别人的同模型会话');
  assert.ok(!api.tokenBusy(tokens[1]), 'B 号试选后的租约必须还回去');
  assert.ok(api.tokenBusy(tokens[2]), 'C 号必须已上租约');
});

test('占用在 grace 窗口内结束：复用原账号，不白烧一份 admission 去换号', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['grace-reuse-token-aaaaaaaaaaaa', 'grace-reuse-token-bbbbbbbbbbbb'];
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(tokens);
  const api = workerVm.api;

  const session = liveSessionAt(start, DS4F);
  api.sessCache.set(`${tokens[0]}:${DS4F}`, session);
  claimSession(api, MASTER, tokens[0], DS4F, session, start);
  assert.ok(api.acquireToken(tokens[0]), '第一个请求正在跑');

  // 上一笔请求正在收尾：grace 没走完就释放了。这时必须复用 A，B 号一根汗毛都不能动 ——
  // 这是 grace 存在的唯一理由，去掉它就会在每次短暂重叠时多建一条会话。
  setTimeout(() => api.releaseToken(tokens[0]), Math.floor(GRACE_MS / 4));
  const picked = await api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, MASTER);

  assert.equal(picked?.token, tokens[0], '短暂占用应等到释放并复用原账号');
  assert.ok(!api.tokenBusy(tokens[1]), 'B 号不该被碰，否则就是白烧一份 admission');
});

test('全池都在忙时仍然等待：不能为了不排队就退化成直接报池耗尽', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['idle-none-token-aaaaaaaaaaaaaa', 'idle-none-token-bbbbbbbbbbbbbb'];
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(tokens);
  const api = workerVm.api;

  const session = liveSessionAt(start, DS4F);
  api.sessCache.set(`${tokens[0]}:${DS4F}`, session);
  claimSession(api, MASTER, tokens[0], DS4F, session, start);
  for (const token of tokens) assert.ok(api.acquireToken(token), '占满全池');

  // 等待期间 A 号释放 → 应该醒过来把 A 号捡回去，而不是立刻回 null。
  // 计时器必须超过 grace，否则「还在等」测的只是 grace 窗口本身，换号那条路根本没跑到。
  const pending = api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, MASTER);
  const raced = await Promise.race([
    pending.then((acct) => ({ acct })),
    new Promise((resolve) => setTimeout(() => resolve({ stillWaiting: true }), GRACE_MS + 300)),
  ]);
  assert.ok(raced.stillWaiting, '没有空闲号时必须等待，不能立刻失败');

  api.releaseToken(tokens[0]);
  const acct = await pending;
  assert.equal(acct?.token, tokens[0], '租约一释放就该醒过来复用自己那条会话');
});

test('每日预算已用尽的分享 Key：仍然等自己的会话，不换号去撞每日上限', async () => {
  const start = Date.UTC(2030, 0, 1);
  const tokens = ['idle-spent-token-aaaaaaaaaaaaaa', 'idle-spent-token-bbbbbbbbbbbbbb'];
  const workerVm = createWorkerVm({ now: start });
  const env = envFor(tokens);
  const api = workerVm.api;
  const client = { ...sharedKey('spent'), dailyLimit: 1 };

  const session = liveSessionAt(start, DS4F);
  api.sessCache.set(`${tokens[0]}:${DS4F}`, session);
  claimSession(api, client, tokens[0], DS4F, session, start);
  api.clientStat(client).daySessions.add('already-spent');   // dailyLimit=1 且已用 1
  assert.ok(api.acquireToken(tokens[0]));

  // 这类 Key 等的是「自己会话不再可复用」（activeWaitMs = sessionRemainingMs = 1h），
  // 不是传进去的 waitMs，所以只 race 一下看它有没有换号。计时器必须超过 grace：
  // 停在 grace 里面的话，B 号没被占用只是因为换号那条路还没跑到。
  const pending = api.pickTokenWithSessionWait(env, DS4F, new Set(), null, 60_000, client);
  const raced = await Promise.race([
    pending.then((acct) => ({ acct })),
    new Promise((resolve) => setTimeout(() => resolve({ stillWaiting: true }), GRACE_MS + 300)),
  ]);

  assert.ok(raced.stillWaiting,
    '预算用尽还换号，createSession 会直接撞 ClientSessionLimitError —— 这种情况等待才是对的');
  assert.ok(!api.tokenBusy(tokens[1]), 'B 号不该被占用');

  // 收尾：那条 await 挂着一个 1 小时的定时器，不放掉会把测试进程吊到超时。
  // 顺便钉住释放后的行为：复用自己那条会话，而不是换号。
  api.releaseToken(tokens[0]);
  assert.equal((await pending)?.token, tokens[0], '租约释放后应复用自己那条会话');
});
