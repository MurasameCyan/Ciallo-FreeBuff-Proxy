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

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createMihomoManager } from './mihomo.mjs';

// ── 端口/路径常量（env 可覆盖，避免和本机其它 clash 类程序撞端口） ──
const MIXED_PORT = parseInt(process.env.MIHOMO_MIXED_PORT || '17897', 10); // 出站 HTTP 代理端口
const CTRL_PORT = parseInt(process.env.MIHOMO_CTRL_PORT || '19090', 10);   // external-controller
const POOL_NAME = 'freebuff-pool';
const PROVIDER_NAME = 'freebuff-airport';
const MIHOMO_BIN = process.env.MIHOMO_BIN || '/usr/local/bin/mihomo';
const MIHOMO_DATA_DIR = process.env.MIHOMO_DATA_DIR || resolve(process.cwd(), '.mihomo');
const MIHOMO_CONFIG = resolve(MIHOMO_DATA_DIR, 'config.yaml');

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

// ── 代理生命周期 ─────────────────────────────────────────
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

/** 让 mihomo 立刻重拉订阅（节点变了马上生效，不用等 5 分钟健康检查） */
export async function refreshSubscription() {
  const ok = await manager.isRunning();
  if (!ok) return { ok: false, error: 'mihomo 未运行' };
  try {
    const r = await fetch(`http://127.0.0.1:${CTRL_PORT}/providers/proxies/${PROVIDER_NAME}`, { method: 'PUT' });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * 启动 mihomo 并返回一个「走代理的 fetch」。
 * - 无订阅地址：返回 null（保持直连）
 * - 有订阅地址：写配置 → 起内核 → 建 undici ProxyAgent → 返回包好的 fetch
 * dispatcher 缓存：内核重启后失效重建。
 */
let agentCache = null;
let upstreamFetchImpl = null;

export async function initProxy(subscriptionUrl) {
  if (!subscriptionUrl) return null;
  try {
    writeMihomoConfig(subscriptionUrl);
    await manager.start();
    await buildProxyAgent();
    return upstreamFetchImpl;
  } catch (e) {
    logger('error', `[proxy] 初始化失败: ${e.message}`);
    return null;
  }
}

async function buildProxyAgent() {
  // undici ProxyAgent：指向 mihomo mixed-port，出站走 HTTP CONNECT
  // 每次请求新建连接（keepAlive 关闭 = 换节点即换出口 IP，与 Zen 一致）
  const { ProxyAgent } = await import('undici');
  const agent = new ProxyAgent({
    uri: `http://127.0.0.1:${MIXED_PORT}`,
    keepAliveTimeout: 10,
    requestTls: { rejectUnauthorized: false },
  });
  agentCache = agent;
  upstreamFetchImpl = (url, init = {}) => fetch(url, { ...init, dispatcher: agent });
}

export async function stopProxy() {
  if (agentCache) {
    try { agentCache.close(); } catch {}
    agentCache = null;
    upstreamFetchImpl = null;
  }
  await manager.stop();
}

/** 当前出站 fetch（直连时为 null，调用方自行回落全局 fetch） */
export function getUpstreamFetch() {
  return upstreamFetchImpl;
}
