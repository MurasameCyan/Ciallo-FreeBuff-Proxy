import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProxyService, maskSubscriptionUrl, resolveProxySettings } from '../server/proxy.mjs';

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
  const { service } = fakeService({
    settings: { autoHealthCheck: false },
    service: {
      setIntervalFn: (fn, ms) => { const id = ++seq; timers.push({ id, fn, ms }); return id; },
      clearIntervalFn: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    },
  });
  await service.setSubscription('https://sub.example.com/list');
  assert.equal(timers.length, 0, '自动测活与自动更新均关闭时不应注册定时器');
  const armed = await service.setUpdate({ enabled: true, interval: 3600 });
  assert.equal(armed.autoUpdate, true);
  assert.equal(timers.length, 1, '启用自动更新应注册一个定时器');
  assert.equal(timers[0].ms, 3600 * 1000);
  await service.setUpdate({ enabled: false, interval: 3600 });
  assert.equal(timers.length, 0, '关闭自动更新应清除定时器');
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

test('管理 API 暴露订阅、刷新、节点、测活与更新设置路由', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  for (const marker of ["sub === 'subscription'", "sub === 'refresh'", "sub === 'node'", "sub === 'health'", "sub === 'update'"]) {
    assert.ok(server.includes(marker), `server.js 缺少代理路由: ${marker}`);
  }
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
