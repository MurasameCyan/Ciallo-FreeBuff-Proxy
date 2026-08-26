import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import * as proxyModule from '../server/proxy.mjs';

const { createProxyService, maskSubscriptionUrl, resolveProxySettings } = proxyModule;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('订阅地址脱敏时不返回凭据、查询参数或片段', () => {
  const masked = maskSubscriptionUrl('https://user:pass@sub.example.com/api/sub?token=secret#frag');
  assert.equal(masked, 'https://sub.example.com/…');
  assert.ok(!masked.includes('pass'));
  assert.ok(!masked.includes('secret'));
});

test('环境变量订阅优先于数据目录中的订阅', () => {
  const resolved = resolveProxySettings({
    envUrl: 'https://env.example/sub?token=env',
    saved: { subscriptionUrl: 'https://saved.example/sub?token=saved', nodeMode: 'manual' },
  });
  assert.equal(resolved.subscriptionUrl, 'https://env.example/sub?token=env');
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.nodeMode, 'manual');
});

function fakeService(overrides = {}) {
  let running = false;
  const calls = [];
  const settings = { ...(overrides.settings || {}) };
  const manager = {
    async isRunning() { return running; },
    async start() { calls.push(['start']); running = true; return true; },
    async stop() { calls.push(['stop']); running = false; return true; },
    async getVersion() { return running ? '1.19.29' : null; },
    ...(overrides.manager || {}),
  };
  const controller = overrides.controller || {
    async request(path, method = 'GET', body) {
      calls.push(['controller', path, method, body]);
      if (path.includes('/proxies/freebuff-pool')) return { all: ['node-a', 'node-b'], now: 'node-a' };
      if (path.includes('/proxies/freebuff-auto')) return { now: 'node-a', all: ['node-a', 'node-b'] };
      return {};
    },
  };
  const service = createProxyService({
    manager,
    controller,
    settings,
    envUrl: overrides.envUrl || '',
    persist: (next) => Object.assign(settings, next),
    writeConfig: (url) => calls.push(['config', url]),
    logger: () => {},
    ...(overrides.service || {}),
  });
  return { service, calls, manager, settings, setRunning: (value) => { running = value; } };
}

test('保存订阅会立即启动内核并刷新 provider', async () => {
  const { service, calls } = fakeService();
  const status = await service.setSubscription('https://sub.example.com/list?token=secret');
  assert.equal(status.configured, true);
  assert.equal(status.state, 'ready');
  assert.ok(calls.some(([kind]) => kind === 'config'));
  assert.ok(calls.some(([kind]) => kind === 'start'));
  assert.ok(calls.some(([kind, path, method]) => kind === 'controller' && method === 'PUT' && path.includes('/providers/proxies/freebuff-airport')));
});

test('初始化时环境变量订阅不能被调用方传入地址覆盖', async () => {
  const { service } = fakeService({
    envUrl: 'https://env.example/sub?token=env',
    settings: { subscriptionUrl: 'https://saved.example/sub?token=saved' },
  });
  await service.initialize('https://caller.example/should-not-win');
  assert.equal(service.getSubscriptionUrl(), 'https://env.example/sub?token=env');
  assert.equal(service.isEnvLocked(), true);
});

test('空订阅会停用内核并回落直连', async () => {
  const { service, calls } = fakeService({ settings: { subscriptionUrl: 'https://old.example/sub' } });
  await service.setSubscription('https://old.example/sub');
  const status = await service.setSubscription('');
  assert.equal(status.state, 'disabled');
  assert.equal(status.configured, false);
  assert.ok(calls.some(([kind]) => kind === 'stop'));
  assert.equal(service.getFetch(), null);
});

test('内核从就绪状态退出后状态查询回落直连', async () => {
  let closed = 0;
  const { service, setRunning } = fakeService({
    service: {
      buildFetch: async () => ({ fetch: () => {}, close: async () => { closed++; } }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  assert.equal(typeof service.getFetch(), 'function');
  setRunning(false);
  const status = await service.status();
  assert.equal(status.state, 'stopped');
  assert.equal(service.getFetch(), null);
  assert.equal(closed, 1);
});

test('手动节点选择与自动模式均通过受控接口生效', async () => {
  const { service, calls } = fakeService();
  await service.setSubscription('https://sub.example.com/list');
  const manual = await service.setNode({ mode: 'manual', node: 'node-b' });
  assert.equal(manual.nodeMode, 'manual');
  assert.equal(manual.currentNode, 'node-b');
  assert.ok(calls.some(([kind, path, method, body]) => kind === 'controller' && method === 'PUT' && path.includes('/proxies/freebuff-pool') && body?.name === 'node-b'));
  const automatic = await service.setNode({ mode: 'auto' });
  assert.equal(automatic.nodeMode, 'auto');
});

test('自动测活间隔拒绝过短或非整数值', async () => {
  const { service } = fakeService();
  await assert.rejects(() => service.setHealth({ enabled: true, interval: 10 }), /30/);
  await assert.rejects(() => service.setHealth({ enabled: true, interval: 30.5 }), /整数/);
  const status = await service.setHealth({ enabled: false, interval: 120 });
  assert.equal(status.autoHealthCheck, false);
  assert.equal(status.healthCheckInterval, 120);
});

test('自动更新间隔拒绝过短或非整数值并按小时粒度保存', async () => {
  const { service } = fakeService();
  await assert.rejects(() => service.setUpdate({ enabled: true, interval: 300 }), /3600/);
  await assert.rejects(() => service.setUpdate({ enabled: true, interval: 3600.5 }), /整数/);
  const status = await service.setUpdate({ enabled: true, interval: 10800 });
  assert.equal(status.autoUpdate, true);
  assert.equal(status.autoUpdateInterval, 10800);
  assert.equal(status.update.enabled, true);
  assert.equal(status.update.interval, 10800);
});

test('启用自动更新按间隔注册定时刷新，关闭后清除', async () => {
  const timers = [];
  let seq = 0;
  let accountRefreshes = 0;
  const { service } = fakeService({
    settings: { autoHealthCheck: false },
    service: {
      setIntervalFn: (fn, ms) => { const id = ++seq; timers.push({ id, fn, ms }); return id; },
      clearIntervalFn: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
      onAutoRefresh: () => { accountRefreshes++; },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  assert.equal(timers.length, 0, '自动测活与自动更新均关闭时不应注册定时器');
  const armed = await service.setUpdate({ enabled: true, interval: 3600 });
  assert.equal(armed.autoUpdate, true);
  assert.equal(timers.length, 1, '启用自动更新应注册一个定时器');
  assert.equal(timers[0].ms, 3600 * 1000);
  await timers[0].fn();
  assert.equal(accountRefreshes, 1, '定时刷新拓扑后必须通知账号路由主动恢复');
  await service.setUpdate({ enabled: false, interval: 3600 });
  assert.equal(timers.length, 0, '关闭自动更新应清除定时器');
});

test('定时订阅刷新失败时不启动账号路由重建', async () => {
  let timerFn = null;
  let failRefresh = false;
  let accountRefreshes = 0;
  const nodes = ['US-A'];
  const { service } = fakeService({
    settings: { autoHealthCheck: false },
    controller: {
      async request(path, method = 'GET') {
        if (failRefresh && method === 'PUT' && path.includes('/providers/proxies/')) {
          throw new Error('provider refresh failed');
        }
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 30 };
        return {};
      },
    },
    service: {
      setIntervalFn: (fn) => { timerFn = fn; return 1; },
      clearIntervalFn: () => {},
      onAutoRefresh: () => { accountRefreshes++; },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setUpdate({ enabled: true, interval: 3600 });
  failRefresh = true;
  await timerFn();
  assert.equal(accountRefreshes, 0, '代理已经进入 error 时不得再批量启动账号探测');
});

test('provider 刷新失败时保留 last-good US/SG 候选和已有账号路由', async () => {
  const nodes = ['US-A', 'SG-B'];
  let providerPuts = 0;
  const { service } = fakeService({
    settings: { autoHealthCheck: false },
    controller: {
      async request(path, method = 'GET') {
        if (method === 'PUT' && path.includes('/providers/proxies/')) {
          providerPuts++;
          if (providerPuts > 1) throw new Error('provider refresh failed');
          return {};
        }
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 30, 'SG-B': 50 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => ({
        fetch: async () => new Response(String(lane)),
        close: async () => {},
      }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({
    lane: 5,
    identity: 'account-a',
    verify: async () => ({ tier: 'advanced', model: 'openai/gpt-5.6-luna' }),
  });
  const lastGoodCandidates = service.getAccountAutoCandidates();
  const lastGoodFetch = service.getAccountAutoFetch(5, { identity: 'account-a' });
  assert.equal(typeof lastGoodFetch, 'function');

  await service.refresh();

  const stableCandidateFields = (entries) => entries
    .map(({ name, region, delay }) => ({ name, region, delay }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    stableCandidateFields(service.getAccountAutoCandidates()),
    stableCandidateFields(lastGoodCandidates),
    '刷新失败不得清空或改写上次成功的 US/SG 候选快照');
  assert.equal(
    service.getAccountAutoFetch(5, { allowStale: true, identity: 'account-a' }),
    lastGoodFetch,
    '刷新失败时已验证账号应继续使用上次成功的出站路由',
  );
});

test('测活更新节点失败时返回安全状态而不是向调用方抛出', async () => {
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/providers/proxies/')) return {};
        throw new Error('控制器暂不可达');
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const status = await service.testHealth();
  assert.equal(status.health.error, '控制器暂不可达');
  assert.equal(status.healthyCount, 0);
});

test('内核启动失败不抛到请求层且保持直连', async () => {
  const { service } = fakeService({ manager: {
    async start() { throw new Error('mihomo failed https://secret.example/?token=abc'); },
  } });
  const status = await service.setSubscription('https://sub.example.com/list?token=secret');
  assert.equal(status.state, 'error');
  assert.equal(status.configured, true);
  assert.equal(service.getFetch(), null);
  assert.ok(!JSON.stringify(status).includes('token=abc'));
});

test('订阅解析后自动测活并按延迟升序排序，测活失败的节点自动删除', async () => {
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: ['slow', 'fast', 'dead'], now: 'slow' };
        if (path.includes('/proxies/freebuff-auto')) return { now: 'fast', all: ['slow', 'fast', 'dead'] };
        if (path.includes('/group/freebuff-pool/delay')) return { slow: 320, fast: 45, dead: 0 };
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.deepEqual(status.nodes.map((n) => n.name), ['fast', 'slow'], 'dead 测活没通，必须从节点列表里删掉');
  assert.equal(status.nodes[0].delay, 45);
  assert.equal(status.healthyCount, 2);
  assert.equal(status.nodeCount, 3, '节点总数仍是订阅解析出的数量，用来看衰减（3 → 健康 2）');
});

test('节点全部测活失败时不清空列表（通常是测活地址自己不通）', async () => {
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: ['a', 'b'], now: 'a' };
        if (path.includes('/group/freebuff-pool/delay')) return { a: 0, b: 0 };
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.equal(status.healthyCount, 0);
  assert.deepEqual(status.nodes.map((n) => n.name), ['a', 'b'], '全灭时删光会让手动选节点没得选');
});

test('上游拒绝出站 IP 时归因到当前节点并进快照，直连时不记', async () => {
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: ['a', 'b'], now: 'a' };
        if (path.includes('/group/freebuff-pool/delay')) return { a: 40, b: 90 };
        return {};
      },
    },
  });
  service.noteEgressReject({ state: 'country_blocked', status: 403 });
  assert.equal((await service.status()).reject, null, '没起代理时无节点可归因，不应记录');

  await service.setSubscription('https://sub.example.com/list');
  service.noteEgressReject({ state: 'country_blocked', status: 403 });
  const hit = await service.status();
  assert.equal(hit.reject.state, 'country_blocked');
  assert.equal(hit.reject.status, 403);
  assert.equal(hit.reject.node, hit.currentNode, '拒绝记录必须钉在当时在用的节点上');
  assert.ok(hit.reject.at, '必须带发生时间');

  await service.setNode({ mode: 'manual', node: 'b' });
  assert.equal((await service.status()).reject, null, '换了节点后旧的拒绝记录必须清掉');
});

test('关闭自动测活时，保存订阅仍会测活一次以完成延迟排序', async () => {
  const { service } = fakeService({
    settings: { autoHealthCheck: false },
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: ['slow', 'fast'], now: 'slow' };
        if (path.includes('/proxies/freebuff-auto')) return { now: 'fast', all: ['slow', 'fast'] };
        if (path.includes('/group/freebuff-pool/delay')) return { slow: 300, fast: 60 };
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.equal(status.autoHealthCheck, false);
  assert.deepEqual(status.nodes.map((n) => n.name), ['fast', 'slow']);
  assert.equal(status.nodes[0].delay, 60);
});

test('自动选点优先 US/SG，同档内仍按延迟排序', async () => {
  const nodes = ['🇯🇵 日本 东京 01', '🇸🇬 新加坡 02', '🇺🇸 美国 洛杉矶 03', 'HK-Premium'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: nodes, now: nodes[0] };
        // mihomo 只看延迟，会选到日本；地区不对就不能采纳它的结果。
        if (path.includes('/proxies/freebuff-auto')) return { now: nodes[0], all: nodes };
        if (path.includes('/group/freebuff-pool/delay')) {
          return { [nodes[0]]: 30, [nodes[1]]: 90, [nodes[2]]: 150, 'HK-Premium': 40 };
        }
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.equal(status.currentNode, nodes[1], '偏好档里应挑延迟最低的新加坡，而不是更快的日本');
});

test('偏好地区的节点测活没通过时不选它，宁可用别的地区活节点', async () => {
  const nodes = ['🇺🇸 美国 洛杉矶 01', '🇯🇵 日本 东京 02'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: nodes, now: nodes[1] };
        if (path.includes('/proxies/freebuff-auto')) return { now: nodes[0], all: nodes };
        if (path.includes('/group/freebuff-pool/delay')) return { [nodes[0]]: 0, [nodes[1]]: 70 };
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.equal(status.currentNode, nodes[1], '死掉的美国节点不能因为地区对就被选中');
});

test('订阅里没有 US/SG 节点时沿用 mihomo 的延迟选点', async () => {
  const nodes = ['🇯🇵 日本 01', '🇭🇰 香港 02'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path.includes('/proxies/freebuff-pool')) return { all: nodes, now: nodes[0] };
        if (path.includes('/proxies/freebuff-auto')) return { now: nodes[1], all: nodes };
        if (path.includes('/group/freebuff-pool/delay')) return { [nodes[0]]: 200, [nodes[1]]: 60 };
        return {};
      },
    },
  });
  const status = await service.setSubscription('https://sub.example.com/list');
  assert.equal(status.currentNode, nodes[1], '没有偏好地区可选时不应改变原有行为');
});

test('账号 lane 可同时固定到不同节点并使用不同本地端口', async () => {
  const nodes = ['US-A', 'SG-B'];
  const switches = [];
  const built = [];
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 60 };
        if (method === 'PUT' && /^\/proxies\/freebuff-account-\d+$/.test(path)) {
          switches.push({ path, node: body?.name });
          return {};
        }
        return {};
      },
    },
    service: {
      buildFetch: async ({ port, lane } = {}) => {
        const marker = async () => new Response(`${lane}:${port}`);
        built.push({ port, lane, marker });
        return { fetch: marker, close: async () => {} };
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 0, node: nodes[0] });
  await service.setAccountNode({ lane: 1, node: nodes[1] });

  assert.deepEqual(switches, [
    { path: '/proxies/freebuff-account-0', node: nodes[0] },
    { path: '/proxies/freebuff-account-1', node: nodes[1] },
  ]);
  assert.notEqual(service.getAccountFetch(0), service.getAccountFetch(1));
  assert.ok(built.some((entry) => entry.lane === 0 && entry.port === 17900));
  assert.ok(built.some((entry) => entry.lane === 1 && entry.port === 17901));
});

test('账号自动出站候选只包含测活成功的 US/SG 节点', async () => {
  const nodes = ['US-fast', 'SG-slow', 'US-dead', 'JP-fast', '🇯🇵 JP¹-SG⁰_tokyo'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[3] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[3], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) {
          return { 'US-fast': 50, 'SG-slow': 90, 'US-dead': 0, 'JP-fast': 20, '🇯🇵 JP¹-SG⁰_tokyo': 15 };
        }
        return {};
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  assert.deepEqual(service.getAccountAutoCandidates().map((entry) => [entry.name, entry.region]), [
    ['US-fast', 'us'],
    ['SG-slow', 'sg'],
  ]);
  assert.equal(proxyModule.inferNodeRegion('🇯🇵 JP¹-SG⁰_tokyo'), null,
    '开头日本旗帜必须压过名称后半段的 SG 标记');
  assert.equal(proxyModule.inferNodeRegion('JP¹-SG⁰_tokyo'), null,
    '开头日本国家前缀必须压过名称后半段的 SG 标记');
  assert.equal(proxyModule.inferNodeRegion('🇸🇬 JP¹-SG⁰_singapore'), 'sg');
});

test('账号高级节点按 accessTier 判定，不因 D4P/Luna 当日额度用完降级', () => {
  assert.equal(typeof proxyModule.classifyAccountProbeAuthorization, 'function');
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok',
    accessTier: 'full',
    quota: [
      { model: 'openai/gpt-5.6-luna', used: 1, limit: 1, pool: 'luna' },
      { model: 'deepseek/deepseek-v4-pro', used: 1, limit: 1, pool: 'deepseek_pro' },
      { model: 'deepseek/deepseek-v4-flash', used: 3, limit: 5, pool: 'premium' },
    ],
  }), { tier: 'advanced', model: 'deepseek/deepseek-v4-pro' });
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok', accessTier: 'full', quota: null,
  }), { tier: 'advanced' },
  'full 能力已明确时，额度快照暂缺也不得把节点卡在自动验证中');
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok',
    accessTier: null,
    quota: [
      { model: 'deepseek/deepseek-v4-flash', used: 3, limit: 5, pool: 'premium' },
    ],
  }), { tier: 'advanced', model: 'deepseek/deepseek-v4-flash' },
  '旧响应缺少 accessTier 时，明确的高级 pool 仍可判定节点能力');
});

test('高级额度不可用时回落免费授权且不按 used 判断免费额度', () => {
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok',
    accessTier: 'limited',
    quota: [
      { model: 'openai/gpt-5.6-luna', used: 1, limit: 1, pool: 'luna' },
      { model: 'mimo/mimo-v2.5', used: 0, limit: 6 },
      { model: 'deepseek/deepseek-v4-flash', used: 5, limit: 5, pool: 'premium' },
    ],
  }), { tier: 'free', model: 'deepseek/deepseek-v4-flash' },
  'limited accessTier 必须保持 Free，不能仅凭额度行误判为高级节点');
  assert.equal(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok',
    quota: [{ model: 'mimo/mimo-v2.5', used: 0, limit: 0 }],
  }), null, '免费模型必须有正 limit');
  assert.equal(proxyModule.classifyAccountProbeAuthorization({
    state: 'banned',
    quota: [{ model: 'mimo/mimo-v2.5', used: 0, limit: 6 }],
  }), null, '非存活账号不能仅凭额度表获得授权');
});

test('旧探测响应不能用已暂停 M3 作为高级节点证据', () => {
  assert.equal(proxyModule.classifyAccountProbeAuthorization({
    state: 'ok',
    quota: [
      { model: 'minimax/minimax-m3', used: 0, limit: 5, pool: 'premium' },
    ],
  }), null, 'M3 即使残留 Premium 行也不得让自动选点误判为高级节点');
});

// 实测 2026-08-26：上游拥堵波次里探针拿到 waiting_room，若判成验证失败，
// 节点被逐个拉黑、lane 无法就绪、全部请求本地拒成 egress_unavailable。
// waiting_room 恰恰证明出口路径已被上游应用层接受——必须算验证通过。
test('排队/额度类探测结果证明出口路径可用，不得判成验证失败', () => {
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'waiting_room',
    accessTier: 'full',
    quota: [
      { model: 'openai/gpt-5.6-luna', used: 1, limit: 2, pool: 'luna' },
    ],
  }), { tier: 'advanced', model: 'openai/gpt-5.6-luna' },
  'waiting_room 探针 + full tier 必须照常授权为高级节点');
  assert.deepEqual(proxyModule.classifyAccountProbeAuthorization({
    state: 'rate_limited',
    accessTier: null,
    quota: [{ model: 'deepseek/deepseek-v4-flash', used: 5, limit: 5, pool: 'premium' }],
  }), { tier: 'advanced', model: 'deepseek/deepseek-v4-flash' },
  '额度耗尽的 429 同样走通了链路，旧响应无 accessTier 时按 pool 判定');
  assert.equal(proxyModule.classifyAccountProbeAuthorization({
    state: 'blocked',
    quota: [{ model: 'mimo/mimo-v2.5', used: 0, limit: 6 }],
  }), null, '403 blocked 是链路被拒，不能算验证通过');
  assert.equal(proxyModule.classifyAccountProbeAuthorization({
    state: 'ip_capped',
    quota: [{ model: 'mimo/mimo-v2.5', used: 0, limit: 6 }],
  }), null, 'ip_capped 是出口 IP 级问题，不能算验证通过');
});

test('账号自动出站优先级可持久化并切换', async () => {
  assert.equal(proxyModule.resolveProxySettings({}).accountSelectionPriority, 'advanced');
  assert.equal(proxyModule.resolveProxySettings({ saved: { accountSelectionPriority: 'unused' } }).accountSelectionPriority, 'unused');

  let refreshOptions = null;
  const { service, settings } = fakeService({
    service: { onAutoRefresh: (options) => { refreshOptions = options; } },
  });
  await service.setSubscription('https://sub.example.com/list');
  const advanced = await service.setAccountSelectionPriority('advanced');
  assert.equal(advanced.accountSelectionPriority, 'advanced');
  assert.equal(settings.accountSelectionPriority, 'advanced');
  const unused = await service.setAccountSelectionPriority('unused');
  assert.equal(unused.accountSelectionPriority, 'unused');
  assert.equal(settings.accountSelectionPriority, 'unused');
  assert.deepEqual(refreshOptions, { force: true }, '切换策略必须强制重新选择已验证账号');
  await assert.rejects(() => service.setAccountSelectionPriority('random'), /优先级/);
});

test('优先高级会跳过 Free 节点，优先未用保留首个未占用节点', async () => {
  const nodes = ['US-free', 'SG-advanced'];
  const verified = [];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-free': 10, 'SG-advanced': 20 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');

  await service.setAccountSelectionPriority('advanced');
  const advanced = await service.selectAccountNodeAuto({
    lane: 0,
    identity: 'target-account',
    verify: async ({ node }) => {
      verified.push(node);
      return node === 'US-free'
        ? { tier: 'free', model: 'mimo/mimo-v2.5' }
        : { tier: 'advanced', model: 'openai/gpt-5.6-luna' };
    },
  });
  assert.equal(advanced.node, 'SG-advanced');
  assert.deepEqual(verified, ['US-free', 'SG-advanced']);

  await service.setAccountSelectionPriority('unused');
  const unused = await service.selectAccountNodeAuto({
    lane: 1,
    identity: 'unused-account',
    verify: async ({ node }) => ({ tier: 'free', model: node === 'US-free' ? 'mimo/mimo-v2.5' : 'deepseek/deepseek-v4-flash' }),
  });
  assert.equal(unused.node, 'US-free');
});

test('优先高级先使用未占用的 SG 高级节点，再复用已占用的 US 高级节点', async () => {
  const nodes = ['US-advanced', 'SG-advanced'];
  const verified = [];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-advanced': 10, 'SG-advanced': 20 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async ({ node }) => {
    verified.push(node);
    return { tier: 'advanced', model: 'openai/gpt-5.6-luna' };
  };

  assert.equal((await service.selectAccountNodeAuto({ lane: 0, identity: 'first', verify })).node, 'US-advanced');
  assert.equal((await service.selectAccountNodeAuto({ lane: 1, identity: 'second', verify })).node, 'SG-advanced');
  assert.deepEqual(verified, ['US-advanced', 'SG-advanced']);
});

test('优先高级找不到未占用高级节点时才复用已占用高级节点', async () => {
  const nodes = ['US-advanced', 'SG-free'];
  const verified = [];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-advanced': 10, 'SG-free': 20 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async ({ node }) => {
    verified.push(node);
    return node === 'US-advanced'
      ? { tier: 'advanced', model: 'openai/gpt-5.6-luna' }
      : { tier: 'free', model: 'mimo/mimo-v2.5' };
  };

  await service.selectAccountNodeAuto({ lane: 0, identity: 'first', verify });
  const second = await service.selectAccountNodeAuto({ lane: 1, identity: 'second', verify });
  assert.equal(second.node, 'US-advanced');
  assert.deepEqual(verified, ['US-advanced', 'SG-free', 'US-advanced']);
});

test('账号进入终态后立即停止自动节点验证，不继续携带 Bearer 遍历候选', async () => {
  const nodes = ['US-A', 'SG-B'];
  const verified = [];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 10, 'SG-B': 20 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');

  await assert.rejects(
    () => service.selectAccountNodeAuto({
      lane: 0,
      identity: 'terminal-account',
      verify: async ({ node }) => {
        verified.push(node);
        throw Object.assign(new Error('账号已进入终态'), { code: 'ACCOUNT_EGRESS_TERMINAL' });
      },
    }),
    (error) => error?.code === 'ACCOUNT_EGRESS_TERMINAL',
  );
  assert.deepEqual(verified, ['US-A'], '终态错误后不得继续探测 SG-B');
});

test('账号自动节点验证结果会缓存，出口拒绝后避开原节点重选', async () => {
  let clock = 1000;
  const nodes = ['US-A', 'SG-B', 'JP-C'];
  const switches = [];
  const verified = [];
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[2] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[2], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 70, 'JP-C': 10 };
        if (method === 'PUT' && path === '/proxies/freebuff-account-3') {
          switches.push(body?.name);
          return {};
        }
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async ({ port, lane } = {}) => ({
        fetch: async () => new Response(`${lane}:${port}`),
        close: async () => {},
      }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async ({ node }) => {
    verified.push(node);
    return true;
  };

  const first = await service.selectAccountNodeAuto({ lane: 3, verify });
  assert.deepEqual(first, { lane: 3, node: 'US-A', port: 17903, cached: false },
    '旧布尔验证器应保持原返回结构');
  const cached = await service.selectAccountNodeAuto({ lane: 3, verify });
  assert.equal(cached.node, 'US-A');
  assert.equal(cached.cached, true);
  assert.deepEqual(verified, ['US-A'], '缓存命中不得重复探测上游模型目录');

  service.noteEgressReject({ lane: 3, state: 'country_blocked', status: 403 });
  clock += 1;
  const reselected = await service.selectAccountNodeAuto({ lane: 3, verify });
  assert.equal(reselected.node, 'SG-B', '被拒节点冷却期间必须换下一个健康 US/SG');
  assert.deepEqual(verified, ['US-A', 'SG-B']);
  assert.deepEqual(switches, ['US-A', 'SG-B']);
});

test('账号自动节点验证缓存过期后重新以该账号探测', async () => {
  let clock = 10_000;
  let verified = 0;
  const nodes = ['US-A'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async () => {
    verified++;
    return { tier: 'advanced', model: 'openai/gpt-5.6-luna' };
  };
  await service.selectAccountNodeAuto({ lane: 2, verify });
  const activeFetch = service.getAccountFetch(2);
  clock += 10 * 60 * 1000 + 1;
  assert.equal(service.getAccountAutoFetch(2), null, '过期验证不能继续伪装成 fresh');
  assert.equal(service.getAccountAutoFetch(2, { allowStale: true }), activeFetch,
    '缓存过期但历史验证与当前节点仍一致时，应提供 stale fetch 给首个业务请求');
  const afterExpiry = await service.selectAccountNodeAuto({ lane: 2, verify });
  assert.equal(afterExpiry.cached, false);
  assert.equal(verified, 2, '十分钟缓存过期后必须重新访问模型目录');

  service.noteEgressReject({ lane: 2, state: 'country_blocked', status: 403 });
  assert.equal(service.getAccountAutoFetch(2, { allowStale: true }), null,
    '明确被上游拒绝后，历史验证必须立刻失效，不能再走 stale 节点');
});

test('免费授权验证缓存恰好十五分钟', async () => {
  let clock = 20_000;
  let verified = 0;
  const nodes = ['US-A'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async () => {
    verified++;
    return { tier: 'free', model: 'mimo/mimo-v2.5' };
  };

  const first = await service.selectAccountNodeAuto({ lane: 2, verify });
  assert.equal(first.tier, 'free');
  assert.equal(first.model, 'mimo/mimo-v2.5');
  clock += 15 * 60 * 1000 - 1;
  assert.ok(service.getAccountAutoFetch(2), '十五分钟届满前仍应 fresh');
  assert.deepEqual(
    await service.selectAccountNodeAuto({ lane: 2, verify }),
    { lane: 2, node: 'US-A', port: 17902, cached: true, tier: 'free', model: 'mimo/mimo-v2.5' },
    '缓存命中应保留授权层级与验证模型',
  );
  assert.equal(verified, 1);

  clock += 1;
  assert.equal(service.getAccountAutoFetch(2), null, '十五分钟届满时必须过期');
  const refreshed = await service.selectAccountNodeAuto({ lane: 2, verify });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.tier, 'free');
  assert.equal(verified, 2);
});

test('节点测活失败只让账号验证过期，旧路由继续承载后台重验', async () => {
  let selectedNodeHealthy = true;
  let accountRefreshes = 0;
  const nodes = ['US-A', 'US-B'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) {
          return selectedNodeHealthy ? { 'US-A': 30, 'US-B': 40 } : { 'US-B': 40 };
        }
        return {};
      },
    },
    service: {
      now: () => 50_000,
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
      onAutoRefresh: () => { accountRefreshes++; },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({
    lane: 3,
    verify: async () => ({ tier: 'free', model: 'mimo/mimo-v2.5' }),
  });
  const activeFetch = service.getAccountAutoFetch(3);
  assert.equal(typeof activeFetch, 'function');

  selectedNodeHealthy = false;
  await service.testHealth();
  assert.equal(accountRefreshes, 1, '测活使旧验证过期后应立即调度后台重验');
  assert.equal(service.getAccountAutoFetch(3), null, '测活失败后必须触发后台重验');
  assert.equal(service.getAccountAutoFetch(3, { allowStale: true }), activeFetch,
    '测活的瞬时失败不能删除旧业务路由并把账号直接变成不可用');
});

test('后台授权复验异常时保留旧路由并一分钟后重试', async () => {
  let clock = 100_000;
  let selectedNodeHealthy = true;
  let accountRefreshes = 0;
  const nodes = ['US-A'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) {
          return selectedNodeHealthy ? { 'US-A': 30 } : {};
        }
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
      onAutoRefresh: () => { accountRefreshes++; },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({
    lane: 4,
    verify: async () => ({ tier: 'advanced', model: 'openai/gpt-5.6-luna' }),
  });
  const activeFetch = service.getAccountAutoFetch(4);
  clock += 10 * 60 * 1000 + 1;

  await assert.rejects(
    () => service.selectAccountNodeAuto({ lane: 4, verify: async () => { throw new Error('probe timeout'); } }),
    /没有可用账号授权/,
  );
  assert.equal(service.getAccountAutoFetch(4), activeFetch,
    '探测异常后的短退避期内旧路由应继续可用');
  selectedNodeHealthy = false;
  clock += 60 * 1000 - 1;
  await service.testHealth();
  assert.equal(accountRefreshes, 0,
    '持续失败的节点测活不能覆盖授权探测的一分钟退避');
  clock += 1;
  await service.testHealth();
  assert.equal(accountRefreshes, 1,
    '一分钟退避届满后，节点仍不健康时应重新调度账号验证');
  assert.equal(service.getAccountAutoFetch(4), null, '一分钟后必须再次进入后台复验');
  assert.equal(service.getAccountAutoFetch(4, { allowStale: true }), activeFetch);
});

test('多个账号并发自动选点优先分散，节点不足时才复用', async () => {
  const nodes = ['US-A', 'US-B', 'SG-C'];
  const verified = [];
  const switches = [];
  const probeSwitches = [];
  const probePorts = [];
  const closedProbePorts = [];
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstProbe = new Promise((resolve) => { firstStarted = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 10, 'US-B': 20, 'SG-C': 30 };
        if (method === 'PUT' && /^\/proxies\/freebuff-account-probe-\d+$/.test(path)) {
          probeSwitches.push({ lane: path.split('-').at(-1), node: body?.name });
        } else if (method === 'PUT' && /^\/proxies\/freebuff-account-\d+$/.test(path)) {
          switches.push({ lane: path.split('-').at(-1), node: body?.name });
        }
        return {};
      },
    },
    service: {
      buildFetch: async ({ port, lane }) => {
        if (lane !== 'probe') return { fetch: async () => new Response('ok'), close: async () => {} };
        probePorts.push(port);
        return {
          fetch: async () => new Response('ok'),
          close: async () => { closedProbePorts.push(port); },
        };
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async ({ node }) => {
    verified.push(node);
    if (verified.length === 1) {
      firstStarted();
      await firstGate;
    }
    return true;
  };

  const first = service.selectAccountNodeAuto({ lane: 0, identity: 'a', verify });
  await firstProbe;
  const second = service.selectAccountNodeAuto({ lane: 1, identity: 'b', verify });
  const third = service.selectAccountNodeAuto({ lane: 2, identity: 'c', verify });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(verified.length, 3,
    '不同账号必须通过独立 probe lane 同时验证，不能排在首个慢账号后面');
  releaseFirst();
  const selected = await Promise.all([first, second, third]);
  assert.equal(new Set(selected.map((entry) => entry.node)).size, 3,
    '有三个可用节点时，三个并发账号不得共享同一节点');
  assert.deepEqual(selected.map((entry) => entry.node).sort(), nodes.slice().sort());
  assert.deepEqual(probeSwitches.map((entry) => entry.lane).sort(), ['0', '1', '2'],
    '每个账号必须使用自己的 probe selector');
  assert.deepEqual(probePorts.slice().sort((a, b) => a - b), [17964, 17965, 17966],
    '每个账号必须使用自己的 probe listener 端口');

  const fourth = await service.selectAccountNodeAuto({ lane: 3, identity: 'd', verify });
  assert.ok(nodes.includes(fourth.node), '节点不足时允许复用已有节点');
  assert.equal(switches.length, 4);

  const verifiedBeforeCacheHit = verified.length;
  const cachedShared = await service.selectAccountNodeAuto({ lane: 0, identity: 'a', verify });
  assert.equal(cachedShared.cached, true, '所有候选均已占用时，共享节点仍应命中有效缓存');
  assert.equal(verified.length, verifiedBeforeCacheHit, '合法共享不得反复探测模型目录');
  await service.stop();
  assert.deepEqual(closedProbePorts.slice().sort((a, b) => a - b), [17964, 17965, 17966, 17967],
    '停止服务时必须关闭所有账号 probe dispatcher');
});

test('候选快照建立后多账号自动验证不重复读取全局节点池', async () => {
  const nodes = ['US-A', 'US-B', 'SG-C'];
  let poolReads = 0;
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') {
          poolReads++;
          return { all: nodes, now: nodes[0] };
        }
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 10, 'US-B': 20, 'SG-C': 30 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  assert.equal(service.getAccountAutoCandidates().length, 3, '订阅刷新应先建立可用候选快照');
  poolReads = 0;

  await Promise.all([
    service.selectAccountNodeAuto({ lane: 0, identity: 'account-a', verify: async () => true }),
    service.selectAccountNodeAuto({ lane: 1, identity: 'account-b', verify: async () => true }),
    service.selectAccountNodeAuto({ lane: 2, identity: 'account-c', verify: async () => true }),
  ]);

  assert.equal(poolReads, 0,
    '账号验证应只读内存候选快照，不应按账号重复 GET /proxies/freebuff-pool');
});

test('自动选点优先避开手动账号已占用的节点', async () => {
  const nodes = ['US-A', 'US-B'];
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 10, 'US-B': 50 };
        return method === 'PUT' ? {} : {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 0, identity: 'manual', node: 'US-A' });
  const selected = await service.selectAccountNodeAuto({ lane: 1, identity: 'auto', verify: async () => true });
  assert.equal(selected.node, 'US-B', '自动账号应优先选择没有被其他账号占用的节点');
});

test('账号自动验证使用隔离 probe lane，切换节点时重建业务 dispatcher', async () => {
  let clock = 20_000;
  let delays = { 'US-A': 40, 'SG-B': 70 };
  const nodes = ['US-A', 'SG-B'];
  const switches = [];
  const built = [];
  const closed = [];
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return delays;
        if (method === 'PUT') switches.push({ path, node: body?.name });
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async ({ port, lane } = {}) => {
        const id = built.length;
        const fetch = async () => new Response(`${String(lane)}:${port}:${id}`);
        built.push({ lane, port, fetch });
        return { fetch, close: async () => { closed.push({ lane, id }); } };
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 6, identity: 'token-a', verify: async () => true });
  const firstBusinessFetch = service.getAccountFetch(6, { identity: 'token-a' });
  const firstGeneration = service.getAccountGeneration(6);
  assert.equal(service.getAccountNode(6), 'US-A');

  clock += 10 * 60 * 1000 + 1;
  delays = { 'US-A': 40, 'SG-B': 10 };
  const selected = await service.selectAccountNodeAuto({
    lane: 6,
    identity: 'token-a',
    verify: async ({ node }) => {
      assert.equal(service.getAccountNode(6), 'US-A',
        '候选验证期间业务 lane 必须继续固定在旧节点');
      assert.equal(service.getAccountFetch(6, { identity: 'token-a' }), firstBusinessFetch,
        '候选验证不能替换正在承载业务的 dispatcher');
      return node === 'SG-B';
    },
  });

  assert.equal(selected.node, 'SG-B');
  assert.notEqual(service.getAccountFetch(6, { identity: 'token-a' }), firstBusinessFetch,
    '业务 selector 真正换节点后必须使用新的 ProxyAgent，不能复用旧 CONNECT');
  assert.ok(switches.some((entry) => entry.path === '/proxies/freebuff-account-probe-6' && entry.node === 'SG-B'),
    '候选节点必须经隔离 probe selector 验证');
  assert.deepEqual(switches.filter((entry) => entry.path === '/proxies/freebuff-account-6').map((entry) => entry.node),
    ['US-A', 'SG-B'], '业务 selector 每次只切到已验证通过的节点');
  assert.ok(closed.some((entry) => entry.lane === 6), '换业务节点后必须关闭旧 dispatcher');
  assert.notEqual(service.getAccountGeneration(6), firstGeneration);

  service.noteEgressReject({
    lane: 6,
    node: 'US-A',
    generation: firstGeneration,
    state: 'country_blocked',
    status: 403,
  });
  assert.equal(service.getAccountReject(6), null,
    '旧代际请求的迟到拒绝不得归因到已经切换后的 SG-B');
  assert.ok(service.getAccountAutoFetch(6, { identity: 'token-a' }),
    '旧节点迟到拒绝不得使当前已验证节点失效');
});

test('账号自动验证缓存绑定 token 身份，换 token 后必须重新验证', async () => {
  const nodes = ['US-A'];
  let verified = 0;
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const verify = async () => { verified++; return true; };
  await service.selectAccountNodeAuto({ lane: 7, identity: 'token-a', verify });
  assert.ok(service.getAccountAutoFetch(7, { identity: 'token-a' }));
  assert.equal(service.getAccountAutoFetch(7, { identity: 'token-b', allowStale: true }), null,
    '旧 token 的验证结果不得授权新 token 使用该 lane');
  const changed = await service.selectAccountNodeAuto({ lane: 7, identity: 'token-b', verify });
  assert.equal(changed.cached, false);
  assert.equal(verified, 2, 'token 轮换后必须重新访问模型目录');
});

test('lane 复用同名节点后忽略旧身份的迟到拒绝', async () => {
  const nodes = ['US-A'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 12, identity: 'account-a', verify: async () => true });
  const oldGeneration = service.getAccountGeneration(12);

  await service.releaseAccountLane(12);
  await service.selectAccountNodeAuto({ lane: 12, identity: 'account-b', verify: async () => true });
  assert.ok(service.getAccountAutoFetch(12, { identity: 'account-b' }));

  service.noteEgressReject({
    lane: 12,
    node: 'US-A',
    generation: oldGeneration,
    state: 'country_blocked',
    status: 403,
  });

  assert.ok(service.getAccountAutoFetch(12, { identity: 'account-b' }),
    '旧身份的拒绝不得删除复用 lane 上新身份的验证结果');
  assert.equal(service.getAccountReject(12), null,
    '旧身份的拒绝不得归因到复用 lane 上的新账号');
});

test('节点切换完成后收到拒绝时不得提交该节点的自动验证', async () => {
  const nodes = ['US-A', 'SG-B'];
  let blockUsSwitch = false;
  let releaseUsSwitch;
  let signalUsSwitch;
  const usSwitchStarted = new Promise((resolve) => { signalUsSwitch = resolve; });
  const usSwitchGate = new Promise((resolve) => { releaseUsSwitch = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        if (method === 'PUT' && path === '/proxies/freebuff-account-13'
          && body?.name === 'US-A' && blockUsSwitch) {
          signalUsSwitch();
          await usSwitchGate;
        }
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 13, node: 'SG-B', identity: 'account-a' });
  const previousGeneration = service.getAccountGeneration(13);

  blockUsSwitch = true;
  const selecting = service.selectAccountNodeAuto({
    lane: 13,
    identity: 'account-a',
    force: true,
    verify: async () => true,
  });
  await usSwitchStarted;

  let watchCount = 0;
  const rejectedDuringCommit = new Promise((resolve, reject) => {
    const watch = () => {
      const generation = service.getAccountGeneration(13);
      if (service.getAccountNode(13) === 'US-A' && generation !== previousGeneration) {
        service.noteEgressReject({
          lane: 13,
          node: 'US-A',
          generation,
          state: 'country_blocked',
          status: 403,
        });
        resolve();
        return;
      }
      if (++watchCount > 1000) {
        reject(new Error('未观察到 US-A 切换提交窗口'));
        return;
      }
      queueMicrotask(watch);
    };
    queueMicrotask(watch);
  });
  releaseUsSwitch();

  const [selected] = await Promise.all([selecting, rejectedDuringCommit]);
  assert.equal(selected.node, 'SG-B', '提交前被拒的 US-A 必须跳过并继续尝试下一候选');
  assert.equal(service.getAccountNode(13), 'SG-B');
  assert.ok(service.getAccountAutoFetch(13, { identity: 'account-a' }),
    '最终只允许未被拒的候选作为自动业务出口');
});

test('provider 刷新移除已选节点后立即让账号 lane 失效', async () => {
  let nodes = ['US-A', 'SG-B'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) {
          return Object.fromEntries(nodes.map((node, index) => [node, 40 + index * 10]));
        }
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 8, node: 'US-A' });
  assert.ok(service.getAccountFetch(8));

  nodes = ['SG-B'];
  await service.refresh();
  assert.equal(service.getAccountNode(8), null);
  assert.equal(service.getAccountFetch(8), null,
    '已从 provider 删除的节点不能静默回退后继续显示 ready');
});

test('自动重选同步 provider 时移除旧节点，当前恢复操作仍可提交新节点', async () => {
  let nodes = ['US-A', 'SG-B'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) {
          return Object.fromEntries(nodes.map((node, index) => [node, 40 + index * 10]));
        }
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 10, identity: 'account-a', verify: async () => true });
  assert.equal(service.getAccountNode(10), 'US-A');

  nodes = ['SG-B'];
  const selected = await service.selectAccountNodeAuto({
    lane: 10,
    identity: 'account-a',
    force: true,
    verify: async () => true,
  });
  assert.equal(selected.node, 'SG-B');
  assert.equal(service.getAccountNode(10), 'SG-B');
});

test('provider 刷新后 selector 实际节点与记录不一致时 lane 失效', async () => {
  const nodes = ['US-A', 'SG-B'];
  let accountNow = 'US-A';
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path === '/proxies/freebuff-account-9') {
          if (method === 'PUT') accountNow = body?.name;
          return { now: accountNow, all: nodes };
        }
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 9, node: 'US-A' });
  assert.ok(service.getAccountFetch(9));

  accountNow = 'SG-B';
  await service.refresh();
  assert.equal(service.getAccountNode(9), null);
  assert.equal(service.getAccountFetch(9), null,
    'mihomo selector 回退到其他节点后不能继续报告旧节点 ready');
});

test('状态查询的迟到 selector 响应不得清除并发完成的新节点', async () => {
  const nodes = ['US-A', 'SG-B'];
  let accountNow = 'US-A';
  let holdStatusRead = false;
  let signalStatusRead;
  let releaseStatusRead;
  const statusReadStarted = new Promise((resolve) => { signalStatusRead = resolve; });
  const statusReadGate = new Promise((resolve) => { releaseStatusRead = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        if (path === '/proxies/freebuff-account-14') {
          if (method === 'PUT') {
            accountNow = body?.name;
            return {};
          }
          if (holdStatusRead) {
            signalStatusRead();
            await statusReadGate;
          }
          return { now: accountNow, all: nodes };
        }
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 14, node: 'US-A', identity: 'account-a' });

  holdStatusRead = true;
  const status = service.status();
  await statusReadStarted;
  const manual = service.setAccountNode({ lane: 14, node: 'SG-B', identity: 'account-a' });
  await Promise.race([
    manual,
    new Promise((resolve) => setImmediate(resolve)),
  ]);
  releaseStatusRead();
  await Promise.all([status, manual]);

  assert.equal(service.getAccountNode(14), 'SG-B',
    '较早开始的状态查询不能在 await 后清除较晚完成的手动切换');
  assert.ok(service.getAccountFetch(14, { identity: 'account-a' }));
});

test('provider 成功刷新原子替换同名候选，旧业务路由可 stale 使用到后台复验', async () => {
  const nodes = ['US-A'];
  let accountNow = '';
  let verified = 0;
  let businessBuilds = 0;
  const closedBusiness = [];
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        if (path === '/proxies/freebuff-account-15') {
          if (method === 'PUT') accountNow = body?.name || '';
          return { now: accountNow, all: nodes };
        }
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => {
        if (lane === 'probe') return { fetch: async () => new Response('ok'), close: async () => {} };
        if (lane == null) return { fetch: async () => new Response('ok'), close: async () => {} };
        const buildId = ++businessBuilds;
        const accountFetch = async () => new Response(String(buildId));
        accountFetch.buildId = buildId;
        return {
          fetch: accountFetch,
          close: async () => { closedBusiness.push(buildId); },
        };
      },
    },
  });
  const verify = async () => { verified++; return true; };
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 15, identity: 'account-a', verify });
  assert.equal(verified, 1);
  const firstFetch = service.getAccountFetch(15, { identity: 'account-a' });
  const firstGeneration = service.getAccountGeneration(15);

  await service.refresh();
  assert.equal(
    service.getAccountAutoFetch(15, { allowStale: true, identity: 'account-a' }),
    firstFetch,
    '同名节点的新候选快照就绪后，旧业务路由应继续 stale 承载到后台复验完成',
  );
  const selected = await service.selectAccountNodeAuto({ lane: 15, identity: 'account-a', verify });
  assert.equal(selected.cached, false, 'provider 拓扑刷新后不得命中刷新前验证缓存');
  assert.equal(verified, 2, '同名节点也必须重新读取该账号可见的模型目录');
  const secondFetch = service.getAccountFetch(15, { identity: 'account-a' });
  assert.notEqual(secondFetch, firstFetch, '同名节点也必须重建业务 dispatcher');
  assert.notEqual(service.getAccountGeneration(15), firstGeneration,
    '业务 dispatcher 换代必须分配新 generation，隔离刷新前迟到拒绝');
  assert.equal(businessBuilds, 2);
  assert.deepEqual(closedBusiness, [1]);
});

test('后台重验期间收到出口拒绝时不得把旧节点重新标成有效', async () => {
  let clock = 10_000;
  let releaseVerify;
  let verifyStarted;
  const started = new Promise((resolve) => { verifyStarted = resolve; });
  const nodes = ['US-A'];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      now: () => clock,
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 4, verify: async () => true });
  clock += 10 * 60 * 1000 + 1;

  const revalidating = service.selectAccountNodeAuto({
    lane: 4,
    verify: async () => {
      verifyStarted();
      return new Promise((resolve) => { releaseVerify = resolve; });
    },
  });
  await started;
  service.noteEgressReject({ lane: 4, state: 'country_blocked', status: 403 });
  releaseVerify(true);
  await assert.rejects(revalidating, /没有可用账号授权/);
  assert.equal(service.getAccountAutoFetch(4, { allowStale: true }), null);
});

test('mihomo 重启后账号 selector 必须重新钉节点，不能复用旧内存状态', async () => {
  const nodes = ['US-A'];
  const switches = [];
  let verified = 0;
  const { service } = fakeService({
    controller: {
      async request(path, method = 'GET', body) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        if (method === 'PUT' && path === '/proxies/freebuff-account-5') {
          switches.push(body?.name);
        }
        return {};
      },
    },
    service: {
      buildFetch: async () => ({ fetch: async () => new Response('ok'), close: async () => {} }),
    },
  });
  const verify = async () => { verified++; return true; };
  await service.setSubscription('https://sub.example.com/one');
  await service.selectAccountNodeAuto({ lane: 5, verify });

  await service.setSubscription('https://sub.example.com/two');
  await service.selectAccountNodeAuto({ lane: 5, verify });

  assert.deepEqual(switches, ['US-A', 'US-A'], '新内核的 selector 必须重新 PUT');
  assert.equal(verified, 2, '内核重启后必须重新按账号验证模型能力');
});

test('释放一个账号 lane 不影响其他账号 dispatcher', async () => {
  const nodes = ['US-A', 'SG-B'];
  const closed = [];
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => ({
        fetch: async () => new Response(String(lane)),
        close: async () => { closed.push(lane); },
      }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 0, node: 'US-A' });
  await service.setAccountNode({ lane: 1, node: 'SG-B' });
  const laneOneFetch = service.getAccountFetch(1);

  await service.releaseAccountLane(0);
  assert.equal(service.getAccountFetch(0), null);
  assert.equal(service.getAccountFetch(1), laneOneFetch);
  assert.deepEqual(closed, [0]);
});

test('释放账号 lane 不等待活跃长流关闭，也不阻塞其他控制操作', async () => {
  const nodes = ['US-A', 'SG-B'];
  let releaseClose;
  const closeStarted = new Promise((resolve) => { releaseClose = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => ({
        fetch: async () => new Response(String(lane)),
        close: lane === 0 ? () => closeStarted : async () => {},
      }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await service.setAccountNode({ lane: 0, node: 'US-A' });
  await service.setAccountNode({ lane: 1, node: 'SG-B' });

  const released = service.releaseAccountLane(0);
  const outcome = await Promise.race([
    released.then(() => 'released'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
  ]);
  assert.equal(outcome, 'released', 'release 不得等待 ProxyAgent.close 的活跃请求 drain');
  assert.equal(service.getAccountFetch(0), null);
  assert.ok(service.getAccountFetch(1));
  releaseClose();
});

test('慢自动探测不阻塞手动 lane，迟到结果不得覆盖手动节点', async () => {
  const nodes = ['US-A', 'SG-B'];
  let releaseVerify;
  let verifyStarted;
  const started = new Promise((resolve) => { verifyStarted = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40, 'SG-B': 50 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => ({
        fetch: async () => new Response(String(lane)),
        close: async () => {},
      }),
    },
  });
  await service.setSubscription('https://sub.example.com/list');

  const automatic = service.selectAccountNodeAuto({
    lane: 0,
    identity: 'account-a',
    verify: async () => {
      verifyStarted();
      return new Promise((resolve) => { releaseVerify = resolve; });
    },
  });
  await started;

  const manual = service.setAccountNode({ lane: 0, node: 'SG-B', identity: 'account-a' });
  const outcome = await Promise.race([
    manual.then(() => 'manual-ready'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
  ]);
  assert.equal(outcome, 'manual-ready', '自动模型探测不得持有整个代理控制锁');
  releaseVerify(true);
  await assert.rejects(automatic, (error) => error?.code === 'ACCOUNT_EGRESS_SUPERSEDED');
  assert.equal(service.getAccountNode(0), 'SG-B', '迟到的自动探测不得覆盖后来的手动选择');
});

test('拓扑切换后迟到的 probe dispatcher 不得跨拓扑复用', async () => {
  const nodes = ['US-A'];
  let probeBuilds = 0;
  const closedProbeIds = [];
  const verifiedProbeIds = [];
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => {
        if (lane === 'probe') {
          const probeId = ++probeBuilds;
          probeStarted();
          await probeGate;
          const probeFetch = async () => new Response('ok');
          probeFetch.probeId = probeId;
          return {
            fetch: probeFetch,
            close: async () => { closedProbeIds.push(probeId); },
          };
        }
        return { fetch: async () => new Response('ok'), close: async () => {} };
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const selecting = service.selectAccountNodeAuto({
    lane: 6,
    identity: 'account-a',
    verify: async ({ fetch }) => { verifiedProbeIds.push(fetch.probeId); return true; },
  });
  await started;

  await service.stop();
  releaseProbe();
  await assert.rejects(selecting, (error) => error?.code === 'ACCOUNT_EGRESS_SUPERSEDED');
  assert.deepEqual(verifiedProbeIds, [], '旧拓扑 dispatcher 不得执行账号模型验证');
  assert.deepEqual(closedProbeIds, [1], '未提交的旧 topology dispatcher 必须关闭且只关闭一次');

  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({
    lane: 6,
    identity: 'account-a',
    force: true,
    verify: async ({ fetch }) => { verifiedProbeIds.push(fetch.probeId); return true; },
  });
  assert.equal(probeBuilds, 2, '拓扑切换后必须重建 probe dispatcher，不能复用迟到的旧连接');
  assert.deepEqual(verifiedProbeIds, [2], '新拓扑只能使用新构建的 probe dispatcher 验证');
});

test('probe selector PUT 期间切换拓扑时旧操作不得继续构建', async () => {
  const nodes = ['US-A'];
  let probePuts = 0;
  let probeBuilds = 0;
  let verifies = 0;
  let signalPut;
  const putStarted = new Promise((resolve) => { signalPut = resolve; });
  let releasePut;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  const { service } = fakeService({
    controller: {
      async request(path, method) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        if (path === '/proxies/freebuff-account-probe-7' && method === 'PUT') {
          probePuts++;
          if (probePuts === 1) {
            signalPut();
            await putGate;
          }
        }
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => {
        if (lane === 'probe') probeBuilds++;
        return { fetch: async () => new Response('ok'), close: async () => {} };
      },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  const selecting = service.selectAccountNodeAuto({
    lane: 7,
    identity: 'account-a',
    verify: async () => { verifies++; return true; },
  });
  await putStarted;

  await service.stop();
  releasePut();
  await assert.rejects(selecting, (error) => error?.code === 'ACCOUNT_EGRESS_SUPERSEDED');
  assert.equal(probeBuilds, 0, '过期 PUT 完成后不得继续构建 dispatcher');
  assert.equal(verifies, 0, '过期 PUT 不得进入账号模型验证');

  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({
    lane: 7,
    identity: 'account-a',
    force: true,
    verify: async () => { verifies++; return true; },
  });
  assert.equal(probePuts, 2, '新拓扑必须重新切换 probe selector');
  assert.equal(probeBuilds, 1);
  assert.equal(verifies, 1);
});

test('仅刷新 provider 后同名 probe 节点也必须重建连接', async () => {
  const nodes = ['US-A'];
  let probePuts = 0;
  let probeBuilds = 0;
  const closedProbeIds = [];
  const verifiedProbeIds = [];
  const { service } = fakeService({
    controller: {
      async request(path, method) {
        if (path === '/proxies/freebuff-pool') return { all: nodes, now: nodes[0] };
        if (path === '/proxies/freebuff-auto') return { now: nodes[0], all: nodes };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        if (path === '/proxies/freebuff-account-8') return { all: nodes, now: 'US-A' };
        if (path === '/proxies/freebuff-account-probe-8' && method === 'PUT') probePuts++;
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => {
        if (lane !== 'probe') return { fetch: async () => new Response('ok'), close: async () => {} };
        const probeId = ++probeBuilds;
        const probeFetch = async () => new Response('ok');
        probeFetch.probeId = probeId;
        return {
          fetch: probeFetch,
          close: async () => { closedProbeIds.push(probeId); },
        };
      },
    },
  });
  const verify = async ({ fetch }) => { verifiedProbeIds.push(fetch.probeId); return true; };
  await service.setSubscription('https://sub.example.com/list');
  await service.selectAccountNodeAuto({ lane: 8, identity: 'account-a', verify });
  await service.refresh();
  await service.selectAccountNodeAuto({ lane: 8, identity: 'account-a', verify });

  assert.equal(probePuts, 2, 'refresh 后同名节点也要重新 PUT');
  assert.equal(probeBuilds, 2, 'refresh 后不得复用旧 topology 的 probe dispatcher');
  assert.deepEqual(verifiedProbeIds, [1, 2]);
  assert.deepEqual(closedProbeIds, [1], '刷新前的 probe dispatcher 必须在重建时关闭');
});

test('probe dispatcher 构建结果无 fetch 时仍关闭未提交资源', async () => {
  let closed = 0;
  const { service } = fakeService({
    controller: {
      async request(path) {
        if (path === '/proxies/freebuff-pool') return { all: ['US-A'], now: 'US-A' };
        if (path === '/proxies/freebuff-auto') return { now: 'US-A', all: ['US-A'] };
        if (path.startsWith('/group/freebuff-pool/delay')) return { 'US-A': 40 };
        return {};
      },
    },
    service: {
      buildFetch: async ({ lane }) => lane === 'probe'
        ? { close: async () => { closed++; } }
        : { fetch: async () => new Response('ok'), close: async () => {} },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  await assert.rejects(
    service.selectAccountNodeAuto({ lane: 9, verify: async () => true }),
    /没有可用账号授权/,
  );
  assert.equal(closed, 1, '无有效 fetch 的 probe dispatcher 也必须释放');
});

test('管理 API 暴露订阅、刷新、节点、测活与更新设置路由', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const marker of ["sub === 'subscription'", "sub === 'refresh'", "sub === 'node'", "sub === 'health'", "sub === 'update'"]) {
    assert.ok(server.includes(marker), `server.js 缺少代理路由: ${marker}`);
  }
});

test('透明转发使用 pipeline 传播背压与客户端断流', () => {
  const server = readFileSync(new URL('../server/http-adapter.mjs', import.meta.url), 'utf8');
  assert.ok(
    server.includes('await pipeline(Readable.fromWeb(response.body), nodeRes)'),
    'server.js 必须通过 Node pipeline 转发 Web response body',
  );
});

test('客户端在 worker Response 前断开会中止 Request.signal', async () => {
  const adapter = await import('../server/http-adapter.mjs').catch(() => ({}));
  assert.equal(typeof adapter.forwardWorkerRequest, 'function', '必须提供可测试的 HTTP 转发桥');

  let workerRequest = null;
  let startedResolve;
  let abortedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const aborted = new Promise((resolve) => { abortedResolve = resolve; });
  const handler = {
    async fetch(request) {
      workerRequest = request;
      startedResolve();
      await new Promise((_, reject) => {
        if (request.signal.aborted) return reject(request.signal.reason);
        request.signal.addEventListener('abort', () => {
          abortedResolve();
          reject(request.signal.reason || new Error('client disconnected'));
        }, { once: true });
      });
    },
  };
  const server = createServer((req, res) => {
    adapter.forwardWorkerRequest(req, res, handler, {}).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/v1/chat/completions', method: 'POST' });
  client.on('error', () => {});
  client.end('{}');
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker 未开始处理请求')), 2000)),
  ]);
  client.destroy();
  await Promise.race([
    aborted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('客户端断开未传播到 worker')), 1000)),
  ]);
  assert.equal(workerRequest.signal.aborted, true);
  await new Promise((resolve) => server.close(resolve));
});

test('正常透明响应不会误触发 Request.signal abort', async () => {
  const { forwardWorkerRequest } = await import('../server/http-adapter.mjs');
  let workerSignal;
  const handler = {
    async fetch(request) {
      workerSignal = request.signal;
      return new Response('ok', { status: 200 });
    },
  };
  const server = createServer((req, res) => {
    forwardWorkerRequest(req, res, handler, {}).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const body = await new Promise((resolve, reject) => {
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/healthz', method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    client.on('error', reject);
    client.end();
  });
  assert.equal(body, 'ok');
  assert.equal(workerSignal.aborted, false);
  await new Promise((resolve) => server.close(resolve));
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}
console.log(`${tests.length} proxy tests passed`);
