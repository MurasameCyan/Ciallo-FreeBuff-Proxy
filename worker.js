const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_API_KEY = "freebuff-default-key";
const VERSION = "1.9.1";
const CONTEXT_PRUNER_AGENT = "context-pruner";

// 自定义模型映射（alias → freebuff 模型 id）。
// 用途：客户端可用任意自定义模型名（如 "gpt-5"、"fast"）调用，映射到 freebuff 真实模型。
// 只做本地字符串映射，不触发网络请求、不创建 session、不消耗免费会话额度。
// 格式（env 或 aliases.json，server.js 合并后经 env.MODEL_ALIASES 传入）：
//   "别名=模型id, 别名2=模型id2"
// 解析优先级：自定义别名 → 真实模型 id → 动态表 → 静态 MODELS。
// ⚠️ worker 顶层无 env 全局（env 经 fetch handler 参数传入），别名表惰性构建：
// 每请求根据 env.MODEL_ALIASES 重建（本地字符串解析，开销可忽略）。
// 每请求经 env.MODEL_ALIASES 重建（fetch 入口调用），下游函数无侵入读取
let currentAliases = new Map();

function parseModelAliases(raw) {
  const out = new Map(); // alias(lower) -> modelId
  if (!raw) return out;
  for (const part of String(raw).split(",")) {
    const kv = part.trim().split("=");
    if (kv.length !== 2) continue;
    const alias = (kv[0] || "").trim().toLowerCase();
    const modelId = (kv[1] || "").trim();
    if (alias && modelId) out.set(alias, modelId);
  }
  return out;
}

// 动态模型注册表：从官方 freebuff 镜像拉取模型清单
// 真源: https://github.com/CodebuffAI/freebuff (freebuff-private 的 public 镜像)
// 与 Freebuff Desktop 0.0.51 orchestrator.js 的 FREEBUFF_ROOT_AGENT_ID_BY_MODEL 同源
// （镜像常量 = 桌面版同源源码，安装包只是编译产物）
// 需要 3 个源（常量分散定义）：
//   1. free-agents.ts       → FREEBUFF_ROOT_AGENT_ID_BY_MODEL（模型→agent 映射）
//   2. freebuff-models.ts   → 大部分模型 ID 常量 + 池定义（PREMIUM/GLM）
//   3. freebuff-model-ids.ts→ deepseek/m3 等 ID 常量（被 models.ts re-export）
// 每源都有 raw 主源 + jsDelivr 备用
const DYNAMIC_MODELS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/free-agents.ts",
];
const DYNAMIC_MODELS_MODEL_IDS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-models.ts",
];
const DYNAMIC_MODELS_STABLE_IDS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-model-ids.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-model-ids.ts",
];
// Releases 兜底源：GitHub Actions 每天生成的解析好的 JSON（无需解析，直接可用）
// 当官方 3 个源全部失败/解析失败时使用。比 raw.githubusercontent 更稳（GitHub CDN）。
// 已实测（2026-08-11）：releases/latest/download 地址 HTTP 200，内容正确。
const DYNAMIC_MODELS_RELEASE_SOURCES = [
  "https://github.com/pingmike2/freebuff2api-wokers/releases/latest/download/freebuff-models.json",
];
// 刷新间隔：与 Quorinex 对齐，6 小时。失败时回退到硬编码 MODELS。
const DYNAMIC_MODELS_REFRESH_MS = 6 * 60 * 60 * 1000;
const DYNAMIC_MODELS_FETCH_TIMEOUT_MS = 10000;

// 运行时动态模型缓存（内存，无 KV）
let dynamicModelsCache = {
  fetchedAt: 0,
  models: null, // 动态模型表（含分类）
  pool: null, // { premium: Set, standard: Set, glm: Set }
};

// 解析 freebuff-models.ts 的模型 ID 常量
// 形如:
//   export const FREEBUFF_MIMO_V25_MODEL_ID = mimoModels.mimoV25
//   export const FREEBUFF_MINIMAX_M3_MODEL_ID = 'minimax/minimax-m3'
// 兼容: 'string' | 标识符.成员（取成员名查 knownDefaults）| 标识符
function parseModelIdConstants(source) {
  const table = {};
  const knownDefaults = {
    mimoV25: "mimo/mimo-v2.5",
  };
  // 匹配 export const NAME = 'value' 或 export const NAME = expr
  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.]+))/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const lit = m[2] ?? m[3] ?? "";
    const expr = m[4] ?? "";
    if (lit) table[name] = lit;
    else if (expr) {
      // 标识符.成员 → 取成员名（mimoModels.mimoV25 → mimoV25）
      const member = expr.includes(".") ? expr.split(".").pop() : expr;
      if (knownDefaults[member]) table[name] = knownDefaults[member];
      else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(expr)) table[name] = expr;
    }
  }
  return table;
}

// 解析 free-agents.ts 中按用途分开的 agent 映射。
// 不把 base2 root、base3 root、reviewer 混为一张表：它们属于不同运行路径。
function parseAgentMappings(source, modelIdConstants) {
  const blockNames = {
    root: "FREEBUFF_ROOT_AGENT_ID_BY_MODEL",
    base3: "FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL",
    reviewer: "FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL",
  };
  const result = { root: {}, base3: {}, reviewer: {} };
  const lineRe = /\[\s*([A-Z0-9_]+)\s*\]\s*:\s*'([^']+)'/g;
  for (const [kind, blockName] of Object.entries(blockNames)) {
    const blockRe = new RegExp(`${blockName}[^=]*=\\s*\\{([^}]*)\\}`);
    const blockMatch = blockRe.exec(source);
    if (!blockMatch) continue;
    let m;
    lineRe.lastIndex = 0;
    while ((m = lineRe.exec(blockMatch[1])) !== null) {
      const modelId = modelIdConstants[m[1]];
      if (modelId) result[kind][modelId] = m[2];
    }
  }
  return result;
}

// 兼容旧调用方：默认返回普通 base2 root 映射。
function parseAgentMapping(source, modelIdConstants) {
  return parseAgentMappings(source, modelIdConstants).root;
}

// 解析 freebuff-models.ts 的池定义（PREMIUM / GLM；STANDARD 由 non-premium 推导）
// FREEBUFF_WEB_PREMIUM_MODEL_IDS 含 spread（...FREEBUFF_PREMIUM_MODEL_IDS）
function parseModelPools(source, modelIdConstants) {
  const premium = new Set();
  const glm = new Set();
  const used = new Set();
  // 展开 spread: ...FOO → FOO 里的条目（常量名 → 值）
  const constValues = new Map();
  const constListRe = /export\s+const\s+([A-Z0-9_]+)\s*=\s*\[([^\]]*)\]\s*as\s*const/g;
  let cm;
  while ((cm = constListRe.exec(source)) !== null) {
    const name = cm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(cm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) items.push(["spread", spread]);
      else if (lit) items.push(["lit", lit]);
      else if (expr && modelIdConstants[expr]) items.push(["lit", modelIdConstants[expr]]);
    }
    constValues.set(name, items);
  }
  // 解析池
  const poolRe = /export\s+const\s+(FREEBUFF_WEB_PREMIUM_MODEL_IDS|FREEBUFF_GLM_V52_MODEL_IDS|FREEBUFF_PREMIUM_MODEL_IDS)\s*=\s*\[([^\]]*)\]/g;
  let pm;
  while ((pm = poolRe.exec(source)) !== null) {
    const poolName = pm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(pm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) {
        // 递归展开 spread 常量
        const expand = (n) => {
          const entries = constValues.get(n) || [];
          for (const [kind, val] of entries) {
            if (kind === "spread") expand(val);
            else items.push(val);
          }
        };
        expand(spread);
      } else if (lit) items.push(lit);
      else if (expr && modelIdConstants[expr]) items.push(modelIdConstants[expr]);
    }
    if (poolName === "FREEBUFF_GLM_V52_MODEL_IDS") {
      for (const id of items) glm.add(id);
    } else {
      for (const id of items) premium.add(id);
    }
  }
  // FREEBUFF_PREMIUM_MODEL_IDS 与 FREEBUFF_WEB_PREMIUM_MODEL_IDS 都算 premium
  return { premium: [...premium], glm: [...glm] };
}

// 动态模型表：分别记录普通 root、base3 root、reviewer。
function buildDynamicModelTable(agentMappings) {
  // 兼容旧调用：传入单张 root mapping 时仍可正常构建。
  const mappings = agentMappings && agentMappings.root
    ? agentMappings
    : { root: agentMappings || {}, base3: {}, reviewer: {} };
  return Object.entries(mappings.root).map(([modelId, rootAgent]) => ({
    id: modelId,
    session: modelId,
    // 旧字段保留为普通 root，普通 chat 永远使用它。
    agent: rootAgent,
    root_agent: rootAgent,
    base3_agent: mappings.base3[modelId] || null,
    reviewer_agent: mappings.reviewer[modelId] || null,
    upstream: modelId,
  }));
}

// 合并硬编码与动态表：硬编码优先（不覆盖），动态新增追加
function mergeModelTables(hardcoded, dynamic) {
  const seen = new Set(hardcoded.map((m) => m.id));
  const merged = [...hardcoded];
  for (const m of dynamic) {
    if (!seen.has(m.id)) {
      merged.push(m);
      seen.add(m.id);
    }
  }
  return merged;
}

// 拉取并刷新动态模型缓存（失败静默回退）
async function fetchSourceList(urls) {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        // 阈值放宽：freebuff-model-ids.ts 只有 ~491B（3 个常量），
        // 500 阈值会误杀。只过滤真正的空文件（<100B）。
        if (text && text.length > 100) return text;
      }
    } catch {}
  }
  return null;
}

async function refreshDynamicModelsIfStale() {
  const now = Date.now();
  if (dynamicModelsCache.models && now - dynamicModelsCache.fetchedAt < DYNAMIC_MODELS_REFRESH_MS) {
    return dynamicModelsCache;
  }
  // 并行拉 3 个源（每源主 raw + 备 jsDelivr）
  const [agentsSrc, modelsSrc, stableIdsSrc] = await Promise.all([
    fetchSourceList(DYNAMIC_MODELS_SOURCES),
    fetchSourceList(DYNAMIC_MODELS_MODEL_IDS_SOURCES),
    fetchSourceList(DYNAMIC_MODELS_STABLE_IDS_SOURCES),
  ]);
  if (!agentsSrc || !modelsSrc) {
    // 官方源拉取失败：尝试 Releases JSON 兜底
    const release = await tryReleaseFallback();
    if (release) {
      dynamicModelsCache = release;
      return dynamicModelsCache;
    }
    // Releases 也失败：保留旧缓存（若有），否则维持现状
    return dynamicModelsCache;
  }
  try {
    // 合并常量表：models.ts 优先（完整），stableIds.ts 补充 deepseek/m3
    const modelIdConstants = { ...parseModelIdConstants(stableIdsSrc || ""), ...parseModelIdConstants(modelsSrc) };
    const agentMappings = parseAgentMappings(agentsSrc, modelIdConstants);
    if (Object.keys(agentMappings.root).length === 0) {
      // 解析失败：尝试 Releases 兜底
      const release = await tryReleaseFallback();
      if (release) {
        dynamicModelsCache = release;
        return dynamicModelsCache;
      }
      return dynamicModelsCache;
    }
    const pools = parseModelPools(modelsSrc, modelIdConstants);
    dynamicModelsCache = {
      fetchedAt: Date.now(),
      models: buildDynamicModelTable(agentMappings),
      pool: {
        premium: new Set(pools.premium),
        standard: null,
        glm: new Set(pools.glm),
      },
    };
  } catch {
    // 解析崩溃：尝试 Releases 兜底
    const release = await tryReleaseFallback();
    if (release) {
      dynamicModelsCache = release;
      return dynamicModelsCache;
    }
    // 保留旧缓存
  }
  return dynamicModelsCache;
}

// Releases JSON 兜底：直接拉预生成的 models.json，零解析成本
async function tryReleaseFallback() {
  for (const url of DYNAMIC_MODELS_RELEASE_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json && Array.isArray(json.models) && json.models.length > 0) {
          return {
            fetchedAt: Date.now(),
            models: json.models,
            pool: {
              premium: new Set(json.pools?.premium ?? []),
              standard: null,
              glm: new Set(json.pools?.glm ?? []),
            },
          };
        }
      }
    } catch {}
  }
  return null;
}

// 动态 STANDARD = 动态表里不在 premium/glm 池的模型
function dynamicStandardModels() {
  const cache = dynamicModelsCache;
  if (!cache || !cache.models || !cache.pool) return new Set();
  const premium = cache.pool.premium;
  const glm = cache.pool.glm;
  return new Set(cache.models.map((m) => m.id).filter((id) => !premium.has(id) && !glm.has(id)));
}

// 模型池分类查询：动态池优先，硬编码兜底
// 返回 "premium" | "standard" | "glm" | null
function modelPoolCategory(modelId) {
  const dyn = dynamicModelsCache;
  if (dyn && dyn.pool) {
    if (dyn.pool.premium.has(modelId)) return "premium";
    if (dyn.pool.glm.has(modelId)) return "glm";
    if (dynamicStandardModels().has(modelId)) return "standard";
  }
  // 硬编码兜底
  if (PREMIUM_QUOTA_MODELS.has(modelId)) return "premium";
  if (STANDARD_MODELS.has(modelId)) return "standard";
  return null;
}


// 模型 → session 用模型名 / 上游 agentId / 上游 chat 模型名
// 只保留 1 个硬编码兜底（极端情况下至少有一个可用）：
//   - mimo/mimo-v2.5   STANDARD 模型
// 其余模型全部由动态拉取提供（官方源 → GitHub Releases JSON → 这个兜底）
const MODELS = [
  { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base2-free-mimo", upstream: "mimo/mimo-v2.5" },
];

// 实测（2026-08-15）免费账号可用的模型白名单：
//   deepseek-v4-flash / mimo-v2.5 —— 其余模型（v4-pro、luna、m3、glm 等）
//   上游返回 409 session_model_mismatch / 403 free_mode_invalid_agent_model，
//   "Limited free access is only available with DeepSeek V4 Flash or MiMo 2.5"。
//   面板 /v1/models 只对这两个打 free tag。
const FREE_AVAILABLE_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "mimo/mimo-v2.5",
]);

// ---------------------------------------------------------------------------
// 额度池说明（逆向自官方源码 freebuff-models.ts，2026-08-10 实证）
//
// 官方三种额度池（都是 session 次数，非 token 数）：
//   1. PREMIUM 池：共享 6 次/天（FREEBUFF_PREMIUM_SESSION_LIMIT=6）
//      m3 / v4-pro / luna / laguna-s-2.1 / muse-spark / greg-2 等
//      （FREEBUFF_WEB_PREMIUM_MODEL_IDS）
//   2. STANDARD 池：浏览器/Web 端 6 次/天
//      （FREEBUFF_WEB_STANDARD_SESSION_LIMIT=6；= 所有非 premium 模型，
//      即 Flash / MiMo 2.5 等。FREEBUFF_WEB_STANDARD_MODEL_IDS）
//      ⚠️ 注释原文："The CLI keeps these models UNLIMITED; browser surfaces
//      cap fresh sessions to deter automated project/session churn."
//      → CLI 协议 Flash 无限，但 CLI 已被官方封堵（free_mode_cli_required）；
//        桌面版/Web 协议下 Flash 同样受 6 次/天限制
//   3. GLM 5.2 池：独立，referral 解锁（不计入以上）
//
// 桌面版并发桶（FREEBUFF_DESKTOP_SESSION_LIMITS，仅限并发非额度）：
//   premium:  1  ← Premium 模型每用户同时 1 个活跃 session
//   unlimited: 3 ← Flash/MiMo 每用户最多 3 个并发 tab
//   limited 访问层（无 Premium 的号）：所有模型都占 1 个 slot
//   （occupiesFreebuffDesktopSlot / getFreebuffDesktopSessionBucket）
//
// 对 1.7.0 的意义：单号串行时每天上限 = Premium 6 + Flash 6（07:00 UTC
// 太平洋日重置）。并发到多号会同时烧各号额度，无法靠并发突破 6 次/天。
// 额度池只用于选号，绝不改变调用方请求的模型。
// ---------------------------------------------------------------------------
const PREMIUM_QUOTA_MODELS = new Set([
  "deepseek/deepseek-v4-pro",
  "openai/gpt-5.6-luna",
  "minimax/minimax-m3",
  "meta/muse-spark-1.2-contributor",
]);
const STANDARD_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "mimo/mimo-v2.5",
]);

// ---------------------------------------------------------------------------
// 桌面版协议常量（逆向自 Freebuff Desktop orchestrator.js）
// 桌面版 = multi-session 模式（每 tab 一个实例），与 CLI 单会话区分。
// ⚠️ 实测（2026-08-10）：multi-session 创建的实例 chat 报 428 waiting_room_required
// （服务端 chat gate 不识别多会话实例），因此 POST 实际用单会话但保留
// 预生成 instance-id 的桌面版签名。include-unused-rate-limits 是浏览器/
// 模型选择器用的额度快照头，GET 探测时带它没问题。
// ---------------------------------------------------------------------------
const DESKTOP_INCLUDE_RATE_LIMITS = { "x-freebuff-include-unused-rate-limits": "1" };


export default {
  // 面板调用日志快照（server.js 的 GET /_api/usage 直接吐出）。
  getCallLog() { return callLogSnapshot(); },
  async fetch(request, env) {
    // 上游出站 fetch 注入（Node adapter 配了订阅时传入走 mihomo 的 fetch）。
    // env 可放函数（Node 的 env 是普通对象）；Cloudflare Worker 的 env 是 KV 型
    // 对象拿不到函数，保持默认全局 fetch 直连。
    if (env && typeof env.FREEBUFF_UPSTREAM_FETCH === "function") {
      upstreamFetch = env.FREEBUFF_UPSTREAM_FETCH;
    }
    // 出站 IP 被上游拒绝时的回调（同上，只有 Node adapter 能注入函数）。
    if (env && typeof env.FREEBUFF_ON_EGRESS_REJECT === "function") {
      onEgressReject = env.FREEBUFF_ON_EGRESS_REJECT;
    }
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // healthz 不鉴权：健康检查/监控探针不应依赖 API key
    if (request.method === "GET" && url.pathname === "/healthz") {
      // 健康检查只读 Worker 最近一次真实请求形成的本地快照。
      // 不因为公开探针访问就向上游 fan-out GET /session 和 /me；这类请求
      // 会产生额外行为，也可能干扰同一账号正在进行的会话。
      //
      // 顶层 status 表示「服务存活」：只要进程能应答就是 ok，存活探针（Docker
      // HEALTHCHECK / k8s liveness / CI 冒烟）据此判定。账号池健康是另一回事——
      // 0 账号是正常初始态（用户还没加号），不该让存活探针失败——单列到 pool_status。
      // 之前把 summarizeAccountHealth 直接展开，其 status 会覆盖顶层 status，
      // 空池时变成 "critical"，导致 CI 冒烟 grep '"status":"ok"' 一直失败。
      const poolHealth = summarizeAccountHealth(parseAccounts(env), acctHealth);
      return jsonResponse({
        status: "ok",
        version: VERSION,
        pool_status: poolHealth.status,
        accounts: poolHealth.accounts,
        alive_accounts: poolHealth.alive_accounts,
        unknown_accounts: poolHealth.unknown_accounts,
        account_states: poolHealth.account_states,
        account_details: poolHealth.account_details,
        health_source: "worker_cache",
        time: new Date().toISOString(),
      }, 200);
    }

    const key = getApiKey(request, env);
    if (!key) {
      if (url.pathname === "/v1/messages" || url.pathname === "/messages" || url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens") {
        return anthropicError("Invalid API key", "authentication_error", 401);
      }
      return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
    }

    // 按 env 重建自定义模型别名表（本地解析，无网络/session 开销）
    currentAliases = parseModelAliases(env.MODEL_ALIASES);

    cleanCache();

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return await handleModels();
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return handleResponses(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
      return handleAnthropicCountTokens(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return handleAnthropicMessages(request, env);
    }
    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------

let accountIdx = 0;
// session 失效安全窗口（v1.9.1，参考 kele68108/Freebuff2API-Optimized 的
// _last_invalidated_at）：同一个 token:model 的 session 被判失效（409/428/410）
// 并重建后，短时间内如果再被判失效，说明上游 session 服务正处于坏状态
// （或我们在同一个坏实例上反复创建）。此时不再无脑重建（会 409 循环打爆
// 上游），而是直接冷却该号、换号，让其他号兜底。
// 用法：
//   markSessionInvalidated(token, model)  在 deleteUpstreamSession 前调用
//   wasRecentlyInvalidated(token, model)  在重建前检查；true 则放弃重建
const sessionInvalidated = new Map();  // `${token}:${model}` -> lastInvalidatedAt(ms)
const INVALIDATION_WINDOW_MS = 30 * 1000; // 30s 内视为「刚失效过」

// single-flight session 创建去重（v1.9.1，参考 trefeon/freebuff-proxy）：
// 多个并发请求同时拿到同一个 token:model 且缓存未命中时，若各自走
// createSession 的 POST，会并发创建多个 session，后建的把先建的顶掉
// （上游 409 session_superseded："Only one instance per account is allowed"）。
// 用 in-flight Promise 去重：第一个请求真正建 session，其余请求等同一个结果。
const sessionCreateFlights = new Map(); // `${token}:${model}` -> Promise

/** single-flight 包装：同 key 并发只执行一次 fn，返回同一个 Promise */
function singleFlight(key, fn) {
  const existing = sessionCreateFlights.get(key);
  if (existing) return existing;
  const p = fn().finally(() => sessionCreateFlights.delete(key));
  sessionCreateFlights.set(key, p);
  return p;
}

function markSessionInvalidated(token, model) {
  if (!token) return;
  sessionInvalidated.set(token + ":" + (model || ""), Date.now());
}

function wasRecentlyInvalidated(token, model, now = Date.now()) {
  if (!token) return false;
  const ts = sessionInvalidated.get(token + ":" + (model || ""));
  return Boolean(ts) && (now - ts) < INVALIDATION_WINDOW_MS;
}


//   { until, retryAfterMs, reason }
//   until      到期时刻 ms；now < until 期间 pickToken 跳过该号
//   retryAfterMs  上游给的重试间隔（429 响应里的 retryAfterMs / Retry-After），
//               0 表示未知。本地 429 锁在 executeChat 开头用它算 Retry-After 头
//   reason      'quota'（上游限流/额度）/ 'error'（交互失败）/ 'invalidation'
// 参考 trefeon/freebuff-proxy：token 撞上游配额时本地直接回 429+Retry-After，
// 不再打上游（无意义地烧池子）。
const cooldowns = new Map();
const sessCache = new Map();      // `${token}:${sessionModel}` -> { instanceId, model, remainingMs, expiresAt }（必须带 token，多账号防串号）

// 明确的账号级隔离由 server.js 持久化；没有 Node adapter 时仍保留内存语义。
const durableAccountStates = new Map(); // token -> { state, until, reason }
const dirtyAccountStates = new Set(); // 本请求刚写入，不能被旧 env 快照覆盖
const accountStateRevisions = new Map(); // token -> 最近已应用/本地写入的 store revision
const accountLeases = new Map(); // token -> inFlight count (最多 1)
let accountStateSet = null;
let accountStateClear = null;
const BANNED_DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function validAccountStateRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function noteAccountStateRevision(token, result) {
  const revision = validAccountStateRevision(result && typeof result === "object" ? result.revision : null);
  if (revision === null) return;
  const previous = accountStateRevisions.get(token);
  if (previous == null || revision > previous) accountStateRevisions.set(token, revision);
}

function syncAccountState(env) {
  accountStateSet = env && typeof env.FREEBUFF_ACCOUNT_STATE_SET === "function"
    ? env.FREEBUFF_ACCOUNT_STATE_SET : null;
  accountStateClear = env && typeof env.FREEBUFF_ACCOUNT_STATE_CLEAR === "function"
    ? env.FREEBUFF_ACCOUNT_STATE_CLEAR : null;
  if (!env || !env.FREEBUFF_ACCOUNT_STATE || typeof env.FREEBUFF_ACCOUNT_STATE !== "object") return;
  const incoming = env.FREEBUFF_ACCOUNT_STATE;
  const incomingRevision = validAccountStateRevision(env.FREEBUFF_ACCOUNT_STATE_REVISION);
  const tokens = new Set(parseAccounts(env).map((acct) => acct.token));
  for (const token of tokens) {
    const knownRevision = accountStateRevisions.get(token);
    if (incomingRevision !== null && knownRevision != null && incomingRevision < knownRevision) continue;
    if (dirtyAccountStates.has(token)
      && (incomingRevision === null || knownRevision == null || incomingRevision <= knownRevision)) continue;
    const record = incoming[token];
    if (record && typeof record === "object" && record.state) {
      durableAccountStates.set(token, { ...record });
    } else {
      const previous = durableAccountStates.get(token);
      if (previous && (previous.state === "banned" || previous.state === "token_invalid" || previous.state === "manual_disabled")) {
        cooldowns.delete(token);
        acctHealth.delete(token);
      }
      durableAccountStates.delete(token);
    }
    if (incomingRevision !== null) accountStateRevisions.set(token, incomingRevision);
    dirtyAccountStates.delete(token);
  }
}

function durableAccountState(token, now = Date.now()) {
  const record = durableAccountStates.get(token);
  if (!record) return null;
  if (record.state === "banned" && Number.isFinite(Number(record.until)) && Number(record.until) <= now) {
    clearDurableAccountState(token);
    acctHealth.delete(token);
    return null;
  }
  return record;
}

function setDurableAccountState(token, record) {
  if (!token || !record || !record.state) return;
  const normalized = {
    state: String(record.state),
    until: record.until == null ? null : Number(record.until),
    ...(record.reason ? { reason: String(record.reason) } : {}),
  };
  durableAccountStates.set(token, normalized);
  dirtyAccountStates.add(token);
  try {
    if (accountStateSet) noteAccountStateRevision(token, accountStateSet(token, normalized));
  } catch {
    console.error("[account-state] persist set failed");
  }
}

function clearDurableAccountState(token) {
  durableAccountStates.delete(token);
  dirtyAccountStates.add(token);
  try {
    if (accountStateClear) noteAccountStateRevision(token, accountStateClear(token));
  } catch {
    console.error("[account-state] persist clear failed");
  }
}

function accountIsBlocked(token, now = Date.now()) {
  const record = durableAccountState(token, now);
  return Boolean(record && (record.state === "banned" || record.state === "token_invalid" || record.state === "manual_disabled"));
}

function acquireToken(token) {
  if (!token || accountLeases.get(token)) return false;
  accountLeases.set(token, 1);
  return true;
}

function releaseToken(token) {
  if (!token) return;
  accountLeases.delete(token);
}

function tokenBusy(token) {
  return accountLeases.get(token) === 1;
}


function parseAccounts(env) {
  // 支持一行一个（换行）或逗号分隔；每项可为纯 token 或 "token:uid"（冒号配对 user_id）
  // 例："t1\nt2:u2\nt3,u4:u4" → [{token:t1,uid:null},{token:t2,uid:u2},...]
  return (env.FREEBUFF_TOKEN || "").split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .map((s) => {
      const idx = s.indexOf(":");
      if (idx > 0) return { token: s.slice(0, idx).trim(), uid: s.slice(idx + 1).trim() || null };
      return { token: s, uid: null };
    })
    .filter((a) => a.token.length > 8);
}

// ---------------------------------------------------------------------------
// 账号健康探测（v1.6.0）：GET /api/v1/me 不消耗 session/额度，探测 token 有效性并自动发现 uid
// ---------------------------------------------------------------------------

const acctHealth = new Map(); // token -> { alive, state, uid, quota, checkedAt }
const HEALTH_OBSERVATION_TTL_MS = 10 * 60 * 1000;

// 只记录真实业务请求已经观察到的上游结果。不要在 healthz 中主动探测，
// 也不要把网络错误/未知响应误记成账号失效。
function recordAccountObservation(token, status, dataOrText, extra = {}) {
  if (!token) return;
  let data = dataOrText;
  if (typeof dataOrText === "string") {
    try { data = JSON.parse(dataOrText); } catch { data = null; }
  }
  const upstreamState = data && typeof data === "object" ? data.status || data.state : null;
  let state = null;
  if (status === 404) state = "ok";
  else if (["banned", "country_blocked", "rate_limited", "model_locked", "ip_capped"].includes(upstreamState)) state = upstreamState;
  else if (status >= 200 && status < 300) state = "ok";
  else if (status === 401) state = "token_invalid";
  else if (status === 403) {
    state = upstreamState === "banned"
      ? "banned"
      : upstreamState === "country_blocked" ? "country_blocked" : "blocked";
  } else if (status === 429) state = "rate_limited";
  if (!state) return;

  // country_blocked / ip_capped 是冲着出站 IP 来的，换账号没用、换节点才有用；
  // 另外「403 且响应体压根没给 status」是 Cloudflare/WAF 那种不解释的拦截，同样归到 IP。
  // 反过来，403 只要报了名字（free_mode_cli_required、free_mode_invalid_agent_model、banned…）
  // 那就是账号/模式的问题，不能记到节点头上——否则面板会拿模型报错去冤枉节点。
  const ipLevel = state === "country_blocked" || state === "ip_capped"
    || (state === "blocked" && !upstreamState);
  if (onEgressReject && ipLevel) {
    try { onEgressReject({ state, status }); } catch {}
  }

  // 只有账号级的明确结果才进入持久隔离；出口节点级拒绝继续交给代理层处理。
  if (state === "banned") {
    setDurableAccountState(token, {
      state: "banned",
      until: banUntil(dataOrText),
      reason: "upstream_banned",
    });
  } else if (state === "token_invalid") {
    setDurableAccountState(token, {
      state: "token_invalid",
      until: null,
      reason: "upstream_auth_rejected",
    });
  }

  const previous = acctHealth.get(token) || {};
  acctHealth.set(token, {
    ...previous,
    ...extra,
    alive: state === "ok",
    state,
    uid: extra.uid || previous.uid || null,
    quota: extra.quota || previous.quota || null,
    retryAfterMs: typeof extra.retryAfterMs === "number" ? extra.retryAfterMs : previous.retryAfterMs || null,
    checkedAt: Date.now(),
  });
}

function summarizeAccountHealth(pool, health) {
  const account_details = pool.map((acct) => {
    const info = health.get(acct.token);
    return {
      token: acct.token.slice(0, 8) + "...",
      alive: info ? info.alive : null,
      state: info?.state || "unknown",
      uid: info?.uid ? info.uid.slice(0, 8) + "..." : null,
    };
  });
  const account_states = {};
  for (const detail of account_details) {
    account_states[detail.state] = (account_states[detail.state] || 0) + 1;
  }
  const alive_accounts = account_details.filter((p) => p.alive === true).length;
  const unknown_accounts = account_details.filter((p) => p.alive === null).length;
  const unhealthy_accounts = account_details.filter((p) => p.alive === false).length;
  const status = pool.length === 0
    ? "critical"
    : alive_accounts === 0 && (unhealthy_accounts > 0 || unknown_accounts > 0)
      ? "critical"
      : unhealthy_accounts > 0 || unknown_accounts > 0
        ? "degraded"
        : "ok";
  return {
    status,
    accounts: pool.length,
    alive_accounts,
    unknown_accounts,
    account_states,
    account_details,
  };
}

// ---------------------------------------------------------------------------
// 调用日志（call log）：每次成功的上游调用记一行，环形缓冲上限 200 条。
// 只记成功；失败按类别累加到 callTotals（供面板"累计限流/超时/错误"展示）。
// 明细里的"账号名"由 server.js 经 env.FREEBUFF_ACCOUNT_LABELS（token→展示名）
// 注入，worker 只在记录时解析成"调度的账号名"；拿不到名字时回落 token 短哈希。
// 数据只在内存里（进程级），面板通过 GET /_api/usage 拉取整份，不落盘。
// ---------------------------------------------------------------------------
const CALL_LOG_LIMIT = 200;
const callLogBuf = [];
const callTotals = { rateLimited: 0, timeout: 0, upstreamError: 0 };

// 概况（移植自 zen）：客户端请求口径的累计统计——请求/成功/失败 + 各类 token。
// 与 callTotals（逐次上游尝试的失败计数）刻意不同口径：这里每个客户端请求只记
// 一次，落在终态（成功一次；或换号全失败/本地 429 各算一次失败）。同样只在内存
// （进程级），重启即清空、不落盘，面板通过 GET /_api/usage 连同调用日志一起拉取。
const OVERVIEW_START = Date.now();
let lastRequestAt = null;
function blankUsageTotals() {
  return {
    requests: 0, success: 0, fail: 0,
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}
const usageTotals = blankUsageTotals();
const usageByModel = {}; // { 模型id: blankUsageTotals() }

// 归一化上游 usage：chat（prompt/completion_tokens）与 Responses（input/output_tokens）
// 两套命名都吃；推理 token 取 completion/output_tokens_details.reasoning_tokens。
function readCallUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    in: num(usage.prompt_tokens ?? usage.input_tokens),
    out: num(usage.completion_tokens ?? usage.output_tokens),
    reasoning: num(
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens,
    ),
  };
}

// 概况用的完整 usage 归一化：在 readCallUsage 的入/出/推理之外，补上 total 与
// 缓存读/写。chat 与 Responses 两套命名都吃；缓存字段各家上游命名不一，逐个兜。
// 空/非对象一律归零（不像 readCallUsage 返回 null）—— 累加方直接读字段，不判空。
function readUsageFull(usage) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  const pd = usage.prompt_tokens_details || {};
  const id = usage.input_tokens_details || {};
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  const reasoning = num(
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.output_tokens_details?.reasoning_tokens,
  );
  return {
    promptTokens: prompt,
    completionTokens: completion,
    reasoningTokens: reasoning,
    totalTokens: num(usage.total_tokens) || prompt + completion,
    cacheReadTokens: num(
      pd.cached_tokens ?? id.cached_tokens ??
      usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens,
    ),
    cacheWriteTokens: num(usage.cache_creation_input_tokens ?? pd.cache_creation_tokens),
  };
}

// token → 调度的账号名。env 注入的 token→名字映射优先；无名回落 token 前 6 位。
function accountLabel(env, token) {
  if (!token) return "";
  const labels = env && env.FREEBUFF_ACCOUNT_LABELS;
  if (labels && typeof labels === "object") {
    const hit = labels[token];
    if (hit) return String(hit).trim();
  }
  return token.slice(0, 6) + "…";
}

// 追加一条调用记录。字段名取短的：整个数组会被整份读写。
function logCall(entry) {
  callLogBuf.push({
    at: Date.now(),
    account: String(entry.account ?? "").trim(),
    model: String(entry.model ?? "").trim(),
    // "" = 没发 reasoning_effort（随上游默认），和"发了 high"是两回事
    effort: String(entry.effort ?? "").trim(),
    ttfb: entry.ttfb > 0 ? Math.round(entry.ttfb) : null,
    ms: entry.ms != null ? Math.round(entry.ms) : null,
    in: entry.in ?? 0,
    out: entry.out ?? 0,
    reasoning: entry.reasoning ?? 0,
  });
  if (callLogBuf.length > CALL_LOG_LIMIT) {
    callLogBuf.splice(0, callLogBuf.length - CALL_LOG_LIMIT);
  }
}

// 记一次客户端请求的终态到概况累计。success=true 时带 usage（累加各类 token），
// 失败时 usage 传空。总量与「该模型」两处一并累加，模型键用解析后的模型 id。
function recordRequest(model, usage, success) {
  const u = readUsageFull(usage);
  const key = (model && String(model).trim()) || "unknown";
  if (!usageByModel[key]) usageByModel[key] = blankUsageTotals();
  for (const b of [usageTotals, usageByModel[key]]) {
    b.requests++;
    if (success) b.success++; else b.fail++;
    b.promptTokens += u.promptTokens;
    b.completionTokens += u.completionTokens;
    b.reasoningTokens += u.reasoningTokens;
    b.totalTokens += u.totalTokens;
    b.cacheReadTokens += u.cacheReadTokens;
    b.cacheWriteTokens += u.cacheWriteTokens;
  }
  lastRequestAt = Date.now();
}

// 记录一次成功调用。firstTokenAt 为空（非流式）时首字记 null。
function recordChatCall(env, token, mc, effort, t0, firstTokenAt, usage) {
  const u = readCallUsage(usage);
  logCall({
    account: accountLabel(env, token),
    model: mc && mc.id ? mc.id : "",
    effort,
    ttfb: firstTokenAt ? firstTokenAt - t0 : null,
    ms: Date.now() - t0,
    in: u ? u.in : 0,
    out: u ? u.out : 0,
    reasoning: u ? u.reasoning : 0,
  });
  // 成功调用 == 该客户端请求的成功终态，顺带记入概况累计（每次成功恰好一条）。
  recordRequest(mc && mc.id ? mc.id : "", usage, true);
}

// 面板读取用的快照（数组/计数/概况都深拷一层，避免外部改到内部状态）。
function callLogSnapshot() {
  const byModel = {};
  for (const k of Object.keys(usageByModel)) byModel[k] = { ...usageByModel[k] };
  return {
    calls: callLogBuf.slice(),
    totals: { ...callTotals },
    // total（单数）= 客户端请求口径的累计；totals（复数）= 逐次尝试的失败计数。
    total: { ...usageTotals },
    byModel,
    startTime: OVERVIEW_START,
    lastRequest: lastRequestAt,
  };
}

function pickToken(env, sessionModel, attempted = new Set()) {
  syncAccountState(env);
  const pool = parseAccounts(env);
  if (pool.length === 0) return null;

  // 只选择没有明确隔离、短期冷却或并发租约的账号。acctHealth 还承载
  // rate_limited/country_blocked 等临时观测，只用于面板展示，不能永久摘号。
  const alivePool = pool.filter((acct) => {
    if (attempted && attempted.has(acct.token)) return false;
    if (accountIsBlocked(acct.token)) return false;
    if (tokenBusy(acct.token)) return false;
    return true;
  });
  const usePool = alivePool;
  if (usePool.length === 0) return null;

  // v1.8.5.1：账号选择恢复为稳定轮询。
  // rateLimitsByModel 仅作为观测数据，不参与轮询顺序；真实 session/chat
  // 返回明确限流后，再通过 cooldown 跳过该账号。这样不会因为旧快照
  // 抢占轮询，也不会把账号顺序重排成“剩余额度最多优先”。
  const finalPool = usePool;

  // 优先复用已有活跃 session 缓存的号：一个 session 约 1 小时有效，创建 session 才扣
  // 免费额度（如 v4-pro 每天 6 次）。纯轮询会让每个请求都切号、各建一个 session，
  // 浪费创建额度。只要当前模型的 session 缓存还活跃就钉在同一个号上，用满再换。
  if (sessionModel) {
    for (const acct of finalPool) {
      const t = acct.token;
      if (inCooldown(t) || !acquireToken(t)) continue;
      const cached = sessCache.get(t + ":" + sessionModel);
      if (isUsableSession(cached)) {
        return acct;
      }
      releaseToken(t);
    }
  }

  // 没有活跃缓存才轮询（跳过冷却中的号）
  for (let k = 0; k < finalPool.length; k++) {
    const acct = finalPool[accountIdx % finalPool.length];
    accountIdx = (accountIdx + 1) % finalPool.length;
    const t = acct.token;
    if (!inCooldown(t) && acquireToken(t)) return acct;
  }
  return null;
}

function accountPoolExhaustion(env) {
  syncAccountState(env);
  const pool = parseAccounts(env);
  if (pool.length === 0) return { status: 503, type: "config_error", retryAfterMs: null, allUnavailable: true };
  const now = Date.now();
  const details = pool.map((acct) => ({
    token: acct.token,
    state: durableAccountState(acct.token, now)?.state || null,
    lock: cooldownInfo(acct.token, now),
    busy: tokenBusy(acct.token),
  }));
  const allUnavailable = details.every((d) => Boolean(d.state || d.lock || d.busy));
  if (details.every((d) => d.state === "banned")) {
    return { status: 403, type: "account_banned", retryAfterMs: null, allUnavailable };
  }
  const quotaOnly = details.every((d) =>
    !d.state && !d.busy && d.lock && d.lock.reason === "quota");
  if (quotaOnly) {
    const quotaLocks = details.map((d) => d.lock);
    const retryAfterMs = Math.min(...quotaLocks.map((lock) => cooldownRemainingMs(lock, now)));
    return { status: 429, type: "rate_limit_exceeded", retryAfterMs, allUnavailable };
  }
  return { status: 503, type: "account_pool_unavailable", retryAfterMs: null, allUnavailable };
}

function poolExhaustionResponse(env) {
  const info = accountPoolExhaustion(env);
  if (info.status === 403) {
    return jsonResponse({ error: { message: "账号池中的账号均已被上游封禁", type: info.type } }, 403);
  }
  if (info.status === 429) {
    const seconds = Math.max(1, Math.ceil(info.retryAfterMs / 1000));
    return jsonResponse({
      error: {
        message: `账号额度已用完,请 ${seconds}s 后重试`,
        type: info.type,
        retryAfterMs: info.retryAfterMs,
      },
    }, 429, { "Retry-After": String(seconds), "X-RateLimit-Local": "1" });
  }
  const message = info.type === "config_error" ? "缺少 FREEBUFF_TOKEN 环境变量" : "当前没有可用账号";
  return jsonResponse({ error: { message, type: info.type } }, 503);
}

function waitingRoomResponse(retryAfterMs = 30 * 1000) {
  const ms = Math.max(1000, Number(retryAfterMs) || 30 * 1000);
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return jsonResponse({
    error: {
      message: `上游会话仍在排队，请 ${seconds}s 后重试`,
      type: "waiting_room",
      retryAfterMs: ms,
    },
  }, 503, { "Retry-After": String(seconds) });
}

function normalizeSession(data, requestedModel, now = Date.now()) {
  const expiryMs = Date.parse(data?.expiresAt || "");
  const remaining = Number(data?.remainingMs);
  const effectiveExpiry = Number.isFinite(expiryMs)
    ? expiryMs
    : (Number.isFinite(remaining) ? now + Math.max(0, remaining) : NaN);
  return {
    model: data?.model || requestedModel,
    instanceId: data?.instanceId || null,
    remainingMs: Number.isFinite(effectiveExpiry) ? Math.max(0, effectiveExpiry - now) : null,
    expiresAt: Number.isFinite(effectiveExpiry) ? new Date(effectiveExpiry).toISOString() : null,
  };
}

function isUsableSession(session, now = Date.now()) {
  const expiryMs = Date.parse(session?.expiresAt || "");
  return Boolean(session?.instanceId) && Number.isFinite(expiryMs) && expiryMs > now + 60000;
}

function accountSlot(pool, token) {
  const index = pool.findIndex((acct) => acct.token === token);
  return index >= 0 ? `${index + 1}/${pool.length}` : `?/${pool.length}`;
}

function logAccountRoute(enabled, pool, token, model, attempt, reason) {
  if (!enabled) return;
  try {
    console.log(JSON.stringify({ event: "account_route", model, account_slot: accountSlot(pool, token), attempt, reason }));
  } catch {}
}

/**
 * 冷却一个 token。三种调用形式兼容：
 *   cooldown(token, ms)                      —— 旧形式，reason=error
 *   cooldown(token, ms, retryAfterMs)        —— 429 限流，带上游重试间隔
 *   cooldown(token, ms, {reason, retryAfterMs})
 * 幂等合并：已存在的冷却如果更长则保留（避免短冷却覆盖长冷却）。
 */
function cooldown(token, ms, opts) {
  if (!(ms > 0)) return;
  let reason = "error";
  let retryAfterMs = null;
  if (opts && typeof opts === "object") {
    reason = opts.reason || reason;
    retryAfterMs = opts.retryAfterMs != null ? opts.retryAfterMs : null;
  } else if (typeof opts === "number" && opts > 0) {
    retryAfterMs = opts;
    reason = "quota";
  } else if (typeof opts === "string") {
    reason = opts;
  }
  const until = Date.now() + ms;
  const prev = cooldowns.get(token);
  if (prev && prev.until > until) return; // 已有更长的冷却，保留
  cooldowns.set(token, { until, retryAfterMs, reason });
}

/** 读取冷却记录；未冷却/已过期返回 null */
function cooldownInfo(token, now = Date.now()) {
  const c = cooldowns.get(token);
  if (!c || c.until <= now) { cooldowns.delete(token); return null; }
  return c;
}

function cooldownRemainingMs(lock, now = Date.now()) {
  return Math.max(1, Number(lock?.until) - now || 1);
}

/** 该 token 是否处于冷却中 */
function inCooldown(token, now = Date.now()) {
  return cooldownInfo(token, now) !== null;
}

// Official Freebuff session-gate recovery requires matching both the HTTP
// status and the relayed error code. Do not treat session_limit_reached or
// waiting_room_queued as stale sessions: those states must not delete a live
// session or burn another session slot.
const SESSION_GATE_RECOVERY = {
  waiting_room_required: 428,
  session_expired: 410,
  session_superseded: 409,
  session_model_mismatch: 409,
};

function hasExactErrorCode(value, expected) {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => hasExactErrorCode(entry, expected));
}

function isStaleSessionGate(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  return Object.entries(SESSION_GATE_RECOVERY).some(([code, expectedStatus]) =>
    status === expectedStatus && hasExactErrorCode(parsed, code));
}

// 仅供流式无首数据时确认 Premium 额度是否耗尽；不参与账号轮询排序。
function remainingQuota(token, sessionModel) {
  if (modelPoolCategory(sessionModel) === "standard") return null;
  const h = acctHealth.get(token);
  if (!h || !h.quota) return null;
  let entry = h.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    const premiumPool = (dynamicModelsCache.pool && dynamicModelsCache.pool.premium)
      ? dynamicModelsCache.pool.premium
      : PREMIUM_QUOTA_MODELS;
    for (const model of premiumPool) {
      if (h.quota[model]) {
        entry = h.quota[model];
        break;
      }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return null;
  return entry.limit - entry.recentCount;
}

// 长流不应因为固定秒数被误杀：只有上游额度探测明确表示不可用时，
// 才允许当前请求中止并切换账号。探测失败/额度未知一律不判定耗尽。
function isQuotaExhausted(info, sessionModel) {
  if (!info) return false;
  if (["rate_limited", "banned", "country_blocked", "token_invalid", "blocked", "model_locked", "ip_capped"].includes(info.state)) return true;
  // STANDARD 没有可靠的剩余次数查询；只处理明确的账号/上游状态，
  // 不根据 rateLimitsByModel 的 STANDARD 数字判断耗尽。
  if (modelPoolCategory(sessionModel) === "standard") return false;
  if (!info.quota) return false;
  let entry = info.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    const premiumPool = (dynamicModelsCache.pool && dynamicModelsCache.pool.premium)
      ? dynamicModelsCache.pool.premium
      : PREMIUM_QUOTA_MODELS;
    for (const model of premiumPool) {
      if (info.quota[model]) { entry = info.quota[model]; break; }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return false;
  return entry.limit - entry.recentCount <= 0;
}

function parseJsonBody(text) {
  if (text && typeof text === "object") return text;
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function findStructuredValue(value, names, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  for (const child of Object.values(value)) {
    const hit = findStructuredValue(child, names, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function timestampMs(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function delayUntil(value, now = Date.now()) {
  const target = timestampMs(value);
  return target == null ? null : Math.max(0, target - now);
}

function pacificDateParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function nextPacificMidnight(now = Date.now()) {
  const local = pacificDateParts(now);
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const targetLocalAsUtc = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
  let candidate = targetLocalAsUtc;
  for (let i = 0; i < 4; i++) {
    const actual = pacificDateParts(candidate);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = targetLocalAsUtc - actualAsUtc;
    candidate += delta;
    if (Math.abs(delta) < 1000) break;
  }
  if (candidate <= now) candidate += 24 * 3600 * 1000;
  return candidate;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase());
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) return headers[key];
  return null;
}

function retryAfterDelay(headers, now = Date.now()) {
  const raw = headerValue(headers, "Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  return delayUntil(raw, now);
}

function humanRetryDelay(text) {
  const m = String(text || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (!m) return null;
  const ms = (parseInt(m[1] || 0, 10) * 3600 + parseInt(m[2] || 0, 10) * 60 + parseInt(m[3] || 0, 10)) * 1000;
  return ms > 0 ? ms : null;
}

function parseCooldown(text, status, headers = {}, now = Date.now()) {
  const body = parseJsonBody(text);
  const upstreamState = body && typeof body === "object"
    ? findStructuredValue(body, ["status", "state"]) : null;
  if (status === 403 && upstreamState === "banned") {
    const banDelay = delayUntil(findStructuredValue(body, ["resumes_at", "resumesAt", "resume_at", "resumeAt"]), now);
    return banDelay > 0 ? banDelay : BANNED_DEFAULT_COOLDOWN_MS;
  }
  if (status === 429) {
    const retryAfterMs = findStructuredValue(body, ["retryAfterMs", "retry_after_ms"]);
    const direct = Number(retryAfterMs);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const resetDelay = delayUntil(findStructuredValue(body, ["resetAt", "reset_at", "resetsAt", "resets_at"]), now);
    if (resetDelay > 0) return resetDelay;
    const headerDelay = retryAfterDelay(headers, now);
    if (headerDelay > 0) return headerDelay;
    const humanDelay = humanRetryDelay(text);
    if (humanDelay > 0) return humanDelay;
    return Math.max(1, nextPacificMidnight(now) - now);
  }
  const humanDelay = humanRetryDelay(text);
  if (humanDelay > 0) return humanDelay;
  return status === 429 ? Math.max(1, nextPacificMidnight(now) - now) : 60 * 1000;
}

function banUntil(text, now = Date.now()) {
  const body = parseJsonBody(text);
  const delay = delayUntil(findStructuredValue(body, ["resumes_at", "resumesAt", "resume_at", "resumeAt"]), now);
  return now + (delay > 0 ? delay : BANNED_DEFAULT_COOLDOWN_MS);
}

class QuotaExhaustedError extends Error {
  constructor(info) {
    super("upstream account quota exhausted");
    this.name = "QuotaExhaustedError";
    this.retryAfterMs = info && typeof info.retryAfterMs === "number" ? info.retryAfterMs : null;
  }
}

class WaitingRoomError extends Error {
  constructor(retryAfterMs = 30 * 1000) {
    super("session stayed queued (retry later)");
    this.name = "WaitingRoomError";
    this.retryAfterMs = retryAfterMs;
  }
}

class EmptyUpstreamStreamError extends Error {
  constructor() {
    super("upstream returned an empty stream");
    this.name = "EmptyUpstreamStreamError";
  }
}

function invalidateSessionCache(token) {
  const prefix = token + ":";
  for (const key of sessCache.keys()) {
    if (key.startsWith(prefix)) sessCache.delete(key);
  }
}

async function deleteUpstreamSession(token, instanceId, model) {
  invalidateSessionCache(token);
  if (!instanceId) return;
  // 失效安全窗口内同一 token:model 不重复 DELETE 上游（避免连续 409 时
  // 疯狂 DELETE+POST 循环打爆上游）。窗口信息在调用方重建前用
  // wasRecentlyInvalidated 检查，这里只是记录时间戳 + 跳过重复 DELETE。
  const key = token + ":" + (model || "");
  const last = sessionInvalidated.get(key);
  if (last && Date.now() - last < INVALIDATION_WINDOW_MS) return;
  sessionInvalidated.set(key, Date.now());
  try {
    await enqueueUp("DELETE", "/api/v1/freebuff/session", token, undefined,
      { "x-freebuff-instance-id": instanceId }, SESSION_TIMEOUT_MS);
  } catch {}
}

// ---------------------------------------------------------------------------
// 上游请求（串行队列，免费通道并发超过 1 就出问题）
// ---------------------------------------------------------------------------

let chainTail = Promise.resolve();
const CHAIN_GAP_MS = 300; // 上游免费通道并发 >1 会出问题，串行+小间隔；300ms 足够防抖且链路总耗时可控
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function enqueue(fn) {
  const run = chainTail.then(() => sleep(CHAIN_GAP_MS)).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

const UPSTREAM_TIMEOUT_MS = 20000; // 上游单请求超时，避免客户端干等
const NONSTREAM_TIMEOUT_MS = 45000; // 非流式要聚合完整上游流（含推理），给更充裕时间
const SESSION_TIMEOUT_MS = 10000;  // session/run 等短交互更快失败
// 这不是流式请求的失败时间，只是首个数据迟迟未到时启动一次额度探测的观察窗口。
// 额度仍在时不 abort、不切号，继续等待上游。
const STREAM_NO_DATA_PROBE_DELAY_MS = 20000;

// ── 出站 header 清洗 + 请求抖动（轻量 stealth，v1.9.1）──────────────────
// 纯应用层隐身：规范化出站 header（不留代理特征）、给串行队列的请求间隔加
// 轻微随机抖动（降低被上游按"恒定节奏批量请求"风控的概率）。
// 不动 TLS 指纹层 —— Node fetch/undici 改不了指纹，uTLS 需要换 HTTP 栈，
// 那是单独任务。这里只做零成本、纯逻辑的部分。
const STEALTH_JITTER_MIN_MS = 100;   // 最小额外间隔
const STEALTH_JITTER_MAX_MS = 400;   // 最大额外间隔
// 统一出站 UA：桌面版协议签名（真实 CLI 特征，不是代理特征）
const STEALTH_UA = "Freebuff-CLI/0.0.138";
// 统一 Accept：和官方 CLI 一致的浏览器风格
const STEALTH_ACCEPT = "application/json";

function jitterMs() {
  return STEALTH_JITTER_MIN_MS +
    Math.floor(Math.random() * (STEALTH_JITTER_MAX_MS - STEALTH_JITTER_MIN_MS + 1));
}

// 上游出站 fetch。默认全局 fetch（Cloudflare Worker / 无代理环境直连）。
// Node adapter（server.js）可注入 env.FREEBUFF_UPSTREAM_FETCH：
// 配置了订阅时 server/proxy.mjs 会构造一个「带 undici ProxyAgent 指向本地
// mihomo mixed-port」的 fetch 传进来，上游流量就经代理节点出站。
let upstreamFetch = typeof fetch === "function" ? fetch : globalThis.fetch;

// 出站 IP 被上游拒绝时的回调（env.FREEBUFF_ON_EGRESS_REJECT）。这里只知道「被拒了、
// 什么原因」，节点名在 server/proxy.mjs 手里，所以把分类结果丢过去由它归因到当前节点。
let onEgressReject = null;

async function up(method, path, token, body, extraHeaders = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  // 出站前加入随机抖动，让请求节奏不规则（CHAIN_GAP_MS 之外）
  await sleep(jitterMs());
  const headers = {};
  // 桌面版协议：带真实 CLI UA + 统一 Accept，不留代理/脚本特征。
  // 不设 Origin —— 上游对 Origin 可能有 CORS 校验，桌面版协议实测不带任何
  // Origin，保持原样（ads 调用会显式覆盖 UA，见 runNormalClientBehavior）。
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  headers["User-Agent"] = extraHeaders["User-Agent"] || STEALTH_UA;
  headers["Accept"] = extraHeaders["Accept"] || STEALTH_ACCEPT;
  Object.assign(headers, extraHeaders);

  const resp = await upstreamFetch(CODEBUFF_API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data, text };
}

function enqueueUp(method, path, token, body, extraHeaders, timeoutMs) {
  return enqueue(() => up(method, path, token, body, extraHeaders, timeoutMs));
}

// 流式无首数据时的额度检查：只读本地缓存，绝不打上游。
// ⚠️ 不能在这里 GET /api/v1/freebuff/session 强制刷新：
// 该接口会占用账号 session，而 freebuff 一个号同一时间只能一个客户端在线，
// 探测会顶掉正在推理的会话（428 waiting_room_required）。luna effort=high
// 等长推理模型首 token 可能 >20s，此时探测必然误伤。
// 缓存缺失/过期/额度未知 → 一律不判定耗尽，继续等待上游。
async function freshQuotaProbe(token, sessionModel) {
  const cached = acctHealth.get(token);
  if (!cached) return;
  if (Date.now() - cached.checkedAt > HEALTH_OBSERVATION_TTL_MS) return;
  if (isQuotaExhausted(cached, sessionModel)) throw new QuotaExhaustedError(cached);
}

function throwIfRequestAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("request aborted");
}

// 流式 chat 不设置总时长 abort。只有在首个数据迟迟未到时，
// 才强制刷新账号额度；额度未知或仍有额度时，原请求继续等待。
// requestSignal 代表下游客户端，必须覆盖 response 已拿到但首 chunk 尚未到达的窗口。
async function fetchStreamWithQuotaGuard(url, init, token, sessionModel, requestSignal = null) {
  const controller = new AbortController();
  let reader = null;
  let requestAbortHandler = null;
  let rejectRequestAbort = null;
  let transferred = false;
  const requestAborted = requestSignal
    ? new Promise((_, reject) => {
        rejectRequestAbort = reject;
        requestAbortHandler = () => {
          const reason = requestSignal.reason || new Error("request aborted");
          try { controller.abort(reason); } catch { controller.abort(); }
          if (reader) Promise.resolve(reader.cancel(reason)).catch(() => {});
          rejectRequestAbort(reason);
        };
        if (requestSignal.aborted) requestAbortHandler();
        else requestSignal.addEventListener("abort", requestAbortHandler, { once: true });
      })
    : null;
  const request = upstreamFetch(url, { ...init, signal: controller.signal });
  let probeTimer = null;
  const armProbe = () => new Promise((_, reject) => {
    probeTimer = setTimeout(() => {
      freshQuotaProbe(token, sessionModel).catch((error) => {
        if (error instanceof QuotaExhaustedError) {
          try { controller.abort(error); } catch { controller.abort(); }
          reject(error);
        }
      });
    }, STREAM_NO_DATA_PROBE_DELAY_MS);
  });
  const clearProbe = () => {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
  };
  const cleanupRequestAbort = () => {
    if (requestSignal && requestAbortHandler) {
      requestSignal.removeEventListener("abort", requestAbortHandler);
      requestAbortHandler = null;
    }
  };
  const raceWithRequestAbort = (promises) => requestAborted
    ? Promise.race([...promises, requestAborted])
    : Promise.race(promises);
  try {
    // 首个字节前不再使用 AbortSignal.timeout(20s)。
    const response = await raceWithRequestAbort([request, armProbe()]);
    clearProbe();
    if (!response.body) throw new EmptyUpstreamStreamError();

    reader = response.body.getReader();
    const first = await raceWithRequestAbort([reader.read(), armProbe()]);
    clearProbe();
    if (first.done) {
      try { reader.releaseLock(); } catch {}
      throw new EmptyUpstreamStreamError();
    }

    // 首个 chunk 已到达，交还给正常 SSE 转发逻辑；不再设置固定总时长。
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(first.value);
        (async () => {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              streamController.enqueue(next.value);
            }
            streamController.close();
          } catch (error) {
            streamController.error(error);
          } finally {
            try { reader.releaseLock(); } catch {}
            cleanupRequestAbort();
          }
        })();
      },
      cancel(reason) {
        cleanupRequestAbort();
        try { controller.abort(reason); } catch { controller.abort(); }
        return reader.cancel(reason);
      },
    });
    transferred = true;
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    clearProbe();
    cleanupRequestAbort();
    try { controller.abort(error); } catch { controller.abort(); }
    if (reader) Promise.resolve(reader.cancel(error)).catch(() => {});
    throw error;
  } finally {
    clearProbe();
    if (!transferred) cleanupRequestAbort();
  }
}

// ---------------------------------------------------------------------------
// session 生命周期
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 正常客户端行为层（v1.8.8.1，源码依据：官方 cli/src/hooks/use-gravity-ad.ts、
// cli/src/utils/fingerprint.ts、sdk/src/impl/llm.ts）
//   - 稳定指纹：每个 Worker（账号）一个永不变化的 fingerprintId（enhanced- 前缀，
//     官方用硬件序列号/MAC/机器ID 哈希；CF 无硬件，用 token 派生稳定哈希即可，
//     关键是"同一账号永远同一指纹"）
//   - 广告链：官方免费推理靠广告（源码注释原话），每次会话前 POST /ads 拉取 +
//     POST /ads/impression 上报曝光，失败静默
//   - usage 触碰：官方客户端启动会查 /api/v1/usage，补上让调用面更完整
// ---------------------------------------------------------------------------
const BEHAVIOR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const behaviorCache = new Map(); // key -> ts

function behaviorDue(key) {
  const ts = behaviorCache.get(key) || 0;
  if (Date.now() - ts > BEHAVIOR_CACHE_TTL_MS) {
    behaviorCache.set(key, Date.now());
    return true;
  }
  return false;
}

// 稳定指纹：token 派生，同一账号永远一致（官方 enhanced- 前缀 + 哈希）
// CF Workers 无同步 WebCrypto，用轻量确定性哈希（FNV-1a 双种子 + hex）
function stableFingerprint(token) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = "freebuff-fp-v2:" + token;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return "enhanced-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// 广告链：POST /ads 拉取 → 若有 impUrl 则 POST /ads/impression 上报曝光。
// 官方实现：getCliAdRequestUserAgent 发 Freebuff-CLI/<version> UA；
// body {provider:"gravity", surface, sessionId, device, userAgent}；曝光 {impUrl, mode}
async function runNormalClientBehavior(token, clientFingerprint) {
  const failures = [];
  // 1) 广告拉取 + 曝光（每 30 分钟一次，避免每个请求都打广告接口）
  if (behaviorDue("ads:" + token)) {
    try {
      const ad = await enqueueUp("POST", "/api/v1/ads", token, {
        provider: "gravity",
        sessionId: crypto.randomUUID(),
        surface: "waiting_room",
        device: { os: "macos", timezone: "Asia/Shanghai", locale: "zh-CN" },
        userAgent: "Freebuff-CLI/0.0.138",
      }, { "User-Agent": "Freebuff-CLI/0.0.138", "Content-Type": "application/json" }, 6000);
      const impUrl = ad.data && Array.isArray(ad.data.ads) && ad.data.ads[0] && ad.data.ads[0].impUrl;
      if (ad.status === 200 && impUrl) {
        await enqueueUp("POST", "/api/v1/ads/impression", token,
          { impUrl, mode: "free" },
          { "User-Agent": "Freebuff-CLI/0.0.138", "Content-Type": "application/json" }, 6000);
      }
    } catch (e) { failures.push("ads:" + String(e && e.message || e).slice(0, 80)); }
  }
  // 2) usage 触碰（30 分钟一次）
  if (behaviorDue("usage:" + token)) {
    try {
      await enqueueUp("POST", "/api/v1/usage", token,
        { fingerprintId: clientFingerprint },
        { "Content-Type": "application/json" }, 6000);
    } catch (e) { failures.push("usage:" + String(e && e.message || e).slice(0, 80)); }
  }
  return failures;
}

// 复用阈值（v1.9.1，optimistic reuse / verify window，参考 FreebuffSessionLease）：
//   - SESSION_REUSE_SAFE_MS：剩余有效期 ≥ 此值时直接复用缓存，不打上游
//   - SESSION_VERIFY_WINDOW_MS：剩余有效期在 (SAFE 以下, SAFE) 之间的临界区，
//     乐观复用 + 后台异步 GET 验证一次；验证发现失效就删缓存，下次自然重建。
//     避免长流场景下"过期前 60s"被反复强制重建。
const SESSION_REUSE_SAFE_MS = 60 * 1000;       // 原 isUsableSession 阈值
const SESSION_VERIFY_WINDOW_MS = 30 * 1000;    // 临界区宽度（剩余 30-60s）

function sessionRemainingMs(session, now = Date.now()) {
  const exp = session && session.expiresAt ? Date.parse(session.expiresAt) : NaN;
  return Number.isFinite(exp) ? exp - now : NaN;
}

// 后台异步验证缓存的 session：GET 上游，若返回非 active 或模型对不上就删缓存。
// 只读不改，不抛错；并发安全由调用方 single-flight 保证。
async function verifySessionInBackground(token, sessionModel) {
  try {
    const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
      DESKTOP_INCLUDE_RATE_LIMITS, SESSION_TIMEOUT_MS);
    recordAccountObservation(token, cur.status, cur.data, {
      quota: cur.data?.rateLimitsByModel || null,
      uid: cur.data?.uid || null,
      retryAfterMs: cur.data?.retryAfterMs,
    });
    if (!(cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId)) {
      const key = token + ":" + sessionModel;
      if (sessCache.has(key)) sessCache.delete(key);
      return;
    }
    const cm = cur.data.model;
    if (cm && cm !== sessionModel) {
      const key = token + ":" + sessionModel;
      if (sessCache.has(key)) sessCache.delete(key);
    }
  } catch { /* 后台验证失败静默，下次请求自然重建 */ }
}

async function createSession(token, sessionModel, forceCreate = false) {
  // 0) 正常客户端行为：广告链 + usage 触碰（30 分钟节流，失败静默）
  try { await runNormalClientBehavior(token, stableFingerprint(token)); } catch {}
  const key = token + ":" + sessionModel;

  // 1) 缓存命中 → optimistic reuse（verify window）：
  //    剩余 ≥ SESSION_REUSE_SAFE_MS（60s）直接复用，不打上游；
  //    临界区（30-60s）乐观复用 + 后台异步验证一次，避免长流被反复重建。
  if (!forceCreate) {
    const cached = sessCache.get(key);
    if (cached) {
      const remain = sessionRemainingMs(cached);
      if (remain >= SESSION_REUSE_SAFE_MS) return cached;
      if (remain > 0 && remain >= SESSION_REUSE_SAFE_MS - SESSION_VERIFY_WINDOW_MS) {
        // 临界区：先复用，同时后台验证（验证失败删缓存，下次请求重建）
        verifySessionInBackground(token, sessionModel).catch(() => {});
        return cached;
      }
      // 剩余不足 30s（或已过期）：删除，走重建
      sessCache.delete(key);
    }
  }

  // 2) 真正建 session（single-flight 去重：并发请求共享同一次 POST）。
  //    forceCreate=true 也必须走 single-flight —— 强制重建场景多个并发
  //    请求同时重建，也会互相顶掉（409 session_superseded 的根源）。
  return singleFlight(key + (forceCreate ? ":force" : ""), async () => {
    // 查上游当前 session，同模型直接复用（forceCreate 时跳过：僵尸 active session
    // 会被 GET 反复复用，导致 chat 一直 428；强制 POST 拿全新实例）
    // 桌面版签名：GET 带 include-unused-rate-limits（模型选择器额度快照头）
    if (!forceCreate) {
      const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
        DESKTOP_INCLUDE_RATE_LIMITS, SESSION_TIMEOUT_MS);
      recordAccountObservation(token, cur.status, cur.data, {
        quota: cur.data?.rateLimitsByModel || null,
        uid: cur.data?.uid || null,
        retryAfterMs: cur.data?.retryAfterMs,
      });
      if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
        const cm = cur.data.model;
        if (!cm || cm === sessionModel) {
          const s = normalizeSession(cur.data, sessionModel);
          sessCache.set(key, s);
          return s;
        }
        await deleteUpstreamSession(token, cur.data.instanceId, sessionModel);
      }
    }

    // 3) create（可能 queue）。桌面版签名：POST 带预生成 x-freebuff-instance-id（客户端 UUID）。
    //    ⚠️ 实测（2026-08-10）：multi-session:1 创建的实例 chat 报 428 waiting_room_required
    //    （服务端 chat gate 不识别多会话实例），所以这里用单会话 + 预生成 instance-id：
    //    既保留桌面版客户端预生成实例的指纹，又确保 chat 能被识别。
    const instId = crypto.randomUUID();
    const r = await enqueueUp("POST", "/api/v1/freebuff/session", token, undefined,
      { "x-freebuff-model": sessionModel, "x-freebuff-instance-id": instId, "Content-Type": "application/json" }, SESSION_TIMEOUT_MS);
    recordAccountObservation(token, r.status, r.data, {
      quota: r.data?.rateLimitsByModel || null,
      uid: r.data?.uid || null,
      retryAfterMs: r.data?.retryAfterMs,
    });
    if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
      const s = normalizeSession(r.data, sessionModel);
      sessCache.set(key, s);
      return s;
    }
    if (r.status === 200 && r.data?.status === "queued" && r.data?.instanceId) {
      const inst = r.data.instanceId;
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const q = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined, { "x-freebuff-instance-id": inst }, SESSION_TIMEOUT_MS);
        recordAccountObservation(token, q.status, q.data, {
          quota: q.data?.rateLimitsByModel || null,
          uid: q.data?.uid || null,
          retryAfterMs: q.data?.retryAfterMs,
        });
        if (q.status === 200 && q.data?.status === "active") {
          const s = normalizeSession({ ...q.data, instanceId: q.data.instanceId || inst }, sessionModel);
          sessCache.set(key, s);
          return s;
        }
      }
      throw new WaitingRoomError();
    }
    if (r.status === 409) throw new Error("session_model_mismatch: " + String(r.data?.message || r.data?.error || "上游拒绝该模型"));
    throw new Error("create session failed: " + r.status + " " + (r.text || "").slice(0, 300));
  });
}

// ---------------------------------------------------------------------------
// agent-runs 生命周期
// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function startRun(token, agentId, ancestors = []) {
  const r = await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "START", agentId, ancestorRunIds: ancestors }, undefined, SESSION_TIMEOUT_MS);
  if (r.status !== 200 || !r.data?.runId) {
    recordAccountObservation(token, r.status, r.data ?? r.text);
    throw new Error("start_run failed: " + r.status + " " + (r.text || "").slice(0, 200));
  }
  return r.data.runId;
}

async function recordStep(token, runId, stepNumber, startTime, children = [], messageId = null) {
  await enqueueUp("POST", `/api/v1/agent-runs/${runId}/steps`, token,
    { stepNumber, credits: 0, childRunIds: children, messageId, status: "completed", startTime }, undefined, SESSION_TIMEOUT_MS);
}

async function finishRun(token, runId, totalSteps) {
  await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "FINISH", runId, status: "completed", totalSteps, directCredits: 0, totalCredits: 0 }, undefined, SESSION_TIMEOUT_MS);
}

// deepseek 等直接模型：主 run + context-pruner 子 run
// 精简版：只 START 两个 run（chat 只校验 run_id 存在，recordStep/finishRun 可跳过），
// 实测链路总耗时 4s 内（原版 8s），满足 qwenpaw check_model_connection 5s 超时
const runCache = new Map();   // `${token}:${agentId}` -> { runId, childRunId, ts }
const RUN_CACHE_TTL_MS = 10 * 60 * 1000; // 实测 run_id 可跨请求复用（上游只校验存在性），10min 缓存省两次上游调用

async function startRunChain(token, agentId) {
  const key = token + ":" + agentId;
  const hit = runCache.get(key);
  if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) {
    return { runId: hit.runId, agentId, startedAt: utcNow(), childRunId: hit.childRunId, cached: true };
  }
  const startedAt = utcNow();
  const runId = await startRun(token, agentId);
  const childRunId = await startRun(token, CONTEXT_PRUNER_AGENT, [runId]);
  runCache.set(key, { runId, childRunId, ts: Date.now() });
  return { runId, agentId, startedAt, childRunId, cached: false };
}

// ---------------------------------------------------------------------------
// 上游 payload 构造（对齐 py 版 build_upstream_payload）
// ---------------------------------------------------------------------------

const UPSTREAM_KEYS = [
  "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "metadata", "modalities", "parallel_tool_calls", "presence_penalty", "reasoning_effort",
  "response_format", "seed", "service_tier", "stop", "store", "stream_options",
  "temperature", "thinking", "tool_choice", "tools", "top_logprobs", "top_p", "top_k", "user",
];

// OpenAI chat 兼容层：把顶层 thinking 参数（{type:"enabled", budget_tokens} 或 {effort}）
// 归一化为上游能识别的 reasoning_effort。Freebuff 上游只认 reasoning_effort ladder。
function normalizeChatThinking(params) {
  if (params.reasoning_effort !== undefined) return params;
  const th = params.thinking;
  if (!th || typeof th !== "object") return params;
  const out = { ...params };
  delete out.thinking;
  const type = String(th.type || "enabled").toLowerCase();
  // 官方 ladder 档位透传：thinking:{type:"low"|"medium"|...}（新 SDK 兼容层形态）
  const rank = REASONING_EFFORT_RANK.includes(type) ? type : null;
  if (rank) out.reasoning_effort = rank;
  else if (type === "none" || type === "disabled" || th.enabled === false) out.reasoning_effort = "none";
  else if (Number.isFinite(th.budget_tokens)) {
    const b = th.budget_tokens;
    out.reasoning_effort = b <= 0 ? "none" : b <= 512 ? "minimal" : b <= 1024 ? "low" : b <= 8192 ? "medium" : b <= 24576 ? "high" : "xhigh";
  } else if (th.effort) out.reasoning_effort = namedEffort(th.effort) ?? th.effort;
  return out;
}

// 官方 free-mode marker 要求系统提示必须以 "You are Buffy, the strategic coding assistant."
// 字节级开头（服务端 hasFreebuffRootSystemPromptOpening 检查，旧 `[System Override...]`
// 前缀绕过已被官方修补并返回 403 free_mode_cli_required）。
const BUFFY = "You are Buffy, the strategic coding assistant.";

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let hasSystem = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = { ...m };
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      hasSystem = true;
      item.cache_control = { type: "ephemeral" };
      // 注入官方 Buffy 前缀（服务器 hasFreebuffRootSystemPromptOpening 字节级校验）。
      // 字符串和数组(content 为 [{type:'text',text}]，OpenAI SDK 常见)都要处理。
      if (typeof item.content === "string") {
        if (!item.content.startsWith(BUFFY)) item.content = BUFFY + item.content;
      } else if (Array.isArray(item.content)) {
        const firstText = item.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (firstText && !firstText.text.startsWith(BUFFY)) firstText.text = BUFFY + firstText.text;
      }
    }
    out.push(item);
  }
  if (!hasSystem) out.unshift({ role: "system", content: BUFFY, cache_control: { type: "ephemeral" } });
  return out;
}

// 官方模型 reasoning effort 上限表（2026-08-12 源码：freebuff-models.ts / reasoning-effort.ts）
// 模型只允许其 efforts 数组中的档位；请求档位超出上限时 clamp-down 到最近可用档，
// 不拒绝请求、不换模型（官方 clampReasoningEffort 语义）。
// 档位升序 ladder：minimal < low < medium < high < xhigh < max < ultra
const REASONING_EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// 客户端点名的档位一律原样采用（含 xhigh / max / ultra）。
// 明确写了名字的档不该在协议转换层被降级——超出模型能力由 buildUpstreamPayload 的
// clampReasoningEffort 按官方 per-model efforts 表下取，那才是唯一该降档的地方。
// 返回 null = 不是已知档位名，交给调用方决定回落。
function namedEffort(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "none" || s === "disabled" || s === "off") return "none";
  return REASONING_EFFORT_RANK.includes(s) ? s : null;
}

// 官方 per-model efforts（2026-08-13 源码 freebuff-models.ts，同步 DEEPSEEK_V4_REASONING_EFFORTS）：
//   - deepseek-v4-flash / deepseek-v4-pro: [low, high, max]（GA 后两模型同表，无 medium）
//   - gpt-5.6-luna:      EFFORTS_THROUGH_MAX（low..max 含 xhigh）
//   - meta/muse-spark:   EFFORTS_THROUGH_XHIGH（minimal..xhigh，ALWAYS reasons，none=400）
//   - minimax-m3 / mimo / glm / fable：无 effort 档位或不接受 effort → 不在表中，原样透传
const MODEL_EFFORTS = {
  "deepseek/deepseek-v4-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["low", "high", "max"],
  "openai/gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.2-contributor": ["minimal", "low", "medium", "high", "xhigh"],
};

function clampReasoningEffort(requested, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return requested;
  const wanted = REASONING_EFFORT_RANK.indexOf(requested);
  if (wanted < 0) return requested; // 未知档位 → 原样透传，交由上游
  let best = null;
  let bestRank = -1;
  for (const cand of allowed) {
    const rank = REASONING_EFFORT_RANK.indexOf(cand);
    if (rank < 0 || rank > wanted) continue;
    if (rank > bestRank) { best = cand; bestRank = rank; }
  }
  if (best !== null) return best;
  // 所有可用档都高于请求 → 取最低档（官方语义）
  return allowed.reduce((lo, c) =>
    REASONING_EFFORT_RANK.indexOf(c) < REASONING_EFFORT_RANK.indexOf(lo) ? c : lo);
}

function normalizeReasoningEffort(model, effort) {
  if (effort === undefined || effort === null) return effort;
  const allowed = MODEL_EFFORTS[model];
  if (!allowed) return effort; // 模型未列 → 不干预
  const clamped = clampReasoningEffort(String(effort), allowed);
  return clamped === String(effort) ? effort : clamped;
}

function buildUpstreamPayload(params, mc, sess, runId) {
  const payload = {};
  for (const k of UPSTREAM_KEYS) if (params[k] !== undefined && params[k] !== null) payload[k] = params[k];
  // reasoning_effort 按官方模型 efforts 表 clamp-down（不拒绝、不换模型）
  if (payload.reasoning_effort !== undefined) {
    payload.reasoning_effort = normalizeReasoningEffort(mc.id, payload.reasoning_effort);
  }
  payload.model = mc.upstream;
  payload.messages = normalizeMessages(params.messages);
  payload.stream = true;
  if (!payload.stop) payload.stop = ['"cb_easp"'];
  payload.provider = { data_collection: "deny" };
  // 工具集签名：Freebuff 对「带 tools 但无官方专属工具名」的请求会判定为
  // foreign_toolset 并拒绝/降级模型（表现为工具调用被限制）。end_turn 是官方
  // TOOLS_WHICH_WONT_FORCE_NEXT_STEP 白名单里的无害工具，混入它能让带工具的
  // 请求通过校验；end_turn 不会被模型实际调用，只用于工具集合签名。
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    const hasSignature = payload.tools.some(
      (t) => t && typeof t === "object" && t.function && typeof t.function.name === "string" && t.function.name === "end_turn",
    );
    if (!hasSignature) {
      payload.tools = [
        ...payload.tools,
        { type: "function", function: { name: "end_turn", description: "Signal the end of the current task.", parameters: { type: "object", properties: {} } } },
      ];
    }
  }
  payload.codebuff_metadata = {
    freebuff_instance_id: sess.instanceId,
    trace_session_id: crypto.randomUUID(),
    run_id: runId,
    // 官方 SDK：client_id = clientSessionId（会话级稳定标识），不是随机数
    client_id: stableFingerprint(runId || "session"),
    cost_mode: "free",
  };
  return payload;
}

// 第一阶段显式代码审计模式：只在调用方明确请求时触发 reviewer 子 run。
// 普通 chat 永远只使用 root agent，不把 reviewer 当成模型 fallback。
function isCodeReviewRequest(params) {
  return params && params.metadata && params.metadata.freebuff_mode === "code_review";
}

function buildReviewerMessages(params) {
  const messages = Array.isArray(params.messages)
    ? params.messages.map((m) => ({ ...m }))
    : [];
  // 与官方 createReviewer() 对齐：reviewer 继承 root 上下文，但不能调用工具或修改文件。
  messages.unshift({
    role: "system",
    content: "You are a subagent that reviews code changes and gives helpful critical feedback. Do not use any tools. Review the last file changes made by the assistant. Focus on missing requirements, correctness, regressions, dead code, missing imports, and consistency with the existing code. Be extremely concise and only suggest changes; do not modify files.",
  });
  const requestedPrompt = params.metadata && typeof params.metadata.freebuff_review_prompt === "string"
    ? params.metadata.freebuff_review_prompt.trim()
    : "";
  messages.push({
    role: "user",
    content: requestedPrompt ||
      "Review the recent code changes in the conversation. Give concise, critical feedback only.",
  });
  return messages;
}

function buildReviewerPayload(params, mc, sess, reviewerRunId) {
  const metadata = params.metadata && typeof params.metadata === "object"
    ? { ...params.metadata }
    : undefined;
  if (metadata) {
    delete metadata.freebuff_mode;
    delete metadata.freebuff_review_prompt;
  }
  return buildUpstreamPayload(
    {
      ...params,
      metadata,
      messages: buildReviewerMessages(params),
      // 官方 code-reviewer 的 toolNames=[]：reviewer 只能给建议，不能调用工具。
      tools: undefined,
      tool_choice: undefined,
      parallel_tool_calls: undefined,
    },
    mc,
    sess,
    reviewerRunId,
  );
}

// ---------------------------------------------------------------------------
// chat 主流程
// ---------------------------------------------------------------------------

// 自定义别名 → 真实模型 id（本地映射，无网络/无 session）
function resolveModelAlias(modelId) {
  const alias = String(modelId || "").trim().toLowerCase();
  return alias ? currentAliases.get(alias) || null : null;
}

// 查找模型配置：自定义别名 → 硬编码 MODELS → 动态表（合并表）
function findModelConfig(modelId) {
  const target = resolveModelAlias(modelId) || modelId;
  const hit = MODELS.find((m) => m.id === target);
  if (hit) return hit;
  const dyn = dynamicModelsCache.models;
  if (dyn) {
    const d = dyn.find((m) => m.id === target);
    if (d) return d;
  }
  return null;
}

// 查找模型配置前确保动态注册表已加载。
// 不能依赖 /v1/models 先被调用：Cloudflare 不保证两个请求落在同一 isolate。
async function resolveModelConfig(modelId) {
  const target = resolveModelAlias(modelId) || modelId;
  let hit = findModelConfig(target);
  if (hit) return hit;
  try {
    const dyn = await refreshDynamicModelsIfStale();
    if (dyn && dyn.models) {
      hit = dyn.models.find((m) => m.id === target) || null;
      if (hit) return hit;
    }
  } catch {}
  return findModelConfig(target);
}

async function handleChat(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  // 顶层 thinking 参数 → reasoning_effort 归一化（新 OpenAI SDK 兼容）
  params = normalizeChatThinking(params);
  return executeChat(env, params, mc, isStream, "chat", request.signal);
}

// OpenAI Responses API（/v1/responses）入口：把 Responses 请求翻译成 chat completions 上游调用
async function handleResponses(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, responsesToChatParams(params, mc), mc, isStream, "responses", request.signal);
}

// Responses API 请求 → chat completions 参数（字段名/结构翻译）
function responsesToChatParams(params, mc) {
  const chat = {};
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop", "seed", "store", "metadata", "user", "stream"]) {
    if (params[k] !== undefined && params[k] !== null) chat[k] = params[k];
  }
  if (params.max_output_tokens !== undefined && params.max_output_tokens !== null) chat.max_completion_tokens = params.max_output_tokens;
  // Responses reasoning.effort → chat reasoning_effort（minimal/low/medium/high/xhigh 直接透传，
  // 其余交 buildUpstreamPayload 的 clamp 归一化）
  if (params.reasoning && typeof params.reasoning === "object") {
    if (params.reasoning.effort) chat.reasoning_effort = params.reasoning.effort;
  }
  if (params.text && typeof params.text === "object" && params.text.format && params.text.format.type && params.text.format.type !== "text") {
    chat.response_format = { type: params.text.format.type };
    if (params.text.format.json_schema) chat.response_format.json_schema = params.text.format.json_schema;
  }
  // Responses 工具格式（扁平 function）→ chat completions 格式（function 包装）。
  // 上游只接受 type:"function"，namespace/web_search 等非 function 工具一律过滤，避免反序列化报错。
  if (Array.isArray(params.tools)) {
    chat.tools = params.tools
      .filter((t) => t && typeof t === "object" && t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name || "",
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (chat.tools.length === 0) delete chat.tools;
  }
  // Responses tool_choice → chat 格式；仅支持 function 类型，其它对象形式退回 auto
  if (params.tool_choice && typeof params.tool_choice === "object") {
    if (params.tool_choice.type === "function" && params.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: params.tool_choice.name } };
    } else {
      chat.tool_choice = "auto";
    }
  }
  chat.model = mc.id;
  chat.messages = responsesInputToMessages(params.input, params.instructions);
  return chat;
}

// Responses API input → chat messages（input 可为字符串或消息条目数组）
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") { messages.push({ role: "user", content: input }); return messages; }
  if (!Array.isArray(input)) { messages.push({ role: "user", content: input == null ? "" : String(input) }); return messages; }
  for (const item of input) {
    if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }
    // function_call / reasoning / item_reference 等条目本地无法执行/回溯，跳过
    if (item.type === "function_call" || item.type === "reasoning" || item.type === "item_reference") continue;
    const role = item.role || "user";
    const content = item.content;
    if (typeof content === "string") { messages.push({ role, content }); continue; }
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "input_text" || c.type === "output_text") { parts.push({ type: "text", text: c.text ?? "" }); continue; }
        if (c.type === "text" && typeof c.text === "string") { parts.push(c); continue; }
      }
      messages.push({ role, content: parts.length ? parts : "" });
      continue;
    }
    messages.push({ role, content: "" });
  }
  return messages;
}

// 第一阶段：显式代码审计模式。
// 这是 reviewer-only 入口：创建 root run 作为父链，再创建 code-reviewer 子 run，
// 不执行普通 root chat，也不把 reviewer agent 混入普通模型路由。
async function executeCodeReview(env, chatParams, mc, isStream, mode, requestSignal = null) {
  syncAccountState(env);
  const debug = env.FREEBUFF_DEBUG === "true";
  const reviewerAgent = mc.reviewer_agent;
  const reviewerModel = mc.upstream;
  if (!reviewerAgent) {
    return jsonResponse({
      error: {
        message: "Code review is not available for model: " + mc.id,
        type: "unsupported_review_agent",
      },
    }, 400);
  }

  const pool = parseAccounts(env);
  if (pool.length === 0) {
    return jsonResponse({ error: { message: "缺少 FREEBUFF_TOKEN 环境变量", type: "config_error" } }, 503);
  }

  let lastErrMsg = "";
  let lastWaitingRetryAfter = null;
  const attempted = new Set();
  for (let acctTry = 0; acctTry < pool.length; acctTry++) {
    throwIfRequestAborted(requestSignal);
    const acct = pickToken(env, mc.session, attempted);
    const token = acct ? acct.token : null;
    if (!token) {
      recordRequest(mc && mc.id ? mc.id : "", null, false);
      return lastWaitingRetryAfter ? waitingRoomResponse(lastWaitingRetryAfter) : poolExhaustionResponse(env);
    }
    attempted.add(token);
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");
    // 429 本地锁（与 executeChat 一致）：冷却中的 quota 号直接本地回 429
    const lock = cooldownInfo(token);
    if (lock && lock.reason === "quota") {
      releaseToken(token);
      const retryAfterMs = cooldownRemainingMs(lock);
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return jsonResponse({
        error: {
          message: `账号额度已用完,请 ${retryAfterSec}s 后重试`,
          type: "rate_limit_exceeded",
          retryAfterMs,
        },
      }, 429, { "Retry-After": String(retryAfterSec), "X-RateLimit-Local": "1" });
    }
    let rootRunId = null;
    let reviewerRunId = null;
    let leaseTransferred = false;
    try {
      throwIfRequestAborted(requestSignal);
      const sess = await createSession(token, mc.session);
      throwIfRequestAborted(requestSignal);
      const root = await startRunChain(token, mc.root_agent || mc.agent);
      throwIfRequestAborted(requestSignal);
      rootRunId = root.runId;
      // Desktop 协议的关键：reviewer 是 root run 的子 run。
      reviewerRunId = await startRun(token, reviewerAgent, [rootRunId]);
      if (debug) console.log(`[review][acct ${acctTry + 1}] root=${rootRunId} reviewer=${reviewerRunId} model=${reviewerModel}`);

      const payload = buildReviewerPayload(chatParams, { ...mc, upstream: reviewerModel }, sess, reviewerRunId);
      const headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "x-freebuff-instance-id": sess.instanceId,
      };
      const resp = await upstreamFetch(CODEBUFF_API + "/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: isStream ? requestSignal : AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const text = await resp.text();
        recordAccountObservation(token, resp.status, text);
        lastErrMsg = "reviewer upstream error: " + text.slice(0, 300);
        if (resp.status === 429) {
          const ra = parseCooldown(text, 429, resp.headers);
          cooldown(token, ra, { reason: "quota", retryAfterMs: ra });
        } else {
          cooldown(token, parseCooldown(text, resp.status, resp.headers));
        }
        throw new Error(lastErrMsg);
      }

      let finalized = false;
      const finalize = async () => {
        if (finalized) return;
        finalized = true;
        if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
        if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
      };

      if (isStream) {
        const { readable, writable } = new TransformStream();
        const onDone = async (info) => {
          try { await finalize(info); } finally { releaseToken(token); }
        };
        if (mode === "responses") pipeUpstreamToResponsesStream(resp.body, writable, mc, onDone);
        else pipeUpstreamToClient(resp.body, writable, onDone);
        leaseTransferred = true;
        return new Response(readable, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
        });
      }

      const result = mode === "responses"
        ? await responsesToNonStream(resp.body, mc)
        : await streamToNonStream(resp.body, reviewerModel);
      await finalize();
      return mode === "responses" ? jsonResponse(result, 200) : jsonResponse(result, 200);
    } catch (e) {
      if (requestSignal?.aborted) throw e;
      console.error("[code_review]", e);
      lastErrMsg = String(e.message || e);
      if (e instanceof WaitingRoomError || /session stayed queued|waiting.room/i.test(lastErrMsg)) {
        lastWaitingRetryAfter = e.retryAfterMs || 30 * 1000;
      } else lastWaitingRetryAfter = null;
      if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
      if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
      if (!cooldownInfo(token)
        && (e instanceof WaitingRoomError || /start_run failed|timeout|timed out|abort|reviewer upstream/i.test(lastErrMsg))) {
        cooldown(token, lastWaitingRetryAfter || 60 * 1000);
      }
    } finally {
      if (!leaseTransferred) releaseToken(token);
    }
  }
  if (lastWaitingRetryAfter) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return waitingRoomResponse(lastWaitingRetryAfter);
  }
  recordRequest(mc && mc.id ? mc.id : "", null, false);
  if (accountPoolExhaustion(env).allUnavailable) return poolExhaustionResponse(env);
  return jsonResponse({ error: { message: lastErrMsg || "code reviewer failed", type: "api_error" } }, 502);
}

// chat completions 与 responses 共用的上游执行：多号重试 + session/run 生命周期 + 流式/非流式出口
async function executeChat(env, chatParams, mc, isStream, mode, requestSignal = null) {
  if (isCodeReviewRequest(chatParams)) return executeCodeReview(env, chatParams, mc, isStream, mode, requestSignal);
  syncAccountState(env);
  const debug = env.FREEBUFF_DEBUG === "true";
  const pool = parseAccounts(env);
  if (pool.length === 0) return jsonResponse({ error: { message: "缺少 FREEBUFF_TOKEN 环境变量", type: "config_error" } }, 503);

  // 请求内多号重试：一个号失败（超时/429/428 重建无效/run 失败）立即冷却并换下一个号，最多试完整个账号池。
  // 免费通道上游波动大（并发>1 即出问题、排队超时），单请求内换号比等客户端重试成功率高得多。
  let lastErrMsg = "";
  let lastWaitingRetryAfter = null;
  const attempted = new Set();
  for (let acctTry = 0; acctTry < pool.length; acctTry++) {
    throwIfRequestAborted(requestSignal);
    const acct = pickToken(env, mc.session, attempted);
    const token = acct ? acct.token : null;
    if (!token) {
      recordRequest(mc && mc.id ? mc.id : "", null, false);
      return lastWaitingRetryAfter ? waitingRoomResponse(lastWaitingRetryAfter) : poolExhaustionResponse(env);
    }
    attempted.add(token);
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");

    // 429 本地锁：该号正在上游限流冷却（reason=quota）且未到期。
    // 直接本地回 429+Retry-After，不打上游 —— 打了也还是 429，白烧池子。
    // 参考 trefeon/freebuff-proxy 的 429 本地锁语义。
    const lock = cooldownInfo(token);
    if (lock && lock.reason === "quota") {
      releaseToken(token);
      const retryAfterMs = cooldownRemainingMs(lock);
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      if (debug) console.log(`[acct ${acctTry + 1}] local 429 lock (${retryAfterSec}s), skip upstream`);
      // 客户端拿到 429 即该请求的失败终态，记一次失败（概况口径，非逐次尝试计数）。
      recordRequest(mc && mc.id ? mc.id : "", null, false);
      return jsonResponse({
        error: {
          message: `账号额度已用完,请 ${retryAfterSec}s 后重试`,
          type: "rate_limit_exceeded",
          retryAfterMs,
        },
      }, 429, { "Retry-After": String(retryAfterSec), "X-RateLimit-Local": "1" });
    }

    let leaseTransferred = false;
    try {
      throwIfRequestAborted(requestSignal);
      // 调用日志计时起点：涵盖 session/run/chat 全过程，与面板"耗时"口径一致。
      const t0 = Date.now();
      let effort = "";
      // 1) session
      const sess = await createSession(token, mc.session);
      throwIfRequestAborted(requestSignal);
      if (debug) console.log(`[acct ${acctTry + 1}] session=${sess.instanceId}`);

      // 2) run 链
      const run = await startRunChain(token, mc.agent);
      throwIfRequestAborted(requestSignal);
      if (debug) console.log(`[acct ${acctTry + 1}] run=${run.runId}`);

      // 3) chat（428 waiting_room_required / 409 session_superseded = session 失效，
      //    清缓存强制重建后重试一次；仍失败则冷却该号交给外层换号）
      let resp, errText = "", sessForChat = sess;
      for (let attempt = 0; attempt < 2; attempt++) {
        const payload = buildUpstreamPayload(chatParams, mc, sessForChat, run.runId);
        // 记录本次实际发给上游的思考强度（clamp 后）；供调用日志"强度"列展示。
        effort = payload.reasoning_effort || "";
        const headers = {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "x-freebuff-instance-id": sessForChat.instanceId,
        };
        // x-freebuff-acting-user-id：⚠️ 实测（2026-08-10）不带它 chat 才能过（200），
        // 带上反而 409 session_superseded（"Another instance of freebuff has taken over
        // this session. Only one instance per account is allowed."）。
        // 原因：预生成 instance-id 已把 session 绑定到 token 自身，再带 acting-user-id
        // 会让服务端以为存在第二个实例抢同一 slot。桌面版默认也不带此头（仅模拟
        // 他人才带）。因此这里不再发送 acting-user-id。
        if (debug) console.log(`[acct ${acctTry + 1}][chat] attempt=${attempt + 1}`);
        const chatInit = {
          method: "POST", headers, body: JSON.stringify(payload),
        };
        try {
          resp = isStream
            ? await fetchStreamWithQuotaGuard(CODEBUFF_API + "/api/v1/chat/completions", chatInit, token, mc.session, requestSignal)
            : await upstreamFetch(CODEBUFF_API + "/api/v1/chat/completions", {
                ...chatInit,
                signal: AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
              });
        } catch (error) {
          // 空流只视为当前账号的同模型 session 疑似脏状态：
          // 删除上游旧实例，重建同模型 session，再重试一次；绝不改成别的模型。
          // 同样受失效安全窗口约束：窗口内再空流 → 冷却换号，不无限重建。
          if (error instanceof EmptyUpstreamStreamError && attempt === 0) {
            if (wasRecentlyInvalidated(token, mc.session)) {
              if (debug) console.log(`[acct ${acctTry + 1}][chat] empty stream within invalidation window, cooldown`);
              cooldown(token, INVALIDATION_WINDOW_MS, { reason: "invalidation", retryAfterMs: INVALIDATION_WINDOW_MS });
              break;
            }
            await deleteUpstreamSession(token, sessForChat.instanceId, mc.session);
            if (debug) console.log(`[acct ${acctTry + 1}][chat] empty stream, same-model session recovery`);
            sessForChat = await createSession(token, mc.session, true);
            continue;
          }
          throw error;
        }
        if (resp.ok) {
          recordAccountObservation(token, resp.status, null);
          break;
        }
        errText = await resp.text();
        recordAccountObservation(token, resp.status, errText);
        // 428 waiting_room_required（无活跃 session）/ 409 session_superseded（被新 session 顶替）
        // 都说明缓存 instance 已失效 → 清缓存强制重建后重试一次；不是限流，不计冷却。
        // 失效安全窗口：该号刚才（30s 内）已经失效重建过一次还再次失效，
        // 说明上游 session 服务对这个号正处于坏状态，继续重建只会 409 循环。
        // 此时放弃重建，冷却该号（reason=invalidation，不会触发 429 本地锁），
        // 交给外层换号。
        const staleSession =
          isStaleSessionGate(resp.status, errText) ||
          // Older upstream wrappers returned model mismatch as HTTP 502.
          (resp.status === 502 && (errText.includes("session_model_mismatch") || errText.includes("not valid for limited access")));
        if (staleSession && attempt === 0) {
          if (wasRecentlyInvalidated(token, mc.session)) {
            if (debug) console.log(`[acct ${acctTry + 1}][chat] session stale again within window, cooldown (skip recreate)`);
            cooldown(token, INVALIDATION_WINDOW_MS, { reason: "invalidation", retryAfterMs: INVALIDATION_WINDOW_MS });
            break;
          }
          await deleteUpstreamSession(token, sessForChat.instanceId, mc.session);
          if (debug) console.log(`[acct ${acctTry + 1}][chat] session stale (${resp.status}), recreate…`);
          sessForChat = await createSession(token, mc.session, true);
          continue;
        }
        // 重建后仍失败：该号 session 状态异常，冷却交给外层换号
        if (staleSession) cooldown(token, 60 * 1000, { reason: "invalidation", retryAfterMs: 60 * 1000 });
        if (resp.status === 429) {
          const ra = parseCooldown(errText, 429, resp.headers);
          cooldown(token, ra, { reason: "quota", retryAfterMs: ra });
        } else {
          cooldown(token, parseCooldown(errText, resp.status, resp.headers));
        }
        break;
      }
      if (!resp.ok) {
        // 累计口径：429 记限流，其余上游失败记错误（超时走 catch 分支单独计）。
        if (resp.status === 429) callTotals.rateLimited++;
        else callTotals.upstreamError++;
        lastErrMsg = "upstream error: " + (errText || "").slice(0, 300);
        if (debug) console.log(`[acct ${acctTry + 1}] failed ${resp.status}, switch account`);
        continue;
      }

      if (isStream) {
        const { readable, writable } = new TransformStream();
        // 流式：首字延迟与 usage 只有管道跑完才知道，用 onComplete 收尾记一行。
        const onDone = async (info) => {
          try {
            recordChatCall(env, token, mc, effort, t0, info && info.firstTokenAt, info && info.usage);
          } finally {
            releaseToken(token);
          }
        };
        if (mode === "responses") pipeUpstreamToResponsesStream(resp.body, writable, mc, onDone);
        else pipeUpstreamToClient(resp.body, writable, onDone);
        leaseTransferred = true;
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
      }

      if (mode === "responses") {
        const out = await responsesToNonStream(resp.body, mc);
        recordChatCall(env, token, mc, effort, t0, null, out && out.usage);
        return jsonResponse(out, 200);
      }

      const agg = await streamToNonStream(resp.body, mc.upstream);
      recordChatCall(env, token, mc, effort, t0, null, agg && agg.usage);
      return jsonResponse(agg, 200);
    } catch (e) {
      if (requestSignal?.aborted) throw e;
      console.error("[" + mode + "]", e);
      const msg = String(e.message || e);
      if (e instanceof WaitingRoomError || /session stayed queued|waiting.room/i.test(msg)) {
        lastWaitingRetryAfter = e.retryAfterMs || 30 * 1000;
      } else lastWaitingRetryAfter = null;
      // 累计口径：额度耗尽记限流，超时/中断记超时，其余异常记错误。
      if (e instanceof QuotaExhaustedError) callTotals.rateLimited++;
      else if (/abort|timeout|timed out|terminated/i.test(msg)) callTotals.timeout++;
      else callTotals.upstreamError++;
      // 额度探测确认耗尽：清除当前模型 session，按上游 retryAfterMs 冷却后切号。
      if (e instanceof QuotaExhaustedError) {
        sessCache.delete(token + ":" + mc.session);
        const ra = e.retryAfterMs || parseCooldown("", 429);
        cooldown(token, ra, { reason: "quota", retryAfterMs: ra });
      }
      if (e instanceof EmptyUpstreamStreamError) {
        cooldown(token, 60 * 1000);
      }
      // 其他上游交互失败/超时继续沿用原有冷却逻辑；流式 chat 不再因固定 20s abort 进入这里。
      // createSession 429（额度耗尽）按 retryAfterMs/文本冷却，不能固定 60s。
      if (e instanceof WaitingRoomError) {
        cooldown(token, e.retryAfterMs || 30 * 1000);
      } else if (/create session failed|stayed queued|start_run failed|session_model_mismatch|abort|timeout|timed out|terminated/i.test(msg)) {
        const m429 = msg.match(/429/);
        if (m429) {
          const ra = parseCooldown(msg, 429);
          cooldown(token, ra, { reason: "quota", retryAfterMs: ra });
        } else {
          cooldown(token, 60 * 1000);
        }
      }
      lastErrMsg = msg;
      if (debug) console.log(`[acct ${acctTry + 1}] exception: ${msg.slice(0, 120)}, switch account`);
    } finally {
      if (!leaseTransferred) releaseToken(token);
    }
  }
  if (lastWaitingRetryAfter) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return waitingRoomResponse(lastWaitingRetryAfter);
  }
  // 全池换号仍失败：该请求的失败终态，记一次失败（每个客户端请求只落一次）。
  recordRequest(mc && mc.id ? mc.id : "", null, false);
  if (accountPoolExhaustion(env).allUnavailable) return poolExhaustionResponse(env);
  return jsonResponse({ error: { message: lastErrMsg, type: "api_error" } }, 502);
}


// ---------------------------------------------------------------------------
// Anthropic Messages API（本地适配，复用稳定的 executeChat 主链路）
// ---------------------------------------------------------------------------
function anthropicModelToOpenAI(model) {
  let raw = String(model || "").trim();
  if (!raw) return null;
  // 剥掉 anthropic/ 前缀（claude 客户端有时带）
  raw = raw.replace(/^anthropic\//, "");
  // 自定义别名优先（本地映射，无网络）
  const aliasHit = resolveModelAlias(raw);
  if (aliasHit) return aliasHit;
  // 已是 openai/freebuff 风格 id（含 provider/ 前缀）：透传给 resolveModelConfig 异步校验（含动态表刷新）
  if (raw.includes("/")) return raw;
  const short = raw;
  const hit = MODELS.find((m) => m.id.toLowerCase().endsWith("/" + short.toLowerCase()))
    || (dynamicModelsCache.models || []).find((m) => m.id.toLowerCase().endsWith("/" + short.toLowerCase()));
  return hit ? hit.id : null; // 未知模型不静默回落默认模型，由调用方返回 400
}

function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function anthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
    if (p.type === "image" && p.source && typeof p.source === "object") {
      const s = p.source;
      if (s.type === "base64" && s.media_type && s.data) out.push({ type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } });
      else if (s.type === "url" && s.url) out.push({ type: "image_url", image_url: { url: s.url } });
    }
  }
  return out;
}

// Anthropic thinking 配置 → Freebuff reasoning_effort。
// budget_tokens 分档语义对齐 Go 版 mapClaudeThinkingToReasoningEffort + budgetToReasoningEffort；
// 但客户端点名的档位（thinking.effort / output_config.effort，Anthropic effort-2025-11-24）
// 一律原样采用，不再把 max 折成 xhigh——那会让 CC 侧设的 max 在这里就掉一档，
// 到了 efforts=[low,high,max] 的模型上再被 clamp 成 high，等于完全失效。
// 输出取值在官方 ladder 内，最终由 buildUpstreamPayload 的 clamp 按模型能力归一化。
// 返回 undefined 表示无需设置。
function anthropicThinkingToEffort(body) {
  const thinking = body?.thinking;
  if (!thinking || typeof thinking !== "object") return undefined;
  const type = String(thinking.type || "").toLowerCase();
  switch (type) {
    case "disabled":
      return "none";
    case "enabled": {
      // 显式档位名优先于 budget（新客户端两者都发时，名字才是用户真正点的那一档）
      const named = namedEffort(thinking.effort);
      if (named) return named;
      const budget = Number(thinking.budget_tokens);
      if (!Number.isFinite(budget)) return "auto";
      if (budget <= 0) return "none";
      if (budget <= 512) return "minimal";
      if (budget <= 1024) return "low";
      if (budget <= 8192) return "medium";
      if (budget <= 24576) return "high";
      return "xhigh";
    }
    case "adaptive":
    case "auto": {
      // Anthropic 扩展：adaptive/auto + output_config.effort（Desk/Agent 工具与 CC 常用）
      const named = namedEffort(body?.output_config?.effort);
      if (named) return named;
      return "auto";
    }
    default:
      return undefined;
  }
}

function anthropicToChat(body, mc) {
  const chat = { model: mc.id, stream: !!body.stream, messages: [] };
  if (body.stream) chat.stream_options = { include_usage: true };
  const system = anthropicText(body.system);
  if (system) chat.messages.push({ role: "system", content: system });
  if (body.max_tokens != null) chat.max_completion_tokens = body.max_tokens;
  for (const k of ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty"]) if (body[k] != null) chat[k] = body[k];
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences;
  // Anthropic thinking → Freebuff reasoning_effort（语义对齐官方 freebuff reasoning-effort.ts ladder：
  // minimal < low < medium < high < xhigh < max < ultra；映射结果再经 normalizeReasoningEffort clamp-down）
  //   thinking.type=disabled        → "none"（关闭思考）
  //   thinking.type=enabled         → thinking.effort 点名优先，否则按 budget_tokens 分档
  //   thinking.type=adaptive/auto   → 读 output_config.effort（Anthropic 扩展，max 原样为 max）
  const thinkingEffort = anthropicThinkingToEffort(body);
  if (thinkingEffort !== undefined) chat.reasoning_effort = thinkingEffort;
  if (body.metadata && typeof body.metadata === "object") chat.metadata = body.metadata;

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.filter((t) => t && t.name).map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    const tc = body.tool_choice;
    if (tc?.type === "auto") chat.tool_choice = "auto";
    else if (tc?.type === "any") chat.tool_choice = "required";
    else if (tc?.type === "none") chat.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) chat.tool_choice = { type: "function", function: { name: tc.name } };
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const results = parts.filter((p) => p && p.type === "tool_result");
      if (results.length) {
        for (const p of results) chat.messages.push({ role: "tool", tool_call_id: p.tool_use_id || "", content: anthropicContent(p.content) });
        const text = parts.filter((p) => p && p.type === "text" && p.text).map((p) => p.text).join("\n");
        if (text) chat.messages.push({ role: "user", content: text });
      } else chat.messages.push({ role: "user", content: anthropicContent(m.content) });
    } else if (m.role === "assistant") {
      const uses = Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "tool_use") : [];
      if (uses.length) chat.messages.push({ role: "assistant", content: anthropicText(m.content), tool_calls: uses.map((p) => ({ id: p.id || ("call_" + Math.random().toString(36).slice(2, 10)), type: "function", function: { name: p.name || "", arguments: JSON.stringify(p.input ?? {}) } })) });
      else chat.messages.push({ role: "assistant", content: anthropicText(m.content) });
    }
  }
  return chat;
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

// 上游 OpenAI reasoning_content → Anthropic thinking block（Go 版 collectReasoningTexts 语义：
// 兼容字符串 / 数组 / 对象三种形态；thinking 块置于文本块之前，与官方流一致）
function collectReasoningTexts(value) {
  const texts = [];
  const walk = (v) => {
    if (typeof v === "string") { if (v.trim()) texts.push(v); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (v && typeof v === "object") {
      const t = v.text ?? v.thinking;
      if (typeof t === "string" && t.trim()) texts.push(t);
      else for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(value);
  return texts;
}

function anthropicFromChat(oai, mc) {
  const choice = oai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  // reasoning_content → thinking block（thinking 在前，text 在后，对齐官方消息格式）
  for (const r of collectReasoningTexts(msg.reasoning_content)) {
    content.push({ type: "thinking", thinking: r });
  }
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: tc.function?.name || "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const u = oai?.usage || {};
  const usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
  // 上游 cached_tokens → cache_read_input_tokens（对齐 Go 版 extractOpenAIUsage）
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (Number.isFinite(cached) && cached > 0) {
    usage.cache_read_input_tokens = cached;
    usage.input_tokens = Math.max(0, usage.input_tokens - cached);
  }
  return { id: oai?.id || ("msg_" + Math.random().toString(36).slice(2, 10)), type: "message", role: "assistant", model: mc.id, content, stop_reason: anthropicStopReason(choice.finish_reason), stop_sequence: null, usage };
}

function anthropicError(message, type, status, retryAfter) {
  const headers = { ...corsHeaders() };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return jsonResponse({ type: "error", error: { type: type || "api_error", message: String(message || "Upstream error") } }, status || 500, headers);
}

function estimateAnthropicTokens(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimateAnthropicTokens(x), 0);
  if (value && typeof value === "object") return Object.entries(value).reduce((n, [k, v]) => n + k.length + estimateAnthropicTokens(v), 0);
  return 0;
}

async function handleAnthropicCountTokens(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  if (!openaiModel) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const mc = await resolveModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  return jsonResponse({ input_tokens: Math.max(1, Math.ceil(estimateAnthropicTokens(chat.messages) / 4)) }, 200);
}

// Anthropic 流式转换：上游 OpenAI SSE（含 reasoning_content）→ Anthropic SSE 事件。
// 对齐 Go 版 claudeStreamState 语义：
//   - 上游 reasoning_content → thinking content_block（thinking_delta 增量）
//   - 工具调用流式参数 → tool_use + input_json_delta
//   - thinking 块在首个文本/工具增量出现前自动 stop（与官方顺序一致）
function anthropicStream(mc, opts = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = {
    started: false, ended: false,
    reason: "end_turn", input: 0, output: 0, cached: 0, reasoning: 0,
    messageId: "msg_" + Math.random().toString(36).slice(2, 10),
    thinking: { started: false, index: -1 },
    text: { started: false, index: -1 },
    tools: new Map(), // 上游 index -> { index, id, name, started, args }
    nextBlockIdx: 0,
    finalSent: false,
  };
  const events = (ctl, name, data) => { if (!data.type) data.type = name; ctl.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); };
  const blockIndex = (slot) => {
    if (slot.index >= 0) return slot.index;
    slot.index = state.nextBlockIdx++;
    return slot.index;
  };
  const stopThinking = (ctl) => {
    if (!state.thinking.started) return;
    events(ctl, "content_block_stop", { index: state.thinking.index });
    state.thinking.started = false; state.thinking.index = -1;
  };
  const stopText = (ctl) => {
    if (!state.text.started) return;
    events(ctl, "content_block_stop", { index: state.text.index });
    state.text.started = false; state.text.index = -1;
  };
  const ensureStarted = (ctl) => {
    if (state.started) return;
    state.started = true;
    events(ctl, "message_start", {
      message: { id: state.messageId, type: "message", role: "assistant", model: mc.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: state.input, output_tokens: 0 } },
    });
  };
  const finalize = (ctl) => {
    if (state.ended) return;
    state.ended = true;
    ensureStarted(ctl);
    stopThinking(ctl);
    stopText(ctl);
    for (const t of state.tools.values()) {
      if (!t.started) continue;
      if (t.args) events(ctl, "content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: t.args } });
      events(ctl, "content_block_stop", { index: t.index });
    }
    const usage = { output_tokens: state.output };
    if (state.cached > 0) usage.cache_read_input_tokens = state.cached;
    if (state.reasoning > 0) usage.output_tokens_details = { reasoning_tokens: state.reasoning };
    events(ctl, "message_delta", { delta: { stop_reason: state.reason, stop_sequence: null }, usage });
    events(ctl, "message_stop", {});
  };
  const usageToTokens = (u) => {
    if (!u) return;
    if (Number.isFinite(u.prompt_tokens)) state.input = u.prompt_tokens;
    if (Number.isFinite(u.completion_tokens)) state.output = u.completion_tokens;
    const cached = u.prompt_tokens_details?.cached_tokens;
    if (Number.isFinite(cached)) state.cached = cached;
    // DeepSeek/推理类上游在 usage.completion_tokens_details 里回报 reasoning 用量，
    // 需要单独统计，不能算进普通 output_tokens（对齐 anthropicFromChat 的非流式逻辑）
    const rt = u.completion_tokens_details?.reasoning_tokens;
    if (Number.isFinite(rt)) state.reasoning = rt;
  };
  return new TransformStream({
    transform(chunk, ctl) {
      if (state.ended) return;
      let buffer = decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") { finalize(ctl); continue; }
        let obj; try { obj = JSON.parse(raw); } catch { continue; }
        usageToTokens(obj.usage);
        const choice = obj.choices?.[0]; if (!choice) continue;
        const delta = choice.delta || {};
        ensureStarted(ctl);
        // reasoning_content → thinking block（thinking 先于文本，与官方顺序一致）
        const reasonTexts = collectReasoningTexts(delta.reasoning_content);
        if (reasonTexts.length) {
          if (!state.thinking.started) {
            stopText(ctl);
            const index = blockIndex(state.thinking);
            events(ctl, "content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
            state.thinking.started = true;
          }
          for (const t of reasonTexts) {
            events(ctl, "content_block_delta", { index: state.thinking.index, delta: { type: "thinking_delta", thinking: t } });
          }
        }
        if (delta.content) {
          stopThinking(ctl);
          if (!state.text.started) {
            const index = blockIndex(state.text);
            events(ctl, "content_block_start", { index, content_block: { type: "text", text: "" } });
            state.text.started = true;
          }
          events(ctl, "content_block_delta", { index: state.text.index, delta: { type: "text_delta", text: delta.content } });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = tc.function || {};
            const srcIdx = tc.index ?? 0;
            let t = state.tools.get(srcIdx);
            if (!t) {
              const slot = { index: -1 };
              const blkIdx = blockIndex(slot);
              t = { index: blkIdx, id: "", name: "", started: false, args: "" };
              state.tools.set(srcIdx, t);
            }
            if (tc.id) t.id = tc.id;
            if (fn.name) t.name = fn.name;
            if (fn.arguments) t.args += fn.arguments;
            if (!t.started && t.name) {
              stopThinking(ctl); stopText(ctl);
              events(ctl, "content_block_start", { index: t.index, content_block: { type: "tool_use", id: t.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: t.name, input: {} } });
              t.started = true;
            }
            if (t.started && fn.arguments) {
              events(ctl, "content_block_delta", { index: t.index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
            }
          }
        }
        if (choice.finish_reason) state.reason = anthropicStopReason(choice.finish_reason);
      }
    },
    flush(ctl) { finalize(ctl); },
  });
}

async function handleAnthropicMessages(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  if (!openaiModel) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  // 异步解析：优先静态 MODELS，缺失时刷新动态官方清单（与 handleChat/handleResponses 一致）
  const mc = await resolveModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  const response = await executeChat(env, chat, mc, !!chat.stream, "chat", request.signal);
  if (response.status >= 400) {
    let msg = "Upstream error"; try { const data = await response.json(); msg = data?.error?.message || msg; } catch {}
    const types = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 429: "rate_limit_error", 503: "overloaded_error" };
    return anthropicError(msg, types[response.status] || "api_error", response.status, response.headers.get("Retry-After"));
  }
  if (!chat.stream) return jsonResponse(anthropicFromChat(await response.json(), mc), response.status);
  return new Response(response.body.pipeThrough(anthropicStream(mc)), { status: response.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
}



function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object" && (obj.data.choices || obj.data.id || obj.data.usage)) return obj.data;
  return obj;
}

function writerClosedSignal(writer) {
  if (!writer || !writer.closed || typeof writer.closed.then !== "function") return null;
  return Promise.resolve(writer.closed).then(
    () => ({ writerClosed: true, error: new Error("downstream stream closed") }),
    (error) => ({
      writerClosed: true,
      error: error instanceof Error ? error : new Error("downstream stream closed"),
    }),
  );
}

// 流式：把上游 SSE 剥 {data:...} 包装后透传
function pipeUpstreamToClient(upstreamBody, writable, onComplete) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const closed = writerClosedSignal(writer);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let firstTokenAt = null, usage = null; // 调用日志：首字时刻 + 末尾 usage 块
  (async () => {
    try {
      while (true) {
        const next = closed ? await Promise.race([reader.read(), closed]) : await reader.read();
        if (next.writerClosed) throw next.error;
        const { done, value } = next;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") { await writer.write(encoder.encode(line + "\n\n")); continue; }
            try {
              const normalized = unwrapData(JSON.parse(payload));
              if (!firstTokenAt) {
                const d = normalized?.choices?.[0]?.delta;
                if (d && (d.content || d.reasoning_content)) firstTokenAt = Date.now();
              }
              if (normalized?.usage) usage = normalized.usage;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (error) {
      // 客户端取消/写入失败时，停止上游读取，避免释放租约后旧流继续占用账号。
      try { if (typeof reader.cancel === "function") await reader.cancel(error); } catch {}
    }
    finally {
      try { if (onComplete) await onComplete({ firstTokenAt, usage }); } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}

// 非流式：聚合上游流成 OpenAI 非流式对象
async function streamToNonStream(upstreamBody, upstreamModel) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoning = "", finishReason = null, model = "", id = "", usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (obj.id) id = obj.id;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const msg = { role: "assistant", content };
  if (reasoning && !content) { msg.content = reasoning; msg.reasoning_used_as_content = true; }
  else if (reasoning) msg.reasoning_content = reasoning;
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || upstreamModel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason || "stop", logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// Responses API（/v1/responses）输出
// ---------------------------------------------------------------------------

function responsesBase(mc, respId, createdAt) {
  return {
    id: respId || "resp_" + Math.random().toString(36).slice(2, 10),
    object: "response",
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: mc.id,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1.0,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function responsesUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
}

// 上游是 Chat Completions 格式，Responses API 要求 input/output_tokens。
// 统一归一化，避免把不完整或错误格式的 usage 直接透传给严格客户端。
function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return responsesUsage();
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : inputTokens + outputTokens;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number.isFinite(inputDetails.cached_tokens) ? inputDetails.cached_tokens : 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number.isFinite(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : 0 },
    total_tokens: totalTokens,
  };
}

// 流式：上游 chat SSE → Responses API 事件序列（response.created … response.completed）
function pipeUpstreamToResponsesStream(upstreamBody, writable, mc, onComplete) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const closed = writerClosedSignal(writer);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const respId = "resp_" + Math.random().toString(36).slice(2, 10);
  const createdAt = Math.floor(Date.now() / 1000);
  let buf = "", model = "", usage = null, firstTokenAt = null;
  const send = (obj) => writer.write(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));

  // 按上游出现顺序记录输出项：message（文本）或 function_call（工具调用）
  const items = [];
  let nextOutputIndex = 0;
  let contentItem = null;
  const toolItems = new Map(); // 上游 tool_calls index → 输出项
  // 推理摘要（Responses reasoning.summary 请求时客户端期待 reasoning_summary_text 事件）
  let reasoningSummary = "";
  let reasoningItem = null;

  const startContent = () => {
    const item = {
      kind: "message",
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      text: "",
      contentIndex: 0,
      started: false,
    };
    items.push(item);
    return item;
  };
  const startTool = (tc) => {
    const fn = tc.function || {};
    const item = {
      kind: "function_call",
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
      name: fn.name || "",
      args: "",
    };
    items.push(item);
    return item;
  };

  (async () => {
    try {
      await send({ type: "response.created", response: responsesBase(mc, respId, createdAt) });
      await send({ type: "response.in_progress", response: responsesBase(mc, respId, createdAt) });

      while (true) {
        const next = closed ? await Promise.race([reader.read(), closed]) : await reader.read();
        if (next.writerClosed) throw next.error;
        const { done, value } = next;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = unwrapData(JSON.parse(payload));
            const choice = obj?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
                if (obj.model) model = obj.model;
                if (obj.usage) usage = obj.usage;
                // 调用日志首字：文本/推理/工具调用任一先到即计。
                if (!firstTokenAt && (delta.content || delta.reasoning_content ||
                  (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) firstTokenAt = Date.now();

            // 推理增量 → response.reasoning_summary_text.delta（OpenAI 客户端按事件名消费）
            const reasonDeltas = collectReasoningTexts(delta.reasoning_content);
            if (reasonDeltas.length) {
              for (const r of reasonDeltas) reasoningSummary += r;
              if (!reasoningItem) {
                reasoningItem = { id: "rs_" + Math.random().toString(36).slice(2, 10), outputIndex: nextOutputIndex++ };
                await send({ type: "response.reasoning_summary_text.added", item_id: reasoningItem.id, output_index: reasoningItem.outputIndex, content_index: 0, text: "" });
              }
              for (const r of reasonDeltas) {
                await send({ type: "response.reasoning_summary_text.delta", item_id: reasoningItem.id, output_index: reasoningItem.outputIndex, content_index: 0, delta: r });
              }
            }

            // 工具调用增量（chat 格式 delta.tool_calls[]）
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (!tc || typeof tc !== "object") continue;
                const ti = tc.index ?? 0;
                let item = toolItems.get(ti);
                if (!item) {
                  item = startTool(tc);
                  toolItems.set(ti, item);
                  await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "in_progress", call_id: item.callId, name: item.name, arguments: "" } });
                }
                const fn = tc.function || {};
                if (fn.name && !item.name) item.name = fn.name;
                if (fn.arguments) {
                  item.args += fn.arguments;
                  await send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.outputIndex, delta: fn.arguments });
                }
              }
            }

            // 文本增量
            if (delta.content) {
              if (!contentItem) contentItem = startContent();
              if (!contentItem.started) {
                contentItem.started = true;
                await send({ type: "response.output_item.added", output_index: contentItem.outputIndex, item: { id: contentItem.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
                await send({ type: "response.content_part.added", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
              }
              contentItem.text += delta.content;
              await send({ type: "response.output_text.delta", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, delta: delta.content });
            }
          } catch {}
        }
      }

      // 既无文本也无工具调用时补一个空 message，避免 output 为空数组
      if (items.length === 0) {
        const item = startContent();
        item.started = true;
        await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
        await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
      }

      // 收尾：按出现顺序输出每个输出项的 done 事件
      for (const item of items) {
        if (item.kind === "message") {
          if (!item.started) {
            await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
            await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
          }
          const part = { type: "output_text", text: item.text, annotations: [] };
          await send({ type: "response.output_text.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, text: item.text });
          await send({ type: "response.content_part.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part });
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "completed", role: "assistant", content: [part] } });
        } else {
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args } });
        }
      }

      // 推理摘要 done（若有）
      if (reasoningItem && reasoningSummary) {
        await send({ type: "response.reasoning_summary_text.done", item_id: reasoningItem.id, output_index: reasoningItem.outputIndex, content_index: 0, text: reasoningSummary });
      }

      const resp = responsesBase(mc, respId, createdAt);
      resp.status = "completed";
      resp.model = model || mc.id;
      resp.output = items.map((item) =>
        item.kind === "message"
          ? { id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }
          : { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args }
      );
      // reasoning summary 一并写入最终 response 对象（非流式消费者能直接读到）
      if (reasoningSummary) {
        resp.reasoning = { effort: null, summary: [{ type: "summary_text", text: reasoningSummary }] };
      }
      resp.usage = chatUsageToResponsesUsage(usage);
      await send({ type: "response.completed", response: resp });
    } catch (error) {
      // 客户端取消/写入失败时，停止上游读取，避免释放租约后旧流继续占用账号。
      try { if (typeof reader.cancel === "function") await reader.cancel(error); } catch {}
    }
    finally {
      try { if (onComplete) await onComplete({ firstTokenAt, usage }); } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}

// 非流式：聚合上游流成 Responses API 非流式对象
async function responsesToNonStream(upstreamBody, mc) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", model = "", outputText = "", reasoning = "", usage = null;
  const toolItems = new Map(); // 上游 tool_calls index → {id, callId, name, args}
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) outputText += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              const fn = tc.function || {};
              item = {
                id: "fc_" + Math.random().toString(36).slice(2, 10),
                callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
                name: fn.name || "",
                args: "",
              };
              toolItems.set(ti, item);
            }
            const fn = tc.function || {};
            if (fn.name && !item.name) item.name = fn.name;
            if (fn.arguments) item.args += fn.arguments;
          }
        }
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const resp = responsesBase(mc, undefined, Math.floor(Date.now() / 1000));
  resp.status = "completed";
  resp.model = model || mc.id;
  resp.output = [];
  // reasoning 独立放入 resp.reasoning（Responses API 语义：reasoning 不属于 output 文本，
  // 仅当客户端请求了 reasoning summary 或文本缺失时兜底展示）
  const reasonText = reasoning.trim();
  if (reasonText) {
    resp.reasoning = { effort: null, summary: [{ type: "summary_text", text: reasonText }] };
  }
  if (outputText) {
    resp.output.push({
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    });
  }
  for (const item of toolItems.values()) {
    resp.output.push({ id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args });
  }
  resp.usage = chatUsageToResponsesUsage(usage);
  return resp;
}


// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

// 轻量缓存清理：避免长时间运行后 Map 无限膨胀（Workers 无自动 GC）
function cleanCache() {
  const now = Date.now();
  try {
    if (sessCache.size > 50) {
      for (const [k, v] of sessCache) {
        const exp = v.expiresAt ? new Date(v.expiresAt).getTime() : 0;
        if (exp > 0 && exp < now) sessCache.delete(k);
      }
    }
    if (runCache.size > 50) {
      for (const [k, v] of runCache) {
        if (now - v.ts > RUN_CACHE_TTL_MS) runCache.delete(k);
      }
    }
  } catch {}
}

// /v1/models 返回 硬编码 MODELS + 动态官方清单（合并去重）
// ⚠️ 不要在这里查上游 GET /api/v1/freebuff/session（额度/状态）：
// 该接口会占用账号 session，而 Freebuff 一个号同一时间只能一个客户端在线，
// 查询会干扰/顶掉正在进行的 chat 会话（428 waiting_room_required）。
// 自定义别名不在此展示（面板单独管理），避免污染客户端模型列表。
async function handleModels() {
  let modelList = MODELS;
  try {
    const dyn = await refreshDynamicModelsIfStale();
    if (dyn && dyn.models && dyn.models.length) {
      modelList = mergeModelTables(MODELS, dyn.models);
    }
  } catch {}
  const data = modelList
    .map((m) => {
      // 实测（2026-08-15）：免费账号只有 Flash / MiMo 2.5 两个模型能建会话
      // （上游 409 session_model_mismatch / 403 free_mode_invalid_agent_model 拒绝其余模型）。
      // 只给这两个打 free 标记，其余模型不带任何 tag。
      const free = FREE_AVAILABLE_MODELS.has(m.id);
      return {
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "freebuff",
        // free 优先排序：可用模型排最前，其余按原顺序（排序后移除内部字段）
        ...(free ? { free: true, _sort: 0 } : { _sort: 1 }),
      };
    })
    .sort((a, b) => a._sort - b._sort)
    .map(({ _sort, ...m }) => m);
  return jsonResponse({ object: "list", data }, 200, { "X-Freebuff2api-Version": VERSION });
}

function getApiKey(request, env) {
  const expected = (env.API_KEY || env.FREEBUFF_API_KEY || DEFAULT_API_KEY).trim();
  if (!expected) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected ? expected : null;
  return request.headers.get("x-api-key") === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta",
  };
}
