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
function readPort(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 的整数端口`);
  }
  return value;
}

export const ACCOUNT_EGRESS_LANE_COUNT = 64;
const MIXED_PORT = readPort('MIHOMO_MIXED_PORT', 17897); // 出站 HTTP 代理端口
const CTRL_PORT = readPort('MIHOMO_CTRL_PORT', 19090);   // external-controller
const POOL_NAME = 'freebuff-pool';
const PROVIDER_NAME = 'freebuff-airport';
export const ACCOUNT_EGRESS_PORT_BASE = readPort('MIHOMO_ACCOUNT_PORT_BASE', 17900);
export const ACCOUNT_EGRESS_PROBE_PORT = ACCOUNT_EGRESS_PORT_BASE + ACCOUNT_EGRESS_LANE_COUNT;
const ACCOUNT_EGRESS_LAST_PORT = ACCOUNT_EGRESS_PROBE_PORT + ACCOUNT_EGRESS_LANE_COUNT - 1;
if (MIXED_PORT === CTRL_PORT) {
  throw new Error('MIHOMO_MIXED_PORT 不能与 MIHOMO_CTRL_PORT 冲突');
}
if (ACCOUNT_EGRESS_LAST_PORT > 65535) {
  throw new Error('MIHOMO_ACCOUNT_PORT_BASE 账号出站端口范围超出 65535');
}
for (const [name, port] of [['MIHOMO_MIXED_PORT', MIXED_PORT], ['MIHOMO_CTRL_PORT', CTRL_PORT]]) {
  if (port >= ACCOUNT_EGRESS_PORT_BASE && port <= ACCOUNT_EGRESS_LAST_PORT) {
    throw new Error(`MIHOMO_ACCOUNT_PORT_BASE 账号出站端口范围与 ${name} 冲突`);
  }
}
const ACCOUNT_AUTO_CACHE_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_FREE_AUTO_CACHE_TTL_MS = 15 * 60 * 1000;
// 优先高级时命中的 Free 只是「这一轮没扫到高级节点」的兜底，不是稳定终态：
// 缓存必须短于 advanced，否则降级结果反而被记更久，高级节点空出来也不会回切。
// ponytail: 固定 2 分钟，不做自适应。上限是重探频率，要更快只能缩短这个值。
const ACCOUNT_FREE_DOWNGRADE_CACHE_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_AUTO_RETRY_TTL_MS = 60 * 1000;
// 节点授权层级的记忆。没有它，每一轮「优先高级」都要把上百个候选重新探一遍：
// 实测 117 个 US/SG 候选、单次探测上限 5s、Free 兜底缓存只有 2 分钟，等于每个账号
// 永远在扫节点，面板上看就是「节点一直在换」，而 10 个账号扫的是同一批节点。
// ponytail: 按节点名做全局记忆，不按账号拆。accessTier 由出口 IP 决定，同一 IP 对
// 不同免费账号给的层级一致（accountAutoCandidates 原本就在跨 lane 复用这个假设）。
// 上限：真出现「同一节点对 A 免费对 B 高级」时会来回改写记忆，但每次提交仍以本次
// 探测结果为准，只多花一次探测。要更严就把 key 改成 `${identity}\n${node}`。
const ACCOUNT_NODE_TIER_TTL_MS = 30 * 60 * 1000;
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
  accountSelectionPriority: 'advanced',
  selectedNode: '',
  autoHealthCheck: true,
  healthCheckInterval: 600,
  autoUpdate: false,
  autoUpdateInterval: 21600,
});
const MIN_HEALTH_INTERVAL = 30;
const MAX_HEALTH_INTERVAL = 86400;
// 自动更新订阅比测活重（要重新拉取机场配置），最小粒度限制为 1 小时。
const MIN_UPDATE_INTERVAL = 3600;
const MAX_UPDATE_INTERVAL = 86400;
const STARTUP_REFRESH_RETRY_DELAY_MS = 1000;

// 自动选点优先的地区。免费额度能用哪些模型由出口 IP 的 accessTier 决定，
// 美国/新加坡出口拿到 full 的概率明显更高，选错地区比慢几十毫秒代价大得多。
// US 和 SG 同属一档，档内仍按延迟排序；测活没通过的节点永远排在后面。
// ponytail: 机场节点名没有统一格式，这里只能按名字猜地区。猜不出就算「其他地区」，
// 只影响自动选点的排序，不会把节点从池子里摘掉。要更准只能靠出口 IP 实测。
const AUTO_US_REGION = new RegExp([
  '🇺🇸',
  '\\bUS\\b', '\\bUSA\\b', 'United States', '美国', '美國',
  '洛杉[矶磯]', '圣何塞', '聖何塞', '西雅[图圖]', '硅谷', '[纽紐]约', '[达達]拉斯',
  '[凤鳳]凰城', '芝加哥', '[迈邁]阿密', '[dD]allas', '[lL]os ?[aA]ngeles', '[sS]an ?[jJ]ose',
].join('|'), 'i');
const AUTO_SG_REGION = new RegExp([
  '🇸🇬',
  '\\bSG\\b', 'Singapore', '新加坡', '[狮獅]城',
].join('|'), 'i');
const LEADING_COUNTRY_FLAG = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})/u;
const LEADING_COUNTRY_CODE = /^\s*(USA|SGP|[A-Z]{2})(?=[^A-Z]|$)/i;

export function inferNodeRegion(name) {
  const value = String(name || '');
  const flag = value.match(LEADING_COUNTRY_FLAG)?.[1] || '';
  if (flag) {
    if (flag === '🇺🇸') return 'us';
    if (flag === '🇸🇬') return 'sg';
    return null;
  }
  const prefix = (value.match(LEADING_COUNTRY_CODE)?.[1] || '').toUpperCase();
  if (prefix) {
    if (prefix === 'US' || prefix === 'USA') return 'us';
    if (prefix === 'SG' || prefix === 'SGP') return 'sg';
    return null;
  }
  if (AUTO_US_REGION.test(value)) return 'us';
  if (AUTO_SG_REGION.test(value)) return 'sg';
  return null;
}

function autoRegionRank(name) {
  return inferNodeRegion(name) ? 0 : 1;
}

const ACCOUNT_ADVANCED_AUTH_MODELS = [
  'deepseek/deepseek-v4-pro',
  'openai/gpt-5.6-luna',
];
const ACCOUNT_PREMIUM_AUTH_MODELS = [
  'deepseek/deepseek-v4-flash',
  'crof/kimi-k3-eco',
  'meta/muse-spark-1.2-contributor',
];
const ACCOUNT_FREE_AUTH_MODELS = [
  'deepseek/deepseek-v4-flash',
  'mimo/mimo-v2.5',
];
const PAUSED_ACCOUNT_AUTH_MODELS = new Set([
  'minimax/minimax-m3',
]);

// 这些探测结果同样证明「出口路径可用」：上游在应用层认出了这个 IP + 凭据并给出了
// 账号/模型级的状态（排队、额度），而不是拒绝这条链路。拥堵波次里若把 waiting_room
// 探针判成验证失败，节点会被逐个拉黑、lane 永远无法就绪，全部请求都被本地拒成
// egress_unavailable（2026-08-26 实测）。地区/IP 级状态不在其中——那才是真·出口问题。
const PATH_PROVEN_PROBE_STATES = new Set(['ok', 'waiting_room', 'rate_limited', 'spend_limited']);

export function classifyAccountProbeAuthorization(probe) {
  if (!probe || typeof probe !== 'object' || !PATH_PROVEN_PROBE_STATES.has(probe.state)) return null;
  const accessTier = String(probe.accessTier || '').trim().toLowerCase();
  const quota = Array.isArray(probe.quota) ? probe.quota : null;
  const rowFor = (model) => quota?.find((entry) => entry?.model === model) || null;
  const advancedModel = [...ACCOUNT_ADVANCED_AUTH_MODELS, ...ACCOUNT_PREMIUM_AUTH_MODELS]
    .find((model) => rowFor(model));

  // accessTier 描述的是出口/账号能力，不是当天某个模型的剩余额度。
  // full 节点即使 D4P/Luna 为 1/1，仍应作为高级节点复用；额度耗尽由请求
  // 调度的 pool 作用域处理，不能在这里把高级节点降级成 Free。
  if (accessTier === 'full' || accessTier === 'advanced') {
    return { tier: 'advanced', ...(advancedModel ? { model: advancedModel } : {}) };
  }

  if (!quota) return null;

  // 旧上游响应没有 accessTier 时，显式 pool 是唯一可接受的能力证据。
  if (!accessTier) {
    const pooledAdvanced = quota.find((entry) => (
      !PAUSED_ACCOUNT_AUTH_MODELS.has(String(entry?.model || ''))
      &&
      ['deepseek_pro', 'luna', 'premium'].includes(String(entry?.pool || '').toLowerCase())
      && Number(entry?.limit) > 0
    ));
    if (pooledAdvanced) return { tier: 'advanced', model: pooledAdvanced.model };
  }

  // limited/free 账号只需要确认有一个免费模型授权；used 达到 limit
  // 不代表模型不能建会话，真正的请求额度由上游 admission 决定。
  for (const model of ACCOUNT_FREE_AUTH_MODELS) {
    const row = quota.find((entry) => entry?.model === model);
    if (row && Number(row.limit) > 0) return { tier: 'free', model };
  }
  return null;
}

function accountPoolName(lane) { return `freebuff-account-${lane}`; }
function accountListenerName(lane) { return `freebuff-account-in-${lane}`; }
function accountPort(lane) { return ACCOUNT_EGRESS_PORT_BASE + lane; }
function accountProbePoolName(lane) { return `freebuff-account-probe-${lane}`; }
function accountProbeListenerName(lane) { return `freebuff-account-probe-in-${lane}`; }
function accountProbePort(lane) { return ACCOUNT_EGRESS_PROBE_PORT + lane; }

function normalizeAccountLane(value) {
  const lane = Number(value);
  if (!Number.isInteger(lane) || lane < 0 || lane >= ACCOUNT_EGRESS_LANE_COUNT) {
    throw new Error(`账号出站 lane 必须在 0 到 ${ACCOUNT_EGRESS_LANE_COUNT - 1} 之间`);
  }
  return lane;
}

let logger = (level, msg) => console.log(`[${level}] ${msg}`);
let accountAutoRefreshHandler = null;

export function setLogger(fn) { logger = fn || logger; }
export function setAccountAutoRefreshHandler(fn) {
  accountAutoRefreshHandler = typeof fn === 'function' ? fn : null;
}
export function getMixedPort() { return MIXED_PORT; }

// ── mihomo 配置生成（移植 Zen config.mjs buildMihomoYaml） ──
// 只写 DOMAIN-SUFFIX + MATCH 两条规则是刻意的：不碰 GEOIP/GEOSITE，
// 内核就不需要 geoip.dat/geosite.dat（省几十 MB，也不触发首启联网下载）。
export function buildMihomoYaml(subscriptionUrl) {
  if (!subscriptionUrl) throw new Error('订阅地址为空');
  // JSON.stringify 转义：机场 token 里常有 & ? = #，裸写会被当注释/流式集合
  const url = JSON.stringify(String(subscriptionUrl));
  const accountGroups = Array.from({ length: ACCOUNT_EGRESS_LANE_COUNT }, (_, lane) => `  - name: ${accountPoolName(lane)}
    type: select
    use: [${PROVIDER_NAME}]`).join('\n');
  const accountListeners = Array.from({ length: ACCOUNT_EGRESS_LANE_COUNT }, (_, lane) => `  - name: ${accountListenerName(lane)}
    type: mixed
    port: ${accountPort(lane)}
    listen: 127.0.0.1
    proxy: ${accountPoolName(lane)}`).join('\n');
  const accountProbeGroups = Array.from({ length: ACCOUNT_EGRESS_LANE_COUNT }, (_, lane) => `  - name: ${accountProbePoolName(lane)}
    type: select
    use: [${PROVIDER_NAME}]`).join('\n');
  const accountProbeListeners = Array.from({ length: ACCOUNT_EGRESS_LANE_COUNT }, (_, lane) => `  - name: ${accountProbeListenerName(lane)}
    type: mixed
    port: ${accountProbePort(lane)}
    listen: 127.0.0.1
    proxy: ${accountProbePoolName(lane)}`).join('\n');

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
${accountGroups}
${accountProbeGroups}

listeners:
${accountListeners}
${accountProbeListeners}

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

function normalizeInterval(value, fallback = DEFAULT_PROXY_SETTINGS.healthCheckInterval, min = MIN_HEALTH_INTERVAL, max = MAX_HEALTH_INTERVAL) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function normalizeAccountSelectionPriority(value) {
  return value === 'unused' ? 'unused' : 'advanced';
}

export function resolveProxySettings({ envUrl = '', saved = {} } = {}) {
  const lockedUrl = String(envUrl || '').trim();
  const savedUrl = String(saved?.subscriptionUrl || '').trim();
  const nodeMode = saved?.nodeMode === 'manual' ? 'manual' : 'auto';
  return {
    subscriptionUrl: lockedUrl || savedUrl,
    nodeMode,
    accountSelectionPriority: normalizeAccountSelectionPriority(saved?.accountSelectionPriority),
    selectedNode: nodeMode === 'manual' ? String(saved?.selectedNode || '').trim() : '',
    autoHealthCheck: saved?.autoHealthCheck !== false,
    healthCheckInterval: normalizeInterval(saved?.healthCheckInterval),
    autoUpdate: saved?.autoUpdate === true,
    autoUpdateInterval: normalizeInterval(
      saved?.autoUpdateInterval, DEFAULT_PROXY_SETTINGS.autoUpdateInterval, MIN_UPDATE_INTERVAL, MAX_UPDATE_INTERVAL,
    ),
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
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAutoRefresh = null,
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
  // 账号自动验证只读最近一次完整测活成功的内存快照。刷新失败时保留，
  // 避免每个账号重复读取控制器或因短暂订阅错误失去旧路由。
  let accountCandidateSnapshot = [];
  let lastReject = null;
  let upstreamFetch = null;
  let closeFetch = null;
  const accountFetches = new Map();
  const accountNodes = new Map();
  const accountGenerations = new Map();
  const accountIdentities = new Map();
  const accountRejects = new Map();
  const accountAutoValidations = new Map();
  // 先占位再验证，避免多个账号都拿到同一个最低延迟节点。
  const accountAutoReservations = new Map();
  const accountRejectedNodes = new Map();
  // 节点名 -> { tier, expiresAt }：任一账号探到过的授权层级，供选点排序复用。
  const accountNodeTiers = new Map();
  const accountProbeDispatchers = new Map();
  let nextAccountGeneration = 1;
  let healthTimer = null;
  let updateTimer = null;
  let tail = Promise.resolve();
  const probeTails = new Map();
  let accountTopologyVersion = 1;
  const accountOperationVersions = new Map();

  const serial = (fn) => {
    const next = tail.catch(() => {}).then(fn);
    tail = next;
    return next;
  };

  const probeSerial = (lane, fn) => {
    const next = (probeTails.get(lane) || Promise.resolve()).catch(() => {}).then(fn);
    probeTails.set(lane, next);
    const clear = () => {
      if (probeTails.get(lane) === next) probeTails.delete(lane);
    };
    next.then(clear, clear);
    return next;
  };

  function bumpAccountOperation(lane) {
    accountAutoReservations.delete(lane);
    const version = (accountOperationVersions.get(lane) || 0) + 1;
    accountOperationVersions.set(lane, version);
    return version;
  }

  function assertAccountOperation(lane, version, identity, topologyVersion) {
    if (accountOperationVersions.get(lane) === version
      && accountIdentities.get(lane) === identity
      && accountTopologyVersion === topologyVersion) return;
    const error = new Error('账号出站配置已被更新的操作取代');
    error.code = 'ACCOUNT_EGRESS_SUPERSEDED';
    throw error;
  }

  function assertAccountTopology(topologyVersion) {
    if (accountTopologyVersion === topologyVersion) return;
    const error = new Error('账号出站配置已被更新的操作取代');
    error.code = 'ACCOUNT_EGRESS_SUPERSEDED';
    throw error;
  }

  function persistedShape() {
    return {
      subscriptionUrl: cfg.envLocked ? savedSubscriptionUrl : cfg.subscriptionUrl,
      nodeMode: cfg.nodeMode,
      accountSelectionPriority: cfg.accountSelectionPriority,
      selectedNode: cfg.selectedNode,
      autoHealthCheck: cfg.autoHealthCheck,
      healthCheckInterval: cfg.healthCheckInterval,
      autoUpdate: cfg.autoUpdate,
      autoUpdateInterval: cfg.autoUpdateInterval,
    };
  }

  function save() { persist(persistedShape()); }

  function closeInBackground(dispatcher) {
    if (!dispatcher?.close) return;
    Promise.resolve().then(() => dispatcher.close()).catch(() => {});
  }

  function invalidateAccountProbeLane(lane) {
    const dispatcher = accountProbeDispatchers.get(lane);
    accountProbeDispatchers.delete(lane);
    closeInBackground(dispatcher);
  }

  function dropAccountLaneRuntime(lane, { clearRejected = false } = {}) {
    const dispatcher = accountFetches.get(lane);
    accountFetches.delete(lane);
    accountNodes.delete(lane);
    accountGenerations.delete(lane);
    accountRejects.delete(lane);
    accountAutoValidations.delete(lane);
    accountAutoReservations.delete(lane);
    if (clearRejected) accountRejectedNodes.delete(lane);
    closeInBackground(dispatcher);
    invalidateAccountProbeLane(lane);
  }

  function invalidateAccountLane(lane, options = {}) {
    bumpAccountOperation(lane);
    dropAccountLaneRuntime(lane, options);
  }

  function invalidateAccountLanes() {
    const lanes = new Set([
      ...accountFetches.keys(),
      ...accountNodes.keys(),
      ...accountGenerations.keys(),
      ...accountAutoValidations.keys(),
      ...accountAutoReservations.keys(),
    ]);
    for (const lane of lanes) invalidateAccountLane(lane);
  }

  function buildAccountCandidateSnapshot(names, delays) {
    return names
      .map((name, index) => ({
        name,
        region: inferNodeRegion(name),
        delay: delays.has(name) ? delays.get(name) : null,
        order: index,
      }))
      .filter((entry) => entry.region && entry.delay != null)
      .sort((a, b) => a.delay - b.delay || a.order - b.order)
      .map(({ order, ...entry }) => entry);
  }

  function rebuildAccountCandidateSnapshot() {
    accountCandidateSnapshot = buildAccountCandidateSnapshot(nodeNames, healthMap);
  }

  function advanceAccountTopology(nextNodeNames) {
    accountTopologyVersion++;
    // 节点名里带着速率/负载百分比，订阅刷新后同一台机器也可能换名字：只留还在池里的键。
    for (const node of accountNodeTiers.keys()) {
      if (!nextNodeNames.includes(node)) accountNodeTiers.delete(node);
    }
    const lanes = new Set([
      ...accountFetches.keys(),
      ...accountNodes.keys(),
      ...accountAutoValidations.keys(),
      ...accountAutoReservations.keys(),
    ]);
    for (const lane of lanes) {
      bumpAccountOperation(lane);
      invalidateAccountProbeLane(lane);
      const validation = accountAutoValidations.get(lane);
      const node = accountNodes.get(lane);
      if (!node || !nextNodeNames.includes(node)) {
        dropAccountLaneRuntime(lane);
      } else if (validation && accountFetches.has(lane)) {
        accountAutoValidations.set(lane, {
          ...validation,
          topologyVersion: accountTopologyVersion,
          stale: true,
          expiresAt: 0,
        });
      }
    }
  }

  async function closeDispatcher() {
    accountTopologyVersion++;
    accountOperationVersions.clear();
    const close = closeFetch;
    closeFetch = null;
    upstreamFetch = null;
    accountNodes.clear();
    accountGenerations.clear();
    accountIdentities.clear();
    accountRejects.clear();
    accountAutoValidations.clear();
    accountAutoReservations.clear();
    accountRejectedNodes.clear();
    accountNodeTiers.clear();
    if (close) {
      try { await close(); } catch {}
    }
    const accountDispatchers = [...accountFetches.values()];
    accountFetches.clear();
    const probeDispatchers = [...accountProbeDispatchers.values()];
    accountProbeDispatchers.clear();
    probeTails.clear();
    await Promise.all(accountDispatchers.map(async ({ close: closeAccount }) => {
      try { await closeAccount?.(); } catch {}
    }));
    await Promise.all(probeDispatchers.map(async ({ close: closeProbe }) => {
      try { await closeProbe?.(); } catch {}
    }));
  }

  function stopHealthTimer() {
    if (healthTimer) clearIntervalFn(healthTimer);
    healthTimer = null;
  }

  function stopUpdateTimer() {
    if (updateTimer) clearIntervalFn(updateTimer);
    updateTimer = null;
  }

  function stopTimers() {
    stopHealthTimer();
    stopUpdateTimer();
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

  // 自动更新：按间隔重新拉取订阅（等价于一次手动刷新），刷新完成后会重排定时器，
  // 保证下一次更新从本次刷新起算，节奏稳定。
  function scheduleUpdate() {
    stopUpdateTimer();
    if (!cfg.autoUpdate || !cfg.subscriptionUrl || state !== 'ready') return;
    updateTimer = setIntervalFn(() => (
      serial(() => refreshCore({ ensureStarted: true })).then((result) => {
        if (result?.ok) onAutoRefresh?.(result);
        return result;
      }).catch((e) => {
        lastError = cleanError(e);
        serviceLogger('warn', `[proxy] 自动更新订阅失败: ${lastError}`);
      })
    ), cfg.autoUpdateInterval * 1000);
    updateTimer?.unref?.();
  }

  function snapshot() {
    const all = nodeNames.map((name) => {
      const delay = healthMap.has(name) ? healthMap.get(name) : null;
      return { name, healthy: delay != null, delay, selected: name === currentNode, region: inferNodeRegion(name) };
    });
    const healthyCount = all.filter((n) => n.healthy).length;
    // 测活失败的节点自动从对外列表里删掉：healthMap 里有这个键但延迟是 null = 测过且没通。
    // 没测过的（healthMap 里根本没这个键）保留，否则首次测活完成前列表会是空的。
    // 全军覆没时也保留：那通常是测活地址自己不通，删光只会让手动选节点没得选。
    // 只删「对外呈现」，nodeNames 不动 —— 一动 applyNodeMode 会把手动模式静默降级成自动。
    const nodes = healthyCount ? all.filter((n) => n.healthy || !healthMap.has(n.name)) : all;
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
      healthyCount,
      currentNode: currentNode || null,
      lastRefreshAt,
      error: lastError || null,
      // 上游把出站 IP 拒了的最近一次记录（地区封禁 / IP 触顶 / 裸 403），已归因到当时在用的节点。
      reject: lastReject,
      nodes,
      nodeMode: cfg.nodeMode,
      mode: cfg.nodeMode,
      accountSelectionPriority: cfg.accountSelectionPriority,
      selectedNode: cfg.selectedNode || null,
      autoHealthCheck: cfg.autoHealthCheck,
      healthCheckInterval: cfg.healthCheckInterval,
      health: {
        enabled: cfg.autoHealthCheck,
        interval: cfg.healthCheckInterval,
        lastCheckAt: lastHealthAt,
        error: healthError || null,
      },
      autoUpdate: cfg.autoUpdate,
      autoUpdateInterval: cfg.autoUpdateInterval,
      update: {
        enabled: cfg.autoUpdate,
        interval: cfg.autoUpdateInterval,
        lastRefreshAt,
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
    for (const [lane, node] of accountNodes) {
      if (!nodeNames.includes(node)) invalidateAccountLane(lane);
    }
    const removedProbeDispatchers = [];
    for (const [lane, dispatcher] of accountProbeDispatchers) {
      if (nodeNames.includes(dispatcher.node)) continue;
      accountProbeDispatchers.delete(lane);
      removedProbeDispatchers.push(dispatcher);
    }
    await Promise.all(removedProbeDispatchers.map(async ({ close }) => {
      try { await close?.(); } catch {}
    }));
    return pool;
  }

  async function reconcileAccountSelectors() {
    await Promise.all([...accountNodes].map(async ([lane, expected]) => {
      let actual;
      try {
        const group = await controller.request(`/proxies/${encodeURIComponent(accountPoolName(lane))}`);
        actual = String(group?.now || '');
      } catch {
        return;
      }
      if (actual !== expected) invalidateAccountLane(lane);
    }));
  }

  async function switchPoolNode(name) {
    if (!name) return;
    await controller.request(`/proxies/${encodeURIComponent(POOL_NAME)}`, 'PUT', { name });
    // 换了节点，之前那次「出站 IP 被拒」不再说明当前出口的状况，清掉。
    if (name !== currentNode) lastReject = null;
    currentNode = name;
  }

  async function ensureAccountDispatcher(lane) {
    if (accountFetches.has(lane)) return accountFetches.get(lane).fetch;
    if (!buildFetch) throw new Error('无法创建账号代理出站连接');
    const built = await buildFetch({ port: accountPort(lane), lane });
    const accountFetch = typeof built === 'function' ? built : built?.fetch || null;
    if (!accountFetch) throw new Error('无法创建账号代理出站连接');
    accountFetches.set(lane, {
      fetch: accountFetch,
      close: typeof built?.close === 'function' ? built.close : null,
    });
    return accountFetch;
  }

  function applyAccountIdentity(lane, identity) {
    const normalized = String(identity || '');
    const previous = accountIdentities.get(lane);
    if (previous !== undefined && previous !== normalized) {
      invalidateAccountLane(lane, { clearRejected: true });
    }
    accountIdentities.set(lane, normalized);
    return normalized;
  }

  async function switchAccountNode(lane, name) {
    const force = accountAutoValidations.get(lane)?.stale === true;
    if (!force && accountNodes.get(lane) === name && accountFetches.has(lane)) {
      accountRejects.delete(lane);
      return accountFetches.get(lane).fetch;
    }
    const previous = accountFetches.get(lane);
    accountFetches.delete(lane);
    accountNodes.delete(lane);
    accountGenerations.delete(lane);
    try {
      await controller.request(`/proxies/${encodeURIComponent(accountPoolName(lane))}`, 'PUT', { name });
      const accountFetch = await ensureAccountDispatcher(lane);
      accountNodes.set(lane, name);
      accountGenerations.set(lane, nextAccountGeneration++);
      accountRejects.delete(lane);
      return accountFetch;
    } finally {
      closeInBackground(previous);
    }
  }

  async function switchAccountProbeNode(lane, name, topologyVersion) {
    assertAccountTopology(topologyVersion);
    const current = accountProbeDispatchers.get(lane);
    if (current?.node === name && current.topologyVersion === topologyVersion) return current.fetch;
    accountProbeDispatchers.delete(lane);
    try { await current?.close?.(); } catch {}
    assertAccountTopology(topologyVersion);
    await controller.request(`/proxies/${encodeURIComponent(accountProbePoolName(lane))}`, 'PUT', { name });
    assertAccountTopology(topologyVersion);
    if (!buildFetch) throw new Error('无法创建账号节点验证连接');
    const built = await buildFetch({ port: accountProbePort(lane), lane: 'probe' });
    const probeFetch = typeof built === 'function' ? built : built?.fetch || null;
    const closeBuilt = typeof built?.close === 'function' ? built.close : null;
    if (!probeFetch) {
      try { await closeBuilt?.(); } catch {}
      assertAccountTopology(topologyVersion);
      throw new Error('无法创建账号节点验证连接');
    }
    if (accountTopologyVersion !== topologyVersion) {
      try { await closeBuilt?.(); } catch {}
      assertAccountTopology(topologyVersion);
    }
    accountProbeDispatchers.set(lane, {
      fetch: probeFetch,
      close: closeBuilt,
      node: name,
      topologyVersion,
    });
    return probeFetch;
  }

  function rejectAccountNode(lane, node, {
    preserveValidation = false,
    ttlMs = ACCOUNT_AUTO_CACHE_TTL_MS,
  } = {}) {
    if (!node) return;
    let rejected = accountRejectedNodes.get(lane);
    if (!rejected) {
      rejected = new Map();
      accountRejectedNodes.set(lane, rejected);
    }
    rejected.set(node, now() + ttlMs);
    if (!preserveValidation && accountAutoValidations.get(lane)?.node === node) {
      accountAutoValidations.delete(lane);
    }
  }

  function liveRejectedNodes(lane) {
    const rejected = accountRejectedNodes.get(lane);
    if (!rejected) return new Set();
    const current = now();
    for (const [node, until] of rejected) if (until <= current) rejected.delete(node);
    if (!rejected.size) accountRejectedNodes.delete(lane);
    return new Set(rejected.keys());
  }

  function noteAccountNodeTier(node, tier) {
    if (!node || (tier !== 'advanced' && tier !== 'free')) return;
    accountNodeTiers.set(node, { tier, expiresAt: now() + ACCOUNT_NODE_TIER_TTL_MS });
  }

  function knownAccountNodeTier(node) {
    const entry = accountNodeTiers.get(node);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      accountNodeTiers.delete(node);
      return null;
    }
    return entry.tier;
  }

  function accountAutoCandidates(lane = null) {
    const rejected = lane == null ? new Set() : liveRejectedNodes(lane);
    const usage = new Map();
    const tierByNode = new Map();
    for (const [usedLane, node] of accountNodes) {
      if (usedLane !== lane && node) usage.set(node, (usage.get(node) || 0) + 1);
      if (usedLane === lane || !node) continue;
      const tier = accountAutoValidations.get(usedLane)?.tier;
      if (tier === 'advanced' || (tier === 'free' && !tierByNode.has(node))) tierByNode.set(node, tier);
    }
    for (const [reservedLane, reservation] of accountAutoReservations) {
      if (reservedLane !== lane && reservation?.node) {
        usage.set(reservation.node, (usage.get(reservation.node) || 0) + 1);
      }
    }
    const order = new Map(accountCandidateSnapshot.map((entry, index) => [entry.name, index]));
    const tierRank = (tier) => tier === 'advanced' ? 0 : tier === 'free' ? 2 : 1;
    // 优先高级时按地区轮转，让每个地区的头部节点都排在任一地区的尾部节点之前。
    // 出口 IP 决定 accessTier，而同一地区的节点常常整段是 limited：纯延迟排序会让
    // 上百个 US 节点全部排在第一个 SG 节点之前，而每次探测串行、单次上限 5s，
    // 扫到 SG 要好几分钟 —— 比 Free 兜底缓存的 2 分钟还长，于是永远轮不到 SG。
    // ponytail: 只按「地区内第几个」交错，不做加权。上限是地区数，够用。
    const regionOf = (name) => inferNodeRegion(name) || 'other';
    const seen = new Map();
    const withRank = accountCandidateSnapshot
      .filter((entry) => nodeNames.includes(entry.name))
      .map((entry) => ({
        ...entry,
        load: usage.get(entry.name) || 0,
        // 其它 lane 当前的验证结果最新鲜，其次才用节点层级记忆（含本 lane 自己上一轮
        // 的结果：force 重扫时靠它把「我原来那个高级节点」重新排到最前面）。
        knownTier: tierByNode.get(entry.name) || knownAccountNodeTier(entry.name) || null,
      }))
      .filter((entry) => !rejected.has(entry.name))
      .sort((a, b) => a.delay - b.delay || order.get(a.name) - order.get(b.name))
      .map((entry) => {
        const region = regionOf(entry.name);
        const regionIndex = seen.get(region) || 0;
        seen.set(region, regionIndex + 1);
        return { ...entry, regionIndex };
      });
    return withRank.sort((a, b) => (
      (cfg.accountSelectionPriority === 'advanced'
        ? (tierRank(a.knownTier) - tierRank(b.knownTier)) || (a.regionIndex - b.regionIndex) : 0)
      || a.load - b.load
      || a.delay - b.delay
      || order.get(a.name) - order.get(b.name)
    ));
  }

  function isAccountNodeOccupied(node, lane) {
    return [...accountNodes].some(([usedLane, usedNode]) => (
      usedLane !== lane && usedNode === node
    )) || [...accountAutoReservations].some(([reservedLane, reservation]) => (
      reservedLane !== lane && reservation?.node === node
    ));
  }

  function reserveNextAccountAutoCandidate({
    lane, identity, operationVersion, topologyVersion, excludedNodes = new Set(),
    skipKnownFree = false,
  }) {
    assertAccountOperation(lane, operationVersion, identity, topologyVersion);
    const candidates = accountAutoCandidates(lane);
    // 本轮已经攥着 Free 兜底、而且还有已知高级节点可以复用时，再探已知是 Free 的节点
    // 纯属浪费：结果不会更好，只会把这一轮拖到上百次探测（线上 117 个候选 × 5s）。
    // 反过来，池里一个已知高级节点都没有时绝不能跳——遍历 Free 节点是发现「某个节点
    // 变成高级了」的唯一途径，跳了就永远回不到高级。
    const reusableAdvanced = candidates.some((candidate) => (
      candidate.knownTier === 'advanced' && !excludedNodes.has(candidate.name)
    ));
    const worth = (candidate) => !excludedNodes.has(candidate.name)
      && !(skipKnownFree && reusableAdvanced && candidate.knownTier === 'free');
    for (const candidate of candidates) {
      if (!worth(candidate)) continue;
      if (isAccountNodeOccupied(candidate.name, lane)) continue;
      accountAutoReservations.set(lane, {
        lane,
        node: candidate.name,
        identity,
        topologyVersion,
        operationVersion,
      });
      return candidate;
    }

    // 节点不足时允许复用，但仍按当前负载最小、延迟最低的顺序取一个。
    const fallback = candidates.find(worth) || null;
    if (fallback) {
      accountAutoReservations.set(lane, {
        lane,
        node: fallback.name,
        identity,
        topologyVersion,
        operationVersion,
      });
    }
    return fallback;
  }

  function reserveAccountAutoCandidateByName({
    lane, identity, operationVersion, topologyVersion, node,
  }) {
    assertAccountOperation(lane, operationVersion, identity, topologyVersion);
    const candidate = accountAutoCandidates(lane).find((entry) => entry.name === node);
    if (!candidate) return null;
    accountAutoReservations.set(lane, {
      lane,
      node: candidate.name,
      identity,
      topologyVersion,
      operationVersion,
    });
    return candidate;
  }

  function releaseAccountAutoReservation(lane, operationVersion = null) {
    const reservation = accountAutoReservations.get(lane);
    if (!reservation || (operationVersion != null && reservation.operationVersion !== operationVersion)) return;
    accountAutoReservations.delete(lane);
  }

  // worker.js 判定「这次失败是冲着出站 IP 来的」之后回调进来。分工：worker 知道被拒的原因，
  // 但不知道节点名；proxy 知道当前节点，但看不到上游响应。这里只负责把两半拼起来。
  // 直连（没起代理）时不记：没有节点可归因，记了只会误导。
  function noteEgressReject(info = {}) {
    if (info.lane !== undefined && info.lane !== null) {
      let lane;
      try { lane = normalizeAccountLane(info.lane); } catch { return; }
      const currentNode = accountNodes.get(lane);
      const currentGeneration = accountGenerations.get(lane);
      const observedNode = String(info.node || currentNode || '');
      const observedGeneration = Number(info.generation);
      if (state !== 'ready' || !observedNode) return;
      const stale = Boolean(info.node) && (
        observedNode !== currentNode
        || (Number.isInteger(observedGeneration) && observedGeneration !== currentGeneration)
      );
      if (stale) {
        serviceLogger('warn', `[proxy] 账号 lane ${lane} 旧代际出站被上游拒绝(${String(info.state || 'blocked')}): ${observedNode}`);
        return;
      }
      rejectAccountNode(lane, observedNode);
      const rejection = {
        node: observedNode,
        state: String(info.state || 'blocked'),
        status: Number(info.status) || null,
        at: new Date(now()).toISOString(),
      };
      accountRejects.set(lane, rejection);
      serviceLogger('warn', `[proxy] 账号 lane ${lane} 出站被上游拒绝(${rejection.state}): ${observedNode}`);
      return;
    }
    if (state !== 'ready' || !currentNode) return;
    lastReject = {
      node: currentNode,
      state: String(info.state || 'blocked'),
      status: Number(info.status) || null,
      at: new Date(now()).toISOString(),
    };
    serviceLogger('warn', `[proxy] 出站被上游拒绝(${lastReject.state}): ${currentNode}`);
  }

  // 自动选点的分档键：先看测活是否通过，再看地区偏好。同档内才比延迟。
  // 测活没过的节点（delay 为 null）永远在后面 —— 再对的地区，节点是死的也没用。
  function autoTierKey(name) {
    const delay = healthMap.get(name) ?? null;
    return `${delay == null ? 1 : 0}:${autoRegionRank(name)}`;
  }

  // 自动选点排序：先分档，档内按延迟，最后保持订阅原顺序（让结果稳定可复现）。
  function autoNodeOrder() {
    return [...nodeNames].sort((a, b) => {
      const ka = autoTierKey(a);
      const kb = autoTierKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const da = healthMap.get(a) ?? null;
      const db = healthMap.get(b) ?? null;
      if (da != null && db != null && da !== db) return da - db;
      return nodeNames.indexOf(a) - nodeNames.indexOf(b);
    });
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
    const best = autoNodeOrder()[0] || '';
    let target = '';
    // mihomo 的 url-test 组自己有测速数据，比我们的周期测活新；但它只看延迟。
    // 所以只在它选中的节点跟我们的首选同档（一样活着、地区偏好一样）时才采纳它的延迟判断，
    // 否则按自己的排序来 —— 不然它会拿一个死掉的或地区不对的节点顶掉正确的选择。
    try {
      const automatic = await controller.request(`/proxies/${encodeURIComponent('freebuff-auto')}`);
      const picked = automatic?.now ? String(automatic.now) : '';
      if (picked && nodeNames.includes(picked) && best && autoTierKey(picked) === autoTierKey(best)) {
        target = picked;
      }
    } catch {}
    if (!target) target = best || nodeNames[0];
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
      rebuildAccountCandidateSnapshot();
      let accountValidationExpired = false;
      for (const [lane, validation] of accountAutoValidations) {
        if (healthMap.get(validation.node) == null) {
          if (validation.expiresAt > now() && liveRejectedNodes(lane).has(validation.node)) continue;
          accountValidationExpired = true;
          accountAutoValidations.set(lane, {
            ...validation,
            expiresAt: Math.min(validation.expiresAt, now()),
          });
        }
      }
      healthError = '';
      lastHealthAt = new Date(now()).toISOString();
      if (cfg.nodeMode === 'auto') await applyNodeMode();
      if (accountValidationExpired) {
        try { onAutoRefresh?.(); } catch (error) {
          serviceLogger('warn', `[proxy] 账号出站后台重验调度失败: ${cleanError(error)}`);
        }
      }
    } catch (e) {
      healthError = cleanError(e);
    }
    return snapshot();
  }

  async function failToDirect(error) {
    lastError = cleanError(error);
    state = 'error';
    stopTimers();
    await closeDispatcher();
    try { await manager.stop(); } catch {}
    version = null;
    currentNode = '';
    nodeNames = [];
    lastReject = null;
    serviceLogger('error', `[proxy] ${lastError}，已回落直连`);
  }

  async function ensureDispatcher() {
    if (!buildFetch || upstreamFetch) return;
    const built = await buildFetch({ port: MIXED_PORT, lane: null });
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
      scheduleUpdate();
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
    const hadLastGood = state === 'ready' && nodeNames.length > 0 && typeof upstreamFetch === 'function';
    try {
      await ensureDispatcher();
      await controller.request(`/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}`, 'PUT');

      // 先完整读取新拓扑和测活结果，全部成功后再一次性提交。刷新中途失败时，
      // 旧候选快照、账号验证和业务 dispatcher 都保持可用。
      const pool = await controller.request(`/proxies/${encodeURIComponent(POOL_NAME)}`);
      const nextNodeNames = Array.isArray(pool?.all) ? pool.all.map(String).filter(Boolean) : [];
      const nextCurrentNode = pool?.now ? String(pool.now) : '';
      const query = `timeout=5000&url=${encodeURIComponent(healthUrl)}`;
      const delays = await controller.request(`/group/${encodeURIComponent(POOL_NAME)}/delay?${query}`);
      const nextHealthMap = new Map(nextNodeNames.map((name) => {
        const delay = Number(delays?.[name]);
        return [name, Number.isFinite(delay) && delay > 0 ? delay : null];
      }));
      const nextCandidates = buildAccountCandidateSnapshot(nextNodeNames, nextHealthMap);

      advanceAccountTopology(nextNodeNames);
      nodeNames = nextNodeNames;
      currentNode = nextCurrentNode;
      healthMap = nextHealthMap;
      accountCandidateSnapshot = nextCandidates;
      const refreshedAt = new Date(now()).toISOString();
      lastRefreshAt = refreshedAt;
      lastHealthAt = refreshedAt;
      healthError = '';
      await reconcileAccountSelectors();
      await applyNodeMode();
      state = 'ready';
      lastError = '';
      scheduleHealth();
      scheduleUpdate();
    } catch (e) {
      lastError = cleanError(e);
      if (hadLastGood) {
        state = 'ready';
      } else {
        stopTimers();
        await closeDispatcher();
        state = 'error';
      }
      serviceLogger('warn', `[proxy] 刷新订阅失败: ${lastError}`);
      return { ...snapshot(), ok: false };
    }
    return snapshot();
  }

  async function disableCore() {
    stopTimers();
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
      accountCandidateSnapshot = [];
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
        let result = await refreshCore({ ensureStarted: false });
        if (!result?.ok) {
          serviceLogger('warn', '[proxy] 启动刷新失败，1 秒后重试一次');
          await sleepFn(STARTUP_REFRESH_RETRY_DELAY_MS);
          result = await refreshCore({ ensureStarted: false });
        }
        return result;
      });
    },
    setSubscription(value) { return serial(() => setSubscriptionCore(value)); },
    refresh() { return serial(() => refreshCore()); },
    status() {
      return serial(async () => {
        if (!cfg.subscriptionUrl) return snapshot();
        try {
          version = await manager.getVersion();
          if (version) {
            await updatePool();
            await reconcileAccountSelectors();
            if (state === 'stopped' || state === 'starting') state = 'ready';
          } else if (state !== 'error' && state !== 'starting') {
            state = 'stopped';
            // 内核可能在 ready 后被 OOM/SIGTERM 杀掉；不能继续把旧 dispatcher
            // 注入 worker，否则请求会反复打到已失效的 mixed-port。状态探测失败
            // 时立即关闭代理连接并回落直连，下一次 refresh 会重新建立它。
            stopTimers();
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
          stopTimers();
          await closeDispatcher();
          version = null;
          nodeNames = [];
          currentNode = '';
        }
        return snapshot();
      });
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
    setAccountSelectionPriority(priority) {
      return serial(async () => {
        if (!['advanced', 'unused'].includes(priority)) {
          throw new Error('账号自动出站优先级必须是 advanced 或 unused');
        }
        if (cfg.accountSelectionPriority === priority) return snapshot();
        cfg.accountSelectionPriority = priority;
        save();
        // 策略切换必须废弃所有已启动的自动选择，不只是已有 validation 的 lane。
        // 否则尚在 verify 的旧策略操作仍能提交 Free，并写入旧策略对应的长 TTL。
        const lanes = new Set([
          ...accountOperationVersions.keys(),
          ...accountAutoValidations.keys(),
        ]);
        for (const lane of lanes) {
          bumpAccountOperation(lane);
          invalidateAccountProbeLane(lane);
          const validation = accountAutoValidations.get(lane);
          if (validation) {
            accountAutoValidations.set(lane, { ...validation, stale: true, expiresAt: 0 });
          }
        }
        try { onAutoRefresh?.({ force: true }); } catch (error) {
          serviceLogger('warn', `[proxy] 账号出站优先级切换后重验调度失败: ${cleanError(error)}`);
        }
        return snapshot();
      });
    },
    setAccountNode({ lane: rawLane, node, identity = '' } = {}) {
      return serial(async () => {
        const lane = normalizeAccountLane(rawLane);
        applyAccountIdentity(lane, identity);
        bumpAccountOperation(lane);
        if (!cfg.subscriptionUrl || !(await manager.isRunning()) || state !== 'ready') throw new Error('mihomo 未运行');
        await updatePool();
        const name = String(node || '').trim();
        if (!name) throw new Error('手动模式必须选择节点');
        if (!nodeNames.includes(name)) throw new Error('节点不存在或已失效');
        await switchAccountNode(lane, name);
        accountAutoValidations.delete(lane);
        return { lane, node: name, port: accountPort(lane) };
      });
    },
    async selectAccountNodeAuto({ lane: rawLane, verify, force = false, identity = '' } = {}) {
      const prepared = await serial(async () => {
        const lane = normalizeAccountLane(rawLane);
        const normalizedIdentity = applyAccountIdentity(lane, identity);
        if (typeof verify !== 'function') throw new Error('自动模式缺少模型目录验证器');
        if (!cfg.subscriptionUrl || !(await manager.isRunning()) || state !== 'ready') throw new Error('mihomo 未运行');
        // 显式 force 也用于外部 provider 变更后的恢复；此时同步一次 selector，
        // 让已被删除的节点立即失效。普通并发验证仍只读已提交快照，不重复 GET。
        if (force) await updatePool();
        // 候选由最近一次成功的订阅刷新/测活原子提交。账号验证只读内存快照，
        // 避免多账号并发时重复读取同一个全局节点池。
        const operationVersion = bumpAccountOperation(lane);
        const topologyVersion = accountTopologyVersion;
        const availableCandidates = accountAutoCandidates(lane);
        if (!availableCandidates.length) {
          const error = new Error('没有测活成功的 US/SG 节点');
          error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
          throw error;
        }
        const cached = accountAutoValidations.get(lane);
        const cachedOccupied = isAccountNodeOccupied(cached?.node, lane);
        const hasUnoccupiedCandidate = availableCandidates.some((entry) => (
          !isAccountNodeOccupied(entry.name, lane)
        ));
        // 「优先高级」下被别的账号复用不是放弃高级节点的理由：复用本来就是这个优先级
        // 允许的（节点不够时靠它保证每个账号都是高级权限），而让出高级节点去赌一个未知
        // 节点，多半赌成 Free。以前这条判据把已占用一律当作缓存失效，两个账号会围着
        // 同一个高级节点来回抢：谁被复用谁重扫，重扫完又把节点让给对方。
        const cachedAdvancedShared = cfg.accountSelectionPriority === 'advanced'
          && cached?.tier === 'advanced';
        if (!force && cached && cached.identity === normalizedIdentity
          && cached.topologyVersion === topologyVersion
          && cached.generation === accountGenerations.get(lane)
          && cached.expiresAt > now()
          && (cachedAdvancedShared || !cachedOccupied || !hasUnoccupiedCandidate)
          && availableCandidates.some((entry) => entry.name === cached.node)) {
          await ensureAccountDispatcher(lane);
          if (accountNodes.get(lane) !== cached.node) await switchAccountNode(lane, cached.node);
          return {
            result: {
              lane,
              node: cached.node,
              port: accountPort(lane),
              cached: true,
              ...(cached.tier && cached.model ? { tier: cached.tier, model: cached.model } : {}),
            },
          };
        }

        const candidate = reserveNextAccountAutoCandidate({
          lane,
          identity: normalizedIdentity,
          operationVersion,
          topologyVersion,
        });
        if (!candidate) {
          const error = new Error('没有测活成功的 US/SG 节点');
          error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
          throw error;
        }
        return { lane, normalizedIdentity, operationVersion, topologyVersion, candidate };
      });
      if (prepared.result) return prepared.result;

      const { lane, normalizedIdentity, operationVersion, topologyVersion } = prepared;
      let candidate = prepared.candidate;
      const selectionPriority = cfg.accountSelectionPriority;
      const attemptedNodes = new Set();
      let freeFallback = null;
      // Free 在「优先未用」下是正常终态，在「优先高级」下只是兜底，按语义分别给 TTL。
      const freeAwareCacheTtl = (tier) => (tier === 'free'
        ? (selectionPriority === 'advanced'
          ? ACCOUNT_FREE_DOWNGRADE_CACHE_TTL_MS : ACCOUNT_FREE_AUTO_CACHE_TTL_MS)
        : ACCOUNT_AUTO_CACHE_TTL_MS);

      // 只在 serial 队列内调用：reservation 已经属于当前 operation 时，
      // 把验证通过的节点切到业务 lane 并写入授权缓存。
      const commitReserved = async (entry, authorization) => {
        const reservation = accountAutoReservations.get(lane);
        if (!reservation || reservation.operationVersion !== operationVersion
          || reservation.node !== entry.name) return null;
        if (!nodeNames.includes(entry.name) || liveRejectedNodes(lane).has(entry.name)) {
          rejectAccountNode(lane, entry.name);
          releaseAccountAutoReservation(lane, operationVersion);
          return null;
        }
        await switchAccountNode(lane, entry.name);
        if (liveRejectedNodes(lane).has(entry.name)) {
          releaseAccountAutoReservation(lane, operationVersion);
          return null;
        }
        releaseAccountAutoReservation(lane, operationVersion);
        accountAutoValidations.set(lane, {
          node: entry.name,
          identity: normalizedIdentity,
          topologyVersion,
          generation: accountGenerations.get(lane),
          tier: authorization?.tier || null,
          model: authorization?.model || null,
          expiresAt: now() + freeAwareCacheTtl(authorization?.tier),
        });
        return {
          lane,
          node: entry.name,
          port: accountPort(lane),
          cached: false,
          ...(authorization?.tier && authorization?.model
            ? { tier: authorization.tier, model: authorization.model } : {}),
        };
      };

      try {
        while (candidate) {
          attemptedNodes.add(candidate.name);
          let verification = null;
          let verificationFailed = false;
          try {
            verification = await probeSerial(lane, async () => {
              assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
              const probeFetch = await switchAccountProbeNode(lane, candidate.name, topologyVersion);
              assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
              return verify({ lane, node: candidate.name, fetch: probeFetch });
            });
          } catch (error) {
            if (error?.code === 'ACCOUNT_EGRESS_SUPERSEDED') throw error;
            if (error?.code === 'ACCOUNT_EGRESS_TERMINAL') throw error;
            verificationFailed = true;
            serviceLogger('warn', `[proxy] 账号 lane ${lane} 节点验证失败 ${candidate.name}: ${cleanError(error)}`);
          }

          const committed = await serial(async () => {
            assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
            const reservation = accountAutoReservations.get(lane);
            if (!reservation || reservation.operationVersion !== operationVersion
              || reservation.node !== candidate.name) return null;
            const authorization = typeof verification === 'object' ? verification : null;
            noteAccountNodeTier(candidate.name, authorization?.tier);
            // 验证请求在途时，业务流量可能已经明确收到 country_blocked/ip_capped。
            // 后到的“模型目录正常”不能覆盖更新鲜的出口拒绝观测。
            if (verification && nodeNames.includes(candidate.name) && !liveRejectedNodes(lane).has(candidate.name)) {
              // 高级优先时，Free 只是候选，不立即提交；继续探测剩余节点。
              // 没有高级节点时由循环末尾提交最早发现的 Free 兜底。
              if (selectionPriority === 'advanced' && authorization?.tier === 'free') {
                freeFallback ||= { candidate, authorization };
                releaseAccountAutoReservation(lane, operationVersion);
                return { deferred: true };
              }
              return commitReserved(candidate, authorization);
            }
            rejectAccountNode(lane, candidate.name, verificationFailed ? {
              preserveValidation: true,
              ttlMs: ACCOUNT_AUTO_RETRY_TTL_MS,
            } : undefined);
            releaseAccountAutoReservation(lane, operationVersion);
            return null;
          });
          if (committed?.deferred) {
            candidate = await serial(async () => {
              assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
              releaseAccountAutoReservation(lane, operationVersion);
              return reserveNextAccountAutoCandidate({
                lane,
                identity: normalizedIdentity,
                operationVersion,
                topologyVersion,
                excludedNodes: attemptedNodes,
                skipKnownFree: true,
              });
            });
            if (!candidate && freeFallback) {
              const fallbackResult = await serial(async () => {
                assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
                const reserved = reserveAccountAutoCandidateByName({
                  lane,
                  identity: normalizedIdentity,
                  operationVersion,
                  topologyVersion,
                  node: freeFallback.candidate.name,
                });
                if (!reserved) return null;
                return commitReserved(reserved, freeFallback.authorization);
              });
              if (fallbackResult) return fallbackResult;
            }
            continue;
          }
          if (committed) return committed;

          candidate = await serial(async () => {
            assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
            releaseAccountAutoReservation(lane, operationVersion);
            return reserveNextAccountAutoCandidate({
              lane,
              identity: normalizedIdentity,
              operationVersion,
              topologyVersion,
              excludedNodes: attemptedNodes,
              skipKnownFree: Boolean(freeFallback),
            });
          });
        }

        await serial(async () => {
          assertAccountOperation(lane, operationVersion, normalizedIdentity, topologyVersion);
          const stale = accountAutoValidations.get(lane);
          if (stale && stale.identity === normalizedIdentity
            && stale.topologyVersion === topologyVersion
            && stale.generation === accountGenerations.get(lane)) {
            accountAutoValidations.set(lane, {
              ...stale,
              expiresAt: now() + ACCOUNT_AUTO_RETRY_TTL_MS,
            });
          } else {
            accountAutoValidations.delete(lane);
          }
        });
        const error = new Error('没有可用账号授权的 US/SG 节点');
        error.code = 'ACCOUNT_EGRESS_UNAVAILABLE';
        throw error;
      } finally {
        await serial(() => releaseAccountAutoReservation(lane, operationVersion));
      }
    },
    releaseAccountLane(rawLane) {
      return serial(async () => {
        const lane = normalizeAccountLane(rawLane);
        bumpAccountOperation(lane);
        const dispatcher = accountFetches.get(lane);
        accountFetches.delete(lane);
        accountNodes.delete(lane);
        accountGenerations.delete(lane);
        accountIdentities.delete(lane);
        accountRejects.delete(lane);
        accountAutoValidations.delete(lane);
        accountRejectedNodes.delete(lane);
        closeInBackground(dispatcher);
        invalidateAccountProbeLane(lane);
      });
    },
    getAccountFetch(rawLane, { identity = '' } = {}) {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return null; }
      return state === 'ready' && accountIdentities.get(lane) === String(identity || '') && accountNodes.has(lane)
        ? accountFetches.get(lane)?.fetch || null : null;
    },
    getAccountAutoFetch(rawLane, { allowStale = false, identity = '' } = {}) {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return null; }
      if (state !== 'ready') return null;
      const validation = accountAutoValidations.get(lane);
      const current = accountNodes.get(lane);
      const accountFetch = accountFetches.get(lane)?.fetch || null;
      if (!validation || validation.identity !== String(identity || '')
        || validation.topologyVersion !== accountTopologyVersion
        || validation.generation !== accountGenerations.get(lane)
        || !accountFetch || !current || validation.node !== current) return null;
      if (!allowStale && validation.expiresAt <= now()) return null;
      return accountFetch;
    },
    getAccountNode(rawLane) {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return null; }
      return accountNodes.get(lane) || null;
    },
    getAccountGeneration(rawLane) {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return null; }
      return accountGenerations.get(lane) || null;
    },
    getAccountAutoCandidates() {
      return accountAutoCandidates();
    },
    isAccountAutoReady(rawLane, node = '', identity = '') {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return false; }
      const validation = accountAutoValidations.get(lane);
      return Boolean(validation && validation.identity === String(identity || '')
        && validation.topologyVersion === accountTopologyVersion
        && validation.generation === accountGenerations.get(lane)
        && validation.expiresAt > now()
        && (!node || validation.node === node));
    },
    getAccountReject(rawLane) {
      let lane;
      try { lane = normalizeAccountLane(rawLane); } catch { return null; }
      return accountRejects.get(lane) || null;
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
    setUpdate({ enabled, interval } = {}) {
      return serial(async () => {
        if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
        const n = Number(interval);
        if (!Number.isInteger(n)) throw new Error('自动更新间隔必须是整数秒');
        if (n < MIN_UPDATE_INTERVAL || n > MAX_UPDATE_INTERVAL) {
          throw new Error(`自动更新间隔必须在 ${MIN_UPDATE_INTERVAL} 到 ${MAX_UPDATE_INTERVAL} 秒之间`);
        }
        cfg.autoUpdate = enabled;
        cfg.autoUpdateInterval = n;
        save();
        scheduleUpdate();
        return snapshot();
      });
    },
    testHealth() { return serial(() => testHealthCore()); },
    async stop() { return serial(() => disableCore()); },
    getFetch() { return upstreamFetch; },
    noteEgressReject,
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

// keepAliveTimeout 用 undici 默认的 4000ms，别再写 10。
// 那个 10 的单位是毫秒（不是秒），等于「空闲 10ms 就关连接」。undici 的规则是：
// 上游给了 `Keep-Alive: timeout=N` 就用上游值，没给才落到这个选项
// （node_modules/undici/lib/dispatcher/client-h1.js 的 onHeadersComplete）。
// 实测上游是 Cloudflare，只发 `Connection: keep-alive`、不带 timeout=N，所以这个 10
// 全程生效：每个上游调用都在重建 TCP + 到 codebuff 的 TLS。
// 收益集中在冷路——建会话那条链在同一条 lane 上背靠背串 5~8 个调用（广告链、usage、
// GET/POST session、agent-runs），间隔毫秒级，实测每个省约 79ms，合计 0.4~0.6s。
// 热路（session 命中缓存，只剩 chat 一个调用）本来就吃不到，两次用户请求间隔远超任何
// keep-alive 窗口。所以不必显式写 30s：默认 4000ms 已经吃满毫秒级间隔那部分，
// 写更长只会把「命中对端已关的 socket」的窗口拉大。那个失败形状
// （ECONNRESET / socket hang up）已被 isTransientUpstreamError 归为上游抖动、
// 原地重试同号，不会白扣额度，但没必要主动扩大。
// 换节点不依赖这个超时：每条切换路径都显式关掉旧 dispatcher（见 switchAccountNode
// 的 closeInBackground(previous) 和 dropAccountLaneRuntime）。
async function buildProxyFetch({ port = MIXED_PORT } = {}) {
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${port}` });
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
  onAutoRefresh: () => accountAutoRefreshHandler?.(),
});

export async function initProxy(subscriptionUrl) {
  await proxyService.initialize(subscriptionUrl);
  return proxyService.getFetch();
}

export async function refreshSubscription() { return proxyService.refresh(); }
export async function getProxyStatus() { return proxyService.status(); }
export async function setProxySubscription(url) { return proxyService.setSubscription(url); }
export async function setProxyNode(options) { return proxyService.setNode(options); }
export async function setAccountProxySelectionPriority(priority) {
  return proxyService.setAccountSelectionPriority(priority);
}
// 兼容更直观的命名，管理服务目前使用上面的 account-prefixed 导出。
export const setProxyAccountSelectionPriority = setAccountProxySelectionPriority;
export async function setProxyHealth(options) { return proxyService.setHealth(options); }
export async function setProxyUpdate(options) { return proxyService.setUpdate(options); }
export function getConfiguredSubscription() { return proxyService.getSubscriptionUrl(); }
export function isProxyEnvLocked() { return proxyService.isEnvLocked(); }
export async function stopProxy() { return proxyService.stop(); }
export function getUpstreamFetch() { return proxyService.getFetch(); }
export function noteEgressReject(info) { return proxyService.noteEgressReject(info); }
export function setAccountProxyNode(options) { return proxyService.setAccountNode(options); }
export function selectAccountProxyNodeAuto(options) { return proxyService.selectAccountNodeAuto(options); }
export function releaseAccountProxyLane(lane) { return proxyService.releaseAccountLane(lane); }
export function getAccountUpstreamFetch(lane, options) { return proxyService.getAccountFetch(lane, options); }
export function getAccountAutoUpstreamFetch(lane, options) { return proxyService.getAccountAutoFetch(lane, options); }
export function getAccountProxyNode(lane) { return proxyService.getAccountNode(lane); }
export function getAccountProxyGeneration(lane) { return proxyService.getAccountGeneration(lane); }
export function getAccountAutoCandidates() { return proxyService.getAccountAutoCandidates(); }
export function isAccountAutoEgressReady(lane, node, identity) { return proxyService.isAccountAutoReady(lane, node, identity); }
export function getAccountEgressReject(lane) { return proxyService.getAccountReject(lane); }
