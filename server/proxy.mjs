/**
 * proxy.mjs —— 出站代理（订阅 → mihomo 内核 → undici ProxyAgent）。
 *
 * 移植自 Ciallo-Zen-Proxy（MIT）的核心思想，但出站接法不同：
 *   Zen：https.request + 手写 MihomoAgent（每请求一条 CONNECT 隧道，换 IP）
 *   我们：worker.js 用全局 fetch（undici）。Node 22 的 undici 支持 fetch 的
 *         dispatcher 选项，所以用 ProxyAgent 指向 mihomo 的 mixed-port，
 *         worker 侧通过 env.FREEBUFF_UPSTREAM_FETCH 注入（见 worker.js up()）。
 *
 * 订阅解析完全交给 mihomo 内核的 proxy-providers（同 Zen）：
 *   给它订阅地址，它自己拉取/解析 base64/yaml/测速/缓存。Node 零解析。
 *
 * 部署形态：
 *   - 配置了 SUBSCRIPTION_URL：启动 mihomo → 生成 yaml → 注入走代理的 fetch
 *   - 未配置：直连（保持现有行为，Worker/无内核环境不受影响）
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMihomoManager } from './mihomo.mjs';

// ── 端口/路径常量（env 可覆盖，避免和本机其它 clash 类程序撞端口） ──
const MIXED_PORT = parseInt(process.env.MIHOMO_MIXED_PORT || '17897', 10); // 出站 HTTP 代理端口
const CTRL_PORT = parseInt(process.env.MIHOMO_CTRL_PORT || '19090', 10);   // external-controller
const POOL_NAME = 'freebuff-pool';
const PROVIDER_NAME = 'freebuff-airport';
const MIHOMO_BIN = process.env.MIHOMO_BIN || '/usr/local/bin/mihomo';
// mihomo 数据（订阅缓存、配置）放到数据目录。默认跟随 server.js 的 DATA_DIR
// （Docker 里是 /data 卷，node 用户可写；本地开发回退到 ./data/.mihomo）。
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FREEBUFF_DATA_ROOT = process.env.FREEBUFF_DATA_DIR
  || resolve(PROJECT_ROOT, 'data');
const MIHOMO_DATA_DIR = process.env.MIHOMO_DATA_DIR
  || resolve(FREEBUFF_DATA_ROOT, '.mihomo');
const MIHOMO_CONFIG = resolve(MIHOMO_DATA_DIR, 'config.yaml');
const PROXY_SETTINGS_FILE = resolve(MIHOMO_DATA_DIR, 'proxy-settings.json');
// 兼容早期版本：当 FREEBUFF_DATA_DIR 直接被当作 mihomo 目录时，
// 设置文件曾落在 data/proxy-settings.json；本地更早版本则使用项目根 .mihomo。
// 只读回退，后续保存会写入新的 data/.mihomo 路径。
const LEGACY_PROXY_SETTINGS_FILES = [
  resolve(FREEBUFF_DATA_ROOT, 'proxy-settings.json'),
  resolve(PROJECT_ROOT, '.mihomo', 'proxy-settings.json'),
];

const DEFAULT_PROXY_SETTINGS = Object.freeze({
  subscriptionUrl: '',
  nodeMode: 'auto',
  selectedNode: '',
  autoHealthCheck: true,
  healthCheckInterval: 300,
});
const MIN_HEALTH_INTERVAL = 30;
const MAX_HEALTH_INTERVAL = 86400;

let logger = (level, msg) => console.log(`[${level}] ${msg}`);

export function setLogger(fn) { logger = fn || logger; }
export function getMixedPort() { return MIXED_PORT; }

// ── mihomo 配置生成（移植 Zen config.mjs buildMihomoYaml） ──
// 只写 DOMAIN-SUFFIX + MATCH 两条规则是刻意的：不碰 GEOIP/GEOSITE，
// 内核就不需要 geoip.dat/geosite.dat（省几十 MB，也不触发首启联网下载）。
export function buildMihomoYaml(subscriptionUrl) {
  if (!subscriptionUrl) throw new Error('订阅地址为空');
  // JSON.stringify 转义：机场 token 里常有 & ? = #，裸写会被当注释/流式集合
  const url = JSON.stringify(String(subscriptionUrl));

  return `# 由 Ciallo FreeBuff Proxy 自动生成,手改会在下次保存时被覆盖。
mixed-port: ${MIXED_PORT}
allow-lan: false
mode: rule
log-level: warning
external-controller: 127.0.0.1:${CTRL_PORT}
ipv6: false
tcp-concurrent: true
unified-delay: true

# 刻意不写 fallback（同 Zen）：fallback 默认用 GeoIP 判采信，触发启动时
# 下载 Country.mmdb —— 容器首启就多一个必须联外网才能过的步骤。
dns:
  enable: true
  ipv6: false
  enhanced-mode: redir-host
  nameserver: [223.5.5.5, 119.29.29.29]

proxy-providers:
  ${PROVIDER_NAME}:
    type: http
    url: ${url}
    path: ./providers/${PROVIDER_NAME}.yaml
    interval: 0
    health-check:
      enable: true
      lazy: true
      url: 'http://www.gstatic.com/generate_204'
      interval: 300

proxy-groups:
  - name: ${POOL_NAME}
    type: select
    use: [${PROVIDER_NAME}]
  - name: freebuff-auto
    type: url-test
    use: [${PROVIDER_NAME}]
    url: 'http://www.gstatic.com/generate_204'
    interval: 300
    tolerance: 50

rules:
  - DOMAIN-SUFFIX,codebuff.com,${POOL_NAME}
  - MATCH,DIRECT
`;
}

export function writeMihomoConfig(subscriptionUrl) {
  mkdirSync(MIHOMO_DATA_DIR, { recursive: true });
  writeFileSync(MIHOMO_CONFIG, buildMihomoYaml(subscriptionUrl), 'utf8');
  return MIHOMO_CONFIG;
}

// ── 配置 / 脱敏 ─────────────────────────────────────────

export function maskSubscriptionUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw));
    if (!['http:', 'https:'].includes(u.protocol)) return '已配置（地址已隐藏）';
    // 机场 token 既可能在 query，也可能直接是 path 的一段，因此只保留协议与主机。
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? '/…' : ''}`;
  } catch {
    return '已配置（地址已隐藏）';
  }
}

function cleanError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"')]+/gi, '[订阅地址]')
    .replace(/([?&](?:token|key|auth|password)=)[^&\s]+/gi, '$1***')
    .slice(0, 240);
}

function normalizeInterval(value, fallback = DEFAULT_PROXY_SETTINGS.healthCheckInterval) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_HEALTH_INTERVAL && n <= MAX_HEALTH_INTERVAL ? n : fallback;
}

export function resolveProxySettings({ envUrl = '', saved = {} } = {}) {
  const lockedUrl = String(envUrl || '').trim();
  const savedUrl = String(saved?.subscriptionUrl || '').trim();
  const nodeMode = saved?.nodeMode === 'manual' ? 'manual' : 'auto';
  return {
    subscriptionUrl: lockedUrl || savedUrl,
    nodeMode,
    selectedNode: nodeMode === 'manual' ? String(saved?.selectedNode || '').trim() : '',
    autoHealthCheck: saved?.autoHealthCheck !== false,
    healthCheckInterval: normalizeInterval(saved?.healthCheckInterval),
    source: lockedUrl ? 'env' : savedUrl ? 'data' : 'none',
    envLocked: Boolean(lockedUrl),
  };
}

function readProxySettings() {
  for (const file of [PROXY_SETTINGS_FILE, ...LEGACY_PROXY_SETTINGS_FILES]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {};
}

function persistProxySettings(settings) {
  mkdirSync(dirname(PROXY_SETTINGS_FILE), { recursive: true });
  const body = JSON.stringify(settings, null, 2) + '\n';
  const tmp = PROXY_SETTINGS_FILE + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, PROXY_SETTINGS_FILE);
  } catch {
    // Windows 上目标文件被短暂占用时退回直接覆盖；配置仍保持完整 JSON。
    writeFileSync(PROXY_SETTINGS_FILE, body, 'utf8');
  }
}

function validateSubscriptionUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('订阅地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('订阅地址必须以 http:// 或 https:// 开头');
  return url;
}

function defaultController() {
  return {
    async request(path, method = 'GET', body = null) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const response = await fetch(`http://127.0.0.1:${CTRL_PORT}${path}`, {
          method,
          signal: ctrl.signal,
          headers: body == null ? undefined : { 'Content-Type': 'application/json' },
          body: body == null ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
        if (!response.ok) throw new Error(`mihomo 控制器 HTTP ${response.status}${data?.message ? `: ${data.message}` : ''}`);
        return data;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 可注入的代理服务。生产实例在文件末尾创建；测试注入假 manager/controller，
 * 因而不需要真的启动 mihomo 或访问外网。
 */
export function createProxyService({
  manager,
  controller = defaultController(),
  settings = {},
  envUrl = '',
  persist = () => {},
  writeConfig = () => {},
  buildFetch = null,
  logger: serviceLogger = () => {},
  healthUrl = process.env.MIHOMO_HEALTH_URL || 'https://www.codebuff.com/',
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!manager) throw new Error('proxy service 缺少 manager');

  const initialSavedUrl = String(settings?.subscriptionUrl || '').trim();
  const cfg = resolveProxySettings({ envUrl, saved: settings });
  // 保存一份不可变的环境变量订阅。环境变量是部署者明确指定的配置，
  // 初始化时即使调用方传入 data 中的旧地址，也不能把它覆盖掉。
  const lockedSubscriptionUrl = cfg.envLocked ? cfg.subscriptionUrl : '';
  let savedSubscriptionUrl = initialSavedUrl;
  let state = cfg.subscriptionUrl ? 'stopped' : 'disabled';
  let lastError = '';
  let lastRefreshAt = null;
  let lastHealthAt = null;
  let healthError = '';
  let version = null;
  let nodeNames = [];
  let currentNode = '';
  let healthMap = new Map();
  let upstreamFetch = null;
  let closeFetch = null;
  let healthTimer = null;
  let tail = Promise.resolve();

  const serial = (fn) => {
    const next = tail.catch(() => {}).then(fn);
    tail = next;
    return next;
  };

  function persistedShape() {
    return {
      subscriptionUrl: cfg.envLocked ? savedSubscriptionUrl : cfg.subscriptionUrl,
      nodeMode: cfg.nodeMode,
      selectedNode: cfg.selectedNode,
      autoHealthCheck: cfg.autoHealthCheck,
      healthCheckInterval: cfg.healthCheckInterval,
    };
  }

  function save() { persist(persistedShape()); }

  async function closeDispatcher() {
    const close = closeFetch;
    closeFetch = null;
    upstreamFetch = null;
    if (close) {
      try { await close(); } catch {}
    }
  }

  function stopHealthTimer() {
    if (healthTimer) clearIntervalFn(healthTimer);
    healthTimer = null;
  }

  function scheduleHealth() {
    stopHealthTimer();
    if (!cfg.autoHealthCheck || !cfg.subscriptionUrl || state !== 'ready') return;
    healthTimer = setIntervalFn(() => {
      serial(() => testHealthCore()).catch((e) => {
        healthError = cleanError(e);
        serviceLogger('warn', `[proxy] 自动测活失败: ${healthError}`);
      });
    }, cfg.healthCheckInterval * 1000);
    healthTimer?.unref?.();
  }

  function snapshot() {
    const nodes = nodeNames.map((name) => {
      const delay = healthMap.has(name) ? healthMap.get(name) : null;
      return { name, healthy: delay != null, delay, selected: name === currentNode };
    });
    // 按延迟升序排序：已测得延迟的在前（延迟低者优先），失效/未测的垫底。
    // Array.sort 在 Node 上是稳定排序，同延迟（含均为 null）保持原订阅顺序。
    nodes.sort((a, b) => (a.delay == null ? Infinity : a.delay) - (b.delay == null ? Infinity : b.delay));
    return {
      ok: state === 'ready',
      configured: Boolean(cfg.subscriptionUrl),
      state,
      urlMasked: maskSubscriptionUrl(cfg.subscriptionUrl),
      subscriptionUrlMasked: maskSubscriptionUrl(cfg.subscriptionUrl),
      version,
      nodeCount: nodeNames.length,
      healthyCount: nodes.filter((n) => n.healthy).length,
      currentNode: currentNode || null,
      lastRefreshAt,
      error: lastError || null,
      nodes,
      nodeMode: cfg.nodeMode,
      mode: cfg.nodeMode,
      selectedNode: cfg.selectedNode || null,
      autoHealthCheck: cfg.autoHealthCheck,
      healthCheckInterval: cfg.healthCheckInterval,
      health: {
        enabled: cfg.autoHealthCheck,
        interval: cfg.healthCheckInterval,
        lastCheckAt: lastHealthAt,
        error: healthError || null,
      },
      source: cfg.source,
      envLocked: cfg.envLocked,
    };
  }

  async function updatePool() {
    const pool = await controller.request(`/proxies/${encodeURIComponent(POOL_NAME)}`);
    nodeNames = Array.isArray(pool?.all) ? pool.all.map(String).filter(Boolean) : [];
    currentNode = pool?.now ? String(pool.now) : '';
    for (const name of [...healthMap.keys()]) if (!nodeNames.includes(name)) healthMap.delete(name);
    return pool;
  }

  async function switchPoolNode(name) {
    if (!name) return;
    await controller.request(`/proxies/${encodeURIComponent(POOL_NAME)}`, 'PUT', { name });
    currentNode = name;
  }

  async function applyNodeMode() {
    if (!nodeNames.length) return;
    if (cfg.nodeMode === 'manual' && cfg.selectedNode && nodeNames.includes(cfg.selectedNode)) {
      await switchPoolNode(cfg.selectedNode);
      return;
    }
    if (cfg.nodeMode === 'manual') {
      cfg.nodeMode = 'auto';
      cfg.selectedNode = '';
      save();
    }
    let target = '';
    try {
      const automatic = await controller.request(`/proxies/${encodeURIComponent('freebuff-auto')}`);
      if (automatic?.now && nodeNames.includes(String(automatic.now))) target = String(automatic.now);
    } catch {}
    if (!target) {
      const healthy = nodeNames
        .filter((name) => healthMap.get(name) != null)
        .sort((a, b) => healthMap.get(a) - healthMap.get(b));
      target = healthy[0] || nodeNames[0];
    }
    await switchPoolNode(target);
  }

  async function testHealthCore() {
    if (!cfg.subscriptionUrl) return snapshot();
    try {
      if (!(await manager.isRunning())) return snapshot();
      await updatePool();
      const query = `timeout=5000&url=${encodeURIComponent(healthUrl)}`;
      const delays = await controller.request(`/group/${encodeURIComponent(POOL_NAME)}/delay?${query}`);
      healthMap = new Map(nodeNames.map((name) => {
        const delay = Number(delays?.[name]);
        return [name, Number.isFinite(delay) && delay > 0 ? delay : null];
      }));
      healthError = '';
      lastHealthAt = new Date(now()).toISOString();
      if (cfg.nodeMode === 'auto') await applyNodeMode();
    } catch (e) {
      healthError = cleanError(e);
    }
    return snapshot();
  }

  async function failToDirect(error) {
    lastError = cleanError(error);
    state = 'error';
    stopHealthTimer();
    await closeDispatcher();
    try { await manager.stop(); } catch {}
    version = null;
    currentNode = '';
    nodeNames = [];
    serviceLogger('error', `[proxy] ${lastError}，已回落直连`);
  }

  async function ensureDispatcher() {
    if (!buildFetch || upstreamFetch) return;
    const built = await buildFetch();
    upstreamFetch = typeof built === 'function' ? built : built?.fetch || null;
    closeFetch = typeof built?.close === 'function' ? built.close : null;
    if (!upstreamFetch) throw new Error('无法创建代理出站连接');
  }

  async function startCore({ restart = false } = {}) {
    if (!cfg.subscriptionUrl) return false;
    state = 'starting';
    lastError = '';
    try {
      writeConfig(cfg.subscriptionUrl);
      if (restart && await manager.isRunning()) {
        await closeDispatcher();
        await manager.stop();
      }
      await manager.start();
      version = await manager.getVersion();
      await ensureDispatcher();
      state = 'ready';
      scheduleHealth();
      return true;
    } catch (e) {
      await failToDirect(e);
      return false;
    }
  }

  async function refreshCore({ ensureStarted = true } = {}) {
    if (!cfg.subscriptionUrl) return snapshot();
    if (ensureStarted && !(await manager.isRunning())) {
      if (!(await startCore())) return snapshot();
    }
    try {
      // 刷新失败后会关闭 dispatcher 以确保上游回落直连；若内核仍在运行，
      // 下一次刷新需要重新建立 dispatcher，而不是误以为已有代理连接。
      await ensureDispatcher();
      await controller.request(`/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}`, 'PUT');
      lastRefreshAt = new Date(now()).toISOString();
      await updatePool();
      await applyNodeMode();
      // 订阅解析后总是测活一次：填充各节点延迟、让列表按延迟排序，
      // 自动模式据此选出最快节点。周期性测活仍由 autoHealthCheck 控制（scheduleHealth）。
      await testHealthCore();
      state = 'ready';
      lastError = '';
      scheduleHealth();
    } catch (e) {
      await closeDispatcher();
      lastError = cleanError(e);
      state = 'error';
      serviceLogger('warn', `[proxy] 刷新订阅失败: ${lastError}`);
    }
    return snapshot();
  }

  async function disableCore() {
    stopHealthTimer();
    await closeDispatcher();
    try { await manager.stop(); } catch {}
    state = 'disabled';
    lastError = '';
    lastRefreshAt = null;
    lastHealthAt = null;
    healthError = '';
    version = null;
    nodeNames = [];
    currentNode = '';
    healthMap = new Map();
    return snapshot();
  }

  async function setSubscriptionCore(value) {
    if (cfg.envLocked) {
      const e = new Error('SUBSCRIPTION_URL 由环境变量配置，面板不可覆盖');
      e.code = 'ENV_LOCKED';
      throw e;
    }
    const next = validateSubscriptionUrl(value);
    const changed = next !== cfg.subscriptionUrl;
    cfg.subscriptionUrl = next;
    cfg.source = next ? 'data' : 'none';
    savedSubscriptionUrl = next;
    save();
    if (!next) return disableCore();
    if (!(await startCore({ restart: changed }))) return snapshot();
    return refreshCore({ ensureStarted: false });
  }

  return {
    async initialize(url) {
      return serial(async () => {
        if (cfg.envLocked) {
          cfg.subscriptionUrl = lockedSubscriptionUrl;
          cfg.source = 'env';
        } else if (url !== undefined && url !== null) {
          cfg.subscriptionUrl = validateSubscriptionUrl(url);
          cfg.source = cfg.subscriptionUrl ? 'data' : 'none';
        }
        if (!cfg.subscriptionUrl) return disableCore();
        if (!(await startCore())) return snapshot();
        return refreshCore({ ensureStarted: false });
      });
    },
    setSubscription(value) { return serial(() => setSubscriptionCore(value)); },
    refresh() { return serial(() => refreshCore()); },
    async status() {
      if (!cfg.subscriptionUrl) return snapshot();
      try {
        version = await manager.getVersion();
        if (version) {
          await updatePool();
          if (state === 'stopped' || state === 'starting') state = 'ready';
        } else if (state !== 'error' && state !== 'starting') {
          state = 'stopped';
          // 内核可能在 ready 后被 OOM/SIGTERM 杀掉；不能继续把旧 dispatcher
          // 注入 worker，否则请求会反复打到已失效的 mixed-port。状态探测失败
          // 时立即关闭代理连接并回落直连，下一次 refresh 会重新建立它。
          stopHealthTimer();
          await closeDispatcher();
          version = null;
          nodeNames = [];
          currentNode = '';
        } else if (state === 'error') {
          // 刷新失败已标记 error；即使控制器随后也不可达，仍确保旧连接不留。
          await closeDispatcher();
        }
      } catch (e) {
        if (state !== 'error') state = 'stopped';
        stopHealthTimer();
        await closeDispatcher();
        version = null;
        nodeNames = [];
        currentNode = '';
      }
      return snapshot();
    },
    setNode({ mode, node } = {}) {
      return serial(async () => {
        if (!['auto', 'manual'].includes(mode)) throw new Error('节点模式必须是 auto 或 manual');
        if (!cfg.subscriptionUrl || !(await manager.isRunning())) throw new Error('mihomo 未运行');
        await updatePool();
        if (mode === 'manual') {
          const name = String(node || '').trim();
          if (!name) throw new Error('手动模式必须选择节点');
          if (!nodeNames.includes(name)) throw new Error('节点不存在或已失效');
          await switchPoolNode(name);
          cfg.nodeMode = 'manual';
          cfg.selectedNode = name;
        } else {
          cfg.nodeMode = 'auto';
          cfg.selectedNode = '';
          await applyNodeMode();
        }
        save();
        return snapshot();
      });
    },
    setHealth({ enabled, interval } = {}) {
      return serial(async () => {
        if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
        const n = Number(interval);
        if (!Number.isInteger(n)) throw new Error('自动测活间隔必须是整数秒');
        if (n < MIN_HEALTH_INTERVAL || n > MAX_HEALTH_INTERVAL) {
          throw new Error(`自动测活间隔必须在 ${MIN_HEALTH_INTERVAL} 到 ${MAX_HEALTH_INTERVAL} 秒之间`);
        }
        cfg.autoHealthCheck = enabled;
        cfg.healthCheckInterval = n;
        save();
        scheduleHealth();
        if (enabled && cfg.subscriptionUrl && await manager.isRunning()) await testHealthCore();
        return snapshot();
      });
    },
    testHealth() { return serial(() => testHealthCore()); },
    async stop() { return serial(() => disableCore()); },
    getFetch() { return upstreamFetch; },
    getSubscriptionUrl() { return cfg.subscriptionUrl; },
    isEnvLocked() { return cfg.envLocked; },
  };
}

// ── 生产实例 / 兼容导出 ─────────────────────────────────

const manager = createMihomoManager({
  bin: MIHOMO_BIN,
  configPath: MIHOMO_CONFIG,
  dataDir: MIHOMO_DATA_DIR,
  ctrlPort: CTRL_PORT,
  logger: (l, m) => logger(l, m),
});

export const mihomo = {
  ...manager,
  get configPath() { return MIHOMO_CONFIG; },
  get dataDir() { return MIHOMO_DATA_DIR; },
  get mixedPort() { return MIXED_PORT; },
  get poolName() { return POOL_NAME; },
  get providerName() { return PROVIDER_NAME; },
};

async function buildProxyFetch() {
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${MIXED_PORT}`, keepAliveTimeout: 10 });
  return {
    fetch: (url, init = {}) => fetch(url, { ...init, dispatcher: agent }),
    close: () => agent.close(),
  };
}

const proxyService = createProxyService({
  manager,
  controller: defaultController(),
  settings: readProxySettings(),
  envUrl: process.env.SUBSCRIPTION_URL || '',
  persist: persistProxySettings,
  writeConfig: writeMihomoConfig,
  buildFetch: buildProxyFetch,
  logger: (level, message) => logger(level, message),
});

export async function initProxy(subscriptionUrl) {
  await proxyService.initialize(subscriptionUrl);
  return proxyService.getFetch();
}

export async function refreshSubscription() { return proxyService.refresh(); }
export async function getProxyStatus() { return proxyService.status(); }
export async function setProxySubscription(url) { return proxyService.setSubscription(url); }
export async function setProxyNode(options) { return proxyService.setNode(options); }
export async function setProxyHealth(options) { return proxyService.setHealth(options); }
export function getConfiguredSubscription() { return proxyService.getSubscriptionUrl(); }
export function isProxyEnvLocked() { return proxyService.isEnvLocked(); }
export async function stopProxy() { return proxyService.stop(); }
export function getUpstreamFetch() { return proxyService.getFetch(); }
