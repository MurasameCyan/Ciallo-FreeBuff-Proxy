const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_API_KEY = "freebuff-default-key";
// 主 Key（部署自带那把）在调用日志/面板里的显示名。server/api-keys.mjs 里有同一个
// 字面量（worker 得能单文件跑 Cloudflare，不能 import 服务端模块），改这里一起改。
const OWNER_KEY_NAME = "主 Key";
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
const MODEL_ENDPOINTS_API = "https://openrouter.ai/api/v1/models";
const ENDPOINT_CHECK_MODEL_IDS = new Set(["stealth/ox-alpha"]);
// 刷新间隔：与 Quorinex 对齐，6 小时。失败时回退到硬编码 MODELS。
const DYNAMIC_MODELS_REFRESH_MS = 6 * 60 * 60 * 1000;
// endpoint 首次无法确认时保持下架，但不要跟着目录缓存冻结 6 小时。
const DYNAMIC_MODEL_ENDPOINT_RETRY_MS = 60 * 1000;
const DYNAMIC_MODELS_FETCH_TIMEOUT_MS = 10000;

// 运行时动态模型缓存（内存，无 KV）
let dynamicModelsCache = {
  fetchedAt: 0,
  models: null, // 动态模型表（含分类）
  pool: null, // { premium: Set, standard: Set, glm: Set, perModelCaps: Object, paused: Set }
};
let dynamicModelsRefreshFlight = null;
const dynamicEndpointRefreshFlights = new Map();
// 公开 provider 端点状态。endpoints: [] / 404 标记不可用；网络错误沿用上次
// 结果。冷启动尚无可信状态时 fail closed，避免把未经确认的模型漏进目录。
let dynamicModelAvailability = new Map(); // modelId -> { available, checkedAt }

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

function parseConstArray(source, name, modelIdConstants) {
  const match = new RegExp(`export\\s+const\\s+${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!match) return [];
  const out = [];
  const itemRe = /'([^']*)'|"([^"]*)"|([A-Z][A-Z0-9_]+)/g;
  let item;
  while ((item = itemRe.exec(match[1])) !== null) {
    const id = item[1] ?? item[2] ?? modelIdConstants[item[3]];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function parsePerModelSessionCaps(source, modelIdConstants) {
  const start = source.search(/export\s+const\s+FREEBUFF_PER_MODEL_SESSION_CAPS\b/);
  if (start < 0) return {};
  const bodyStart = source.indexOf('{', source.indexOf('=', start));
  if (bodyStart < 0) return {};
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { bodyEnd = i; break; }
  }
  if (bodyEnd < 0) return {};
  const body = source.slice(bodyStart + 1, bodyEnd);
  const caps = {};
  const entryRe = /\[\s*([A-Z0-9_]+)\s*\]\s*:\s*\{([\s\S]*?)\}\s*,?/g;
  let entry;
  while ((entry = entryRe.exec(body)) !== null) {
    const id = modelIdConstants[entry[1]];
    if (!id) continue;
    const limit = Number(/\blimit\s*:\s*([0-9]+(?:\.[0-9]+)?)/.exec(entry[2])?.[1]);
    const pool = /\bpool\s*:\s*['"]([^'"]+)['"]/.exec(entry[2])?.[1] || '';
    const poolLabel = /\bpoolLabel\s*:\s*['"]([^'"]+)['"]/.exec(entry[2])?.[1] || '';
    if (Number.isFinite(limit) && pool) caps[id] = { limit, pool, ...(poolLabel ? { poolLabel } : {}) };
  }
  return caps;
}

// 解析 freebuff-models.ts 的共享池、单模型 cap 与暂停清单。
// STANDARD 仍由 non-premium/non-GLM 推导；独立 cap 只覆盖展示/作用域，不会抹掉
// GLM 5.3 Flash 同时属于共享 Premium 池的事实。
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
  const perModelCaps = parsePerModelSessionCaps(source, modelIdConstants);
  const paused = parseConstArray(source, "FREEBUFF_PAUSED_FREE_MODEL_IDS", modelIdConstants);
  // FREEBUFF_PREMIUM_MODEL_IDS 与 FREEBUFF_WEB_PREMIUM_MODEL_IDS 都算 premium。
  return { premium: [...premium], glm: [...glm], perModelCaps, paused };
}

// 上游把这些模型的 base2 root agent 在服务端下线了：session 200、agent-runs 200，
// 只有 POST /chat/completions 回 403 free_mode_legacy_luna_agent
// （"This conversation uses a retired Luna agent."）。公开常量里 root 映射照旧指向
// base2，目录和漂移巡检都看不出来，只能按实测结果改路由到 base3 root。
// ponytail: 手工名单。下一个模型的 base2 被下线还得再加一行；要自动化就得在收到
// free_mode_legacy_*_agent 时回落到 base3_agent 重试一次（代价是每次多一轮上游往返）。
const RETIRED_BASE2_ROOT_MODEL_IDS = new Set(["openai/gpt-5.6-luna"]);

// 动态模型表：分别记录普通 root、base3 root、reviewer。
function buildDynamicModelTable(agentMappings) {
  // 兼容旧调用：传入单张 root mapping 时仍可正常构建。
  const mappings = agentMappings && agentMappings.root
    ? agentMappings
    : { root: agentMappings || {}, base3: {}, reviewer: {} };
  return Object.entries(mappings.root).map(([modelId, rootAgent]) => {
    const base3Agent = mappings.base3[modelId] || null;
    const root = base3Agent && RETIRED_BASE2_ROOT_MODEL_IDS.has(modelId) ? base3Agent : rootAgent;
    return {
      id: modelId,
      session: modelId,
      // 旧字段保留为普通 root，普通 chat 永远使用它。
      agent: root,
      root_agent: root,
      base3_agent: base3Agent,
      reviewer_agent: mappings.reviewer[modelId] || null,
      upstream: modelId,
    };
  });
}

function annotateDynamicModelPools(models, pool) {
  const premium = pool?.premium instanceof Set ? pool.premium : new Set(pool?.premium || []);
  const glm = pool?.glm instanceof Set ? pool.glm : new Set(pool?.glm || []);
  const perModelCaps = pool?.perModelCaps && typeof pool.perModelCaps === "object"
    ? pool.perModelCaps : {};
  return (Array.isArray(models) ? models : []).map((model) => {
    const id = String(model?.id || "");
    const cap = perModelCaps[id];
    if (cap && typeof cap === "object" && String(cap.pool || "").trim()) {
      return {
        ...model,
        pool: String(cap.pool),
        perModelCap: {
          limit: Number(cap.limit),
          pool: String(cap.pool),
          ...(String(cap.poolLabel || "").trim() ? { poolLabel: String(cap.poolLabel) } : {}),
        },
        ...(premium.has(id) ? { sharedPool: "premium" } : {}),
      };
    }
    if (model && typeof model === "object" && String(model.pool || "").trim()) return model;
    const category = glm.has(id) ? "glm" : premium.has(id) ? "premium" : null;
    return category ? { ...model, pool: category } : model;
  });
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
      let timeoutReject;
      const timeout = new Promise((_, reject) => {
        timeoutReject = reject;
      });
      const timeoutError = () => {
        ctrl.abort();
        timeoutReject(new Error("model source timeout"));
      };
      const timeoutTimer = setTimeout(timeoutError, DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      try {
        const resp = await Promise.race([fetch(url, { signal: ctrl.signal }), timeout]);
        if (resp.ok) {
          const text = await Promise.race([resp.text(), timeout]);
          // 阈值放宽：freebuff-model-ids.ts 只有 ~491B（3 个常量），
          // 500 阈值会误杀。只过滤真正的空文件（<100B）。
          if (text && text.length > 100) return text;
        }
      } finally {
        // 响应头到了不代表 body 已读完；超时必须覆盖 text()。
        clearTimeout(timer);
        clearTimeout(timeoutTimer);
      }
    } catch {}
  }
  return null;
}

async function probeEndpointAvailability(modelId) {
  const id = String(modelId || "");
  const existing = dynamicEndpointRefreshFlights.get(id);
  if (existing) return existing;
  const flight = (async () => {
    const attemptedAt = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      let timeoutReject;
      const timeout = new Promise((_, reject) => {
        timeoutReject = reject;
      });
      const timeoutError = () => {
        ctrl.abort();
        timeoutReject(new Error("endpoint timeout"));
      };
      const timeoutTimer = setTimeout(timeoutError, DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      try {
        const resp = await Promise.race([fetch(`${MODEL_ENDPOINTS_API}/${id}/endpoints`, {
          signal: ctrl.signal,
          headers: { Accept: "application/json" },
        }), timeout]);
        // OpenRouter 明确返回 404 表示该模型没有 endpoint；这不是瞬时网络
        // 故障，应立即撤下。429/5xx/超时等仍沿用上次状态，避免抖动误删。
        if (resp.status === 404) {
          return { available: false, checkedAt: attemptedAt, lastAttemptAt: attemptedAt, retryAt: 0 };
        }
        if (!resp.ok) throw new Error(`endpoint status ${resp.status}`);
        const body = await Promise.race([resp.json(), timeout]);
        if (!Array.isArray(body?.data?.endpoints)) throw new Error("invalid endpoint response");
        return {
          available: body.data.endpoints.length > 0,
          checkedAt: attemptedAt,
          lastAttemptAt: attemptedAt,
          retryAt: 0,
        };
      } finally {
        // 同样覆盖 json()，避免单飞卡在只返回响应头的连接上。
        clearTimeout(timer);
        clearTimeout(timeoutTimer);
      }
    } catch {
      return {
        available: null,
        lastAttemptAt: attemptedAt,
        retryAt: attemptedAt + DYNAMIC_MODEL_ENDPOINT_RETRY_MS,
      };
    }
  })();
  dynamicEndpointRefreshFlights.set(id, flight);
  try {
    return await flight;
  } finally {
    if (dynamicEndpointRefreshFlights.get(id) === flight) dynamicEndpointRefreshFlights.delete(id);
  }
}

async function refreshEndpointAvailability(models, previous = dynamicModelAvailability) {
  const next = new Map(previous);
  const ids = new Set((Array.isArray(models) ? models : []).map((model) => model?.id));
  for (const modelId of ENDPOINT_CHECK_MODEL_IDS) {
    if (!ids.has(modelId)) continue;
    const prior = next.get(modelId);
    const result = await probeEndpointAvailability(modelId);
    if (typeof result?.available === "boolean") {
      next.set(modelId, result);
    } else {
      // 瞬时失败沿用调用方自己的明确状态，但安排短重试；冷启动未知状态继续 fail closed。
      next.set(modelId, {
        ...(prior || { available: null, checkedAt: 0 }),
        lastAttemptAt: result.lastAttemptAt,
        retryAt: result.retryAt,
      });
    }
  }
  return next;
}

function modelIsAvailable(modelId, availability = dynamicModelAvailability) {
  const id = String(modelId || "");
  const state = availability?.get(id);
  // 只有列入 endpoint 检查的模型需要显式确认；首次检查失败时不能把“未知”
  // 当成可用。普通模型不依赖 OpenRouter 状态，仍默认放行。
  return state ? state.available === true : !ENDPOINT_CHECK_MODEL_IDS.has(id);
}

function endpointAvailabilityNeedsRetry(modelId, now = Date.now()) {
  const id = String(modelId || "");
  if (!ENDPOINT_CHECK_MODEL_IDS.has(id)) return false;
  // 冷启动需要先拉目录；已发布目录里没有这个模型时按正常 6 小时 TTL 等待。
  if (!Array.isArray(dynamicModelsCache.models)) return true;
  if (!dynamicModelsCache.models.some((model) => model?.id === id)) return false;
  const state = dynamicModelAvailability.get(id);
  if (Number.isFinite(Number(state?.retryAt)) && Number(state.retryAt) > 0) {
    return now >= Number(state.retryAt);
  }
  if (typeof state?.available === "boolean") return false;
  const checkedAt = Number(state?.checkedAt) || 0;
  return now - checkedAt >= DYNAMIC_MODEL_ENDPOINT_RETRY_MS;
}

async function refreshEndpointModelAvailability(modelId) {
  const id = String(modelId || "");
  if (!ENDPOINT_CHECK_MODEL_IDS.has(id)) return dynamicModelsSnapshot();
  const cacheAtStart = dynamicModelsCache;
  const model = Array.isArray(cacheAtStart.models)
    ? cacheAtStart.models.find((entry) => entry?.id === id)
    : null;
  if (!model) return dynamicModelsSnapshot();
  const next = await refreshEndpointAvailability([model], dynamicModelAvailability);
  // 若目录刷新已发布新快照，旧 probe 不能把新 generation 的状态覆盖掉。
  if (dynamicModelsCache === cacheAtStart) dynamicModelAvailability = next;
  return dynamicModelsSnapshot(false, "endpoint");
}

function dynamicModelsSnapshot(refreshed = false, source = "cache") {
  return {
    cache: dynamicModelsCache,
    availability: dynamicModelAvailability,
    refreshed,
    source,
  };
}

async function performDynamicModelsRefresh() {
  let nextCache = dynamicModelsCache;
  let refreshed = false;
  let source = "cache";
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
      nextCache = release;
      refreshed = true;
      source = "release";
    }
  } else try {
    // 合并常量表：models.ts 优先（完整），stableIds.ts 补充 deepseek/m3
    const modelIdConstants = { ...parseModelIdConstants(stableIdsSrc || ""), ...parseModelIdConstants(modelsSrc) };
    const agentMappings = parseAgentMappings(agentsSrc, modelIdConstants);
    if (Object.keys(agentMappings.root).length === 0) {
      // 解析失败：尝试 Releases 兜底
      const release = await tryReleaseFallback();
      if (release) {
        nextCache = release;
        refreshed = true;
        source = "release";
      }
    } else {
      const pools = parseModelPools(modelsSrc, modelIdConstants);
      const pool = {
        premium: new Set(pools.premium),
        standard: null,
        glm: new Set(pools.glm),
        perModelCaps: pools.perModelCaps || {},
        paused: new Set(pools.paused || []),
      };
      nextCache = {
        fetchedAt: Date.now(),
        models: annotateDynamicModelPools(buildDynamicModelTable(agentMappings), pool),
        pool,
      };
      refreshed = true;
      source = "official";
    }
  } catch {
    // 解析崩溃：尝试 Releases 兜底
    const release = await tryReleaseFallback();
    if (release) {
      nextCache = release;
      refreshed = true;
      source = "release";
    }
    // 保留旧缓存
  }

  // 目录源全失败时必须完整保留旧快照，不能只更新 availability 后却宣称
  // “使用缓存”。下一次成功拿到目录时再一起更新两份状态。
  if (!refreshed) return dynamicModelsSnapshot();

  // 先完成 endpoint 检查，再在同一 tick 发布两份状态。并发请求不会看到
  // “新目录 + 旧/未知 availability” 的半成品。
  const nextAvailability = await refreshEndpointAvailability(nextCache.models, dynamicModelAvailability);
  dynamicModelAvailability = nextAvailability;
  dynamicModelsCache = nextCache;
  return dynamicModelsSnapshot(refreshed, source);
}

async function refreshDynamicModelsIfStale(force = false) {
  // 强刷调用等待同一轮；普通目录请求继续读取已发布的旧快照，避免公开源
  // 抖动时把所有模型列表/静态模型调用一起阻塞数十秒。
  if (dynamicModelsRefreshFlight) {
    // 冷启动还没有可发布快照时不能回硬编码残缺目录；等待首轮刷新。已有旧
    // 快照时则立即返回 cache + availability 的同版本组合。
    if (force || !Array.isArray(dynamicModelsCache.models)) return dynamicModelsRefreshFlight;
    return dynamicModelsSnapshot();
  }
  const now = Date.now();
  if (!force && dynamicModelsCache.models && now - dynamicModelsCache.fetchedAt < DYNAMIC_MODELS_REFRESH_MS) {
    return dynamicModelsSnapshot();
  }
  const flight = performDynamicModelsRefresh();
  dynamicModelsRefreshFlight = flight;
  try {
    return await flight;
  } finally {
    if (dynamicModelsRefreshFlight === flight) dynamicModelsRefreshFlight = null;
  }
}

// Releases JSON 兜底：直接拉预生成的 models.json，零解析成本
async function tryReleaseFallback() {
  for (const url of DYNAMIC_MODELS_RELEASE_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      let timeoutReject;
      const timeout = new Promise((_, reject) => {
        timeoutReject = reject;
      });
      const timeoutError = () => {
        ctrl.abort();
        timeoutReject(new Error("release model source timeout"));
      };
      const timeoutTimer = setTimeout(timeoutError, DYNAMIC_MODELS_FETCH_TIMEOUT_MS);
      try {
        const resp = await Promise.race([fetch(url, { signal: ctrl.signal }), timeout]);
        if (resp.ok) {
          const json = await Promise.race([resp.json(), timeout]);
          if (json && Array.isArray(json.models) && json.models.length > 0) {
            const pool = {
              premium: new Set(json.pools?.premium ?? []),
              standard: null,
              glm: new Set(json.pools?.glm ?? []),
              perModelCaps: json.upstream?.perModelCaps && typeof json.upstream.perModelCaps === "object"
                ? json.upstream.perModelCaps : {},
              paused: new Set(Array.isArray(json.upstream?.paused) ? json.upstream.paused : []),
            };
            return {
              fetchedAt: Date.now(),
              models: annotateDynamicModelPools(json.models, pool),
              pool,
            };
          }
        }
      } finally {
        clearTimeout(timer);
        clearTimeout(timeoutTimer);
      }
    } catch {}
  }
  return null;
}

// 动态 STANDARD = 动态表里不在 premium/glm 池的模型
function dynamicStandardModels(cache = dynamicModelsCache) {
  if (!cache || !cache.models || !cache.pool) return new Set();
  const premium = cache.pool.premium;
  const glm = cache.pool.glm;
  return new Set(cache.models.map((m) => m.id).filter((id) => !premium.has(id) && !glm.has(id)));
}

const KNOWN_QUOTA_POOLS = new Set([
  "premium", "luna", "deepseek_pro", "glm", "glm_v53_flash", "standard",
]);

function normalizePoolName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  return KNOWN_QUOTA_POOLS.has(raw) ? raw : "";
}

function safePoolName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw) ? raw : "";
}

function quotaRowForModel(quota, modelId) {
  if (!quota || typeof quota !== "object") return null;
  const exact = quota[modelId];
  if (exact && typeof exact === "object") return exact;
  const wanted = String(modelId || "").toLowerCase();
  const hit = Object.entries(quota).find(([id, entry]) =>
    String(id).toLowerCase() === wanted && entry && typeof entry === "object");
  return hit ? hit[1] : null;
}

function dynamicModelForId(modelId, cache = dynamicModelsCache) {
  const id = String(modelId || "");
  return Array.isArray(cache?.models)
    ? cache.models.find((model) => model?.id === id) || null
    : null;
}

// 模型池分类查询：实时账号快照 > 动态模型元数据 > 动态池集合 > 静态兜底。
// 未知 pool 返回 null，调用层按模型隔离，不能猜测为共享池。
function modelPoolCategory(modelId, quota = null, cache = dynamicModelsCache) {
  const id = String(modelId || "").trim();
  if (!id || isPausedModelId(id, cache) || isHiddenModelId(id)) return null;

  const quotaRow = quotaRowForModel(quota, id);
  if (quotaRow && String(quotaRow.pool || "").trim()) {
    const pool = normalizePoolName(quotaRow.pool);
    return KNOWN_QUOTA_POOLS.has(pool) ? pool : null;
  }

  const dynamic = dynamicModelForId(id, cache);
  if (dynamic && String(dynamic.pool || "").trim()) {
    const pool = normalizePoolName(dynamic.pool);
    return KNOWN_QUOTA_POOLS.has(pool) ? pool : null;
  }

  const dyn = cache;
  if (dyn && dyn.pool) {
    if (dyn.pool.premium?.has(id)) return "premium";
    if (dyn.pool.glm?.has(id)) return "glm";
    if (dynamicStandardModels(cache).has(id)) return "standard";
  }
  // 静态兼容兜底只在没有实时/动态 pool 时使用。
  if (GLM_V53_FLASH_QUOTA_MODELS.has(id)) return "glm_v53_flash";
  if (PREMIUM_QUOTA_MODELS.has(id)) return "premium";
  if (STANDARD_MODELS.has(id)) return "standard";
  if (GLM_QUOTA_MODELS.has(id)) return "glm";
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

// /v1/models 的分组键，数组顺序 = 面板「模型列表」的展示顺序（组内保持模型表原序）：
//   free    免费号实测能建会话的两个（= FREE_AVAILABLE_MODELS）
//   us_sg   要 full accessTier（美/新出口 IP）才能建会话的 premium 模型
//   limited 额度池独立、要 referral / 白名单解锁的模型（glm-5.2 独立池、fable-5 白名单）
// 未列入的模型不带 tag、排在最后。这里只给分组键，标签文案和配色由 web/app.js 决定
// —— 别把中文文案塞进 /v1/models，那是给客户端读的协议字段。
const MODEL_TIERS = [
  ["free", FREE_AVAILABLE_MODELS],
  ["us_sg", new Set([
    "meta/muse-spark-1.2-contributor",
  ])],
  ["limited", new Set([
    "z-ai/glm-5.2",
    "z-ai/glm-5.3-flash",
    "anthropic/claude-fable-5",
  ])],
];

// Luna 跟随共享 Premium 归入 US/SG；GLM 5.3 Flash 虽也是 Premium 成员，
// 但独立 cap 在目录/面板中优先显示为限定 GLM 池。
const POOL_DRIVEN_TIER_MODELS = new Set([
  "openai/gpt-5.6-luna",
]);
// luna 是 premium 的旧兼容池名（见下方额度池说明），上游偶尔还会在旧快照里回它。
// 不折算的话 luna 拿到 pool='luna' 就两头落空：不等于 "premium" 拿不到 us_sg，
// 又不在 MODEL_TIERS 里 → tier=null，目录上直接掉标签。面板侧 normalizeQuotaPool
// 已经做了同样的折算。
const LEGACY_POOL_ALIASES = { luna: "premium" };
function modelCatalogTier(modelId, pool) {
  const id = String(modelId || "");
  const raw = String(pool || "").trim().toLowerCase();
  const normalizedPool = LEGACY_POOL_ALIASES[raw] || raw;
  if (POOL_DRIVEN_TIER_MODELS.has(id) && normalizedPool === "premium") return "us_sg";
  const rank = MODEL_TIERS.findIndex(([, ids]) => ids.has(id));
  return rank >= 0 ? MODEL_TIERS[rank][0] : null;
}

// ---------------------------------------------------------------------------
// 额度池说明（上游 rateLimitsByModel）：
//   同一模型的 pool 会随上游 entitlement/rollout 变化；账号实时快照优先。
//   premium / glm / glm_v53_flash 是当前有效池；deepseek_pro / luna 仅保留为
//   旧快照兼容池名，不能作为当前静态归属。
//   glm：GLM referral 独立池
// M3 虽曾出现在旧 Premium 快照里，但已于 2026-08-20 暂停，不得再据旧表
// 认定为当前可运行额度池。额度只用于本地调度/错误作用域，不改变调用方模型。
// ---------------------------------------------------------------------------
const PAUSED_QUOTA_MODELS = new Set([
  "minimax/minimax-m3",
  // 官方 2026-08-26 已从免费目录和所有额度池撤下；仅保留 wire id 供旧客户端
  // 被上游识别/替换。代理不能继续把兼容 ID 暴露成可调用模型。
  "deepseek/deepseek-v4-pro",
  "stealth/ox-alpha",
]);
function isPausedModelId(modelId, cache = dynamicModelsCache) {
  const value = String(modelId || "").trim().toLowerCase();
  if (!value) return false;
  const paused = new Set(PAUSED_QUOTA_MODELS);
  const dynamicPaused = cache?.pool?.paused;
  if (dynamicPaused && typeof dynamicPaused[Symbol.iterator] === "function") {
    for (const id of dynamicPaused) {
      const normalized = String(id || "").trim().toLowerCase();
      if (normalized) paused.add(normalized);
    }
  }
  for (const base of paused) {
    const normalizedBase = String(base || "").trim().toLowerCase();
    if (!normalizedBase) continue;
    if (value === normalizedBase) return true;
    if (!value.startsWith(normalizedBase + "-")) continue;
    const suffix = value.slice(normalizedBase.length + 1);
    if (/^\d{6,8}(?:$|[-:])/.test(suffix)) return true;
  }
  return false;
}
// God-only / 服务专用模型。普通 token 一定调不通，动态源即使返回也必须 fail closed。
// stealth/ox-alpha 曾在此列（当时官方 FREEBUFF_SERVICE_ONLY_MODEL_IDS 非空）；2026-08-24
// 官方把它放进了 CLI/Desktop 目录并清空该名单（d534205ad39d），隐藏前提失效，已开放。
const HIDDEN_MODEL_IDS = new Set([
  // Official Web God-only Novita/Codex test route; it is not the public Luna model.
  "openai/gpt-5.6-luna-es",
  // 同在官方 FREEBUFF_WEB_GOD_ONLY_MODELS 里（0766319c）：god 账号专属的 Web/Cloud
  // 路由，且**不在 CLI 目录 FREEBUFF_MODELS 里**，普通 token 一定调不通。
  // 旧 08-16 观测里它曾经能调通，之后被划成 god-only —— 按 fail closed 处理。
  "crof/kimi-k3-eco",
]);
function isHiddenModelId(modelId) {
  const value = String(modelId || "").trim().toLowerCase();
  return HIDDEN_MODEL_IDS.has(value)
    || value.startsWith("openai/gpt-5.6-luna-es")
    // 官方模型判定都是 suffix/前缀容错的，免得带日期的 provider 快照绕过分类。
    || value.startsWith("crof/kimi-k3-eco");
}
const PREMIUM_QUOTA_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "openai/gpt-5.6-luna",
  "z-ai/glm-5.3-flash",
  "meta/muse-spark-1.2-contributor",
]);
const STANDARD_MODELS = new Set([
  "mimo/mimo-v2.5",
]);
const GLM_QUOTA_MODELS = new Set([
  "z-ai/glm-5.2",
]);
const GLM_V53_FLASH_QUOTA_MODELS = new Set([
  "z-ai/glm-5.3-flash",
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
  // 概况统计持久化适配器（server.js 启动时注入）。
  configureUsagePersistence,
  restoreUsageSnapshot,
  restoreKeyUsageSnapshot,
  usageSnapshot,
  // Node 服务启动时只配置一次。避免并发请求各自携带的 env 函数互相覆盖
  // 模块级出站状态；Cloudflare Worker 不调用此入口，仍使用每请求 env。
  configureUpstreamRouting({ getUpstreamFetch, resolveAccountFetch, isAccountRouteReady, onReject } = {}) {
    configuredUpstreamFetch = typeof getUpstreamFetch === "function" ? getUpstreamFetch : null;
    upstreamFetchForAccount = typeof resolveAccountFetch === "function" ? resolveAccountFetch : null;
    accountRouteReady = typeof isAccountRouteReady === "function" ? isAccountRouteReady : null;
    onEgressReject = typeof onReject === "function" ? onReject : null;
    upstreamRoutingConfigured = true;
  },
  // 只用于服务端迁移尚未发布版本写过的旧 FNV 快照；新分享 Key 使用服务端 SHA-256 指纹。
  keyFingerprint(token) { return stableFingerprint(String(token || "")); },
  async fetch(request, env) {
    // 上游出站 fetch 注入（Node adapter 配了订阅时传入走 mihomo 的 fetch）。
    // env 可放函数（Node 的 env 是普通对象）；Cloudflare Worker 的 env 是 KV 型
    // 对象拿不到函数，保持默认全局 fetch 直连。
    if (!upstreamRoutingConfigured) {
      upstreamFetch = env && typeof env.FREEBUFF_UPSTREAM_FETCH === "function"
        ? env.FREEBUFF_UPSTREAM_FETCH : defaultUpstreamFetch;
      upstreamFetchForAccount = env && typeof env.FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT === "function"
        ? env.FREEBUFF_UPSTREAM_FETCH_FOR_ACCOUNT : null;
      // 出站 IP 被上游拒绝时的回调（同上，只有 Node adapter 能注入函数）。
      onEgressReject = env && typeof env.FREEBUFF_ON_EGRESS_REJECT === "function"
        ? env.FREEBUFF_ON_EGRESS_REJECT : null;
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

    // client = 这把 key 的身份与限额（主 Key 全不限）。往下一路传，闸门与归账都看它。
    const client = resolveClient(request, env);
    if (!client) {
      if (url.pathname === "/v1/messages" || url.pathname === "/messages" || url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens") {
        return anthropicError("Invalid API key", "authentication_error", 401);
      }
      return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
    }

    // 按 env 重建自定义模型别名表（本地解析，无网络/session 开销）
    currentAliases = parseModelAliases(env.MODEL_ALIASES);

    cleanCache();

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const forceRefresh = client.owner === true && url.searchParams.get("refresh") === "1";
      return await handleModels(client, { forceRefresh });
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env, client);
    }
    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return handleResponses(request, env, client);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
      return handleAnthropicCountTokens(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return handleAnthropicMessages(request, env, client);
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

function accountRouteSelectable(token) {
  return !accountRouteReady || accountRouteReady(token) !== false;
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
const accountLeaseWaiters = new Set(); // 任意账号租约变化时广播，等待者醒来后重新扫描
// 等待原账号释放租约的上限。默认远大于一次普通请求，让同一对话尽量钉在同一个
// 号上：换号=在新账号上再建一个 session，而免费额度按账号计（每天个位数）。
// ponytail: 这个上限只是租约泄漏的兜底，不是调度策略。客户端断开会立即结束等待；
// 想彻底禁止回退就把 FREEBUFF_SESSION_WAIT_MS 设成一个足够大的值。
const ACTIVE_SESSION_LEASE_WAIT_MS = 120 * 1000;
// 上游抖动（session/run 5xx、超时）不是账号自身的问题，换号只会白扣一份新账号的
// 创建额度，所以先重试同一个号；用尽后才换号，保留跨账号故障转移。
const SAME_ACCOUNT_TRANSIENT_RETRIES = 1;
// 单个客户端请求内最多换几个账号。每换一个号都要 createSession，而建会话就是扣
// admission 的动作 —— 旧上界是 pool.length（18），一条失败请求能连开 18 个会话，
// 上游会把这种「秒级跨账号会话爆发」判成滥用并一次封一串（实测 2026-08-24 的
// 07:02Z / 08:45:59Z / 08:46:10Z 三笔封禁，后两笔相隔 11 秒）。
// 只统计「换到一个新号并建会话」：同号原地重试（retakeToken）和同号会话重建都不算，
// 它们复用已有会话，不烧 admission。
// ponytail: 固定小上限，不是自适应策略。代价是上游整片抖动时成功率不如试满全池；
// 不够用就调大 FREEBUFF_MAX_ACCOUNT_SWITCHES。
const MAX_ACCOUNT_SWITCHES = 2;
// 换号之间的随机间隔：抹掉「N 秒内多个账号连续建会话」这个时间特征。只在真正
// 换号时等，同号重试不等 —— 同号重试不产生新会话，没有需要打散的特征。
const ACCOUNT_SWITCH_JITTER_MIN_MS = 800;
const ACCOUNT_SWITCH_JITTER_MAX_MS = 2500;

function maxAccountSwitches(env) {
  // 空串陷阱同 sessionLeaseWaitMs：docker-compose 里写 `FREEBUFF_MAX_ACCOUNT_SWITCHES=`
  // 会传进来空串，而 Number("") 是 0 —— 那会静默变成「一个号都不许换」。
  const raw = String((env && env.FREEBUFF_MAX_ACCOUNT_SWITCHES) ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 1 ? n : MAX_ACCOUNT_SWITCHES;
}

function accountSwitchJitterMs(env) {
  // 固定值覆盖：给测试一个确定的间隔，也给运维一个按上游脾气调节的旋钮。
  // 空串同样要当"没设"处理，否则 Number("")===0 会静默关掉抖动。
  const raw = String((env && env.FREEBUFF_ACCOUNT_SWITCH_JITTER_MS) ?? "").trim();
  const fixed = Number(raw);
  if (raw !== "" && Number.isFinite(fixed) && fixed >= 0) return fixed;
  const span = ACCOUNT_SWITCH_JITTER_MAX_MS - ACCOUNT_SWITCH_JITTER_MIN_MS;
  return ACCOUNT_SWITCH_JITTER_MIN_MS + Math.floor(Math.random() * (span + 1));
}
// 上游 waiting room：createSession 拿到 queued 后轮询 8x1.5s 仍未 active 就抛
// WaitingRoomError。排队不是这个号的错，所以刻意不写冷却、不摘号（见两处循环里的
// `!(e instanceof WaitingRoomError)`）。但 acctHealth 里的 waiting_room_required 也
// 没有失效时间，只能等下一次真实请求撞上才被覆盖 —— 低流量时段（实测 2026-08-25
// 03:17 北京时间）那份旧观测会一直挂着，配合换号预算 2，轮询前两位撞上就必然 503。
//
// 处置分两层，都不摘号：
//   ① 新鲜的排队观测在 pickToken 里降权到候选末尾（本窗口内），过期即视同未知；
//   ② 因排队而换号时给一份独立预算，不占 MAX_ACCOUNT_SWITCHES。
// ponytail: 固定窗口 + 固定额度，不是自适应退避。上游长队时仍会 503，只是不再
// 因为一份几小时前的旧状态而失败；不够用就调这两个环境变量。
const WAITING_ROOM_DEPRIORITIZE_MS = 60 * 1000;
// 实测 2026-08-26：排队是模型后端级的（同一秒 luna 200 而 ox 503），但波次里并非
// 全池同挡——多试几个空闲号常能捡到没被排队的。2 → 4；仍受重试链 45s 总预算约束，
// 不会吊到客户端超时。
const MAX_WAITING_ROOM_SWITCHES = 4;

function waitingRoomDeprioritizeMs(env) {
  // 空串陷阱同 maxAccountSwitches：`FREEBUFF_WAITING_ROOM_DEPRIORITIZE_MS=` 传进来是
  // 空串，Number("") 是 0 —— 那会静默关掉降权。0 是合法的显式关闭，空串不是。
  const raw = String((env && env.FREEBUFF_WAITING_ROOM_DEPRIORITIZE_MS) ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : WAITING_ROOM_DEPRIORITIZE_MS;
}

function maxWaitingRoomSwitches(env) {
  const raw = String((env && env.FREEBUFF_MAX_WAITING_ROOM_SWITCHES) ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 0 ? n : MAX_WAITING_ROOM_SWITCHES;
}

// 单请求重试链的时间总预算。实测 2026-08-25 20:38 北京时间：整池排队时重试链烧了
// 74.7s 一无所获，而客户端（CC GUI）首字超时约 75s —— 差 1s 被 499 掐断，客户端
// 既没拿到错误也没拿到 Retry-After。预算到顶就不再起新号的尝试，让循环后的兜底
// 分支回干净的 503 waiting_room（带 Retry-After）—— 早失败早重试比吊到超时强。
// 只约束「再起一个新号的尝试」：正在跑的尝试不拦，第一个号永远试。
// 0 是合法值 = 只试第一个号。空串陷阱同 maxAccountSwitches。
const RETRY_CHAIN_BUDGET_MS = 45 * 1000;

function retryChainBudgetMs(env) {
  const raw = String((env && env.FREEBUFF_RETRY_CHAIN_BUDGET_MS) ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : RETRY_CHAIN_BUDGET_MS;
}

// 这个号刚刚被上游放进 waiting room 吗？只看新鲜观测：过期的旧状态不该继续压它。
function recentlyWaitingRoom(token, env, now = Date.now()) {
  const windowMs = waitingRoomDeprioritizeMs(env);
  if (!(windowMs > 0)) return false;
  const info = acctHealth.get(token);
  if (!info) return false;
  if (info.state !== "waiting_room_queued" && info.state !== "waiting_room_required") return false;
  const checkedAt = Number(info.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return now - checkedAt < windowMs;
}
const TERMINAL_ACCOUNT_STATES = new Set(["banned", "token_invalid", "manual_disabled"]);
let accountStateSet = null;
let accountStateClear = null;
let accountStateGet = null;

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
  accountStateGet = env && typeof env.FREEBUFF_ACCOUNT_STATE_GET === "function"
    ? env.FREEBUFF_ACCOUNT_STATE_GET : null;
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
      durableAccountStates.set(token, {
        ...record,
        until: TERMINAL_ACCOUNT_STATES.has(record.state) ? null : record.until,
      });
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

function durableAccountState(token) {
  // 管理探测可能在当前业务请求执行期间更新持久状态；发送 Bearer 前读取
  // 最新值。当前请求刚写入的 dirty 状态优先，避免失败写盘时被旧值覆盖。
  if (token && accountStateGet && !dirtyAccountStates.has(token)) {
    try {
      const live = accountStateGet(token);
      if (live && typeof live === "object" && live.state) {
        durableAccountStates.set(token, {
          ...live,
          until: TERMINAL_ACCOUNT_STATES.has(live.state) ? null : live.until,
        });
      } else {
        durableAccountStates.delete(token);
      }
    } catch {}
  }
  return durableAccountStates.get(token) || null;
}

function setDurableAccountState(token, record) {
  if (!token || !record || !record.state) return;
  const state = String(record.state);
  const normalized = {
    state,
    until: TERMINAL_ACCOUNT_STATES.has(state) || record.until == null ? null : Number(record.until),
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
  return Boolean(record && TERMINAL_ACCOUNT_STATES.has(record.state));
}

function acquireToken(token) {
  if (!token || accountLeases.get(token)) return false;
  accountLeases.set(token, 1);
  return true;
}

function releaseToken(token) {
  if (!token) return;
  accountLeases.delete(token);
  const waiters = [...accountLeaseWaiters];
  accountLeaseWaiters.clear();
  for (const wake of waiters) wake();
}

function tokenBusy(token) {
  return accountLeases.get(token) === 1;
}

function waitForAnyTokenRelease(tokens, waitMs = ACTIVE_SESSION_LEASE_WAIT_MS, signal = null) {
  const watched = [...new Set(tokens)].filter((token) => tokenBusy(token));
  if (!watched.length || !(waitMs > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      accountLeaseWaiters.delete(finish);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
    accountLeaseWaiters.add(finish);
    timer = setTimeout(() => finish(), waitMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (watched.some((token) => !tokenBusy(token))) finish();
  });
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

const acctHealth = new Map(); // token -> { alive, state, uid, quota, checkedAt, quotaUntil }
const HEALTH_OBSERVATION_TTL_MS = 10 * 60 * 1000;

// 只记录真实业务请求已经观察到的上游结果。不要在 healthz 中主动探测，
// 也不要把网络错误/未知响应误记成账号失效。
function recordAccountObservation(token, status, dataOrText, extra = {}) {
  if (!token) return;
  const previous = acctHealth.get(token) || {};
  let data = dataOrText;
  if (typeof dataOrText === "string") {
    try { data = JSON.parse(dataOrText); } catch { data = null; }
  }
  const upstreamState = findStructuredState(data);
  const rateLimit = (status === 429 || [
    "rate_limited", "rate_limit_exceeded", "quota_exceeded", "spend_limited",
    "ip_capped", "country_blocked", "waiting_room_queued", "waiting_room_required",
  ].includes(upstreamState))
    ? classifyRateLimit(dataOrText, status, extra.headers || {}, extra.model || null,
      Date.now(), extra.quota || previous.quota || null)
    : null;
  let state = null;
  if (status === 404) state = "ok";
  else if (["banned", "country_blocked", "rate_limited", "model_locked", "ip_capped", "spend_limited", "waiting_room_queued", "waiting_room_required"].includes(upstreamState)) state = upstreamState;
  else if (status >= 200 && status < 300) state = "ok";
  // 业务 endpoint 的单次 401 可能只是 session/路由瞬时拒绝；只有独立
  // session 探测再次确认 401 时，才把凭据记为 token_invalid 终态。
  else if (status === 401) state = extra.confirmedState === "token_invalid" ? "token_invalid" : "auth_rejected";
  else if (status === 403) {
    state = upstreamState === "banned"
      ? "banned"
      : upstreamState === "country_blocked" ? "country_blocked" : "blocked";
  } else if (status === 429) state = rateLimit?.state || "rate_limited";
  if (!state) return;

  // country_blocked / ip_capped 是冲着出站 IP 来的，换账号没用、换节点才有用；
  // 另外「403 且响应体压根没给 status」是 Cloudflare/WAF 那种不解释的拦截，同样归到 IP。
  // 反过来，403 只要报了名字（free_mode_cli_required、free_mode_invalid_agent_model、banned…）
  // 那就是账号/模式的问题，不能记到节点头上——否则面板会拿模型报错去冤枉节点。
  const ipLevel = state === "country_blocked" || state === "ip_capped"
    || (state === "blocked" && !upstreamState);
  if (onEgressReject && ipLevel) {
    const egress = extra.headers ? upstreamEgressByHeaders.get(extra.headers) : null;
    try { onEgressReject({ token, state, status, ...(egress || {}) }); } catch {}
  }

  // 只有账号级的明确结果才进入持久隔离；出口节点级拒绝继续交给代理层处理。
  if (state === "banned") {
    setDurableAccountState(token, {
      state: "banned",
      until: null,
      reason: "upstream_banned",
    });
  } else if (state === "token_invalid") {
    setDurableAccountState(token, {
      state: "token_invalid",
      until: null,
      reason: "upstream_auth_rejected",
    });
  }

  const hasQuota = Boolean(extra.quota && typeof extra.quota === "object");
  const hasScopedQuota = Boolean(rateLimit && rateLimit.reason === "quota");
  const observedAt = Date.now();
  const retryAfterMs = hasScopedQuota && Number.isFinite(Number(rateLimit.retryAfterMs))
    ? Math.max(0, Number(rateLimit.retryAfterMs))
    : null;
  acctHealth.set(token, {
    ...previous,
    ...extra,
    alive: state === "ok",
    state,
    uid: extra.uid || previous.uid || null,
    quota: hasQuota ? extra.quota : previous.quota || null,
    quotaCheckedAt: hasQuota ? observedAt : previous.quotaCheckedAt || null,
    quotaScope: hasScopedQuota ? rateLimit.scope : state === "ok" ? null : previous.quotaScope || null,
    quotaModel: hasScopedQuota
      ? (extra.model ? String(extra.model) : null)
      : state === "ok" ? null : previous.quotaModel || null,
    retryAfterMs: hasScopedQuota
      ? retryAfterMs
      : state === "ok" ? null
        : typeof extra.retryAfterMs === "number" ? extra.retryAfterMs : previous.retryAfterMs || null,
    quotaUntil: hasScopedQuota && retryAfterMs != null
      ? observedAt + retryAfterMs
      : state === "ok" ? null : previous.quotaUntil || null,
    checkedAt: observedAt,
  });
}

function summarizeAccountHealth(pool, health) {
  const account_details = pool.map((acct) => {
    const info = health.get(acct.token);
    return {
      alive: info ? info.alive : null,
      state: info?.state || "unknown",
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
let OVERVIEW_START = Date.now();
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
// 按稳定 Key 指纹累计成功请求 token；只存备注名和数值，不把明文 Key 写入快照。
const usageByKey = {}; // { keyFingerprint: { name, owner, totalTokens } }

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

// token → 调度的账号名。env 注入的 token→名字映射优先；无名不泄露 token。
function accountLabel(env, token) {
  if (!token) return "";
  const labels = env && env.FREEBUFF_ACCOUNT_LABELS;
  if (labels && typeof labels === "object") {
    const hit = labels[token];
    if (hit) return String(hit).trim();
  }
  return "未命名账号";
}

// 追加一条调用记录。字段名取短的：整个数组会被整份读写。
function logCall(entry) {
  callLogBuf.push({
    at: Date.now(),
    account: String(entry.account ?? "").trim(),
    // 哪把 key 发的（存备注名，不存明文 key —— 这份数组会整份回给面板）。
    // "" = 加多 key 之前的历史行/无 key 上下文的内部调用。
    key: String(entry.key ?? "").trim(),
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
function recordRequest(model, usage, success, client = null) {
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
  if (success && client && client.key && client.owner !== true && u.totalTokens > 0) {
    const fingerprint = clientKeyFingerprint(client);
    const entry = usageByKey[fingerprint] || {
      name: String(client.name || "").trim(),
      owner: client.owner === true,
      totalTokens: 0,
    };
    entry.name = String(client.name || entry.name).trim();
    entry.owner = client.owner === true;
    entry.totalTokens += u.totalTokens;
    usageByKey[fingerprint] = entry;
  }
  lastRequestAt = Date.now();
  usageSaveHook();
}

// ---------------------------------------------------------------------------
// 概况统计持久化（可选）：server.js 注入 { load, save, enabled } 适配器后，worker
// 在每次 recordRequest 更新内存后通知适配器保存。分享 Key 的 byKey 统计另有 saveKey
// 通道，始终落盘，不受概况开关影响。保存是异步安全的——异常不冒泡到请求处理。
// ---------------------------------------------------------------------------
const usagePersistence = { load: null, save: null, saveKey: null, enabled: null };

function configureUsagePersistence(adapter) {
  if (!adapter || typeof adapter !== "object") return;
  usagePersistence.load = typeof adapter.load === "function" ? adapter.load : null;
  usagePersistence.save = typeof adapter.save === "function" ? adapter.save : null;
  usagePersistence.saveKey = typeof adapter.saveKey === "function" ? adapter.saveKey : null;
  usagePersistence.enabled = typeof adapter.enabled === "function" ? adapter.enabled : null;
}

function usageSaveHook() {
  const save = usagePersistence.save;
  const snapshot = usageSnapshot();
  const fullEnabled = !usagePersistence.enabled || usagePersistence.enabled() === true;
  const persist = save && fullEnabled
    ? () => save(snapshot)
    : usagePersistence.saveKey
      ? () => usagePersistence.saveKey(snapshot.byKey)
      : null;
  if (!persist) return;
  // 立即调用适配器，让它把写入登记到自己的队列；只把异步 I/O 错误转为
  // rejected promise，避免请求被磁盘故障阻断。若延迟到下一个微任务，SIGTERM
  // 期间的 flush 可能在 save 尚未入队时提前返回，丢掉最后一条 Key 统计。
  try {
    Promise.resolve(persist()).catch(() => {
      /* 磁盘写失败不阻断请求处理；内存统计照常累计。 */
    });
  } catch {
    /* 同步适配器错误同样不阻断请求处理。 */
  }
}

function usageSnapshot() {
  const byModel = {};
  for (const k of Object.keys(usageByModel)) byModel[k] = { ...usageByModel[k] };
  const byKey = {};
  for (const k of Object.keys(usageByKey)) byKey[k] = { ...usageByKey[k] };
  // 会话归账（今日 / 累计）跟 token 累计合成同一行落盘：只有 token 会重启清零很奇怪，
  // 面板那两列本来就是并排显示的。daySessions 存的是会话身份指纹，不含账号凭据。
  for (const [fingerprint, row] of clientSessionRows()) {
    if (row.owner) continue;
    const entry = byKey[fingerprint] || { name: row.name, owner: row.owner, totalTokens: 0 };
    entry.name = entry.name || row.name;
    entry.owner = row.owner;
    entry.day = row.day;
    entry.daySessions = row.daySessions;
    if (row.seenSessions?.length) entry.seenSessions = row.seenSessions;
    entry.total = row.total;
    entry.lastAt = row.lastAt;
    byKey[fingerprint] = entry;
  }
  return {
    total: { ...usageTotals },
    byModel,
    byKey,
    startTime: OVERVIEW_START,
    lastRequest: lastRequestAt,
  };
}

// 用启动时加载的持久化快照覆盖内存累计。只认规范化形状，缺字段回退空值；
// 外部传入畸形对象不会破坏内部状态。
function restoreKeyUsageSnapshot(src) {
  for (const k of Object.keys(usageByKey)) delete usageByKey[k];
  restoredClientSessions.clear();
  if (!src || typeof src !== "object" || !src.byKey || typeof src.byKey !== "object") return;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  for (const [fingerprint, v] of Object.entries(src.byKey)) {
    if (!v || typeof v !== "object") continue;
    if (v.owner === true) continue;
    const name = String(v.name ?? "").trim();
    const totalTokens = num(v.totalTokens);
    if (!name || totalTokens < 0) continue;
    usageByKey[fingerprint] = {
      name,
      owner: v.owner === true,
      totalTokens,
    };
    // 会话归账：明文 key 要等请求带来才知道，先按指纹搁着（见 restoredClientSessions）。
    const day = String(v.day ?? "").trim();
    const total = num(v.total);
    if (!day && total <= 0) continue;
    const seenIds = new Set();
    const seenSessions = Array.isArray(v.seenSessions)
      ? v.seenSessions.flatMap((raw) => {
        const id = typeof raw === "string" ? raw : String(raw?.id ?? "");
        if (!id || seenIds.has(id)) return [];
        seenIds.add(id);
        const expiresAt = raw && typeof raw === "object" && Number.isFinite(Number(raw.expiresAt))
          ? Number(raw.expiresAt) : null;
        return [{ id, expiresAt }];
      })
      : [];
    restoredClientSessions.set(fingerprint, {
      name,
      owner: v.owner === true,
      day,
      daySessions: Array.isArray(v.daySessions)
        ? v.daySessions.filter((id) => typeof id === "string" && id)
        : [],
      seenSessions,
      total,
      lastAt: Number.isFinite(Number(v.lastAt)) && v.lastAt !== null ? num(v.lastAt) : null,
    });
  }
}

function restoreUsageSnapshot(src) {
  if (!src || typeof src !== "object") return;
  const t = src.total && typeof src.total === "object" ? src.total : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const keys = ["requests", "success", "fail", "promptTokens", "completionTokens", "reasoningTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"];
  for (const k of keys) usageTotals[k] = num(t[k]);
  for (const k of Object.keys(usageByModel)) delete usageByModel[k];
  if (src.byModel && typeof src.byModel === "object") {
    for (const [model, v] of Object.entries(src.byModel)) {
      if (!v || typeof v !== "object") continue;
      const b = blankUsageTotals();
      for (const k of keys) b[k] = num(v[k]);
      usageByModel[model] = b;
    }
  }
  restoreKeyUsageSnapshot(src);
  if (Number.isFinite(Number(src.startTime))) OVERVIEW_START = num(src.startTime);
  lastRequestAt = Number.isFinite(Number(src.lastRequest)) ? num(src.lastRequest) : null;
}

// 记录一次成功调用。firstTokenAt 为空（非流式）时首字记 null。
function recordChatCall(env, token, mc, effort, t0, firstTokenAt, usage, client = null) {
  const u = readCallUsage(usage);
  logCall({
    account: accountLabel(env, token),
    key: client && client.name ? client.name : "",
    model: mc && mc.id ? mc.id : "",
    effort,
    ttfb: firstTokenAt ? firstTokenAt - t0 : null,
    ms: Date.now() - t0,
    in: u ? u.in : 0,
    out: u ? u.out : 0,
    reasoning: u ? u.reasoning : 0,
  });
  // 成功调用 == 该客户端请求的成功终态，顺带记入概况累计（每次成功恰好一条）。
  recordRequest(mc && mc.id ? mc.id : "", usage, true, client);
}

// ---------------------------------------------------------------------------
// 客户端 key 闸门与归账（多 key）。
// 每把共享 key 各自限：可用模型白名单、并发请求数（默认 1）、每日 session 数。
// 主 Key 三项全不限，走同一条代码路径。
//
// 归账口径：每把 Key 当天实际使用的不同上游 session。命中同一个一小时 session 的
// 多次请求只算一次；换账号、换模型或强制重建得到新 instanceId 时再算一次。
// ---------------------------------------------------------------------------
const clientStats = new Map(); // key(明文，只在进程内) -> 并发槽位 + session 归账
// 启动时从持久化快照恢复的会话归账，按指纹索引：明文 key 要等请求带着它来才知道，
// 所以先搁在这里，clientStat() 第一次见到这把 key 时灌进去（灌完就从这里移走）。
// 没被本进程用过的 key 也要出现在面板里，所以快照会一并读这份。
const restoredClientSessions = new Map(); // fingerprint -> { name, owner, day, daySessions[], total, lastAt }
// 槽位兜底回收窗口：任何一条释放路径漏了，槽位也不会把 key 永久卡死。
// ponytail: 这是泄漏兜底，不是超时策略 —— 正常释放走 finally / 流 flush-cancel。
// 真有超过这个时长的长流，它占的槽位会被下一个请求提前回收，最坏情况是并发短暂超 1。
const CLIENT_SLOT_STALE_MS = 30 * 60 * 1000;

// 上游额度按 America/Los_Angeles 日历日重置（见 MODELS.md 的额度池说明），每日上限
// 跟着同一个边界翻页，否则「今日」在我们这边翻了、上游没翻，等于白送一轮预算。
function quotaDay(now = Date.now()) {
  try {
    return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  } catch {
    return new Date(now).toISOString().slice(0, 10); // 没有完整 ICU 的运行时回落 UTC 日
  }
}

function clientStat(client, now = Date.now()) {
  const id = client.key;
  let st = clientStats.get(id);
  if (!st) {
    st = {
      key: id, fingerprint: clientKeyFingerprint(client), name: client.name,
      owner: client.owner === true, live: [], day: quotaDay(now),
      daySessions: new Set(), seenSessions: new Map(), pendingSessions: new Set(),
      dayCount: 0, total: 0, lastAt: null,
    };
    clientStats.set(id, st);
    hydrateClientStat(st, now);
  }
  if (!(st.daySessions instanceof Set)) st.daySessions = new Set();
  if (!(st.seenSessions instanceof Map)) st.seenSessions = new Map();
  if (!(st.pendingSessions instanceof Set)) st.pendingSessions = new Set();
  st.name = client.name;              // 面板改了备注名，历史归账跟着改名，不另起一行
  const today = quotaDay(now);
  if (st.day !== today) {
    st.day = today;
    st.daySessions.clear();
    st.pendingSessions.clear();
    st.dayCount = 0;
  }
  for (const [identity, expiresAt] of st.seenSessions) {
    if (Number.isFinite(expiresAt) && expiresAt <= now) st.seenSessions.delete(identity);
  }
  // 兜底回收：只在这里做，不额外挂定时器
  if (st.live.length) st.live = st.live.filter((at) => now - at < CLIENT_SLOT_STALE_MS);
  return st;
}

// 用持久化快照里的会话归账填一把新 key 的进程内状态。日期不是今天就只补累计：
// 那是上一个太平洋日的记录，今日预算本该重新给。
// 旧快照没有每条 session 的过期时间时，才按「不过期」兼容恢复；新快照会保存
// seenSessions 的 [identity, expiresAt]，因此跨午夜重启仍能准确去重。
function hydrateClientStat(st, now) {
  const fingerprint = st.fingerprint || stableFingerprint(st.key || "");
  const rec = restoredClientSessions.get(fingerprint);
  if (!rec) return;
  restoredClientSessions.delete(fingerprint);   // 活状态接管，避免快照里同一把 key 出现两行
  st.total = rec.total;
  st.lastAt = rec.lastAt;
  for (const item of rec.seenSessions || []) st.seenSessions.set(item.id, item.expiresAt);
  // Old snapshots only had daySessions. Keep their current-day dedupe behavior;
  // new snapshots carry exact expiry times so a live session can cross midnight.
  if (!rec.seenSessions?.length) {
    for (const identity of rec.daySessions) st.seenSessions.set(identity, null);
  }
  if (rec.day !== quotaDay(now)) return;
  st.day = rec.day;
  for (const identity of rec.daySessions) {
    st.daySessions.add(identity);
    if (!st.seenSessions.has(identity)) st.seenSessions.set(identity, null);
  }
  st.dayCount = st.daySessions.size;
}

// 每把 Key 的会话归账（今日集合 + 累计），进程内的活状态优先，没被本进程碰过的 key
// 用启动时恢复的那份补上 —— 否则重启后面板得等这把 key 再被用一次才看得见历史。
function clientSessionRows(now = Date.now()) {
  const today = quotaDay(now);
  const out = new Map();
  for (const [fingerprint, rec] of restoredClientSessions) {
    out.set(fingerprint, {
      name: rec.name,
      owner: rec.owner === true,
      inFlight: 0,
      day: rec.day,
      daySessions: rec.daySessions.slice(),
      seenSessions: (rec.seenSessions || []).map((item) => ({ ...item })),
      dayCount: rec.day === today ? rec.daySessions.length : 0,
      total: rec.total,
      lastAt: rec.lastAt,
    });
  }
  for (const st of clientStats.values()) {
    const seenSessions = [];
    for (const [id, expiresAt] of st.seenSessions) {
      if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
      seenSessions.push({ id, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
    }
    out.set(st.fingerprint || stableFingerprint(st.key || ""), {
      name: st.name,
      owner: st.owner === true,
      inFlight: st.live.filter((at) => now - at < CLIENT_SLOT_STALE_MS).length,
      day: st.day,
      daySessions: [...st.daySessions],
      seenSessions,
      dayCount: st.day === today ? st.dayCount : 0,
      total: st.total,
      lastAt: st.lastAt,
    });
  }
  return out;
}

// 白名单比对解析后的真实模型 id：客户端只要能自己配别名就能绕开按别名写的白名单。
function clientModelAllowed(client, mc) {
  if (!client || !Array.isArray(client.models) || client.models.length === 0) return true;
  return client.models.includes(mc && mc.id);
}

// 把毫秒说成人话：解锁剩余时间要让人一眼看出是「还要等一小时」还是「马上就好」，
// 3598s 这种数字读不出来。秒/分/小时三档，只保留两级，不凑第三级。
function humanDuration(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min} 分 ${sec % 60} 秒` : `${min} 分`;
  return min % 60 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分` : `${Math.floor(min / 60)} 小时`;
}

// 报错里的解锁时间点。按进程时区渲染（镜像 ENV 与 server.js 默认都是 Asia/Shanghai），
// 并把实际偏移标出来 —— 万一部署在别的时区，用户能看出这是哪个钟，不会差几小时还看不出。
function lockTimeText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  // getTimezoneOffset 返回「UTC 减本地」的分钟数，符号与展示习惯相反。
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  const label = `UTC${offset < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? ":" + p(abs % 60) : ""}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${label})`;
}

// 准入闸门只管模型与并发。每日 session 预算必须等 createSession 知道是否复用后再判。
function openClientGate(client, mc) {
  if (!client) return { release: () => {} };   // 没有 key 上下文（内部调用）不设限
  if (!clientModelAllowed(client, mc)) {
    return {
      error: jsonResponse({
        error: {
          message: `当前 Key 无权使用模型 ${(mc && mc.id) || ""}；可用模型：${client.models.join(", ")}`,
          type: "model_not_allowed",
        },
      }, 403),
    };
  }
  const now = Date.now();
  const st = clientStat(client, now);
  // 会话存续期内这把 Key 只能用一个模型：换模型要么等会话到期，要么用 Master Key。
  // 这里就地回中文提示，不进选号/建会话流程 —— 换模型的代价是删会话重建，
  // 白扣一份 admission（见 deleteUpstreamSession 的注释）。
  const lock = clientModelLock(client, now);
  if (lock && lock.model !== (mc && mc.session)) {
    const waitMs = Math.max(1000, lock.until - now);
    const waitSec = Math.ceil(waitMs / 1000);
    return {
      error: jsonResponse({
        error: {
          message: `当前 Key 已锁定模型 ${lock.model},会话存续期内只能用这一个模型。\n`
            + `· 锁定模型: ${lock.model}\n`
            + `· 本次请求: ${(mc && mc.session) || "未知"}（已拒绝）\n`
            + `· 解锁时间: ${lockTimeText(lock.until)},还需 ${humanDuration(waitMs)}（${waitSec}s）\n`
            + `在此之前请继续用 ${lock.model};需要立刻换模型请改用 Master Key`,
          type: "key_model_locked",
          currentModel: lock.model,
          requestedModel: (mc && mc.session) || null,
          // 客户端可以直接读这两个字段做等待/倒计时，不用去解析中文句子。
          retryAfterSec: waitSec,
          unlockAt: new Date(lock.until).toISOString(),
        },
      }, 409, { "Retry-After": String(waitSec), "X-RateLimit-Scope": "api-key" }),
    };
  }
  if (client.concurrency > 0 && st.live.length >= client.concurrency) {
    // 不排队：排队只会让客户端自己超时，还看不出是被自己的并发限住了。
    return {
      error: jsonResponse({
        error: {
          message: `当前 Key 并发上限 ${client.concurrency},请等上一个请求结束后重试`,
          type: "key_concurrency_exceeded",
        },
      }, 429, { "Retry-After": "5", "X-RateLimit-Scope": "api-key" }),
    };
  }
  st.live.push(now);
  let released = false;
  return {
    release: () => {
      if (released) return;           // flush 与 cancel 都可能来，只放一次
      released = true;
      const idx = st.live.indexOf(now);
      if (idx >= 0) st.live.splice(idx, 1);
      else if (st.live.length) st.live.shift();   // 时间戳被兜底回收清掉了，扣一个避免负计数
    },
  };
}

class ClientSessionLimitError extends Error {
  constructor(client, now = Date.now()) {
    super("client key daily session limit exceeded");
    this.name = "ClientSessionLimitError";
    this.limit = Math.max(0, Number(client?.dailyLimit) || 0);
    this.retryAfterSec = secondsToNextQuotaDay(now);
  }
}

function clientSessionLimitResponse(error) {
  const retryAfterSec = Math.max(60, Number(error?.retryAfterSec) || secondsToNextQuotaDay());
  const limit = Math.max(0, Number(error?.limit) || 0);
  return jsonResponse({
    error: {
      message: `当前 Key 今日会话已达上限 ${limit} 次,${Math.ceil(retryAfterSec / 3600)} 小时后重置`,
      type: "key_daily_limit_exceeded",
    },
  }, 429, { "Retry-After": String(retryAfterSec), "X-RateLimit-Scope": "api-key" });
}

// 会话身份只当去重键用，所以直接存指纹：这份集合要落盘（usage-stats.json），
// 原文里的 token 是上游账号凭据，不该出现在统计文件里。
function clientSessionIdentity(token, model, session) {
  return session?.instanceId ? stableFingerprint(`${token}:${model}:${session.instanceId}`) : "";
}

function clientKeyFingerprint(client) {
  const supplied = String(client?.fingerprint || "");
  if (client?.owner !== true && /^sha256-[0-9a-f]{64}$/.test(supplied)) return supplied;
  return stableFingerprint(String(client?.key || ""));
}

// 同一 Key 对同一 instanceId 只记一次。seenSessions 跨太平洋日保留到 session 过期，
// 避免一个跨午夜仍存活的 session 被新的一天重复计数。
function claimClientSession(client, token, model, session, now = Date.now()) {
  if (!client || !session?.instanceId) return session;
  const st = clientStat(client, now);
  const identity = clientSessionIdentity(token, model, session);
  const expiresAt = Date.parse(session.expiresAt || "");
  const fresh = !st.seenSessions.has(identity);
  if (fresh && client.dailyLimit > 0 && st.daySessions.size >= client.dailyLimit) {
    throw new ClientSessionLimitError(client, now);
  }
  // 单 Key 在会话存续期内只允许一个模型。这里是这把 Key「拿到会话」的唯一入口，
  // 所以锁只写在这里（复用同一条会话也会走到，顺便刷新）。Master Key 不锁。
  // 过期时间读不出来的会话在 isLiveSession 眼里本来就不算活着，锁它没有意义。
  if (client.owner !== true && Number.isFinite(expiresAt)) {
    st.modelLock = { model: String(model || ""), token, until: expiresAt };
  }
  if (!fresh) return session;
  st.seenSessions.set(identity, Number.isFinite(expiresAt) ? expiresAt : null);
  st.daySessions.add(identity);
  st.dayCount = st.daySessions.size;
  st.total++;
  st.lastAt = now;
  usageSaveHook();   // 今日/累计要跨重启活下来，新会话落一次盘（一天最多几次，不是每请求）
  return session;
}

// 这把 Key 当前被绑在哪个模型上（会话存续期内）。Master Key 永不受限。
// 会话过期、或本地缓存里那条会话已经不在了（换模型删掉 / 被顶替 / 进程重启），
// 都算解锁 —— 宁可放开，也不要把用户锁在一条已经不存在的会话上。
function clientModelLock(client, now = Date.now()) {
  if (!client || client.owner === true) return null;
  const st = clientStats.get(client.key);
  const lock = st?.modelLock;
  if (!lock) return null;
  if (!(lock.until > now) || !isLiveSession(sessCache.get(lock.token + ":" + lock.model), now)) {
    st.modelLock = null;
    return null;
  }
  return lock;
}

// 这个号上该模型的活跃会话是不是这把 Key 自己开的。别的 Key 开的不复用：
// 同一个 instanceId 会把两边的上下文串在一起。宁可换个干净的号新建会话，
// 代价是多花一份 admission —— 这是用户明确要的取舍（避免上下文污染）。
// 没有 key 上下文（内部调用）时一律当自己的，保持原有复用行为。
function sessionOwnedByClient(client, token, model, session) {
  if (!client || !session?.instanceId) return true;
  const st = clientStats.get(client.key);
  return Boolean(st?.seenSessions?.has(clientSessionIdentity(token, model, session)));
}

// 只在确定要发 fresh-session POST 时预留预算。失败会取消；成功后用真实 instanceId 提交。
function reserveClientSession(client, flightKey, now = Date.now()) {
  if (!client) return null;
  const st = clientStat(client, now);
  if (st.pendingSessions.has(flightKey)) return null;
  if (client.dailyLimit > 0 && st.daySessions.size + st.pendingSessions.size >= client.dailyLimit) {
    throw new ClientSessionLimitError(client, now);
  }
  st.pendingSessions.add(flightKey);
  let settled = false;
  return {
    commit(token, model, session) {
      if (settled) return session;
      settled = true;
      st.pendingSessions.delete(flightKey);
      return claimClientSession(client, token, model, session);
    },
    cancel() {
      if (settled) return;
      settled = true;
      st.pendingSessions.delete(flightKey);
    },
  };
}

function secondsToNextQuotaDay(now = Date.now()) {
  const today = quotaDay(now);
  // 从 now 起按小时探到日期翻页；最多 26 小时（覆盖 DST 前后的 23/25 小时日）。
  for (let h = 1; h <= 26; h++) {
    const t = now + h * 3600 * 1000;
    if (quotaDay(t) !== today) return Math.max(60, Math.round((t - now) / 1000));
  }
  return 3600;
}

// 流式响应：Response 已经交出去了，body 还在写。槽位要等 body 到终态才放 ——
// 正常收尾走 flush，客户端断开/上游出错走 cancel，三条路都覆盖到。
function releaseOnStreamEnd(release) {
  return new TransformStream({
    transform(chunk, ctrl) { ctrl.enqueue(chunk); },
    flush() { release(); },
    cancel() { release(); },
  });
}

// 面板用的按 key 归账快照。只出备注名，绝不出明文 key（GET /_api/usage 会整份返回）；
// 会话身份指纹也不出——面板用不上，出去只是噪音。
function clientStatsSnapshot() {
  const out = new Map();
  for (const [fingerprint, row] of clientSessionRows()) {
    const output = {
      name: row.name,
      owner: row.owner,
      inFlight: row.inFlight,
      dayCount: row.dayCount,
      total: row.total,
      totalTokens: 0,
      lastAt: row.lastAt,
    };
    // 仅供同进程的 server.js 做稳定关联；设为不可枚举，JSON 响应仍不会暴露
    // 指纹字段（更不会暴露明文 Key）。
    Object.defineProperty(output, "fingerprint", { value: fingerprint, enumerable: false });
    out.set(fingerprint, output);
  }
  for (const [fingerprint, usage] of Object.entries(usageByKey)) {
    const row = out.get(fingerprint) || {
      name: usage.name,
      owner: usage.owner === true,
      inFlight: 0,
      dayCount: 0,
      total: 0,
      totalTokens: 0,
      lastAt: null,
    };
    row.name = usage.name || row.name;
    row.owner = usage.owner === true;
    row.totalTokens = usage.totalTokens;
    if (!Object.prototype.hasOwnProperty.call(row, "fingerprint")) {
      Object.defineProperty(row, "fingerprint", { value: fingerprint, enumerable: false });
    }
    out.set(fingerprint, row);
  }
  return [...out.values()].sort((a, b) => b.total - a.total || b.totalTokens - a.totalTokens);
}

// 面板读取用的快照（数组/计数/概况都深拷一层，避免外部改到内部状态）。
function callLogSnapshot() {
  const usage = usageSnapshot();
  return {
    calls: callLogBuf.slice(),
    totals: { ...callTotals },
    // total（单数）= 客户端请求口径的累计；totals（复数）= 逐次尝试的失败计数。
    total: usage.total,
    byModel: usage.byModel,
    // byKey = 按客户端 key 归账（多 key 分享给别人时看谁用了多少）。
    byKey: clientStatsSnapshot(),
    startTime: usage.startTime,
    lastRequest: usage.lastRequest,
  };
}

// 第一次选号若已有同模型 active session，等待它的单并发租约释放而不是立刻换号。
// 有每日 session 预算的分享 Key 会等到该 session 不再可复用，避免长请求超过普通
// 等待上限后换号建新 session；不限量 Key 仍保留超时回退，真正失败后的重试也照常换号。
async function pickTokenWithSessionWait(
  env,
  sessionModel,
  attempted = new Set(),
  signal = null,
  waitMs = ACTIVE_SESSION_LEASE_WAIT_MS,
  client = null,
) {
  if (sessionModel && attempted.size === 0) {
    const preserveBudget = client?.owner !== true && Number(client?.dailyLimit) > 0;
    while (true) {
      syncAccountState(env);
      const accounts = parseAccounts(env);
      const active = accounts.flatMap((acct) => {
        const session = sessCache.get(acct.token + ":" + sessionModel);
        return !accountIsBlocked(acct.token)
          && !inScopedCooldown(acct.token, sessionModel)
          && accountRouteSelectable(acct.token)
          && (preserveBudget ? isLiveSession(session) : isUsableSession(session))
          // 别的 Key 开的同模型会话不等也不复用：共用一个 instanceId 会串上下文。
          // 这种号交给 pickToken 排到候选末尾，优先换个干净的号新建会话。
          && sessionOwnedByClient(client, acct.token, sessionModel, session)
          ? [{ acct, session }] : [];
      });
      if (!active.length) break;
      const idle = active.find(({ acct }) => !tokenBusy(acct.token));
      if (idle) {
        if (!preserveBudget) break;
        if (acquireToken(idle.acct.token)) return idle.acct;
        continue;
      }

      // 活跃 session 都被占用时，先利用没有该模型 session 的空闲账号。
      // 这让 concurrency>1 真正扩展到账号池，而不是让所有请求一起占着 Key
      // 槽位等待同一个账号；只有没有预算或没有空闲账号时才等待旧 session。
      if (preserveBudget) {
        const st = clientStat(client);
        const budgetAvailable = st.daySessions.size + st.pendingSessions.size < client.dailyLimit;
        if (budgetAvailable) {
          const fresh = accounts.find((acct) => {
            if (accountIsBlocked(acct.token) || inScopedCooldown(acct.token, sessionModel)) return false;
            if (tokenBusy(acct.token)) return false;
            if (!accountRouteSelectable(acct.token)) return false;
            const session = sessCache.get(acct.token + ":" + sessionModel);
            return !isLiveSession(session);
          });
          if (fresh && acquireToken(fresh.token)) return fresh;
        }
      }

      const activeWaitMs = preserveBudget
        ? Math.min(...active.map(({ session }) => (
            Math.max(0, sessionRemainingMs(session))
          )))
        : waitMs;
      if (!(activeWaitMs > 0)) break;
      await waitForAnyTokenRelease(active.map(({ acct }) => acct.token), activeWaitMs, signal);
      if (!preserveBudget) break;
    }
  }
  return pickToken(env, sessionModel, attempted, client);
}

function sessionLeaseWaitMs(env) {
  // 注意空串：docker-compose 里写 `FREEBUFF_SESSION_WAIT_MS=` 会传进来一个空值，
  // 而 Number("") 是 0 —— 那会静默关掉等待，等于悄悄退回「忙就换号」。
  const raw = String((env && env.FREEBUFF_SESSION_WAIT_MS) ?? "").trim();
  const ms = Number(raw);
  return raw !== "" && Number.isFinite(ms) && ms >= 0 ? ms : ACTIVE_SESSION_LEASE_WAIT_MS;
}

// 上游抖动后重新拿回同一个号：它此刻已释放租约，且没有被隔离或冷却。
// 拿不回来（被隔离/冷却/又被别的请求占住）就返回 null，交给外层正常换号。
function retakeToken(env, token, sessionModel) {
  if (!token) return null;
  syncAccountState(env);
  if (accountIsBlocked(token) || inScopedCooldown(token, sessionModel)) return null;
  if (!acquireToken(token)) return null;
  const acct = parseAccounts(env).find((item) => item.token === token);
  if (!acct) releaseToken(token);
  return acct || null;
}

// 只有这些形状算「上游抖动」，值得重试同一个号：session/run 创建的非 429 失败、
// 超时、连接被掐断。账号自身的问题（终态、额度耗尽、401 复核、排队）不在其中——
// 那些情况重试同号没有意义，必须换号。
function isTransientUpstreamError(error) {
  if (error instanceof TerminalAccountStateError
    || error instanceof QuotaExhaustedError
    || error instanceof TransientAccountAuthError
    || error instanceof EgressRejectedError
    || error instanceof WaitingRoomError
    || error instanceof ModelLockedError
    || error instanceof ModelUnavailableError
    || error instanceof EmptyUpstreamStreamError) return false;
  const msg = String((error && error.message) || error);
  if (/\b429\b/.test(msg) || /stayed queued|waiting.room/i.test(msg)) return false;
  return /create session failed|start_run failed|timeout|timed out|terminated|abort|fetch failed|ECONNRESET|socket hang up/i.test(msg);
}

function pickToken(env, sessionModel, attempted = new Set(), client = null) {
  if (isPausedModelId(sessionModel) || isHiddenModelId(sessionModel)) return null;
  syncAccountState(env);
  const pool = parseAccounts(env);
  if (pool.length === 0) return null;

  // 只选择没有明确隔离、短期冷却或并发租约的账号。acctHealth 还承载
  // rate_limited/country_blocked 等临时观测，只用于面板展示，不能永久摘号。
  const eligiblePool = pool.filter((acct) => {
    if (attempted && attempted.has(acct.token)) return false;
    if (accountIsBlocked(acct.token)) return false;
    if (tokenBusy(acct.token)) return false;
    return true;
  });
  // Node adapter 能直接看见每个账号 lane 的 dispatcher 状态。有任意可路由账号时，
  // 在选号前跳过明确未就绪的 lane：本地拒绝没有创建 session，不应白占
  // MAX_ACCOUNT_SWITCHES 的 admission 预算。若全池都未就绪，保留原池走一次正常错误
  // 路径，客户端仍得到准确的 egress_unavailable，而不是泛化的池耗尽提示。
  // 未注入或返回 null 表示未知，Cloudflare/直连部署保持原有行为。
  const routablePool = accountRouteReady
    ? eligiblePool.filter((acct) => accountRouteSelectable(acct.token))
    : eligiblePool;
  const alivePool = routablePool.length > 0 ? routablePool : eligiblePool;
  const usePool = alivePool;
  if (usePool.length === 0) return null;

  // 活跃 session 仍优先；仅在必须新建 session 时，才使用新鲜 quota 快照
  // 减少把新 session 分配给剩余额度更少的账号。未知/过期/并列保持轮询顺序。
  const finalPool = usePool;

  // 优先复用已有活跃 session 缓存的号：一个 session 约 1 小时有效，创建 session 才扣
  // 免费额度（如 v4-pro 每天 6 次）。纯轮询会让每个请求都切号、各建一个 session，
  // 浪费创建额度。只要当前模型的 session 缓存还活跃就钉在同一个号上，用满再换。
  // ⚠️ 只钉自己开的会话：别的 Key 的会话复用了会串上下文，那种号往下排到候选末尾。
  if (sessionModel) {
    for (const acct of finalPool) {
      const t = acct.token;
      if (inScopedCooldown(t, sessionModel) || !acquireToken(t)) continue;
      const cached = sessCache.get(t + ":" + sessionModel);
      if (isUsableSession(cached) && sessionOwnedByClient(client, t, sessionModel, cached)) {
        return acct;
      }
      releaseToken(t);
    }
  }

  // 没有活跃缓存才轮询（跳过冷却中的号）。先生成稳定轮询序列，再排序：
  // ① 没有被别的模型会话占住的号优先（避免删别人的会话、白烧一份 admission）；
  // ② 然后是该模型上没挂着别的 Key 会话的号（避免上下文污染，同模型优先换号新建）；
  // ③ 最后把新鲜的正剩余额度按降序提到前面；未知仍在已知 0 之前。
  // ①在②前面：抢占别人的会话既毁掉对方的上下文又白扣一份额度，比共用一条会话更糟。
  const candidates = [];
  const nowTs = Date.now();
  for (let k = 0; k < finalPool.length; k++) {
    const acct = finalPool[accountIdx % finalPool.length];
    accountIdx = (accountIdx + 1) % finalPool.length;
    const t = acct.token;
    if (!inScopedCooldown(t, sessionModel) && !tokenBusy(t)) {
      const cached = sessionModel ? sessCache.get(t + ":" + sessionModel) : null;
      candidates.push({
        acct,
        order: candidates.length,
        conflict: hasConflictingSession(t, sessionModel) ? 1 : 0,
        foreign: isLiveSession(cached) && !sessionOwnedByClient(client, t, sessionModel, cached) ? 1 : 0,
        waiting: recentlyWaitingRoom(t, env, nowTs) ? 1 : 0,
        remaining: remainingQuota(t, sessionModel),
      });
    }
  }
  candidates.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict - b.conflict;
    // 新鲜的 waiting room 观测降权：这个号大概率还在队列里，建会话要白等 12s 才失败。
    // 排在 conflict 之后 —— 抢占别人的会话是实际损害，比一次概率性失败更该避免。
    // 过期观测由 recentlyWaitingRoom 判为 false，自动回到正常轮询顺序。
    if (a.waiting !== b.waiting) return a.waiting - b.waiting;
    if (a.foreign !== b.foreign) return a.foreign - b.foreign;
    const rank = (item) => item.remaining == null ? 1 : item.remaining > 0 ? 0 : 2;
    const rankDiff = rank(a) - rank(b);
    if (rankDiff) return rankDiff;
    if (rank(a) === 0 && a.remaining !== b.remaining) return b.remaining - a.remaining;
    return a.order - b.order;
  });
  for (const { acct } of candidates) {
    if (acquireToken(acct.token)) return acct;
  }
  return null;
}

function accountPoolExhaustion(env, sessionModel = null) {
  syncAccountState(env);
  const pool = parseAccounts(env);
  if (pool.length === 0) return { status: 503, type: "config_error", retryAfterMs: null, allUnavailable: true };
  const now = Date.now();
  const details = pool.map((acct) => ({
    token: acct.token,
    state: durableAccountState(acct.token, now)?.state || null,
    lock: scopedCooldownInfo(acct.token, sessionModel, now),
    busy: tokenBusy(acct.token),
  }));
  const allUnavailable = details.every((d) => Boolean(d.state || d.lock || d.busy));
  const terminalStates = ["banned", "token_invalid", "manual_disabled"];
  if (details.every((d) => terminalStates.includes(d.state))) {
    const states = [...new Set(details.map((d) => d.state))];
    return {
      status: 403,
      type: states.length === 1 && states[0] === "banned" ? "account_banned" : "account_terminal",
      terminalStates: states,
      retryAfterMs: null,
      allUnavailable,
    };
  }
  const quotaOnly = details.every((d) =>
    !d.state && !d.busy && d.lock && d.lock.reason === "quota");
  if (quotaOnly) {
    const quotaLocks = details.map((d) => d.lock);
    const retryAfterMs = Math.min(...quotaLocks.map((lock) => cooldownRemainingMs(lock, now)));
    return { status: 429, type: "rate_limit_exceeded", retryAfterMs, allUnavailable };
  }
  const transientOnly = details.every((d) =>
    !d.state && !d.busy && d.lock && d.lock.reason !== "quota");
  if (transientOnly) {
    const retryAfterMs = Math.min(...details.map((d) => cooldownRemainingMs(d.lock, now)));
    return { status: 503, type: "upstream_session_unavailable", retryAfterMs, allUnavailable };
  }
  return { status: 503, type: "account_pool_unavailable", retryAfterMs: null, allUnavailable };
}

function poolExhaustionResponse(env, sessionModel = null) {
  const info = accountPoolExhaustion(env, sessionModel);
  if (info.status === 403) {
    const message = info.type === "account_banned"
      ? "账号池中的账号均已被上游封禁"
      : "账号池中的账号均已进入终态隔离，请检查账号状态";
    return jsonResponse({
      error: {
        message,
        type: info.type,
        ...(info.terminalStates ? { states: info.terminalStates } : {}),
      },
    }, 403);
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
  if (info.type === "upstream_session_unavailable") {
    const seconds = Math.max(1, Math.ceil((info.retryAfterMs || 60 * 1000) / 1000));
    return jsonResponse({
      error: {
        message: `当前模型上游会话暂不可用,请 ${seconds}s 后重试`,
        type: info.type,
        retryAfterMs: info.retryAfterMs,
      },
    }, 503, { "Retry-After": String(seconds) });
  }
  const message = info.type === "config_error" ? "缺少 FREEBUFF_TOKEN 环境变量" : "当前没有可用账号";
  return jsonResponse({ error: { message, type: info.type } }, 503);
}

// 文案要点名上游（Freebuff）：503 waiting_room 是官方按模型后端的容量闸，
// 不是本网关在限流——不点名会被客户端当成我们网关排队（2026-08-26 用户反馈）。
function waitingRoomResponse(retryAfterMs = 30 * 1000, modelHint = "") {
  const ms = Math.max(1000, Number(retryAfterMs) || 30 * 1000);
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  const hint = modelHint ? `模型 ${modelHint} ` : "";
  return jsonResponse({
    error: {
      message: `上游（Freebuff）${hint}后端容量已满，会话请求被官方排队拦截，非本网关限流；请约 ${seconds}s 后重试`,
      type: "waiting_room",
      retryAfterMs: ms,
    },
  }, 503, { "Retry-After": String(seconds) });
}

// 两种 state 必须分开说（2026-08-26 用户反馈）：egress_unavailable 是本地判定
// （lane 未就绪，请求根本没发出去），说「被上游拒绝」会把锅甩给上游；只有
// egress_rejected 才是上游真拒了出口 IP。
function egressRejectedResponse(state) {
  const unavailable = state === "egress_unavailable";
  return jsonResponse({
    error: {
      message: unavailable
        ? "出站代理通道尚未就绪，网关正在自动重建，请稍后重试"
        : "当前出口节点被上游（Freebuff）拒绝，网关正在自动更换节点，请稍后重试",
      type: "egress_unavailable",
      state: state || "egress_rejected",
    },
  }, 503);
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

function isLiveSession(session, now = Date.now()) {
  const expiryMs = Date.parse(session?.expiresAt || "");
  return Boolean(session?.instanceId) && Number.isFinite(expiryMs) && expiryMs > now;
}

// 这个号是否已经被另一个模型的会话占住。CLI 通道一个号同时只能有一个会话，
// 所以在它上面开新模型必须先 DELETE 旧会话 —— 而重建一次要扣一份 premium
// admission（每天只有 4~7 份）。选号时把这种号排到最后，让「换模型」优先落到
// 干净的空闲号上：这才是两个模型真正并行的方式，也是不白烧额度的方式。
function hasConflictingSession(token, sessionModel, now = Date.now()) {
  const id = String(sessionModel || "");
  if (!id) return false;
  const prefix = token + ":";
  for (const [cacheKey, session] of sessCache) {
    if (!cacheKey.startsWith(prefix)) continue;
    if (cacheKey.slice(prefix.length) === id) continue;
    if (isLiveSession(session, now)) return true;
  }
  return false;
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
 *   cooldown(token, ms, {reason, retryAfterMs, model, scope})
 * 幂等合并：已存在的冷却如果更长则保留（避免短冷却覆盖长冷却）。
 */
function scopedCooldownKey(token, scope) {
  return token + "\u0000scope:" + String(scope);
}

function quotaScopeForModel(model, quota = null) {
  const id = String(model || "").trim();
  if (!id) return "account";
  // GLM 5.3 Flash 同时消耗 Premium 共享池，并额外受独立 2 次/日上限约束。
  // rateLimitsByModel 的精确行优先；typed 429 未携带快照时按官方独立 cap
  // fail closed，不能退成模型级或误锁整个 Premium 池。
  if (GLM_V53_FLASH_QUOTA_MODELS.has(id)) {
    const exactPool = normalizePoolName(quotaRowForModel(quota, id)?.pool);
    return "pool:" + (exactPool || "glm_v53_flash");
  }
  const category = modelPoolCategory(id, quota);
  if (["deepseek_pro", "luna", "premium"].includes(category)) return "pool:" + category;
  if (category === "glm") return "pool:glm";
  if (category === "glm_v53_flash") return "pool:glm_v53_flash";
  // Standard/Limited grouping is not assumed without a confirmed upstream pool.
  return "model:" + id;
}

function quotaScopesForModel(model, quota = null) {
  const id = String(model || "").trim();
  if (!id) return ["account"];
  if (GLM_V53_FLASH_QUOTA_MODELS.has(id)) {
    const exactPool = normalizePoolName(quotaRowForModel(quota, id)?.pool);
    if (exactPool === "premium") return ["pool:premium"];
    return ["pool:glm_v53_flash", "pool:premium"];
  }
  return [quotaScopeForModel(id, quota)];
}

function accountQuotaSnapshot(token) {
  return acctHealth.get(token)?.quota || null;
}

// 写入侧必须和读取侧（scopedCooldownInfo）用同一个池口径，否则冷却写进一个 key、
// 查的是另一个 key，等于没冷却。DS4P 就踩过：静态兜底表说 deepseek_pro，
// 2026-08-23 起线上 rateLimitsByModel 说 premium。
function cooldownScopeFor(model, reason, explicitScope, quota = null) {
  if (explicitScope) return String(explicitScope);
  if (!model) return "account";
  // Only typed quota responses may use a shared pool. Transport/session errors
  // stay model-scoped so one broken model cannot disable the account's others.
  return reason === "quota" ? quotaScopeForModel(model, quota) : "model:" + String(model);
}

function cooldown(token, ms, opts) {
  if (!(ms > 0)) return;
  let reason = "error";
  let retryAfterMs = null;
  let model = null;
  let scope = null;
  if (opts && typeof opts === "object") {
    reason = opts.reason || reason;
    retryAfterMs = opts.retryAfterMs != null ? opts.retryAfterMs : null;
    model = opts.model || opts.sessionModel || null;
    scope = opts.scope || null;
  } else if (typeof opts === "number" && opts > 0) {
    retryAfterMs = opts;
    reason = "quota";
  } else if (typeof opts === "string") {
    reason = opts;
  }
  const until = Date.now() + ms;
  const storedScope = cooldownScopeFor(model, reason, scope, accountQuotaSnapshot(token));
  const key = storedScope === "account" ? token : scopedCooldownKey(token, storedScope);
  const prev = cooldowns.get(key);
  if (prev && prev.until > until) return; // 已有更长的冷却，保留
  cooldowns.set(key, {
    until,
    retryAfterMs,
    reason,
    scope: storedScope,
    ...(model ? { model: String(model) } : {}),
  });
}

/** 读取冷却记录；未冷却/已过期返回 null */
function cooldownInfo(token, now = Date.now()) {
  const c = cooldowns.get(token);
  if (!c || c.until <= now) { cooldowns.delete(token); return null; }
  return c;
}

// 当前模型同时看模型级冷却和显式账号级冷却；模型级 SDK/session 故障
// 不应把同一账号仍有额度的其他模型一起摘掉。
// 池 key 要查两份：实时快照口径 + 静态兜底口径。上游改过池归属（DS4P 的
// deepseek_pro → premium），只查一份会让归属切换的瞬间把还没到期的冷却丢掉。
function scopedCooldownInfo(token, model, now = Date.now()) {
  const keys = [token];
  if (model) {
    keys.push(scopedCooldownKey(token, "model:" + String(model)));
    const scopes = new Set([
      ...quotaScopesForModel(model, accountQuotaSnapshot(token)),
      ...quotaScopesForModel(model, null),
    ]);
    for (const scope of scopes) {
      if (scope !== "account") keys.push(scopedCooldownKey(token, scope));
    }
  }
  let selected = null;
  for (const key of keys) {
    const lock = cooldowns.get(key);
    if (!lock) continue;
    if (lock.until <= now) {
      cooldowns.delete(key);
      continue;
    }
    if (!selected || lock.until > selected.until) selected = lock;
  }
  return selected;
}

function cooldownRemainingMs(lock, now = Date.now()) {
  return Math.max(1, Number(lock?.until) - now || 1);
}

/** 该 token 是否处于冷却中 */
function inCooldown(token, now = Date.now()) {
  return cooldownInfo(token, now) !== null;
}

function inScopedCooldown(token, model, now = Date.now()) {
  return scopedCooldownInfo(token, model, now) !== null;
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

function quotaEntryForModel(quota, sessionModel) {
  const id = String(sessionModel || "").trim();
  if (!quota || typeof quota !== "object" || isPausedModelId(id) || isHiddenModelId(id)) return null;
  const exact = quotaRowForModel(quota, id);
  const declaredPool = safePoolName(exact?.pool);
  const scope = quotaScopeForModel(id, quota);
  const pool = scope.startsWith("pool:") ? scope.slice(5) : null;
  if (pool === "premium") return premiumQuotaEntry(quota, exact);
  if (exact && typeof exact === "object") {
    if (!declaredPool || !pool || declaredPool === pool) return exact;
  }
  if (!pool) return null;
  for (const entry of Object.values(quota)) {
    if (entry && typeof entry === "object" && safePoolName(entry.pool) === pool) return entry;
  }
  return null;
}

function premiumQuotaEntry(quota, exact = null) {
  if (!quota || typeof quota !== "object") return null;
  const pooled = [];
  for (const [model, entry] of Object.entries(quota)) {
    if (!entry || typeof entry !== "object" || isPausedModelId(model) || isHiddenModelId(model)) continue;
    const entryPool = safePoolName(entry.pool);
    if (entryPool === "premium" || (!entryPool && PREMIUM_QUOTA_MODELS.has(model))) pooled.push(entry);
  }
  if (!pooled.length) return null;
  const limits = pooled.map((entry) => Number(entry.limit)).filter(Number.isFinite);
  const counts = pooled.map((entry) => Number(entry.recentCount)).filter(Number.isFinite);
  const limit = limits.length ? Math.min(...limits) : null;
  const recentCount = counts.length ? Math.max(...counts) : null;
  if (exact && (!limits.length || Number(exact.limit) === limit)
    && (!counts.length || Number(exact.recentCount) === recentCount)) return exact;
  return {
    ...pooled[0],
    ...(limits.length ? { limit } : {}),
    ...(counts.length ? { recentCount } : {}),
    pool: "premium",
  };
}

function quotaEntryForScope(quota, scope) {
  const pool = String(scope || "").startsWith("pool:") ? String(scope).slice(5) : "";
  if (!pool) return null;
  if (pool === "premium") return premiumQuotaEntry(quota);
  for (const entry of Object.values(quota || {})) {
    if (entry && typeof entry === "object" && safePoolName(entry.pool) === pool) return entry;
  }
  return null;
}

function quotaConstraintsForModel(quota, sessionModel) {
  const id = String(sessionModel || "").trim();
  if (!GLM_V53_FLASH_QUOTA_MODELS.has(id)) {
    const primary = quotaEntryForModel(quota, id);
    return primary ? [{ entry: primary, scope: quotaScopeForModel(id, quota) }] : [];
  }

  return quotaScopesForModel(id, quota)
    .map((scope) => ({ scope, entry: quotaEntryForScope(quota, scope) }))
    .filter((constraint) => constraint.entry);
}

function quotaConstraintRemaining(constraint) {
  const entry = constraint?.entry;
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return null;
  return entry.limit - entry.recentCount;
}

function exhaustedQuotaScope(info, sessionModel) {
  for (const constraint of quotaConstraintsForModel(info?.quota, sessionModel)) {
    const remaining = quotaConstraintRemaining(constraint);
    if (remaining !== null && remaining <= 0) return constraint.scope;
  }
  return null;
}

// 仅供流式无首数据时确认对应额度池是否耗尽；不参与账号轮询排序。
function remainingQuota(token, sessionModel) {
  const h = acctHealth.get(token);
  if (!h || !h.quota || !Number.isFinite(Number(h.quotaCheckedAt))) return null;
  if (Date.now() - Number(h.quotaCheckedAt) > HEALTH_OBSERVATION_TTL_MS) return null;
  const remaining = quotaConstraintsForModel(h.quota, sessionModel)
    .map(quotaConstraintRemaining)
    .filter((value) => value !== null);
  return remaining.length ? Math.min(...remaining) : null;
}

// 长流不应因为固定秒数被误杀：只有上游额度探测明确表示不可用时，
// 才允许当前请求中止并切换账号。探测失败/额度未知一律不判定耗尽。
function isQuotaExhausted(info, sessionModel) {
  if (!info) return false;
  if (info.state === "spend_limited") return true;
  if (["rate_limited", "rate_limit_exceeded", "quota_exceeded"].includes(info.state)) {
    const scope = info.quotaScope || null;
    const modelScope = sessionModel ? "model:" + String(sessionModel) : "account";
    // A missing scope is not evidence of a shared pool. Only reuse the
    // observation for the exact model that produced it; typed pool/account
    // scopes may be shared according to the upstream contract.
    const expectedScopes = new Set(quotaScopesForModel(sessionModel, info.quota || null));
    return scope
      ? scope === "account" || scope === modelScope || expectedScopes.has(scope)
      : info.quotaModel != null && String(info.quotaModel) === String(sessionModel);
  }
  // STANDARD 没有可靠的剩余次数查询；只处理明确的账号/上游状态，
  // 不根据 rateLimitsByModel 的 STANDARD 数字判断耗尽。
  if (modelPoolCategory(sessionModel, info.quota) === "standard") return false;
  if (!info.quota) return false;
  return exhaustedQuotaScope(info, sessionModel) !== null;
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

function normalizeStructuredState(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[- ]+/g, "_");
  return normalized || null;
}

function isPriorityStructuredState(state) {
  return state === "banned"
    || state === "token_invalid"
    || RATE_LIMIT_STATE_NAMES.has(state)
    || state.startsWith("free_mode_");
}

// 状态可能包在 error/data 里；优先返回已知终态/准入态，避免外层
// status=error 把内层 banned 隐藏掉。只读取命名字段，不把 message 当状态。
function findStructuredState(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  let fallback = null;
  for (const name of ["status", "state", "code", "errorCode", "error_code", "type", "error"]) {
    // `error` 只认 code 形态（不含空白）：chat gate 的 wire shape 就是
    // {error:"free_mode_legacy_luna_agent", message:"..."}，漏掉它整个 body 会被当成
    // 「403 但没给名字」，也就是 WAF 级拦截，冤枉出口节点。反过来 {error:"edge rejected"}
    // 那种自由文本是 message 不是状态，认了它真正的裸 403 就不再判定为出口拦截。
    if (name === "error" && (typeof value[name] !== "string" || /\s/.test(value[name]))) continue;
    const candidate = normalizeStructuredState(value[name]);
    if (!candidate) continue;
    if (isPriorityStructuredState(candidate)) return candidate;
    fallback ||= candidate;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const nested = findStructuredState(child, depth + 1);
    if (!nested) continue;
    if (isPriorityStructuredState(nested)) return nested;
    fallback ||= nested;
  }
  return fallback;
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

const GENERIC_429_COOLDOWN_MS = 60 * 1000;

function parseCooldown(text, status, headers = {}, now = Date.now()) {
  const body = parseJsonBody(text);
  const upstreamState = body && typeof body === "object"
    ? findStructuredValue(body, ["status", "state"]) : null;
  if (status === 403 && upstreamState === "banned") {
    // 官方 banned 是终态；持久状态才是唯一恢复边界，不生成临时冷却。
    return 0;
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
    return GENERIC_429_COOLDOWN_MS;
  }
  const humanDelay = humanRetryDelay(text);
  if (humanDelay > 0) return humanDelay;
  return status === 429 ? GENERIC_429_COOLDOWN_MS : 60 * 1000;
}

const RATE_LIMIT_STATE_NAMES = new Set([
  "rate_limited",
  "rate_limit_exceeded",
  "quota_exceeded",
  "spend_limited",
  "ip_capped",
  "country_blocked",
  "waiting_room_queued",
  "waiting_room_required",
]);

function findRateLimitState(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/[- ]+/g, "_");
    return RATE_LIMIT_STATE_NAMES.has(normalized) ? normalized : null;
  }
  if (typeof value !== "object") return null;
  for (const key of ["status", "state", "code", "errorCode", "error_code", "type"]) {
    const hit = findRateLimitState(value[key], depth + 1);
    if (hit) return hit;
  }
  for (const child of Object.values(value)) {
    const hit = findRateLimitState(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 将 429/typed admission 状态转换成统一的作用域决策。
 * 该函数只返回公开状态和时间，不携带 token、响应原文或 URL。
 */
function classifyRateLimit(text, status = 429, headers = {}, model = null, now = Date.now(), quota = null) {
  const body = parseJsonBody(text);
  const headerState = headerValue(headers, "x-freebuff-status")
    || headerValue(headers, "x-freebuff-state");
  const state = findRateLimitState(body) || findRateLimitState(headerState);
  const declaredState = findStructuredState(body) || normalizeStructuredState(headerState);
  const retryAfterMs = status === 429 || state
    ? parseCooldown(text, 429, headers, now)
    : null;
  if (state === "ip_capped" || state === "country_blocked") {
    return { state, reason: "egress", scope: "egress", retryAfterMs };
  }
  if (state === "spend_limited") {
    return { state, reason: "quota", scope: "account", retryAfterMs };
  }
  if (state === "waiting_room_queued" || state === "waiting_room_required") {
    return { state, reason: "waiting_room", scope: "waiting_room", retryAfterMs };
  }
  if (status === 403 && !state && !declaredState) {
    return { state: null, reason: "egress", scope: "egress", retryAfterMs };
  }
  if (status === 429 || state === "rate_limited" || state === "rate_limit_exceeded" || state === "quota_exceeded") {
    const exhaustedScope = state
      ? exhaustedQuotaScope({ quota }, model)
      : null;
    return {
      state: "rate_limited",
      reason: "quota",
      // 只有明确的 typed quota 状态才能证明对应共享池；generic 429
      // 没有作用域信息，只锁当前模型，避免误伤同账号其他 Premium 模型。
      scope: state
        ? (exhaustedScope || quotaScopeForModel(model, quota))
        : (model ? "model:" + String(model) : "account"),
      retryAfterMs,
    };
  }
  return { state: state || null, reason: "error", scope: model ? "model:" + String(model) : "account", retryAfterMs };
}

class TerminalAccountStateError extends Error {
  constructor(state, status) {
    super("upstream account state is terminal");
    this.name = "TerminalAccountStateError";
    this.state = String(state || "blocked");
    this.status = Number(status) || 0;
  }
}

class EgressRejectedError extends Error {
  constructor(decision, status) {
    super("upstream egress is unavailable");
    this.name = "EgressRejectedError";
    this.state = decision?.state || "egress_rejected";
    this.status = Number(status) || 0;
    this.retryAfterMs = Number(decision?.retryAfterMs) || null;
  }
}

class TransientAccountAuthError extends Error {
  constructor() {
    super("upstream account auth was rejected transiently");
    this.name = "TransientAccountAuthError";
    this.status = 401;
  }
}

function terminalStateFromResponse(status, payload) {
  if (status !== 403) return null;
  const body = parseJsonBody(payload);
  return findStructuredState(body) === "banned" ? "banned" : null;
}

function throwIfTerminalResponse(token, status, payload) {
  const state = terminalStateFromResponse(status, payload);
  if (state) throw new TerminalAccountStateError(state, status);
}

// 业务 endpoint 的 401 可能是上游会话/路由的瞬时拒绝，不能凭单次响应永久摘号。
// 仅在独立的无消耗 session GET 也明确返回 401 时确认 token_invalid。
async function confirmTokenInvalid(token, sessionModel) {
  const probe = await up(
    "GET",
    "/api/v1/freebuff/session",
    token,
    undefined,
    DESKTOP_INCLUDE_RATE_LIMITS,
    SESSION_TIMEOUT_MS,
    { skipAuthConfirmation: true },
  );
  recordAccountObservation(token, probe.status, probe.data ?? probe.text, {
    quota: probe.data?.rateLimitsByModel || null,
    uid: probe.data?.uid || null,
    retryAfterMs: probe.data?.retryAfterMs,
    headers: probe.headers,
    model: sessionModel,
    confirmedState: probe.status === 401 ? "token_invalid" : null,
  });
  if (probe.status === 401) {
    // recordAccountObservation 已以 confirmedState 写入同一终态；这里只负责
    // 中止当前链，不再重复持久化或推进 revision。
    throw new TerminalAccountStateError("token_invalid", 401);
  }
  return probe;
}

class QuotaExhaustedError extends Error {
  constructor(info) {
    super("upstream account quota exhausted");
    this.name = "QuotaExhaustedError";
    this.retryAfterMs = info && typeof info.retryAfterMs === "number" ? info.retryAfterMs : null;
    this.scope = info?.scope || null;
    this.state = info?.state || "rate_limited";
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

// 上游 `model_locked`：该账号已有一个绑在别的模型上的会话。CLI/web 通道一个号
// 同时只能有一个会话（官方 premium_slot_taken 注释：多会话只给 Desktop，
// "Never returned to CLI/web, which run one session per user."），官方唯一处置是
// DELETE 旧会话再 POST 新模型。DELETE + 重发一次仍然锁着，才抛这个错误。
//
// ⚠️ 它不是"上游抖动"也不是这个号的问题：绝不能原地重试同号（重试必然再锁），
// 也绝不能写冷却（写了会把整池按模型冷却，看起来像"这个模型彻底不可用"）。
// 正确做法是换一个没有会话冲突的账号——那才是两个模型真正并行的方式。
class ModelLockedError extends Error {
  constructor(currentModel, requestedModel) {
    super(`model_locked: account session is bound to ${currentModel || "another model"}`);
    this.name = "ModelLockedError";
    this.currentModel = currentModel || null;
    this.requestedModel = requestedModel || null;
  }
}

// POST /session 的 model_locked 判定。只看 body 的联合体判别式，HTTP status
// 不参与：私有服务端把它挂在 200 或 409 上都要能识别，挂在 409 上时更不能被
// 下面那条 session_model_mismatch 分支吞掉（那条会写 60s 冷却，等于整池按模型封住）。
//
// 线上实测（2026-08-23，ellamorris5186）：上游真的挂在 **409** 上 ——
// `HTTP 409 {"status":"model_locked","currentModel":…,"requestedModel":…}`，
// 且**不带 currentInstanceId**，所以要 DELETE 必须先 GET 拿 instanceId。
function isModelLockedResponse(resp) {
  return String(resp?.data?.status || "") === "model_locked";
}

// 上游 `model_unavailable`：模型本身当前不可选（已从 free mode 撤下，或只在
// 某些时段开放，联合体里带 `availableHours`）。这是**全局**结果，和账号无关。
//
// ⚠️ 官方 FREEBUFF_GATE_CODES 把它定成 `{status: 410, endsTheSession: false}`，
// 注释写明为什么不能置 true：已发布客户端的编译期目录里还留着被下线的 id，
// 客户端下次发送还会再问一次；置 true 会让每次重发都变成一次新 admission ——
// 正是 #1801 里让 limited tier admissions 涨 2.5 倍、91% 会话卡在 0.1 unit
// 下限的那个循环。所以拿到它绝不能删会话/重建会话，也绝不能冷却账号或换号
// （换号只是把同一个全局结果再要一遍），只能立刻把原因回给客户端。
class ModelUnavailableError extends Error {
  constructor(requestedModel, availableHours, detail) {
    super(`model_unavailable: ${requestedModel || "model"} is not selectable right now`);
    this.name = "ModelUnavailableError";
    this.requestedModel = requestedModel || null;
    this.availableHours = availableHours || null;
    this.detail = detail || "";
  }
}

// session 联合体形态（POST/GET /session）：判别式同样只看 body 的 status。
function throwIfModelUnavailableResponse(resp, sessionModel) {
  const data = resp?.data;
  if (String(data?.status || "") !== "model_unavailable") return;
  throw new ModelUnavailableError(data.requestedModel || sessionModel, data.availableHours);
}

// chat gate 形态：必须 code + HTTP status **同时**匹配（官方注释：410 本身也是
// 普通 provider 结果，且上游 error body 可能回显同名 code，只对一半会让无关故障
// 冒充 gate）。410 上的另一个 code 是 session_expired，由 isStaleSessionGate 处理，
// 两者互不干扰。
function isModelUnavailableGate(status, body) {
  if (status !== 410) return false;
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  return hasExactErrorCode(parsed, "model_unavailable");
}

// free mode 的请求级 gate：403 且 body 报了 free_mode_* 名字
// （free_mode_legacy_luna_agent / free_mode_cli_required / free_mode_invalid_agent_model…）。
// 这类结果跟账号、跟出口节点都无关 —— 全池每个号问到的都是同一句话，而每次换号重试
// 都要先建一次会话（真扣 admission 额度：luna 一天只有 3 次）。所以与 400 同口径：
// 不冷却、不换号，直接把上游原文回给客户端。
function isFreeModeGate(status, body) {
  if (status !== 403) return false;
  const state = findStructuredState(parseJsonBody(body));
  return typeof state === "string" && state.startsWith("free_mode_");
}

function modelUnavailableResponse(error) {
  const model = error?.requestedModel ? String(error.requestedModel) : "该模型";
  const hours = error?.availableHours ? `，开放时段：${error.availableHours}` : "";
  return jsonResponse({
    error: {
      message: `上游当前不提供 ${model}（model_unavailable）${hours}。`
        + `这是上游的全局状态，换账号也一样，请改用其他模型。`,
      type: "model_unavailable",
      requestedModel: error?.requestedModel || null,
      ...(error?.availableHours ? { availableHours: error.availableHours } : {}),
    },
  }, 503);
}



// 上游始终以 SSE 返回，即使客户端请求的是非流式响应。HTTP 200 或首个字节
// 本身并不代表模型真的开始输出：角色、usage、finish-only 和 [DONE] 都可能
// 在额度/会话异常时单独出现。预读到首个有意义增量后再把原始字节重放给下游，
// 这样空流可以在建会话重试循环内恢复，而不会先把 200 错误交给客户端。
function ssePayloadHasMeaningfulOutput(payload) {
  if (!payload || payload === "[DONE]") return false;
  let obj;
  try { obj = unwrapData(JSON.parse(payload)); } catch { return false; }
  const delta = obj?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return false;
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (collectReasoningTexts(delta.reasoning_content).length > 0) return true;
  if (Array.isArray(delta.tool_calls)) {
    return delta.tool_calls.some((call) => {
      if (!call || typeof call !== "object") return false;
      const fn = call.function;
      return !!(call.id || (fn && typeof fn === "object" && (fn.name || fn.arguments)));
    });
  }
  return false;
}

function scanSseForMeaningfulOutput(state, text, final = false) {
  state.pending += text || "";
  const lines = state.pending.split("\n");
  state.pending = final ? "" : (lines.pop() || "");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      state.doneSeen = true;
      return false;
    }
    if (ssePayloadHasMeaningfulOutput(payload)) {
      state.meaningful = true;
      return true;
    }
  }
  return state.meaningful;
}

function preflightErrorShouldPropagate(error) {
  if (!error) return false;
  if (error instanceof EmptyUpstreamStreamError || error instanceof QuotaExhaustedError) return true;
  if (error.name === "AbortError") return true;
  return /request aborted|client disconnected/i.test(String(error.message || error));
}

async function preflightMeaningfulSseResponse(response, readNext = null, hooks = {}) {
  if (!response?.body) throw new EmptyUpstreamStreamError();
  const reader = response.body.getReader();
  const buffered = [];
  const scanner = { pending: "", meaningful: false, doneSeen: false };
  const decoder = new TextDecoder();
  let readError = null;
  try {
    while (!scanner.meaningful) {
      let next;
      try {
        next = await (readNext ? readNext(reader) : reader.read());
      } catch (error) {
        readError = error;
        break;
      }
      if (next.done) {
        scanSseForMeaningfulOutput(scanner, decoder.decode(), true);
        break;
      }
      if (next.value && next.value.byteLength) {
        const copy = new Uint8Array(next.value);
        buffered.push(copy);
        scanSseForMeaningfulOutput(scanner, decoder.decode(copy, { stream: true }));
        if (scanner.doneSeen) break;
      }
    }

    if (!scanner.meaningful) {
      try { await reader.cancel(readError || new EmptyUpstreamStreamError()); } catch {}
      if (readError && preflightErrorShouldPropagate(readError)) throw readError;
      throw new EmptyUpstreamStreamError();
    }

    const replay = new ReadableStream({
      async start(controller) {
        try {
          for (const chunk of buffered) controller.enqueue(chunk);
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value && next.value.byteLength) controller.enqueue(next.value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          try { reader.releaseLock(); } catch {}
          try { hooks.onDone?.(); } catch {}
        }
      },
      cancel(reason) {
        try { hooks.onCancel?.(reason); } catch {}
        return reader.cancel(reason);
      },
    });
    return new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  }
}

function isExpectedFlowError(error) {
  return error instanceof TerminalAccountStateError
    || error instanceof TransientAccountAuthError
    || error instanceof EgressRejectedError
    || error instanceof QuotaExhaustedError
    || error instanceof WaitingRoomError
    || error instanceof ClientSessionLimitError
    || error instanceof ModelLockedError
    || error instanceof ModelUnavailableError
    || error instanceof EmptyUpstreamStreamError;
}

function throwIfAdmissionResponse(status, payload, headers, model, quota = null) {
  const decision = classifyRateLimit(payload, status, headers, model, Date.now(), quota);
  if (decision.reason === "egress") throw new EgressRejectedError(decision, status);
  if (decision.reason === "waiting_room") {
    throw new WaitingRoomError(decision.retryAfterMs || 30 * 1000);
  }
  if (decision.reason !== "quota") return;
  if (status !== 429 && !["rate_limited", "rate_limit_exceeded", "quota_exceeded", "spend_limited"].includes(decision.state)) return;
  throw new QuotaExhaustedError(decision);
}

function invalidateSessionCache(token) {
  const prefix = token + ":";
  for (const key of sessCache.keys()) {
    if (key.startsWith(prefix)) sessCache.delete(key);
  }
}

async function deleteUpstreamSession(token, instanceId, model, { force = false } = {}) {
  invalidateSessionCache(token);
  if (!instanceId) return;
  // 失效安全窗口内同一 token:model 不重复 DELETE 上游（避免连续 409 时
  // 疯狂 DELETE+POST 循环打爆上游）。窗口信息在调用方重建前用
  // wasRecentlyInvalidated 检查，这里只是记录时间戳 + 跳过重复 DELETE。
  //
  // ⚠️ `model` 必须是**被删掉的那个会话**的模型，不能传"接下来要建的模型"：
  // 换模型（ds4p → luna）是一次合法切换，不是同模型重建循环。传错会让
  // luna 的窗口被 ds4p 的切换动作占住，30s 内再要 luna 时 DELETE 被当成
  // 重复调用跳过，POST 必然拿到 model_locked。
  //
  // force：上游已经明确告诉我们"有一个别的模型的会话挡着"（GET 看到 active
  // 换模型、或 POST 回 model_locked）。那是权威事实而不是猜测性重建，必须真删，
  // 否则窗口会把换模型永久锁死。窗口只用来防同模型的 DELETE+POST 循环。
  const key = token + ":" + (model || "");
  const last = sessionInvalidated.get(key);
  if (!force && last && Date.now() - last < INVALIDATION_WINDOW_MS) return;
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

// 流式收敛护栏（思考循环兜底）。上游一旦陷入推理自环，连接会一直活着、字节一直在流，
// 客户端 signal 不动就没人喊停 —— 账号租约被无限占用。这里只做两条纯收敛判据，
// 不解析内容、不改正常路径：
//   - 空闲：连续 STREAM_IDLE_TIMEOUT_MS 没有任何字节 → 判定卡死
//   - 总时长：超过 STREAM_MAX_DURATION_MS → 判定失控
// 两者都按"优雅结束"处理：cancel 上游 reader 并正常 close 下游，让既有 pipe 的
// finally 照常跑完（记账 + releaseToken + [DONE]/response.completed）。
// ponytail: 时长上限是钝器 —— 它拦得住"一直吐推理"的自环，但也会截断真正需要
// 超过 10 分钟的单次回答。真正精确的判据是"只出 reasoning、零 content 且超过 N
// 字符"，那需要在护栏里再解析一遍 SSE；等出现被误伤的实例再升级。
const STREAM_IDLE_TIMEOUT_MS = 60000;
const STREAM_MAX_DURATION_MS = 600000;

function guardStreamConvergence(body, label = "", opts = {}) {
  if (!body || typeof body.getReader !== "function") return body;
  const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : STREAM_IDLE_TIMEOUT_MS;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : STREAM_MAX_DURATION_MS;
  const reader = body.getReader();
  const startedAt = Date.now();
  return new ReadableStream({
    async pull(controller) {
      let timer = null;
      const idle = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __guard: "idle" }), idleMs);
      });
      let next;
      try {
        next = await Promise.race([reader.read(), idle]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      if (next && next.__guard === "idle") {
        console.warn(`[stream-guard] idle >${idleMs}ms, closing${label ? " " + label : ""}`);
        try { await reader.cancel(new Error("stream idle timeout")); } catch {}
        controller.close();
        return;
      }
      if (next.done) { controller.close(); return; }
      if (Date.now() - startedAt > maxMs) {
        console.warn(`[stream-guard] exceeded ${maxMs}ms, closing${label ? " " + label : ""}`);
        try { await reader.cancel(new Error("stream duration cap")); } catch {}
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
}

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
const defaultUpstreamFetch = typeof fetch === "function" ? fetch : globalThis.fetch;
let upstreamFetch = defaultUpstreamFetch;
let upstreamFetchForAccount = null;
let accountRouteReady = null;
let configuredUpstreamFetch = null;
let upstreamRoutingConfigured = false;
const upstreamEgressByHeaders = new WeakMap();

async function authenticatedUpstreamFetch(token, url, init = {}) {
  if (token && accountIsBlocked(token)) {
    const state = durableAccountState(token)?.state || "blocked";
    throw new TerminalAccountStateError(state, 403);
  }
  const accountRoute = token && upstreamFetchForAccount ? upstreamFetchForAccount(token) : null;
  const accountFetch = typeof accountRoute === "function" ? accountRoute : accountRoute?.fetch;
  const globalFetch = configuredUpstreamFetch?.() || upstreamFetch || defaultUpstreamFetch;
  try {
    const response = await (typeof accountFetch === "function" ? accountFetch : globalFetch)(url, init);
    if (response?.headers && accountRoute?.egress && typeof accountRoute.egress === "object") {
      upstreamEgressByHeaders.set(response.headers, accountRoute.egress);
    }
    return response;
  } catch (error) {
    if (error?.code === "ACCOUNT_EGRESS_UNAVAILABLE") {
      throw new EgressRejectedError({ state: "egress_unavailable" }, 503);
    }
    throw error;
  }
}

// 出站 IP 被上游拒绝时的回调（env.FREEBUFF_ON_EGRESS_REJECT）。这里只知道「被拒了、
// 什么原因」，节点名在 server/proxy.mjs 手里，所以把分类结果丢过去由它归因到当前节点。
let onEgressReject = null;

async function up(method, path, token, body, extraHeaders = {}, timeoutMs = UPSTREAM_TIMEOUT_MS, options = {}) {
  if (token && accountIsBlocked(token)) {
    const state = durableAccountState(token)?.state || "blocked";
    throw new TerminalAccountStateError(state, 403);
  }
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

  const resp = await authenticatedUpstreamFetch(token, CODEBUFF_API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const terminalState = terminalStateFromResponse(resp.status, data ?? text);
  if (terminalState) {
    recordAccountObservation(token, resp.status, data ?? text, { headers: resp.headers });
    throw new TerminalAccountStateError(terminalState, resp.status);
  }
  if (resp.status === 401 && !options.skipAuthConfirmation) {
    // GET session 自身就是独立、无消耗的凭据复核：它明确返回 401 时可直接
    // 确认终态，不要再递归探测。其他 endpoint 的 401 则先复核一次；复核
    // 成功只中止当前账号链并短暂冷却，不能永久摘号。
    if (method === "GET" && path === "/api/v1/freebuff/session") {
      recordAccountObservation(token, resp.status, data ?? text, {
        headers: resp.headers,
        confirmedState: "token_invalid",
      });
      throw new TerminalAccountStateError("token_invalid", 401);
    }
    recordAccountObservation(token, resp.status, data ?? text, { headers: resp.headers });
    await confirmTokenInvalid(token, null);
    throw new TransientAccountAuthError();
  }
  return { status: resp.status, data, text, headers: resp.headers };
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
  if (cached.state === "banned" || cached.state === "token_invalid") {
    throw new TerminalAccountStateError(cached.state, cached.state === "token_invalid" ? 401 : 403);
  }
  const now = Date.now();
  const quotaState = ["rate_limited", "rate_limit_exceeded", "quota_exceeded", "spend_limited"]
    .includes(cached.state);
  if (quotaState && Number.isFinite(Number(cached.quotaUntil)) && now >= Number(cached.quotaUntil)) return;
  const hasQuotaSnapshot = cached.quota && Number.isFinite(Number(cached.quotaCheckedAt));
  const freshnessAt = hasQuotaSnapshot ? Number(cached.quotaCheckedAt) : Number(cached.checkedAt);
  if (!Number.isFinite(freshnessAt) || now - freshnessAt > HEALTH_OBSERVATION_TTL_MS) return;
  if (isQuotaExhausted(cached, sessionModel)) {
    const snapshotScope = exhaustedQuotaScope(cached, sessionModel);
    throw new QuotaExhaustedError({
      ...cached,
      scope: cached.state === "spend_limited"
        ? "account"
        : cached.quotaScope || snapshotScope || quotaScopeForModel(sessionModel, cached.quota || null),
    });
  }
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
  const request = authenticatedUpstreamFetch(token, url, { ...init, signal: controller.signal });
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
    // HTTP 错误由调用方统一读取 body 后分类。不能先把空 body 当作空流，
    // 否则 401/403/429 会错误走 session 重建并产生新的 Bearer 请求。
    if (!response.ok) return response;
    if (!response.body) throw new EmptyUpstreamStreamError();

    // 首个有效增量前持续做额度保护；角色/usage/[DONE] 等元数据不能提前
    // 让请求进入 200 成功态。预检返回的 body 会重放已读字节，再继续消费原 reader。
    const prepared = await preflightMeaningfulSseResponse(
      response,
      async (activeReader) => {
        reader = activeReader;
        try {
          return await raceWithRequestAbort([activeReader.read(), armProbe()]);
        } finally {
          clearProbe();
        }
      },
      {
        onDone: cleanupRequestAbort,
        onCancel(reason) {
          cleanupRequestAbort();
          try { controller.abort(reason); } catch { controller.abort(); }
        },
      },
    );
    transferred = true;
    return prepared;
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
    } catch (e) {
      if (e instanceof TerminalAccountStateError) throw e;
      failures.push("ads:" + String(e && e.message || e).slice(0, 80));
    }
  }
  // 2) usage 触碰（30 分钟一次）
  if (behaviorDue("usage:" + token)) {
    try {
      await enqueueUp("POST", "/api/v1/usage", token,
        { fingerprintId: clientFingerprint },
        { "Content-Type": "application/json" }, 6000);
    } catch (e) {
      if (e instanceof TerminalAccountStateError) throw e;
      failures.push("usage:" + String(e && e.message || e).slice(0, 80));
    }
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
      headers: cur.headers,
      model: sessionModel,
    });
    throwIfTerminalResponse(token, cur.status, cur.data);
    throwIfAdmissionResponse(cur.status, cur.data, cur.headers, sessionModel,
      cur.data?.rateLimitsByModel || acctHealth.get(token)?.quota || null);
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

async function createSession(token, sessionModel, forceCreate = false, client = null) {
  // 0) 正常客户端行为：广告链 + usage 触碰（30 分钟节流，失败静默）
  try {
    await runNormalClientBehavior(token, stableFingerprint(token));
  } catch (e) {
    if (e instanceof TerminalAccountStateError) throw e;
  }
  const key = token + ":" + sessionModel;

  // 1) 缓存命中 → optimistic reuse（verify window）：
  //    剩余 ≥ SESSION_REUSE_SAFE_MS（60s）直接复用，不打上游；
  //    临界区（30-60s）乐观复用 + 后台异步验证一次，避免长流被反复重建。
  if (!forceCreate) {
    const cached = sessCache.get(key);
    if (cached) {
      const remain = sessionRemainingMs(cached);
      const preserveBudget = client?.owner !== true && Number(client?.dailyLimit) > 0;
      if (preserveBudget && remain > 0) {
        if (remain >= SESSION_REUSE_SAFE_MS - SESSION_VERIFY_WINDOW_MS
          && remain < SESSION_REUSE_SAFE_MS) {
          verifySessionInBackground(token, sessionModel).catch(() => {});
        }
        return claimClientSession(client, token, sessionModel, cached);
      }
      if (remain >= SESSION_REUSE_SAFE_MS) return claimClientSession(client, token, sessionModel, cached);
      if (remain > 0 && remain >= SESSION_REUSE_SAFE_MS - SESSION_VERIFY_WINDOW_MS) {
        // 临界区：先复用，同时后台验证（验证失败删缓存，下次请求重建）
        verifySessionInBackground(token, sessionModel).catch(() => {});
        return claimClientSession(client, token, sessionModel, cached);
      }
      // 剩余不足 30s（或已过期）：删除，走重建
      sessCache.delete(key);
    }
  }

  // 2) 真正建 session（single-flight 去重：并发请求共享同一次 POST）。
  //    forceCreate=true 也必须走 single-flight —— 强制重建场景多个并发
  //    请求同时重建，也会互相顶掉（409 session_superseded 的根源）。
  const flightKey = key + (forceCreate ? ":force" : "");
  let reservation = null;
  try {
    const session = await singleFlight(flightKey, async () => {
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
        headers: cur.headers,
        model: sessionModel,
      });
      if (cur.status === 401) await confirmTokenInvalid(token, sessionModel);
      throwIfTerminalResponse(token, cur.status, cur.data);
      throwIfAdmissionResponse(cur.status, cur.data, cur.headers, sessionModel,
        cur.data?.rateLimitsByModel || acctHealth.get(token)?.quota || null);
      throwIfModelUnavailableResponse(cur, sessionModel);
      if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
        const cm = cur.data.model;
        if (!cm || cm === sessionModel) {
          const s = normalizeSession(cur.data, sessionModel);
          sessCache.set(key, s);
          return s;
        }
        // 换模型：删掉的是 cm 那个会话，窗口就要记在 cm 头上（见 deleteUpstreamSession）。
        // GET 已经确认它 active，是权威事实 → force 真删，否则 POST 必然 model_locked。
        await deleteUpstreamSession(token, cur.data.instanceId, cm, { force: true });
      }
    }

    // 3) create（可能 queue）。桌面版签名：POST 带预生成 x-freebuff-instance-id（客户端 UUID）。
    //    ⚠️ 实测（2026-08-10）：multi-session:1 创建的实例 chat 报 428 waiting_room_required
    //    （服务端 chat gate 不识别多会话实例），所以这里用单会话 + 预生成 instance-id：
    //    既保留桌面版客户端预生成实例的指纹，又确保 chat 能被识别。
    reservation = reserveClientSession(client, flightKey);
    const postSession = async () => {
      const instId = crypto.randomUUID();
      const resp = await enqueueUp("POST", "/api/v1/freebuff/session", token, undefined,
        { "x-freebuff-model": sessionModel, "x-freebuff-instance-id": instId, "Content-Type": "application/json" }, SESSION_TIMEOUT_MS);
      recordAccountObservation(token, resp.status, resp.data, {
        quota: resp.data?.rateLimitsByModel || null,
        uid: resp.data?.uid || null,
        retryAfterMs: resp.data?.retryAfterMs,
        headers: resp.headers,
        model: sessionModel,
      });
      if (resp.status === 401) await confirmTokenInvalid(token, sessionModel);
      throwIfTerminalResponse(token, resp.status, resp.data);
      throwIfAdmissionResponse(resp.status, resp.data, resp.headers, sessionModel,
        resp.data?.rateLimitsByModel || acctHealth.get(token)?.quota || null);
      // model_unavailable：模型全局不可选（联合体里带 availableHours）。不是这个号
      // 的问题，换号只会把同一个结果再要一遍，所以直接抛到最外层回客户端。
      throwIfModelUnavailableResponse(resp, sessionModel);
      return resp;
    };
    let r = await postSession();
    // model_locked：账号还挂着另一个模型的会话（上面的 GET 没看到，或 forceCreate
    // 跳过了 GET）。官方唯一处置是 DELETE 旧会话再 POST —— 这里补一次 GET 拿
    // instanceId（model_locked 本身不带 currentInstanceId），删掉再发一次。
    //
    // ⚠️ 只认 body 里的 status，不绑 HTTP status：POST /session 的响应是
    // FreebuffSessionServerResponse 联合体，判别式就是 body 的 `status` 字段
    // （官方那条「code + HTTP status 必须同时匹配」的规则是给 chat 的
    // FREEBUFF_GATE_CODES 的，不是给 session 联合体的）。私有服务端把
    // model_locked 挂在 200 还是 409 上都能正确恢复。
    if (isModelLockedResponse(r)) {
      const lockedModel = String(r.data.currentModel || "").trim() || null;
      const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
        undefined, SESSION_TIMEOUT_MS);
      recordAccountObservation(token, cur.status, cur.data, {
        quota: cur.data?.rateLimitsByModel || null,
        headers: cur.headers,
        model: sessionModel,
      });
      throwIfTerminalResponse(token, cur.status, cur.data);
      const lockedInstance = cur.data?.instanceId || null;
      if (lockedInstance) {
        await deleteUpstreamSession(token, lockedInstance, cur.data?.model || lockedModel,
          { force: true });
        r = await postSession();
      }
      if (isModelLockedResponse(r)) {
        throw new ModelLockedError(r.data.currentModel || lockedModel, sessionModel);
      }
    }
    if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
      const s = normalizeSession(r.data, sessionModel);
      sessCache.set(key, s);
      reservation?.commit(token, sessionModel, s);
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
          headers: q.headers,
          model: sessionModel,
        });
        throwIfTerminalResponse(token, q.status, q.data);
        throwIfAdmissionResponse(q.status, q.data, q.headers, sessionModel,
          q.data?.rateLimitsByModel || acctHealth.get(token)?.quota || null);
        if (q.status === 200 && q.data?.status === "active") {
          const s = normalizeSession({ ...q.data, instanceId: q.data.instanceId || inst }, sessionModel);
          sessCache.set(key, s);
          reservation?.commit(token, sessionModel, s);
          return s;
        }
      }
      throw new WaitingRoomError();
    }
    if (r.status === 409) throw new Error("session_model_mismatch: " + String(r.data?.message || r.data?.error || "上游拒绝该模型"));
    throw new Error("create session failed: " + r.status + " " + (r.text || "").slice(0, 300));
    });
    return claimClientSession(client, token, sessionModel, session);
  } catch (error) {
    reservation?.cancel();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// agent-runs 生命周期
// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function startRun(token, agentId, ancestors = [], sessionModel = null) {
  const r = await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "START", agentId, ancestorRunIds: ancestors }, undefined, SESSION_TIMEOUT_MS);
  if (r.status !== 200 || !r.data?.runId) {
    recordAccountObservation(token, r.status, r.data ?? r.text, {
      headers: r.headers,
      model: sessionModel,
    });
    throwIfTerminalResponse(token, r.status, r.data ?? r.text);
    throwIfAdmissionResponse(r.status, r.data ?? r.text, r.headers, sessionModel,
      acctHealth.get(token)?.quota || null);
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

async function startRunChain(token, agentId, sessionModel = null) {
  const key = token + ":" + agentId;
  const hit = runCache.get(key);
  if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) {
    return { runId: hit.runId, agentId, startedAt: utcNow(), childRunId: hit.childRunId, cached: true };
  }
  const startedAt = utcNow();
  const runId = await startRun(token, agentId, [], sessionModel);
  // base3 harness 是单循环：不 spawn 子 agent，压缩在 harness 内部机械完成。
  // 给它挂 context-pruner 子 run 会多烧一次上游调用，实测也不需要。
  const childRunId = agentId.startsWith("base3")
    ? null
    : await startRun(token, CONTEXT_PRUNER_AGENT, [runId], sessionModel);
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
    // 历史里的思考痕迹绝不回灌上游。DeepSeek 官方要求多轮请求不要带回上一轮的
    // reasoning_content：模型看到自己上一轮未收束的思考，会倾向接着想下去，这是
    // ds4p/ds4f 思考循环在第二轮更易复现的原因。Anthropic 入站（anthropicText 只留
    // type==="text"）和 Responses 入站（显式 skip reasoning 条目）本来就不带，这里
    // 把 OpenAI 这条路径对齐。reasoning_used_as_content 是我们自己打的标记，同样不外发。
    delete item.reasoning_content;
    delete item.reasoning_used_as_content;
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
//   - meta/muse-spark:   EFFORTS_THROUGH_XHIGH（minimal..xhigh，ALWAYS reasons，none=400）
//   - gpt-5.6-luna:      见 MODEL_PINNED_EFFORT —— 目录里写的是 EFFORTS_THROUGH_MAX，
//                        但那是 OpenRouter 广告的档位，实际链路只收 high
//   - minimax-m3 / mimo / fable：无 effort 档位或不接受 effort → 不在表中，原样透传
const MODEL_EFFORTS = {
  "deepseek/deepseek-v4-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["low", "high", "max"],
  "meta/muse-spark-1.2-contributor": ["minimal", "low", "medium", "high", "xhigh"],
  // 官方目录给 glm-5.3-flash 不带 reasoningEffort 字段（= 不在 effort 表里），
  // 但实测 2026-08-27（容器内直连 12 个 OpenRouter endpoint）与目录相反：
  // minimal/low/medium/high/xhigh/max 全部 200，ultra 被上游 400 并回吐合法集
  //   "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"
  // none 另有一条 400："Reasoning is mandatory for this endpoint and cannot be disabled."
  // 目录漏字段 ≠ 不收 effort，按实测建表：ultra 下取 max，none 由 clamp 兜到 minimal。
  "z-ai/glm-5.3-flash": ["minimal", "low", "medium", "high", "xhigh", "max"],
  // 官方 OX_ALPHA_REASONING_EFFORTS = ['low','high','max']（d534205），
  // defaultEffort:'high' 只是未点名时的默认，不是唯一可发值。客户端点名 max
  // 原样透传（官方 Web UI 自己就发 max）；low/medium 这类不在 ladder 上的值
  // 由 clampReasoningEffort 下取到 high。
  "stealth/ox-alpha": ["low", "high", "max"],
};

// 服务端钉死思考强度的模型：这里的值不是「上限」而是「唯一可发的值」。
// gpt-5.6-luna 走 OpenRouter 的 openai 直连路由，Freebuff 的
// applyFreebuffReasoningDefaults 会给这条路由注入 reasoning.effort='high'
// （FREEBUFF_GPT_5_6_LUNA_REASONING_EFFORT）。它只看请求里有没有 reasoning 对象，
// 不看我们发的扁平 reasoning_effort，于是两个字段同时存在；取值不一致时
// OpenRouter 直接 400：
//   "reasoning_effort" and "reasoning.effort" are both provided with conflicting values
// 实测 2026-08-17（容器内打点抓上游原文）：xhigh / max / low 全部 400，
// 只有 high 因为和注入值相同而不冲突。
// 所以 luna 不能走 MODEL_EFFORTS 的 clamp-down —— clamp 只保证「不超上限」，
// low/none/auto 这类值仍会原样发出去继续 400。必须无条件改写成 high。
const MODEL_PINNED_EFFORT = {
  "openai/gpt-5.6-luna": "high",
  // stealth/ox-alpha 曾在此钉死 high——那是把 defaultEffort 误当唯一可发值的过度矫正：
  // 官方 efforts 表明确给 ['low','high','max']，且注入条件是「调用方未点名才注入」
  // （freebuff-models.ts:74-78），点名 max 不存在 luna 那种双字段冲突。已移入 MODEL_EFFORTS。
};

function clampReasoningEffort(requested, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return requested;
  // none/disabled/off 不在 ladder 上，但它是「比 minimal 更低」的语义档，不是未知值。
  // 列了 efforts 表的模型都是强制思考的 endpoint，收到 none 会 400
  // （glm-5.3-flash: "Reasoning is mandatory for this endpoint and cannot be disabled."；
  // muse-spark 同样 ALWAYS reasons）。按 rank=-1 走下面的「所有档都高于请求」分支，
  // 兜到最低可用档 —— 关思考的客户端（Anthropic thinking.type=disabled、
  // budget_tokens=0）因此拿到最省的一档而不是 400。
  const off = namedEffort(requested) === "none";
  const wanted = off ? -1 : REASONING_EFFORT_RANK.indexOf(requested);
  if (wanted < 0 && !off) return requested; // 真正的未知档位 → 原样透传，交由上游
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
  const pinned = MODEL_PINNED_EFFORT[model];
  if (pinned) return pinned; // 钉死档位：任何值（含 none/auto 这种不在 ladder 上的）都改写
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
  // 上游永远是流式（见上一行），而流式只有显式 include_usage 才会在末尾发 usage 块。
  // 不带它 → 调用日志和概况/Key 累计全部记 0 token（成功但 0 消耗）。客户端自己
  // 有没有要 usage 是另一回事，透传时再按客户端口径决定要不要把这个块发下去。
  payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
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
  if (isPausedModelId(target) || isHiddenModelId(target) || !modelIsAvailable(target)) return null;
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
  if (isPausedModelId(target) || isHiddenModelId(target)) return null;

  // 受 endpoint 管理的模型必须在 TTL 到期后重新确认。普通模型仍可直接命中
  // 已发布快照，不会被公开源刷新阻塞。
  if (ENDPOINT_CHECK_MODEL_IDS.has(target)) {
    try {
      if (dynamicModelsRefreshFlight) await dynamicModelsRefreshFlight;
      else {
        const cacheStale = !Array.isArray(dynamicModelsCache.models)
          || Date.now() - Number(dynamicModelsCache.fetchedAt || 0) >= DYNAMIC_MODELS_REFRESH_MS;
        if (cacheStale) await refreshDynamicModelsIfStale();
        if (endpointAvailabilityNeedsRetry(target)) await refreshEndpointModelAvailability(target);
      }
    } catch {}
    return findModelConfig(target);
  }

  if (!modelIsAvailable(target)) return null;
  let hit = findModelConfig(target);
  // 已发布快照里的普通模型可直接用；快照里没有的模型等待当前刷新，才能
  // 判断它是否刚被官方加入。
  if (hit) return hit;
  if (dynamicModelsRefreshFlight) {
    try { await dynamicModelsRefreshFlight; } catch {}
    if (!modelIsAvailable(target)) return null;
    hit = findModelConfig(target);
    if (hit) return hit;
  }
  try {
    const { cache: dyn } = await refreshDynamicModelsIfStale();
    if (dyn && dyn.models) {
      // Endpoint 可用性检查可能刚在刷新阶段更新；统一再过一次本地闸门，
      // 避免冷启动首笔请求绕过已确认的不可用状态。
      hit = dyn.models.find((m) => m.id === target) || null;
      if (hit && modelIsAvailable(target)) return hit;
    }
  } catch {}
  return findModelConfig(target);
}

async function handleChat(request, env, client = null) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  // 顶层 thinking 参数 → reasoning_effort 归一化（新 OpenAI SDK 兼容）
  params = normalizeChatThinking(params);
  return executeChat(env, params, mc, isStream, "chat", request.signal, client);
}

// OpenAI Responses API（/v1/responses）入口：把 Responses 请求翻译成 chat completions 上游调用
async function handleResponses(request, env, client = null) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, responsesToChatParams(params, mc), mc, isStream, "responses", request.signal, client);
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
async function executeCodeReview(env, chatParams, mc, isStream, mode, requestSignal = null, client = null) {
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
  let lastEgressUnavailable = false;
  const attempted = new Set();
  let pinnedToken = null; // 上游抖动后待重试的同一个号
  let sameAccountRetries = 0;
  const switchBudget = Math.min(maxAccountSwitches(env), pool.length);
  const waitingBudget = Math.min(maxWaitingRoomSwitches(env), pool.length);
  let accountSwitches = 0;
  let waitingRoomSwitches = 0;
  const chainBudgetMs = retryChainBudgetMs(env);
  const chainStart = Date.now();
  for (let acctTry = 0; acctTry < switchBudget + waitingBudget + SAME_ACCOUNT_TRANSIENT_RETRIES; acctTry++) {
    throwIfRequestAborted(requestSignal);
    // 时间总预算：只拦「再起一个新号的尝试」，正在跑的尝试不拦。第一个号
    // （acctTry === 0）永远试 —— 预算管的是换号链的长度，不是把请求直接拒掉。
    if (acctTry > 0 && Date.now() - chainStart >= chainBudgetMs) {
      if (debug) console.log(`[retry-chain] budget ${chainBudgetMs}ms exhausted after ${acctTry} attempts`);
      break;
    }
    // 上游抖动过的号优先原地重试；拿不回来（被隔离/冷却/占用）才正常选号。
    let acct = pinnedToken ? retakeToken(env, pinnedToken, mc.session) : null;
    pinnedToken = null;
    if (!acct) {
      // 换号计数只在这里：pinnedToken 命中走的是同号原地重试，复用已有会话，不烧
      // admission，也就不该占换号预算、不需要抖动。
      // 上一个号是被 waiting room 挡住的：那不是这个号的失败，也没扣到 admission，
      // 走独立的小预算，不占 MAX_ACCOUNT_SWITCHES（否则整池被队列挡住就直接 503）。
      const waitingSwitch = lastWaitingRetryAfter != null && waitingRoomSwitches < waitingBudget;
      if (!waitingSwitch && accountSwitches >= switchBudget) break;
      // 第一个号不是「换号」，不等；之后每次换号前打散时间特征。
      if (accountSwitches + waitingRoomSwitches > 0) await sleep(accountSwitchJitterMs(env));
      if (waitingSwitch) waitingRoomSwitches += 1;
      else accountSwitches += 1;
      acct = await pickTokenWithSessionWait(
        env, mc.session, attempted, requestSignal,
        attempted.size === 0 ? sessionLeaseWaitMs(env) : 0,
        client,
      );
    }
    const token = acct ? acct.token : null;
    if (!token) {
      recordRequest(mc && mc.id ? mc.id : "", null, false);
      if (lastWaitingRetryAfter) return waitingRoomResponse(lastWaitingRetryAfter, mc.session);
      if (lastEgressUnavailable) return egressRejectedResponse("egress_unavailable");
      return poolExhaustionResponse(env, mc.session);
    }
    attempted.add(token);
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");
    // 429 本地锁（与 executeChat 一致）：冷却中的 quota 号直接本地回 429
    const lock = scopedCooldownInfo(token, mc.session);
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
      const t0 = Date.now();
      let effort = "";
      const sess = await createSession(token, mc.session, false, client);
      throwIfRequestAborted(requestSignal);
      const root = await startRunChain(token, mc.root_agent || mc.agent, mc.session);
      throwIfRequestAborted(requestSignal);
      rootRunId = root.runId;
      // Desktop 协议的关键：reviewer 是 root run 的子 run。
      reviewerRunId = await startRun(token, reviewerAgent, [rootRunId], mc.session);
      if (debug) console.log(`[review][acct ${acctTry + 1}] root=${rootRunId} reviewer=${reviewerRunId} model=${reviewerModel}`);

      const payload = buildReviewerPayload(chatParams, { ...mc, upstream: reviewerModel }, sess, reviewerRunId);
      effort = payload.reasoning_effort || "";
      const headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "x-freebuff-instance-id": sess.instanceId,
      };
      let resp = await authenticatedUpstreamFetch(token, CODEBUFF_API + "/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: isStream ? requestSignal : AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
      });
      if (resp.ok) resp = await preflightMeaningfulSseResponse(resp);
      if (!resp.ok) {
        lastEgressUnavailable = false;
        const text = await resp.text();
        recordAccountObservation(token, resp.status, text, { headers: resp.headers, model: mc.session });
        throwIfTerminalResponse(token, resp.status, text);
        if (resp.status === 401) {
          await confirmTokenInvalid(token, mc.session);
          throw new TransientAccountAuthError();
        }
        throwIfAdmissionResponse(resp.status, text, resp.headers, mc.session,
          acctHealth.get(token)?.quota || null);
        lastErrMsg = "reviewer upstream error: " + text.slice(0, 300);
        // 410 model_unavailable：模型全局不可选，换号/重建都拿同一个结果。
        // 与 400 同口径就地收尾原文回传，绝不冷却账号（见 ModelUnavailableError）。
        if (isModelUnavailableGate(resp.status, text)) {
          if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
          if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
          recordRequest(mc && mc.id ? mc.id : "", null, false);
          return modelUnavailableResponse(new ModelUnavailableError(mc.session, null, text));
        }
        if (resp.status === 400 || isFreeModeGate(resp.status, text)) {
          // 与 executeChat 同口径：400 是「请求本身不合法」，和账号无关。
          // 冷却+换号只会把整池冷掉（连别的模型一起打不通），换号也是同一个 400，
          // 最后还把上游原文换成"当前没有可用账号"。先收尾 run，再原文回传。
          // 403 free_mode_* gate 也是全池一致的答案，同样就地收尾。
          if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
          if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
          recordRequest(mc && mc.id ? mc.id : "", null, false);
          return jsonResponse({
            error: {
              message: lastErrMsg,
              type: resp.status === 400 ? "invalid_request_error" : "permission_error",
            },
          }, resp.status);
        } else {
          cooldown(token, parseCooldown(text, resp.status, resp.headers), { model: mc.session });
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
          try {
            // 与普通 chat 同口径：成功一次记一行调用日志 + 概况/Key 累计。
            recordChatCall(env, token, mc, effort, t0, info && info.firstTokenAt, info && info.usage, client);
            await finalize(info);
          } finally { releaseToken(token); }
        };
        const guardedBody = guardStreamConvergence(resp.body, mc.id);
        if (mode === "responses") pipeUpstreamToResponsesStream(guardedBody, writable, mc, onDone);
        else pipeUpstreamToClient(guardedBody, writable, onDone, !!chatParams?.stream_options?.include_usage);
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
      recordChatCall(env, token, mc, effort, t0, null, result && result.usage, client);
      return mode === "responses" ? jsonResponse(result, 200) : jsonResponse(result, 200);
    } catch (e) {
      if (requestSignal?.aborted) throw e;
      if (!isExpectedFlowError(e)) console.error("[code_review]", e);
      lastErrMsg = String(e.message || e);
      if (e instanceof EgressRejectedError) {
        if (e.state !== "egress_unavailable") {
          recordRequest(mc && mc.id ? mc.id : "", null, false);
          return egressRejectedResponse(e.state);
        }
        lastEgressUnavailable = true;
      } else {
        lastEgressUnavailable = false;
      }
      if (e instanceof ClientSessionLimitError) return clientSessionLimitResponse(e);
      // model_unavailable：模型被上游下线/当前时段不可选，是全局结果。换号拿到的
      // 还是同一个答案，重建会话更是白扣 admission，所以先收尾 run 再原文回传，
      // 绝不冷却账号（见 ModelUnavailableError）。
      if (e instanceof ModelUnavailableError) {
        if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
        if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
        callTotals.upstreamError++;
        recordRequest(mc && mc.id ? mc.id : "", null, false);
        return modelUnavailableResponse(e);
      }
      if (e instanceof WaitingRoomError || /session stayed queued|waiting.room/i.test(lastErrMsg)) {
        lastWaitingRetryAfter = e.retryAfterMs || 30 * 1000;
      } else lastWaitingRetryAfter = null;
      const terminal = e instanceof TerminalAccountStateError;
      // 上游抖动不是这个号的问题：原地重试，别换号白扣新账号的 session 创建额度。
      const retrySameAccount = isTransientUpstreamError(e)
        && sameAccountRetries < SAME_ACCOUNT_TRANSIENT_RETRIES
        && !accountIsBlocked(token);
      if (retrySameAccount) {
        pinnedToken = token;
        sameAccountRetries += 1;
      }
      if (!terminal && reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
      if (!terminal && rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
      if (e instanceof QuotaExhaustedError) {
        const ra = e.retryAfterMs || GENERIC_429_COOLDOWN_MS;
        cooldown(token, ra, {
          reason: "quota",
          retryAfterMs: ra,
          model: mc.session,
          scope: e.scope || quotaScopeForModel(mc.session, acctHealth.get(token)?.quota || null),
        });
      } else if (!terminal && !retrySameAccount && !(e instanceof WaitingRoomError) && !scopedCooldownInfo(token, mc.session)
        && (e instanceof TransientAccountAuthError
          || /start_run failed|timeout|timed out|abort|reviewer upstream/i.test(lastErrMsg))) {
        cooldown(token, lastWaitingRetryAfter || 60 * 1000, { model: mc.session });
      }
    } finally {
      if (!leaseTransferred) releaseToken(token);
    }
  }
  if (lastWaitingRetryAfter) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return waitingRoomResponse(lastWaitingRetryAfter, mc.session);
  }
  if (lastEgressUnavailable) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return egressRejectedResponse("egress_unavailable");
  }
  recordRequest(mc && mc.id ? mc.id : "", null, false);
  if (accountPoolExhaustion(env, mc.session).allUnavailable) return poolExhaustionResponse(env, mc.session);
  return jsonResponse({ error: { message: lastErrMsg || "code reviewer failed", type: "api_error" } }, 502);
}

// 客户端 key 闸门 + 上游执行。闸门只此一处：chat / responses / anthropic / code review
// 四条入口全都收口到这里，不必在十几个 return 分支上各贴一遍限额判断。
async function executeChat(env, chatParams, mc, isStream, mode, requestSignal = null, client = null) {
  const gate = openClientGate(client, mc);
  if (gate.error) return gate.error;
  let resp;
  try {
    resp = await executeChatPooled(env, chatParams, mc, isStream, mode, requestSignal, client);
  } catch (e) {
    gate.release();
    throw e;
  }
  // 流式成功：Response 已经能返回了，body 还在写 —— 槽位得等 body 到终态才放，
  // 否则 concurrency:1 的 key 能同时挂着无限条流。错误响应 body 是完整 JSON，立即放。
  if (isStream && resp && resp.body && resp.status < 400) {
    return new Response(resp.body.pipeThrough(releaseOnStreamEnd(gate.release)), {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  gate.release();
  return resp;
}

// chat completions 与 responses 共用的上游执行：多号重试 + session/run 生命周期 + 流式/非流式出口
// client 同时用于调用日志与 createSession 的每日 session 预算。
async function executeChatPooled(env, chatParams, mc, isStream, mode, requestSignal = null, client = null) {
  if (isCodeReviewRequest(chatParams)) return executeCodeReview(env, chatParams, mc, isStream, mode, requestSignal, client);
  syncAccountState(env);
  const debug = env.FREEBUFF_DEBUG === "true";
  const pool = parseAccounts(env);
  if (pool.length === 0) return jsonResponse({ error: { message: "缺少 FREEBUFF_TOKEN 环境变量", type: "config_error" } }, 503);

  // 请求内多号重试：一个号失败（超时/429/428 重建无效/run 失败）立即冷却并换下一个号，最多试完整个账号池。
  // 免费通道上游波动大（并发>1 即出问题、排队超时），单请求内换号比等客户端重试成功率高得多。
  let lastErrMsg = "";
  let lastWaitingRetryAfter = null;
  let lastEgressUnavailable = false;
  let lastModelLocked = null;
  const attempted = new Set();
  let pinnedToken = null; // 上游抖动后待重试的同一个号
  let sameAccountRetries = 0;
  const switchBudget = Math.min(maxAccountSwitches(env), pool.length);
  const waitingBudget = Math.min(maxWaitingRoomSwitches(env), pool.length);
  let accountSwitches = 0;
  let waitingRoomSwitches = 0;
  const chainBudgetMs = retryChainBudgetMs(env);
  const chainStart = Date.now();
  for (let acctTry = 0; acctTry < switchBudget + waitingBudget + SAME_ACCOUNT_TRANSIENT_RETRIES; acctTry++) {
    throwIfRequestAborted(requestSignal);
    // 时间总预算：只拦「再起一个新号的尝试」，正在跑的尝试不拦。第一个号
    // （acctTry === 0）永远试 —— 预算管的是换号链的长度，不是把请求直接拒掉。
    if (acctTry > 0 && Date.now() - chainStart >= chainBudgetMs) {
      if (debug) console.log(`[retry-chain] budget ${chainBudgetMs}ms exhausted after ${acctTry} attempts`);
      break;
    }
    // 上游抖动过的号优先原地重试；拿不回来（被隔离/冷却/占用）才正常选号。
    let acct = pinnedToken ? retakeToken(env, pinnedToken, mc.session) : null;
    pinnedToken = null;
    if (!acct) {
      // 换号计数只在这里：pinnedToken 命中走的是同号原地重试，复用已有会话，不烧
      // admission，也就不该占换号预算、不需要抖动。
      // 上一个号是被 waiting room 挡住的：那不是这个号的失败，也没扣到 admission，
      // 走独立的小预算，不占 MAX_ACCOUNT_SWITCHES（否则整池被队列挡住就直接 503）。
      const waitingSwitch = lastWaitingRetryAfter != null && waitingRoomSwitches < waitingBudget;
      if (!waitingSwitch && accountSwitches >= switchBudget) break;
      // 第一个号不是「换号」，不等；之后每次换号前打散时间特征。
      if (accountSwitches + waitingRoomSwitches > 0) await sleep(accountSwitchJitterMs(env));
      if (waitingSwitch) waitingRoomSwitches += 1;
      else accountSwitches += 1;
      acct = await pickTokenWithSessionWait(
        env, mc.session, attempted, requestSignal,
        attempted.size === 0 ? sessionLeaseWaitMs(env) : 0,
        client,
      );
    }
    const token = acct ? acct.token : null;
    if (!token) {
      recordRequest(mc && mc.id ? mc.id : "", null, false);
      if (lastWaitingRetryAfter) return waitingRoomResponse(lastWaitingRetryAfter, mc.session);
      if (lastEgressUnavailable) return egressRejectedResponse("egress_unavailable");
      return poolExhaustionResponse(env, mc.session);
    }
    attempted.add(token);
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");

    // 429 本地锁：该号正在上游限流冷却（reason=quota）且未到期。
    // 直接本地回 429+Retry-After，不打上游 —— 打了也还是 429，白烧池子。
    // 参考 trefeon/freebuff-proxy 的 429 本地锁语义。
    const lock = scopedCooldownInfo(token, mc.session);
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
      const sess = await createSession(token, mc.session, false, client);
      throwIfRequestAborted(requestSignal);
      if (debug) console.log(`[acct ${acctTry + 1}] session=${sess.instanceId}`);

      // 2) run 链
      const run = await startRunChain(token, mc.agent, mc.session);
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
            : await authenticatedUpstreamFetch(token, CODEBUFF_API + "/api/v1/chat/completions", {
                ...chatInit,
                signal: AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
              });
          if (!isStream && resp.ok) resp = await preflightMeaningfulSseResponse(resp);
        } catch (error) {
          // 空流只视为当前账号的同模型 session 疑似脏状态：
          // 删除上游旧实例，重建同模型 session，再重试一次；绝不改成别的模型。
          // 同样受失效安全窗口约束：窗口内再空流 → 冷却换号，不无限重建。
          if (error instanceof EmptyUpstreamStreamError && attempt === 0) {
            if (wasRecentlyInvalidated(token, mc.session)) {
              if (debug) console.log(`[acct ${acctTry + 1}][chat] empty stream within invalidation window, cooldown`);
              cooldown(token, INVALIDATION_WINDOW_MS, { reason: "invalidation", retryAfterMs: INVALIDATION_WINDOW_MS, model: mc.session });
              break;
            }
            await deleteUpstreamSession(token, sessForChat.instanceId, mc.session);
            if (debug) console.log(`[acct ${acctTry + 1}][chat] empty stream, same-model session recovery`);
            sessForChat = await createSession(token, mc.session, true, client);
            continue;
          }
          throw error;
        }
        if (resp.ok) {
          recordAccountObservation(token, resp.status, null);
          break;
        }
        errText = await resp.text();
        recordAccountObservation(token, resp.status, errText, { headers: resp.headers, model: mc.session });
        throwIfTerminalResponse(token, resp.status, errText);
        if (resp.status === 401) await confirmTokenInvalid(token, mc.session);
        throwIfAdmissionResponse(resp.status, errText, resp.headers, mc.session,
          acctHealth.get(token)?.quota || null);
        // 410 model_unavailable：模型被上游下线/当前时段不可选。endsTheSession 为
        // false —— 会话还是好的，绝不能删会话重建（那是 #1801 的 admission 循环），
        // 也不能冷却这个号或换号。直接抛出去，让外层立刻回客户端。
        if (isModelUnavailableGate(resp.status, errText)) {
          throw new ModelUnavailableError(mc.session, null, errText);
        }
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
            cooldown(token, INVALIDATION_WINDOW_MS, { reason: "invalidation", retryAfterMs: INVALIDATION_WINDOW_MS, model: mc.session });
            break;
          }
          await deleteUpstreamSession(token, sessForChat.instanceId, mc.session);
          if (debug) console.log(`[acct ${acctTry + 1}][chat] session stale (${resp.status}), recreate…`);
          sessForChat = await createSession(token, mc.session, true, client);
          continue;
        }
        // 重建后仍失败：该号 session 状态异常，冷却交给外层换号
        if (staleSession) cooldown(token, 60 * 1000, { reason: "invalidation", retryAfterMs: 60 * 1000, model: mc.session });
        if (resp.status !== 400 && !isFreeModeGate(resp.status, errText)) {
          // 400 是「请求本身不合法」，和账号无关：冷却这个号毫无意义，
          // 换号重试只会把整池 60s 全冷掉（连别的模型一起打不通），
          // 最后还把上游原文换成"当前没有可用账号"，真实原因彻底看不见。
          // free_mode_* gate 同理，而且它每换一个号都要先建一次会话，是真烧额度。
          cooldown(token, parseCooldown(errText, resp.status, resp.headers), { model: mc.session });
        }
        break;
      }
      if (!resp.ok) {
        lastEgressUnavailable = false;
        // 累计口径：429 记限流，其余上游失败记错误（超时走 catch 分支单独计）。
        if (resp.status === 429) callTotals.rateLimited++;
        else callTotals.upstreamError++;
        lastErrMsg = "upstream error: " + (errText || "").slice(0, 300);
        // 400 换号也是同一个 400，直接把上游原文回给客户端，别再试剩下的号。
        // free_mode_* gate（403）同样是全池一致的答案，一起走这条快速失败路径。
        if (resp.status === 400 || isFreeModeGate(resp.status, errText)) {
          recordRequest(mc && mc.id ? mc.id : "", null, false);
          return jsonResponse({
            error: {
              message: lastErrMsg,
              type: resp.status === 400 ? "invalid_request_error" : "permission_error",
            },
          }, resp.status);
        }
        if (debug) console.log(`[acct ${acctTry + 1}] failed ${resp.status}, switch account`);
        continue;
      }

      if (isStream) {
        const { readable, writable } = new TransformStream();
        // 流式：首字延迟与 usage 只有管道跑完才知道，用 onComplete 收尾记一行。
        const onDone = async (info) => {
          try {
            recordChatCall(env, token, mc, effort, t0, info && info.firstTokenAt, info && info.usage, client);
          } finally {
            releaseToken(token);
          }
        };
        const guardedBody = guardStreamConvergence(resp.body, mc.id);
        if (mode === "responses") pipeUpstreamToResponsesStream(guardedBody, writable, mc, onDone);
        else pipeUpstreamToClient(guardedBody, writable, onDone, !!chatParams?.stream_options?.include_usage);
        leaseTransferred = true;
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
      }

      if (mode === "responses") {
        const out = await responsesToNonStream(resp.body, mc);
        recordChatCall(env, token, mc, effort, t0, null, out && out.usage, client);
        return jsonResponse(out, 200);
      }

      const agg = await streamToNonStream(resp.body, mc.upstream);
      recordChatCall(env, token, mc, effort, t0, null, agg && agg.usage, client);
      return jsonResponse(agg, 200);
    } catch (e) {
      if (requestSignal?.aborted) throw e;
      if (!isExpectedFlowError(e)) console.error("[" + mode + "]", e);
      const msg = String(e.message || e);
      if (e instanceof EgressRejectedError) {
        if (e.state !== "egress_unavailable") {
          recordRequest(mc && mc.id ? mc.id : "", null, false);
          return egressRejectedResponse(e.state);
        }
        lastEgressUnavailable = true;
      } else {
        lastEgressUnavailable = false;
      }
      if (e instanceof ClientSessionLimitError) return clientSessionLimitResponse(e);
      // model_unavailable：模型被上游下线/当前时段不可选，是全局结果。换号拿到的
      // 还是同一个答案，重建会话更是白扣 admission（#1801 的循环），所以既不冷却
      // 也不换号，立刻把原因回给客户端。
      if (e instanceof ModelUnavailableError) {
        callTotals.upstreamError++;
        recordRequest(mc && mc.id ? mc.id : "", null, false);
        return modelUnavailableResponse(e);
      }
      // model_locked：这个号被别的模型占着。换号继续（另一个号就是真正的并行），
      // 但不写冷却、不原地重试 —— 见 ModelLockedError 的注释。
      if (e instanceof ModelLockedError) lastModelLocked = e;
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
        cooldown(token, ra, {
          reason: "quota",
          retryAfterMs: ra,
          model: mc.session,
          scope: e.scope || quotaScopeForModel(mc.session, acctHealth.get(token)?.quota || null),
        });
      }
      if (e instanceof EmptyUpstreamStreamError) {
        cooldown(token, 60 * 1000, { model: mc.session });
      }
      // 上游抖动不是这个号的问题：原地重试，别换号白扣新账号的 session 创建额度。
      const retrySameAccount = isTransientUpstreamError(e)
        && sameAccountRetries < SAME_ACCOUNT_TRANSIENT_RETRIES
        && !accountIsBlocked(token);
      if (retrySameAccount) {
        pinnedToken = token;
        sameAccountRetries += 1;
      }
      // 其他上游交互失败/超时继续沿用原有冷却逻辑；流式 chat 不再因固定 20s abort 进入这里。
      // createSession 429（额度耗尽）按 retryAfterMs/文本冷却，不能固定 60s。
      if (!(e instanceof WaitingRoomError) && /create session failed|stayed queued|start_run failed|session_model_mismatch|abort|timeout|timed out|terminated/i.test(msg)) {
        const m429 = msg.match(/429/);
        if (m429) {
          const ra = parseCooldown(msg, 429);
          cooldown(token, ra, {
            reason: "quota",
            retryAfterMs: ra,
            model: mc.session,
            scope: "model:" + String(mc.session),
          });
        } else if (!retrySameAccount) {
          // 冷却会让 retakeToken 拿不回这个号，所以原地重试期间不写冷却。
          cooldown(token, 60 * 1000, { model: mc.session });
        }
      }
      lastErrMsg = msg;
      if (debug) {
        console.log(`[acct ${acctTry + 1}] exception: ${msg.slice(0, 120)}, `
          + (retrySameAccount ? "retry same account" : "switch account"));
      }
    } finally {
      if (!leaseTransferred) releaseToken(token);
    }
  }
  if (lastWaitingRetryAfter) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return waitingRoomResponse(lastWaitingRetryAfter, mc.session);
  }
  if (lastEgressUnavailable) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return egressRejectedResponse("egress_unavailable");
  }
  // 全池都被别的模型的会话占着：这是上游"一个号同时只能一个会话"的硬约束，
  // 不是额度问题也不是账号故障。给一句能照做的话，别伪装成 503 无可用账号。
  if (lastModelLocked) {
    recordRequest(mc && mc.id ? mc.id : "", null, false);
    return jsonResponse({
      error: {
        message: `所有账号当前都被其他模型的会话占用（上游一个账号同时只能有一个会话）。`
          + `等正在跑的请求结束，或增加账号数量后重试。`,
        type: "model_locked",
        currentModel: lastModelLocked.currentModel,
        requestedModel: lastModelLocked.requestedModel,
      },
    }, 409);
  }
  // 全池换号仍失败：该请求的失败终态，记一次失败（每个客户端请求只落一次）。
  recordRequest(mc && mc.id ? mc.id : "", null, false);
  if (accountPoolExhaustion(env, mc.session).allUnavailable) return poolExhaustionResponse(env, mc.session);
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
  if (isHiddenModelId(raw)) return null;
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
  const flushToolArgs = (ctl, tool) => {
    if (!tool.started || tool.sentArgs >= tool.args.length) return;
    const pending = tool.args.slice(tool.sentArgs);
    tool.sentArgs = tool.args.length;
    if (pending) events(ctl, "content_block_delta", { index: tool.index, delta: { type: "input_json_delta", partial_json: pending } });
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
      flushToolArgs(ctl, t);
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
              t = { index: blkIdx, id: "", name: "", started: false, args: "", sentArgs: 0 };
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
            flushToolArgs(ctl, t);
          }
        }
        if (choice.finish_reason) state.reason = anthropicStopReason(choice.finish_reason);
      }
    },
    flush(ctl) { finalize(ctl); },
  });
}

async function handleAnthropicMessages(request, env, client = null) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  if (!openaiModel) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  // 异步解析：优先静态 MODELS，缺失时刷新动态官方清单（与 handleChat/handleResponses 一致）
  const mc = await resolveModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  const response = await executeChat(env, chat, mc, !!chat.stream, "chat", request.signal, client);
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
// wantUsage：客户端自己有没有要 stream_options.include_usage。上游一律带 include_usage
// （为了记账），所以没要的客户端要把末尾那个 choices:[] 的 usage 块过滤掉 —— 按 OpenAI
// 语义它本不该出现，只认 chunk.choices[0] 的客户端会当场炸。
function pipeUpstreamToClient(upstreamBody, writable, onComplete, wantUsage = false) {
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
              // usage-only 块（choices 为空）：记账已经收下了，客户端没要就别下发。
              if (!wantUsage && normalized?.usage && !normalized?.choices?.length) continue;
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
  const toolItems = new Map(); // 上游 tool_calls index → {id, type, function:{name, arguments}}
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
        // usage 必须在 choices 判空之前收：include_usage 的末尾块只有 usage、choices 是空数组，
        // 放到 !choice 之后就永远读不到（成功调用记 0 token 的根因之一）。
        if (obj?.usage) usage = obj.usage;
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              const fn = tc.function || {};
              item = { id: tc.id || "call_" + Math.random().toString(36).slice(2, 10), type: "function", function: { name: fn.name || "", arguments: "" } };
              toolItems.set(ti, item);
            }
            const fn = tc.function || {};
            if (tc.id && !item.id) item.id = tc.id;
            if (fn.name && !item.function.name) item.function.name = fn.name;
            if (fn.arguments) item.function.arguments += fn.arguments;
          }
        }
        if (obj.id) id = obj.id;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning_content = reasoning;
  // 只有思考、没有正文、也没有工具调用 = 这一轮被截断在思考阶段（思考循环撞上收敛护栏就是这个形态）。
  // 旧行为把未完成的思考塞进 content 冒充答案，客户端下一轮会把它当助手发言回传，模型接着想 —— 放大循环。
  // 改用标准字段表达：content 留空 + finish_reason=length，思考只留在 reasoning_content 里。
  if (toolItems.size) msg.tool_calls = [...toolItems.values()];
  if (reasoning && !content && !toolItems.size) finishReason = "length";
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
            // 同 streamToNonStream：usage-only 末尾块的 choices 是空数组，先收 usage 再判空。
            if (obj?.usage) usage = obj.usage;
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
        // usage 必须在 choices 判空之前收：include_usage 的末尾块只有 usage、choices 是空数组，
        // 放到 !choice 之后就永远读不到（成功调用记 0 token 的根因之一）。
        if (obj?.usage) usage = obj.usage;
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
async function handleModels(client = null, { forceRefresh = false } = {}) {
  let modelList = MODELS;
  let refreshResult = dynamicModelsSnapshot();
  try {
    refreshResult = await refreshDynamicModelsIfStale(forceRefresh);
    const dyn = refreshResult.cache;
    if (dyn && dyn.models && dyn.models.length) {
      modelList = mergeModelTables(MODELS, dyn.models);
    }
  } catch {}
  // 有白名单的 key 只看得见白名单里的模型：客户端拉不到的模型不会被它选中，
  // 少一轮「选了→403」的往返。白名单为空 = 不限，主 Key 同理。
  if (client && Array.isArray(client.models) && client.models.length) {
    modelList = modelList.filter((m) => client.models.includes(m.id));
  }
  // 官方暂停模型可能残留在动态源/旧 Key 白名单中；它不能继续出现在正常
  // 模型目录，否则客户端会先选中再收到上游 409。
  const snapshotCache = refreshResult.cache;
  const snapshotAvailability = refreshResult.availability;
  modelList = modelList.filter((m) =>
    !isPausedModelId(m.id, snapshotCache)
      && !isHiddenModelId(m.id)
      && modelIsAvailable(m.id, snapshotAvailability));
  const data = modelList
    .map((m) => {
      // 实测（2026-08-15）：免费账号只有 Flash / MiMo 2.5 两个模型能建会话
      // （上游 409 session_model_mismatch / 403 free_mode_invalid_agent_model 拒绝其余模型）。
      // 分组键与排序都取自 MODEL_TIERS：免费 → US/SG → 限定 → 未分组。
      const declaredPool = safePoolName(m.pool);
      const pool = declaredPool || modelPoolCategory(m.id, null, snapshotCache) || "";
      const tier = modelCatalogTier(m.id, pool);
      const rank = tier ? MODEL_TIERS.findIndex(([key]) => key === tier) : -1;
      return {
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "freebuff",
        ...(pool ? { pool } : {}),
        ...(tier ? { tier } : {}),
        _sort: rank < 0 ? MODEL_TIERS.length : rank,
      };
    })
    .sort((a, b) => a._sort - b._sort)
    .map(({ _sort, ...m }) => m);
  return jsonResponse({
    object: "list",
    data,
    ...(forceRefresh ? {
      refresh: {
        updated: refreshResult?.refreshed === true,
        source: refreshResult?.source || "cache",
      },
    } : {}),
  }, 200, { "X-Freebuff2api-Version": VERSION });
}

// 请求带的 key。Bearer 优先，其次 x-api-key。
function presentedApiKey(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return request.headers.get("x-api-key") || "";
}

// 鉴权：主 Key（部署自带，不设限）或共享 key（env.FREEBUFF_API_KEYS，各自限
// 并发/模型/每日 session 上限）。返回客户端描述符，null = 无效 key。
// 主 Key 的 limits 全为不限，所以下游闸门一律按同一条路径走，不必到处判"是不是主 Key"。
function resolveClient(request, env) {
  const presented = presentedApiKey(request).trim();
  if (!presented) return null;
  const owner = (env.API_KEY || env.FREEBUFF_API_KEY || DEFAULT_API_KEY).trim();
  if (owner && presented === owner) {
    return { key: presented, name: OWNER_KEY_NAME, concurrency: 0, models: [], dailyLimit: 0, owner: true };
  }
  const shared = Array.isArray(env.FREEBUFF_API_KEYS) ? env.FREEBUFF_API_KEYS : [];
  for (const k of shared) {
    if (!k || typeof k !== "object" || String(k.key || "") !== presented) continue;
    if (k.disabled === true) return null;   // 停用的 key 当无效 key，不泄露"这把存在但被停了"
    return {
      key: presented,
      fingerprint: String(k.fingerprint || "").trim(),
      name: String(k.name || "").trim() || presented.slice(0, 10),
      concurrency: Number.isFinite(Number(k.concurrency)) ? Math.max(1, Math.floor(Number(k.concurrency))) : 1,
      models: Array.isArray(k.models) ? k.models.map((m) => String(m || "").trim()).filter(Boolean) : [],
      dailyLimit: Number.isFinite(Number(k.dailyLimit)) ? Math.max(0, Math.floor(Number(k.dailyLimit))) : 0,
      owner: false,
    };
  }
  return null;
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
