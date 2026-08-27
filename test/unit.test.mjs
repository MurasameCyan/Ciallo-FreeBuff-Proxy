import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf-8');

// worker.js 使用 ESM `export default {...}`，vm 沙箱不支持 ESM 语法。
// 把首处 `export default {` 替换为普通 const 声明，并在文件末尾附加导出赋值，
// 使内部函数在沙箱全局可见，供单测直接调用。
const wrapper = src
  .replace('export default {', 'const __workerDefault__ = {')
  .replace('const DYNAMIC_MODELS_FETCH_TIMEOUT_MS = 10000;', 'const DYNAMIC_MODELS_FETCH_TIMEOUT_MS = 25;')
  .replace('const DYNAMIC_MODEL_ENDPOINT_RETRY_MS = 60 * 1000;', 'const DYNAMIC_MODEL_ENDPOINT_RETRY_MS = 25;') +
  '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n' +
  'globalThis.__unitTestApi__ = { normalizeChatThinking, anthropicThinkingToEffort, namedEffort, normalizeReasoningEffort, collectReasoningTexts, anthropicStopReason, anthropicModelToOpenAI, parseModelAliases, resolveModelAlias, resolveModelConfig, findModelConfig, refreshDynamicModelsIfStale, modelIsAvailable, setTestAliases: (raw) => { currentAliases = parseModelAliases(raw); }, setTestDynamicModels: (models, fetchedAt = Date.now()) => { dynamicModelsCache = { fetchedAt, models, pool: { premium: new Set(), standard: null, glm: new Set() } }; if (typeof dynamicModelAvailability !== "undefined") dynamicModelAvailability = new Map(); if (typeof dynamicEndpointRefreshFlights !== "undefined") dynamicEndpointRefreshFlights.clear(); }, setTestModelAvailability: (id, available) => { if (typeof dynamicModelAvailability !== "undefined") dynamicModelAvailability.set(id, { available, checkedAt: Date.now(), retryAt: 0 }); }, resetTestModelRefreshFlight: () => { dynamicModelsRefreshFlight = null; if (typeof dynamicEndpointRefreshFlights !== "undefined") dynamicEndpointRefreshFlights.clear(); }, cooldown, cooldownInfo, inCooldown, parseCooldown, nextPacificMidnight: typeof nextPacificMidnight === "function" ? nextPacificMidnight : null, pickToken, releaseToken: typeof releaseToken === "function" ? releaseToken : null, accountPoolExhaustion: typeof accountPoolExhaustion === "function" ? accountPoolExhaustion : null, waitingRoomResponse: typeof waitingRoomResponse === "function" ? waitingRoomResponse : null, pipeUpstreamToClient, pipeUpstreamToResponsesStream, anthropicStream, streamToNonStream, buildUpstreamPayload, anthropicFromChat, responsesToNonStream, markSessionInvalidated, wasRecentlyInvalidated, singleFlight, sessionRemainingMs, INVALIDATION_WINDOW_MS, SESSION_REUSE_SAFE_MS, SESSION_VERIFY_WINDOW_MS, executeChat, readCallUsage, accountLabel, summarizeAccountHealth, logCall, callLogSnapshot, readUsageFull, recordRequest, blankUsageTotals, recordAccountObservation, configureUsagePersistence, restoreUsageSnapshot, usageSnapshot, setTestEgressReject: (fn) => { onEgressReject = fn; }, egressRejectedResponse: typeof egressRejectedResponse === "function" ? egressRejectedResponse : null, MODEL_TIERS, handleModels };\n';

// 可编程 fetch mock：测试里可替换 sandbox.fetch，返回可定制的 Response 形状
// （worker 里用的是 { status, ok, headers, text() } 简化形状）。
const fetchState = { calls: [], impl: null };
const sandbox = {
  console, TextEncoder, TextDecoder, Set, Map, Date, Math, Number, String, JSON, Uint8Array, Object, URL,
  setTimeout, clearTimeout, AbortController, ReadableStream, TransformStream,
  // Node 18+ 全局 Response/Request 注入沙箱（worker.js 的 jsonResponse 用 new Response）
  Response, Request, Headers,
  fetch: async (url, init = {}) => {
    fetchState.calls.push({ url: String(url), init });
    const impl = fetchState.impl;
    if (impl) return impl(url, init);
    return { status: 200, ok: true, headers: {}, text: async () => '{}' };
  },
  AbortSignal: { timeout: () => ({}) }, crypto: { randomUUID: () => 'x' },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(wrapper, sandbox);

const { normalizeChatThinking, anthropicThinkingToEffort, namedEffort, normalizeReasoningEffort, collectReasoningTexts, anthropicStopReason, anthropicModelToOpenAI, parseModelAliases, resolveModelAlias, resolveModelConfig, findModelConfig, refreshDynamicModelsIfStale, modelIsAvailable, setTestAliases, setTestDynamicModels, setTestModelAvailability, resetTestModelRefreshFlight, cooldown, cooldownInfo, inCooldown, parseCooldown, nextPacificMidnight, pickToken, releaseToken, accountPoolExhaustion, waitingRoomResponse, pipeUpstreamToClient, pipeUpstreamToResponsesStream, anthropicStream, streamToNonStream, buildUpstreamPayload, anthropicFromChat, responsesToNonStream, markSessionInvalidated, wasRecentlyInvalidated, singleFlight, sessionRemainingMs, INVALIDATION_WINDOW_MS, SESSION_REUSE_SAFE_MS, SESSION_VERIFY_WINDOW_MS, executeChat, readCallUsage, accountLabel, summarizeAccountHealth, logCall, callLogSnapshot, readUsageFull, recordRequest, blankUsageTotals, recordAccountObservation, configureUsagePersistence, restoreUsageSnapshot, usageSnapshot, setTestEgressReject, egressRejectedResponse, MODEL_TIERS, handleModels } = sandbox.__unitTestApi__;
const workerDefault = sandbox.__workerDefault__;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '-', e.message); }
}

console.log('--- normalizeChatThinking (reasoning effort 透传) ---');
t('顶层 thinking.minimal → reasoning_effort minimal', () => {
  const r = normalizeChatThinking({ thinking: { type: 'minimal' } });
  if (r.reasoning_effort !== 'minimal') throw new Error('got ' + r.reasoning_effort);
});
t('顶层 thinking.low → low', () => {
  const r = normalizeChatThinking({ thinking: { type: 'low' } });
  if (r.reasoning_effort !== 'low') throw new Error('got ' + r.reasoning_effort);
});
t('顶层 thinking.medium → medium', () => {
  const r = normalizeChatThinking({ thinking: { type: 'medium' } });
  if (r.reasoning_effort !== 'medium') throw new Error('got ' + r.reasoning_effort);
});
t('顶层 thinking.high → high', () => {
  const r = normalizeChatThinking({ thinking: { type: 'high' } });
  if (r.reasoning_effort !== 'high') throw new Error('got ' + r.reasoning_effort);
});
t('顶层 thinking.none → none', () => {
  const r = normalizeChatThinking({ thinking: { type: 'none' } });
  if (r.reasoning_effort !== 'none') throw new Error('got ' + r.reasoning_effort);
});
t('thinking 缺省 → 不注入', () => {
  const r = normalizeChatThinking({ model: 'x' });
  if ('reasoning_effort' in r) throw new Error('injected ' + JSON.stringify(r));
});
t('既有 reasoning_effort 不覆盖', () => {
  const r = normalizeChatThinking({ thinking: { type: 'high' }, reasoning_effort: 'low' });
  if (r.reasoning_effort !== 'low') throw new Error('got ' + r.reasoning_effort);
});
t('顶层 thinking.max → max', () => {
  const r = normalizeChatThinking({ thinking: { type: 'max' } });
  if (r.reasoning_effort !== 'max') throw new Error('got ' + r.reasoning_effort);
});
t('thinking.effort MAX → max（大小写归一）', () => {
  const r = normalizeChatThinking({ thinking: { effort: 'MAX' } });
  if (r.reasoning_effort !== 'max') throw new Error('got ' + r.reasoning_effort);
});
t('thinking.effort 未知值原样透传给上游', () => {
  const r = normalizeChatThinking({ thinking: { effort: 'turbo' } });
  if (r.reasoning_effort !== 'turbo') throw new Error('got ' + r.reasoning_effort);
});

console.log('--- anthropicThinkingToEffort (thinking → effort 映射) ---');
t('thinking disabled → none', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'disabled' } }) !== 'none') throw new Error('nope');
});
t('enabled budget 512 → minimal', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', budget_tokens: 512 } }) !== 'minimal') throw new Error('nope');
});
t('enabled budget 1024 → low', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', budget_tokens: 1024 } }) !== 'low') throw new Error('nope');
});
t('enabled budget 4096 → medium', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', budget_tokens: 4096 } }) !== 'medium') throw new Error('nope');
});
t('enabled budget 16384 → high', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', budget_tokens: 16384 } }) !== 'high') throw new Error('nope');
});
t('enabled budget 32768 → xhigh', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', budget_tokens: 32768 } }) !== 'xhigh') throw new Error('nope');
});
// 点名的档位不降级：CC 侧设 max 必须原样到达上游，否则在 efforts=[low,high,max]
// 的模型上会被 clamp 成 high（曾经的 max→xhigh 折算就是这么失效的）
t('adaptive + effort max → max（不再折成 xhigh）', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }) !== 'max') throw new Error('nope');
});
t('adaptive + effort xhigh → xhigh', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } }) !== 'xhigh') throw new Error('nope');
});
t('adaptive + effort ultra → ultra', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'ultra' } }) !== 'ultra') throw new Error('nope');
});
t('adaptive + effort none → none', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'none' } }) !== 'none') throw new Error('nope');
});
t('adaptive 无 effort → auto', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' } }) !== 'auto') throw new Error('nope');
});
t('adaptive + 未知 effort → auto', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'adaptive' }, output_config: { effort: 'turbo' } }) !== 'auto') throw new Error('nope');
});
t('enabled + effort max（无 budget）→ max', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', effort: 'MAX' } }) !== 'max') throw new Error('nope');
});
t('enabled 时 effort 优先于 budget', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'enabled', effort: 'max', budget_tokens: 1024 } }) !== 'max') throw new Error('nope');
});
t('auto + effort medium → medium', () => {
  if (anthropicThinkingToEffort({ thinking: { type: 'auto' }, output_config: { effort: 'medium' } }) !== 'medium') throw new Error('nope');
});
t('no thinking → undefined', () => {
  if (anthropicThinkingToEffort({}) !== undefined) throw new Error('nope');
});

console.log('--- normalizeReasoningEffort (per-model clamp) ---');
// 官方 efforts 表：deepseek-v4-* = [low, high, max]；gpt-5.6-luna 由服务端钉死 high
t('max 在 deepseek-v4-pro 上原样保留', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-pro', 'max') !== 'max') throw new Error('nope');
});
t('xhigh 在 deepseek-v4-pro 上被下取成 high（所以 max 绝不能先折成 xhigh）', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-pro', 'xhigh') !== 'high') throw new Error('nope');
});
t('medium 在 deepseek-v4-flash 上被下取成 low（该模型无 medium 档）', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-flash', 'medium') !== 'low') throw new Error('nope');
});
// luna：上游注入 reasoning.effort=high，任何不等于 high 的 reasoning_effort 都会 400
// （"both provided with conflicting values"），所以是钉死不是 clamp —— 低档也要抬回 high。
t('max 在 gpt-5.6-luna 上被钉成 high', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'max') !== 'high') throw new Error('nope');
});
t('低档 low 在 gpt-5.6-luna 上同样被钉成 high', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'low') !== 'high') throw new Error('nope');
});
t('不在 ladder 上的 none/auto 在 gpt-5.6-luna 上也被钉成 high', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'none') !== 'high') throw new Error('nope');
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'auto') !== 'high') throw new Error('nope');
});
t('未发 reasoning_effort 时不给 gpt-5.6-luna 补一个', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', undefined) !== undefined) throw new Error('nope');
});
t('未列入 efforts 表的模型原样透传 max', () => {
  if (normalizeReasoningEffort('crof/kimi-k3-eco', 'max') !== 'max') throw new Error('nope');
});

console.log('--- collectReasoningTexts ---');
t('字符串透传', () => {
  const r = collectReasoningTexts('thinking here');
  if (r.length !== 1 || r[0] !== 'thinking here') throw new Error(JSON.stringify(r));
});
t('数组拼合', () => {
  const r = collectReasoningTexts(['a', 'b']);
  if (r.join('') !== 'ab') throw new Error(JSON.stringify(r));
});
t('null/undefined → []', () => {
  if (collectReasoningTexts(null).length !== 0) throw new Error('nope');
  if (collectReasoningTexts(undefined).length !== 0) throw new Error('nope');
});

console.log('--- anthropicStopReason ---');
t('tool_calls → tool_use', () => { if (anthropicStopReason('tool_calls') !== 'tool_use') throw new Error('nope'); });
t('length → max_tokens', () => { if (anthropicStopReason('length') !== 'max_tokens') throw new Error('nope'); });
t('其它 → end_turn', () => { if (anthropicStopReason('stop') !== 'end_turn') throw new Error('nope'); });

console.log('--- anthropicModelToOpenAI ---');
t('freebuff 风格 id 透传', () => {
  if (anthropicModelToOpenAI('deepseek/deepseek-v4-flash') !== 'deepseek/deepseek-v4-flash') throw new Error('nope');
});
t('短名别名解析（静态表 mimo-v2.5 → mimo/mimo-v2.5）', () => {
  const r = anthropicModelToOpenAI('mimo-v2.5');
  if (r !== 'mimo/mimo-v2.5') throw new Error('got ' + r);
});
t('anthropic/ 前缀剥离（anthropic/mimo-v2.5）', () => {
  const r = anthropicModelToOpenAI('anthropic/mimo-v2.5');
  if (r !== 'mimo/mimo-v2.5') throw new Error('got ' + r);
});
t('未知模型 → null', () => {
  if (anthropicModelToOpenAI('claude-nonexistent-xyz') !== null) throw new Error('nope');
});
t('空模型 → null', () => {
  if (anthropicModelToOpenAI('') !== null) throw new Error('nope');
});

console.log('--- parseModelAliases (自定义模型映射) ---');
t('基本解析', () => {
  const m = parseModelAliases('fast=deepseek/deepseek-v4-flash,pro=deepseek/deepseek-v4-pro');
  if (m.size !== 2) throw new Error('size ' + m.size);
  if (m.get('fast') !== 'deepseek/deepseek-v4-flash') throw new Error('fast wrong');
  if (m.get('pro') !== 'deepseek/deepseek-v4-pro') throw new Error('pro wrong');
});
t('大小写不敏感（别名小写化）', () => {
  const m = parseModelAliases('MyModel=deepseek/deepseek-v4-flash');
  if (!m.has('mymodel')) throw new Error('not lowercased');
});
t('空格容忍', () => {
  const m = parseModelAliases(' a = b ,  c = d ');
  if (m.get('a') !== 'b' || m.get('c') !== 'd') throw new Error(JSON.stringify([...m]));
});
t('非法行跳过', () => {
  const m = parseModelAliases('good=ok, badline, =x, y=');
  if (m.size !== 1 || m.get('good') !== 'ok') throw new Error(JSON.stringify([...m]));
});
t('空输入 → 空 Map', () => {
  if (parseModelAliases('').size !== 0) throw new Error('nope');
  if (parseModelAliases(null).size !== 0) throw new Error('nope');
});

console.log('--- resolveModelAlias + 解析链 ---');
t('currentAliases 未设置时别名不解析', () => {
  if (resolveModelAlias('fast') !== null) throw new Error('nope');
});
t('设置 currentAliases 后别名解析', () => {
  setTestAliases('fast=deepseek/deepseek-v4-flash');
  if (resolveModelAlias('fast') !== 'deepseek/deepseek-v4-flash') throw new Error('nope');
});
t('findModelConfig 别名 → 真实模型配置（静态表 mimo 别名）', () => {
  setTestAliases('my-mimo=mimo/mimo-v2.5');
  const mc = findModelConfig('my-mimo');
  if (!mc || mc.id !== 'mimo/mimo-v2.5') throw new Error('mc=' + JSON.stringify(mc));
});
t('anthropicModelToOpenAI 别名优先', () => {
  setTestAliases('fast=deepseek/deepseek-v4-flash');
  if (anthropicModelToOpenAI('fast') !== 'deepseek/deepseek-v4-flash') throw new Error('got ' + anthropicModelToOpenAI('fast'));
});
t('别名比后缀短名匹配优先（避免别名被误当作模型名）', () => {
  setTestAliases('mimo=mimo/mimo-v2.5');
  if (resolveModelAlias('mimo') !== 'mimo/mimo-v2.5') throw new Error('nope');
});
t('恢复空别名', () => {
  setTestAliases('');
});

console.log('--- cooldown 升级（429 锁 / reason） ---');
const tok = 't-cooldown-test';
t('cooldown 基础：到期前 inCooldown=true', () => {
  cooldown(tok, 60 * 1000);
  if (!inCooldown(tok)) throw new Error('not cooled');
  const info = cooldownInfo(tok);
  if (!info || info.reason !== 'error') throw new Error('reason=' + (info && info.reason));
});
t('cooldown 429 带 retryAfterMs + reason=quota', () => {
  cooldown(tok, 5 * 60 * 1000, { reason: 'quota', retryAfterMs: 5 * 60 * 1000 });
  const info = cooldownInfo(tok);
  if (!info || info.reason !== 'quota' || info.retryAfterMs !== 5 * 60 * 1000) {
    throw new Error('bad: ' + JSON.stringify(info));
  }
});
t('短冷却不覆盖长冷却（幂等合并）', () => {
  cooldown(tok, 60 * 1000, { reason: 'error' }); // 短，应被忽略
  const info = cooldownInfo(tok);
  if (!info || info.reason !== 'quota') throw new Error('overwritten by short: ' + JSON.stringify(info));
});
t('数字第三参 → quota + retryAfterMs（旧形式兼容）', () => {
  cooldown('t-cooldown-num', 120 * 1000, 120 * 1000);
  const info = cooldownInfo('t-cooldown-num');
  if (!info || info.reason !== 'quota' || info.retryAfterMs !== 120 * 1000) {
    throw new Error('bad: ' + JSON.stringify(info));
  }
});
t('reason=invalidation 不触发 429 锁（retryAfterMs 应仍可读）', () => {
  cooldown('t-invalid', INVALIDATION_WINDOW_MS, { reason: 'invalidation', retryAfterMs: INVALIDATION_WINDOW_MS });
  const info = cooldownInfo('t-invalid');
  if (!info || info.reason !== 'invalidation') throw new Error('bad: ' + JSON.stringify(info));
});

console.log('--- 失效安全窗口（sessionInvalidated） ---');
t('markSessionInvalidated 后窗口内 wasRecentlyInvalidated=true', () => {
  markSessionInvalidated('t-inv-token', 'deepseek/deepseek-v4-flash');
  if (!wasRecentlyInvalidated('t-inv-token', 'deepseek/deepseek-v4-flash')) throw new Error('not flagged');
});
t('不同模型互不影响', () => {
  if (wasRecentlyInvalidated('t-inv-token', 'mimo/mimo-v2.5')) throw new Error('wrong model flagged');
});
t('不同 token 互不影响', () => {
  if (wasRecentlyInvalidated('t-other', 'deepseek/deepseek-v4-flash')) throw new Error('wrong token flagged');
});
t('无标记 → false', () => {
  if (wasRecentlyInvalidated('t-none', 'x')) throw new Error('unexpected true');
});

console.log('--- single-flight 去重 ---');
t('并发同 key 只执行一次', async () => {
  let runs = 0;
  const p1 = singleFlight('k1', async () => { runs++; await new Promise(r => setTimeout(r, 30)); return 'a'; });
  const p2 = singleFlight('k1', async () => { runs++; return 'b'; });
  const [a, b] = await Promise.all([p1, p2]);
  if (a !== 'a' || b !== 'a') throw new Error(`p1=${a} p2=${b} (应共享同一结果)`);
  if (runs !== 1) throw new Error(`runs=${runs} (应只执行 1 次)`);
});
t('不同 key 互不干扰', async () => {
  let runs = 0;
  const p1 = singleFlight('kx', async () => { runs++; await new Promise(r => setTimeout(r, 20)); return 1; });
  const p2 = singleFlight('ky', async () => { runs++; return 2; });
  const [a, b] = await Promise.all([p1, p2]);
  if (a !== 1 || b !== 2) throw new Error(`a=${a} b=${b}`);
  if (runs !== 2) throw new Error(`runs=${runs}`);
});
t('完成后可再次执行（去重按 in-flight）', async () => {
  let runs = 0;
  const fn = async () => { runs++; return runs; };
  await singleFlight('kz', fn);
  const r2 = await singleFlight('kz', fn);
  if (r2 !== 2) throw new Error(`r2=${r2} (去重只挡并发，不挡串行)`);
});

console.log('--- optimistic session reuse（verify window） ---');
t('剩余 ≥ 60s → 直接复用（SAFE 阈值）', () => {
  const remain = sessionRemainingMs({ expiresAt: new Date(Date.now() + 120 * 1000).toISOString() });
  if (remain < SESSION_REUSE_SAFE_MS) throw new Error(`remain=${remain} (应 ≥ ${SESSION_REUSE_SAFE_MS})`);
});
t('剩余 45s（临界区 30-60s）→ 乐观复用但触发后台验证', () => {
  const remain = sessionRemainingMs({ expiresAt: new Date(Date.now() + 45 * 1000).toISOString() });
  if (!(remain > 0 && remain >= SESSION_REUSE_SAFE_MS - SESSION_VERIFY_WINDOW_MS)) {
    throw new Error(`remain=${remain} (应落在临界区)`);
  }
});
t('剩余 < 30s → 不再复用', () => {
  const remain = sessionRemainingMs({ expiresAt: new Date(Date.now() + 10 * 1000).toISOString() });
  if (remain >= SESSION_REUSE_SAFE_MS - SESSION_VERIFY_WINDOW_MS) throw new Error(`remain=${remain} (应已过临界区)`);
});

// ── 集成测试：429 本地锁 + 失效安全窗口闭环 ──────────────────
// 通过可编程 fetch 模拟上游，驱动 executeChat 走完整重试逻辑。
// 需要 async 测试能力，扩展 t 支持 async fn。
console.log('--- 集成：429 本地锁闭环 ---');

async function tAsync(name, fn) {
  try { await fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '-', e.message); }
}

function buildUpstreamToolStream() {
  const argument = '{"command":"echo hello"}';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'Bash', arguments: argument } }] } }],
      }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
}

function parseSseData(text) {
  return [...text.matchAll(/data: (\{.*\})\n\n/g)].map((m) => JSON.parse(m[1]));
}

async function collectPipedSse(startPipe) {
  const { readable, writable } = new TransformStream();
  startPipe(buildUpstreamToolStream(), writable);
  return parseSseData(await new Response(readable).text());
}

await tAsync('Anthropic 工具参数流只发送一次，不重复追加累计参数', async () => {
  const response = new Response(buildUpstreamToolStream()).body.pipeThrough(anthropicStream({ id: 'deepseek/deepseek-v4-pro' }));
  const text = await new Response(response).text();
  const partials = [...text.matchAll(/data: (\{.*\})\n\n/g)]
    .map((m) => JSON.parse(m[1]))
    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta')
    .map((event) => event.delta.partial_json);
  if (partials.length !== 1) throw new Error('工具参数增量次数应为 1，实际 ' + partials.length);
  if (partials[0] !== '{"command":"echo hello"}') throw new Error('工具参数被重复或改写: ' + partials.join(''));
});

await tAsync('OpenAI 工具参数流透明转发一次', async () => {
  const events = await collectPipedSse((body, writable) => pipeUpstreamToClient(body, writable));
  const partials = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])
    .map((tool) => tool.function?.arguments).filter(Boolean);
  if (partials.length !== 1) throw new Error('工具参数增量次数应为 1，实际 ' + partials.length);
  if (partials.join('') !== '{"command":"echo hello"}') throw new Error('工具参数被重复或改写: ' + partials.join(''));
});

await tAsync('Responses 工具参数 delta 只发送一次，done 保存完整参数', async () => {
  const events = await collectPipedSse((body, writable) =>
    pipeUpstreamToResponsesStream(body, writable, { id: 'deepseek/deepseek-v4-pro' }));
  const deltas = events.filter((event) => event.type === 'response.function_call_arguments.delta')
    .map((event) => event.delta);
  if (deltas.length !== 1) throw new Error('工具参数增量次数应为 1，实际 ' + deltas.length);
  if (deltas.join('') !== '{"command":"echo hello"}') throw new Error('工具参数被重复或改写: ' + deltas.join(''));
  const done = events.filter((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call');
  if (done.length !== 1) throw new Error('function_call done 次数应为 1，实际 ' + done.length);
  if (done[0].item.arguments !== '{"command":"echo hello"}') throw new Error('done 参数不完整: ' + done[0].item.arguments);
});

await tAsync('OpenAI 非流式工具参数聚合一次并保留 tool_calls', async () => {
  const response = await streamToNonStream(buildUpstreamToolStream(), 'deepseek/deepseek-v4-pro');
  const calls = response.choices?.[0]?.message?.tool_calls || [];
  if (calls.length !== 1) throw new Error('tool_calls 数量应为 1，实际 ' + calls.length);
  if (calls[0].function?.arguments !== '{"command":"echo hello"}') throw new Error('工具参数丢失或重复: ' + calls[0].function?.arguments);
});

await tAsync('Anthropic 非流式工具参数经共享聚合器只解析一次', async () => {
  const openai = await streamToNonStream(buildUpstreamToolStream(), 'deepseek/deepseek-v4-pro');
  const response = anthropicFromChat(openai, { id: 'deepseek/deepseek-v4-pro' });
  const tools = response.content.filter((block) => block.type === 'tool_use');
  if (tools.length !== 1) throw new Error('tool_use 数量应为 1，实际 ' + tools.length);
  if (tools[0].input?.command !== 'echo hello') throw new Error('工具参数未正确解析: ' + JSON.stringify(tools[0].input));
});

await tAsync('Responses 非流式工具参数聚合一次', async () => {
  const response = await responsesToNonStream(buildUpstreamToolStream(), { id: 'deepseek/deepseek-v4-pro' });
  const tools = response.output.filter((item) => item.type === 'function_call');
  if (tools.length !== 1) throw new Error('function_call 数量应为 1，实际 ' + tools.length);
  if (tools[0].arguments !== '{"command":"echo hello"}') throw new Error('工具参数丢失或重复: ' + tools[0].arguments);
});

// ---------------------------------------------------------------------------
// include_usage：上游一律流式，末尾 usage 块是唯一的 token 来源
const USAGE_BLOCK = { prompt_tokens: 11, completion_tokens: 31, total_tokens: 42 };

// include_usage 的真实形状：最后一个 chunk 只有 usage，choices 是空数组。
function buildUsageOnlyStream() {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'chatcmpl-u', model: 'deepseek/deepseek-v4-pro',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      }) + '\n\n'));
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'chatcmpl-u', model: 'deepseek/deepseek-v4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) + '\n\n'));
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'chatcmpl-u', model: 'deepseek/deepseek-v4-pro', choices: [], usage: USAGE_BLOCK,
      }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
}

async function pipeUsageOnly(startPipe) {
  const { readable, writable } = new TransformStream();
  let info = null;
  startPipe(buildUsageOnlyStream(), writable, (result) => { info = result; });
  const text = await new Response(readable).text();
  return { info, text, events: parseSseData(text) };
}

t('上游 payload 必须带 stream_options.include_usage，否则流式全程记 0 token', () => {
  const payload = buildUpstreamPayload({ messages: [{ role: 'user', content: 'hi' }] },
    { id: 'deepseek/deepseek-v4-pro', upstream: 'deepseek/deepseek-v4-pro', session: 'deepseek/deepseek-v4-pro' },
    { instanceId: 'inst-1' }, 'run-1');
  if (payload.stream !== true) throw new Error('上游必须流式');
  if (payload.stream_options?.include_usage !== true) throw new Error('缺少 include_usage: ' + JSON.stringify(payload.stream_options));
});

t('客户端自带的 stream_options 其它字段不被 include_usage 覆盖掉', () => {
  const payload = buildUpstreamPayload({ messages: [], stream_options: { include_obfuscation: false } },
    { id: 'x', upstream: 'x', session: 'x' }, { instanceId: 'i' }, 'r');
  if (payload.stream_options.include_obfuscation !== false) throw new Error('客户端字段被丢弃');
  if (payload.stream_options.include_usage !== true) throw new Error('include_usage 未注入');
});

await tAsync('Chat 流式：usage-only 块进记账，但客户端没要就不下发', async () => {
  const { info, events } = await pipeUsageOnly((body, writable, onComplete) =>
    pipeUpstreamToClient(body, writable, onComplete));
  if (info?.usage?.total_tokens !== 42) throw new Error('记账拿不到 usage: ' + JSON.stringify(info?.usage));
  if (events.some((e) => e.usage)) throw new Error('未请求 include_usage 的客户端收到了 usage 块');
  if (events.some((e) => Array.isArray(e.choices) && e.choices.length === 0)) throw new Error('下发了 choices 为空的块');
  if (events.length !== 2) throw new Error('正常内容块被误删，剩 ' + events.length);
});

await tAsync('Chat 流式：客户端要了 include_usage 就照实下发', async () => {
  const { info, events } = await pipeUsageOnly((body, writable, onComplete) =>
    pipeUpstreamToClient(body, writable, onComplete, true));
  if (info?.usage?.total_tokens !== 42) throw new Error('记账拿不到 usage');
  const usageEvents = events.filter((e) => e.usage);
  if (usageEvents.length !== 1) throw new Error('usage 块应下发 1 次，实际 ' + usageEvents.length);
  if (usageEvents[0].usage.total_tokens !== 42) throw new Error('usage 内容被改写');
});

await tAsync('Chat 非流式：usage-only 块不能被 choices 判空丢掉', async () => {
  const out = await streamToNonStream(buildUsageOnlyStream(), 'deepseek/deepseek-v4-pro');
  if (out.usage?.total_tokens !== 42) throw new Error('聚合结果 usage 为 ' + JSON.stringify(out.usage));
  if (out.choices?.[0]?.message?.content !== 'hi') throw new Error('正文被丢: ' + JSON.stringify(out.choices));
});

// ---------------------------------------------------------------------------
// 思考阶段被截断的表达（选项 2 完整形态）。只有 reasoning、没有 content、也没有
// 工具调用，就是这一轮被截断在思考里 —— 思考循环撞上收敛护栏正是这个形态。
function buildReasoningOnlyStream() {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'chatcmpl-r', model: 'deepseek/deepseek-v4-pro',
        choices: [{ index: 0, delta: { reasoning_content: '让我想想…' }, finish_reason: null }],
      }) + '\n\n'));
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'chatcmpl-r', model: 'deepseek/deepseek-v4-pro',
        choices: [{ index: 0, delta: { reasoning_content: '再想想…' }, finish_reason: null }],
      }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
}

await tAsync('只有思考没有正文：content 留空、思考进 reasoning_content、finish_reason=length', async () => {
  const out = await streamToNonStream(buildReasoningOnlyStream(), 'deepseek/deepseek-v4-pro');
  const choice = out.choices?.[0];
  if (choice.message.content !== '') throw new Error('思考不得冒充正文，content=' + JSON.stringify(choice.message.content));
  if (choice.message.reasoning_content !== '让我想想…再想想…') throw new Error('思考应留在 reasoning_content: ' + JSON.stringify(choice.message.reasoning_content));
  if (choice.finish_reason !== 'length') throw new Error('截断应表达为 finish_reason=length，实际 ' + choice.finish_reason);
});

await tAsync('自造字段 reasoning_used_as_content 已彻底移除', async () => {
  const out = await streamToNonStream(buildReasoningOnlyStream(), 'deepseek/deepseek-v4-pro');
  if ('reasoning_used_as_content' in out.choices[0].message) throw new Error('仍在下发自造字段');
});

await tAsync('思考 + 正文都有时：正文照常、finish_reason 不被改写', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'c', model: 'm',
        choices: [{ index: 0, delta: { reasoning_content: '想', content: '答' }, finish_reason: 'stop' }],
      }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const out = await streamToNonStream(stream, 'deepseek/deepseek-v4-pro');
  const choice = out.choices[0];
  if (choice.message.content !== '答') throw new Error('正文被改: ' + choice.message.content);
  if (choice.message.reasoning_content !== '想') throw new Error('思考丢失');
  if (choice.finish_reason !== 'stop') throw new Error('正常回答的 finish_reason 被改成 ' + choice.finish_reason);
});

await tAsync('只有思考但带工具调用时不算截断（工具调用就是这轮的产出）', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: ' + JSON.stringify({
        id: 'c', model: 'm',
        choices: [{ index: 0, delta: { reasoning_content: '该调工具', tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const out = await streamToNonStream(stream, 'deepseek/deepseek-v4-pro');
  const choice = out.choices[0];
  if (choice.finish_reason !== 'tool_calls') throw new Error('有工具调用不该判成 length，实际 ' + choice.finish_reason);
  if (choice.message.tool_calls?.[0]?.id !== 'call_x') throw new Error('tool_calls 丢失');
});

await tAsync('Anthropic 流式：usage-only 块转成 message_delta.usage', async () => {
  const piped = new Response(buildUsageOnlyStream()).body.pipeThrough(anthropicStream({ id: 'deepseek/deepseek-v4-pro' }));
  const events = parseSseData(await new Response(piped).text());
  const delta = events.find((e) => e.type === 'message_delta');
  if (delta?.usage?.output_tokens !== 31) throw new Error('message_delta.usage 缺失: ' + JSON.stringify(delta));
  const start = events.find((e) => e.type === 'message_start');
  if (start?.message?.usage?.input_tokens == null) throw new Error('message_start 缺 input_tokens');
});

await tAsync('Responses 流式：usage-only 块进记账', async () => {
  const { info } = await pipeUsageOnly((body, writable, onComplete) =>
    pipeUpstreamToResponsesStream(body, writable, { id: 'deepseek/deepseek-v4-pro' }, onComplete));
  if (info?.usage?.total_tokens !== 42) throw new Error('记账拿不到 usage: ' + JSON.stringify(info?.usage));
});

await tAsync('Responses 非流式：usage-only 块进 resp.usage', async () => {
  const out = await responsesToNonStream(buildUsageOnlyStream(), { id: 'deepseek/deepseek-v4-pro' });
  if (out.usage?.total_tokens !== 42) throw new Error('resp.usage 为 ' + JSON.stringify(out.usage));
});

const T = 't-integration-token';
// 构造上游 mock：session 创建 200，chat 首次 429 带 retryAfterMs
let upstream429Left = 0;
let upstreamChatCalls = 0;
function installUpstream429(retryAfterMs) {
  fetchState.calls = [];
  upstream429Left = 1;
  upstreamChatCalls = 0;
  fetchState.impl = (url, init) => {
    const u = String(url);
    if (u.includes('/api/v1/freebuff/session')) {
      if (init.method === 'POST') return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => JSON.stringify({ status: 'active', instanceId: 'inst-' + (++upstreamChatCalls), expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() }) });
      return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => JSON.stringify({ status: 'active', instanceId: 'inst-x', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() }) });
    }
    if (u.includes('/api/v1/agent-runs')) return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => JSON.stringify({ runId: 'run-' + (++upstreamChatCalls) }) });
    if (u.includes('/api/v1/ads') || u.includes('/api/v1/usage')) return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => '{}' });
    if (u.includes('/api/v1/chat/completions')) {
      upstreamChatCalls++;
      if (upstream429Left > 0) {
        upstream429Left--;
        return Promise.resolve({ status: 429, ok: false, headers: {}, text: async () => JSON.stringify({ error: { retryAfterMs } }) });
      }
      return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n' });
    }
    return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => '{}' });
  };
}

await tAsync('上游 429 → 本地冷却 + 下次直接本地 429', async () => {
  // 先手动冷却该 token（模拟上次上游 429 留下的锁）
  cooldown(T, 300 * 1000, { reason: 'quota', retryAfterMs: 300 * 1000 });
  // executeChat 走 fetch 会打到上游 —— 但我们设了锁，第一次就该直接本地 429
  installUpstream429(300 * 1000);
  const env = { FREEBUFF_TOKEN: T, FREEBUFF_DEBUG: 'false' };
  const chatParams = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false };
  const mc = { id: 'deepseek/deepseek-v4-flash', session: 'deepseek/deepseek-v4-flash', upstream: 'deepseek/deepseek-v4-flash', agent: 'base2-free-deepseek' };
  const resp = await executeChat(env, chatParams, mc, false, 'chat');
  const body = await resp.text();
  const j = JSON.parse(body);
  if (resp.status !== 429) throw new Error('期望 429, got ' + resp.status + ': ' + body.slice(0, 100));
  if (!j.error || j.error.type !== 'rate_limit_exceeded') throw new Error('错误类型不对: ' + body.slice(0, 120));
  // 检查 Retry-After 头（resp.headers 是普通对象，直接用）
  const ra = resp.headers.get ? resp.headers.get('Retry-After') : resp.headers['Retry-After'];
  if (ra !== '300') throw new Error('Retry-After 头不对: ' + ra);
  // 关键：应该没有打到上游 chat（本地拦截）
  if (upstreamChatCalls !== 0) throw new Error(`本地锁不应打上游, 上游被调用 ${upstreamChatCalls} 次`);
  console.log('       [OK] 本地 429 锁拦截上游调用 ✓');
});

function installSingleChatResponse(makeResponse) {
  let chatCalls = 0;
  fetchState.calls = [];
  fetchState.impl = (url, init) => {
    const u = String(url);
    if (u.includes('/api/v1/freebuff/session')) {
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: {},
        text: async () => JSON.stringify({
          status: 'active',
          instanceId: 'inst-first-failure',
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      });
    }
    if (u.includes('/api/v1/agent-runs')) {
      return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => JSON.stringify({ runId: 'run-first-failure' }) });
    }
    if (u.includes('/api/v1/ads') || u.includes('/api/v1/usage')) {
      return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => '{}' });
    }
    if (u.includes('/api/v1/chat/completions')) {
      chatCalls++;
      return Promise.resolve(makeResponse());
    }
    return Promise.resolve({ status: 200, ok: true, headers: {}, text: async () => '{}' });
  };
  return () => chatCalls;
}

function installSingleChatFailure(status, payload) {
  return installSingleChatResponse(() => ({
    status,
    ok: false,
    headers: {},
    text: async () => JSON.stringify(payload),
  }));
}

const integrationChat = { model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: false };
const integrationModel = { id: 'deepseek/deepseek-v4-flash', session: 'deepseek/deepseek-v4-flash', upstream: 'deepseek/deepseek-v4-flash', agent: 'base2-free-deepseek' };
const integrationReview = { ...integrationChat, metadata: { freebuff_mode: 'code_review' } };
const integrationReviewModel = { ...integrationModel, root_agent: integrationModel.agent, reviewer_agent: 'code-reviewer' };

await tAsync('首次上游 429 当次返回结构化池耗尽响应', async () => {
  const chatCalls = installSingleChatFailure(429, { status: 'rate_limited', retryAfterMs: 60000 });
  const env = { FREEBUFF_TOKEN: 'first-upstream-429-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationChat, integrationModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 chat 调用 ${chatCalls()} 次`);
  if (response.status !== 429 || body.error?.type !== 'rate_limit_exceeded') {
    throw new Error(`首次 429 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
});

await tAsync('首次明确 banned 当次返回 403', async () => {
  const chatCalls = installSingleChatFailure(403, { status: 'banned' });
  const env = { FREEBUFF_TOKEN: 'first-upstream-banned-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationChat, integrationModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 chat 调用 ${chatCalls()} 次`);
  if (response.status !== 403 || body.error?.type !== 'account_banned') {
    throw new Error(`首次 banned 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
});

await tAsync('业务 endpoint 首次 401 经 session 确认仍存活时不永久隔离', async () => {
  const chatCalls = installSingleChatFailure(401, { status: 'unauthorized' });
  const env = { FREEBUFF_TOKEN: 'first-upstream-invalid-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationChat, integrationModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 chat 调用 ${chatCalls()} 次`);
  if (response.status !== 503 || body.error?.type !== 'upstream_session_unavailable') {
    throw new Error(`瞬时 401 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
});

await tAsync('上游 400 原文回传，不换号也不冷却账号', async () => {
  // luna 的 reasoning_effort 冲突就是这种 400：换号也是同一个 400，
  // 旧行为会把整池冷却 60s 并把原文换成"当前没有可用账号"。
  const chatCalls = installSingleChatFailure(400, {
    error: { message: '"reasoning_effort" and "reasoning.effort" are both provided with conflicting values', code: 400 },
  });
  const tokenA = 'upstream-400-aaaaaa';
  const tokenB = 'upstream-400-bbbbbb';
  const env = { FREEBUFF_TOKEN: `${tokenA}\n${tokenB}`, FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationChat, integrationModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`400 仍在换号重试: 上游 chat 被调用 ${chatCalls()} 次`);
  if (response.status !== 400 || body.error?.type !== 'invalid_request_error') {
    throw new Error(`400 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
  if (!String(body.error.message).includes('conflicting values')) {
    throw new Error('上游原文被吞: ' + body.error.message);
  }
  if (inCooldown(tokenA) || inCooldown(tokenB)) throw new Error('400 不应冷却账号');
});

await tAsync('Reviewer 首次上游 429 当次返回结构化池耗尽响应', async () => {
  const chatCalls = installSingleChatFailure(429, { status: 'rate_limited', retryAfterMs: 60000 });
  const env = { FREEBUFF_TOKEN: 'first-review-429-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationReview, integrationReviewModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 reviewer 调用 ${chatCalls()} 次`);
  if (response.status !== 429 || body.error?.type !== 'rate_limit_exceeded') {
    throw new Error(`Reviewer 首次 429 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
});

await tAsync('Reviewer 首次明确 banned 当次返回 403', async () => {
  const chatCalls = installSingleChatFailure(403, { status: 'banned' });
  const env = { FREEBUFF_TOKEN: 'first-review-banned-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationReview, integrationReviewModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 reviewer 调用 ${chatCalls()} 次`);
  if (response.status !== 403 || body.error?.type !== 'account_banned') {
    throw new Error(`Reviewer 首次 banned 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
});

await tAsync('Reviewer 上游 400 原文回传，不换号也不冷却账号', async () => {
  // 与 chat 同口径：reviewer 那条支路以前会冷却+换号，把一个「请求不合法」
  // 的确定性 400 扩散成整池冷却 + "当前没有可用账号"。
  const chatCalls = installSingleChatFailure(400, {
    error: { message: 'reviewer payload rejected: bad reasoning_effort', code: 400 },
  });
  const tokenA = 'review-400-aaaaaa';
  const tokenB = 'review-400-bbbbbb';
  const env = { FREEBUFF_TOKEN: `${tokenA}\n${tokenB}`, FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationReview, integrationReviewModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`400 仍在换号重试: 上游 reviewer 被调用 ${chatCalls()} 次`);
  if (response.status !== 400 || body.error?.type !== 'invalid_request_error') {
    throw new Error(`Reviewer 400 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
  if (!String(body.error.message).includes('bad reasoning_effort')) {
    throw new Error('上游原文被吞: ' + body.error.message);
  }
  if (inCooldown(tokenA) || inCooldown(tokenB)) throw new Error('400 不应冷却账号');
});

await tAsync('模型目录携带官方动态 pool 元数据', async () => {
  setTestDynamicModels([
    {
      id: 'deepseek/deepseek-v4-pro', session: 'deepseek/deepseek-v4-pro',
      agent: 'base2-free-deepseek', root_agent: 'base2-free-deepseek',
      pool: 'premium',
    },
    {
      id: 'openai/gpt-5.6-luna', session: 'openai/gpt-5.6-luna',
      agent: 'base2-free-luna', root_agent: 'base2-free-luna',
      pool: 'premium',
    },
    {
      id: 'anthropic/claude-fable-5', session: 'anthropic/claude-fable-5',
      agent: 'base2-free-fable', root_agent: 'base2-free-fable',
      pool: 'standard',
    },
  ]);
  const body = await (await handleModels()).json();
  const pro = body.data.find((model) => model.id === 'deepseek/deepseek-v4-pro');
  if (!pro || pro.pool !== 'premium' || pro.tier !== 'us_sg') {
    throw new Error('DS4P 共享 Premium 分组错误: ' + JSON.stringify(pro));
  }
  const luna = body.data.find((entry) => entry.id === 'openai/gpt-5.6-luna');
  if (!luna || luna.pool !== 'premium' || luna.tier !== 'us_sg') {
    throw new Error('Luna 共享 Premium 分组错误: ' + JSON.stringify(luna));
  }
  const fable = body.data.find((entry) => entry.id === 'anthropic/claude-fable-5');
  if (!fable || fable.pool !== 'standard' || fable.tier !== 'limited') {
    throw new Error('Fable 限定 tier 错误: ' + JSON.stringify(fable));
  }
  setTestDynamicModels(null);
});

await tAsync('DS4P/Luna 独立额度池进入限定分组', async () => {
  setTestDynamicModels([
    {
      id: 'deepseek/deepseek-v4-pro', session: 'deepseek/deepseek-v4-pro',
      agent: 'base2-free-deepseek', root_agent: 'base2-free-deepseek',
      pool: 'deepseek_pro',
    },
    {
      id: 'openai/gpt-5.6-luna', session: 'openai/gpt-5.6-luna',
      agent: 'base2-free-luna', root_agent: 'base2-free-luna',
      pool: 'luna',
    },
  ]);
  const body = await (await handleModels()).json();
  for (const id of ['deepseek/deepseek-v4-pro', 'openai/gpt-5.6-luna']) {
    const model = body.data.find((entry) => entry.id === id);
    if (!model || model.tier !== 'limited') {
      throw new Error(`${id} 独立额度 tier 错误: ` + JSON.stringify(model));
    }
  }
  setTestDynamicModels(null);
});

await tAsync('动态目录中的 luna-es 不进入普通模型目录', async () => {
  setTestDynamicModels([
    {
      id: 'openai/gpt-5.6-luna-es', session: 'openai/gpt-5.6-luna-es',
      agent: 'base2-free-luna-es', root_agent: 'base2-free-luna-es',
      pool: 'premium',
    },
  ]);
  const body = await (await handleModels()).json();
  if (body.data.some((model) => model.id === 'openai/gpt-5.6-luna-es')) {
    throw new Error('luna-es 不得出现在普通 /v1/models: ' + JSON.stringify(body.data));
  }
  if (await resolveModelConfig('openai/gpt-5.6-luna-es') !== null) {
    throw new Error('luna-es 不得进入普通请求解析入口');
  }
  setTestDynamicModels(null);
});

console.log('--- /v1/models 分组 tag ---');
await tAsync('模型按 免费 → US/SG → 限定 分组打 tier', async () => {
  if (MODEL_TIERS.map(([k]) => k).join(',') !== 'free,us_sg,limited') {
    throw new Error('分组顺序错了: ' + MODEL_TIERS.map(([k]) => k).join(','));
  }
  const tierOf = (id) => {
    const i = MODEL_TIERS.findIndex(([, ids]) => ids.has(id));
    return i < 0 ? null : MODEL_TIERS[i][0];
  };
  const expected = {
    'mimo/mimo-v2.5': 'free',
    'deepseek/deepseek-v4-flash': 'free',
    'deepseek/deepseek-v4-pro': 'limited',
    'openai/gpt-5.6-luna': 'limited',
    'meta/muse-spark-1.2-contributor': 'us_sg',
    'z-ai/glm-5.2': 'limited',
    'anthropic/claude-fable-5': 'limited',
  };
  for (const [id, want] of Object.entries(expected)) {
    if (tierOf(id) !== want) throw new Error(`${id} tier=${tierOf(id)}，期望 ${want}`);
  }
  // handleModels 的拼装：带 tier、不再有旧的 free 字段、内部排序键要摘掉
  const body = await (await handleModels()).json();
  if (body.data.some((m) => m.id === 'minimax/minimax-m3')) {
    throw new Error('已暂停的 M3 不得出现在 /v1/models');
  }
  const mimo = body.data.find((m) => m.id === 'mimo/mimo-v2.5');
  if (!mimo || mimo.tier !== 'free' || 'free' in mimo || '_sort' in mimo) {
    throw new Error('handleModels 输出不对: ' + JSON.stringify(mimo));
  }
  // 有分组的一定排在无分组的前面，且组内序号单调不减
  const ranks = body.data.map((m) => (m.tier ? MODEL_TIERS.findIndex(([k]) => k === m.tier) : MODEL_TIERS.length));
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] < ranks[i - 1]) throw new Error('模型列表没按分组排序: ' + JSON.stringify(body.data.map((m) => m.id)));
  }
  if (await resolveModelConfig('minimax/minimax-m3') !== null) {
    throw new Error('已暂停的 M3 必须在请求解析入口被拒绝');
  }
  setTestAliases('old-m3=minimax/minimax-m3');
  if (await resolveModelConfig('old-m3') !== null) {
    throw new Error('别名不得绕过 M3 暂停闸门');
  }
  setTestAliases('');
});

const modelRefreshSources = {
  agents: `
export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL: Record<string, string> = {
  [FREEBUFF_MIMO_V25_MODEL_ID]: 'base2-free-mimo',
  [FREEBUFF_OX_ALPHA_MODEL_ID]: 'base2-free-ox-alpha',
}
export const FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL: Record<string, string> = {
  [FREEBUFF_OX_ALPHA_MODEL_ID]: 'base3-free-ox-alpha',
}
`,
  models: `
export const FREEBUFF_MIMO_V25_MODEL_ID = 'mimo/mimo-v2.5'
export const FREEBUFF_OX_ALPHA_MODEL_ID = 'stealth/ox-alpha'
export const FREEBUFF_PREMIUM_MODEL_IDS = [] as const
export const FREEBUFF_WEB_PREMIUM_MODEL_IDS = [...FREEBUFF_PREMIUM_MODEL_IDS] as const
export const FREEBUFF_GLM_V52_MODEL_IDS = [] as const
`,
  stable: `
export const FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek/deepseek-v4-flash'
export const FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek/deepseek-v4-pro'
export const FREEBUFF_MINIMAX_M3_MODEL_ID = 'minimax/minimax-m3'
`,
};

function modelRefreshResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: async () => text,
    json: async () => JSON.parse(text),
  });
}

function installModelRefreshFetch(endpointResponse) {
  fetchState.calls = [];
  fetchState.impl = (url) => {
    const value = String(url);
    if (value.includes('free-agents.ts')) return modelRefreshResponse(200, modelRefreshSources.agents);
    if (value.includes('freebuff-models.ts')) return modelRefreshResponse(200, modelRefreshSources.models);
    if (value.includes('freebuff-model-ids.ts')) return modelRefreshResponse(200, modelRefreshSources.stable);
    if (value.includes('/models/stealth/ox-alpha/endpoints')) return endpointResponse();
    return modelRefreshResponse(404, { error: { message: 'not found' } });
  };
}

async function requestModelRefresh(apiKey = 'owner-key', env = { FREEBUFF_API_KEY: 'owner-key' }) {
  return workerDefault.fetch(new Request('http://worker.test/v1/models?refresh=1', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }), env);
}

async function requestModels(apiKey = 'owner-key', env = { FREEBUFF_API_KEY: 'owner-key' }) {
  return workerDefault.fetch(new Request('http://worker.test/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  }), env);
}

await tAsync('Master Key 强制刷新绕过新鲜缓存，Ox 无端点时动态撤下且不创建 session', async () => {
  setTestDynamicModels([
    { id: 'legacy/stale-model', session: 'legacy/stale-model', agent: 'legacy-agent' },
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  installModelRefreshFetch(() => modelRefreshResponse(200, {
    data: { id: 'stealth/ox-alpha', endpoints: [] },
  }));

  const response = await requestModelRefresh();
  const body = await response.json();
  const urls = fetchState.calls.map((call) => call.url);
  if (!urls.some((url) => url.includes('free-agents.ts'))) {
    throw new Error('refresh=1 没有绕过 6 小时缓存: ' + JSON.stringify(urls));
  }
  if (!urls.some((url) => url.includes('/models/stealth/ox-alpha/endpoints'))) {
    throw new Error('没有定点检查 ox-alpha endpoints: ' + JSON.stringify(urls));
  }
  if (urls.some((url) => url.includes('codebuff.com') || url.includes('/api/v1/freebuff/session'))) {
    throw new Error('模型刷新不得请求 Freebuff session: ' + JSON.stringify(urls));
  }
  if (body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('无 endpoints 的 ox-alpha 仍在模型目录: ' + JSON.stringify(body.data));
  }
  if (body.data.some((model) => model.id === 'legacy/stale-model')) {
    throw new Error('强刷后仍保留旧缓存模型: ' + JSON.stringify(body.data));
  }
  if (await resolveModelConfig('stealth/ox-alpha') !== null) {
    throw new Error('已动态撤下的 ox-alpha 仍可进入请求解析');
  }
});

await tAsync('进程冷启动直接调用 Ox 时也先检查 endpoints，不漏放首笔请求', async () => {
  setTestDynamicModels(null);
  installModelRefreshFetch(() => modelRefreshResponse(200, {
    data: { id: 'stealth/ox-alpha', endpoints: [] },
  }));

  if (await resolveModelConfig('stealth/ox-alpha') !== null) {
    throw new Error('冷启动刷新已确认无 endpoints，首笔 Ox 仍被解析为可调用');
  }
});

await tAsync('Ox 旧快照过期后直接调用也要刷新 endpoints', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ], 0);
  setTestModelAvailability('stealth/ox-alpha', true);
  installModelRefreshFetch(() => modelRefreshResponse(200, {
    data: { id: 'stealth/ox-alpha', endpoints: [] },
  }));

  const resolved = await resolveModelConfig('stealth/ox-alpha');
  const endpointWasCalled = fetchState.calls.some((call) =>
    call.url.includes('/models/stealth/ox-alpha/endpoints'));

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (!endpointWasCalled) throw new Error('过期 Ox 快照被直接命中，未重新检查 endpoints');
  if (resolved !== null) throw new Error('过期刷新已确认无 endpoints，Ox 仍可进入调用入口');
});

await tAsync('首次发现 Ox 但 endpoints 无法确认时保持下架', async () => {
  setTestDynamicModels(null);
  installModelRefreshFetch(() => modelRefreshResponse(503, {
    error: { message: 'endpoint service unavailable' },
  }));

  const body = await (await requestModelRefresh()).json();
  const resolved = await resolveModelConfig('stealth/ox-alpha');

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('没有上次可用状态且 endpoint 检查失败时 Ox 被默认上架');
  }
  if (resolved !== null) throw new Error('未经 endpoint 确认的新 Ox 可进入调用入口');
});

await tAsync('冷启动 endpoint 瞬时失败后普通调用只重试 endpoint 并自动恢复', async () => {
  setTestDynamicModels(null);
  let endpointCalls = 0;
  let sourceCalls = 0;
  installModelRefreshFetch(() => {
    endpointCalls++;
    return endpointCalls === 1
      ? modelRefreshResponse(503, { error: { message: 'temporary endpoint outage' } })
      : modelRefreshResponse(200, { data: { id: 'stealth/ox-alpha', endpoints: [{ name: 'restored' }] } });
  });
  const originalImpl = fetchState.impl;
  fetchState.impl = (url, init) => {
    if (String(url).includes('free-agents.ts')
      || String(url).includes('freebuff-models.ts')
      || String(url).includes('freebuff-model-ids.ts')) sourceCalls++;
    return originalImpl(url, init);
  };

  try {
    if (await resolveModelConfig('stealth/ox-alpha') !== null) {
      throw new Error('冷启动首次 endpoint 瞬时失败时 Ox 不应立即放行');
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const resolved = await resolveModelConfig('stealth/ox-alpha');
    if (!resolved) throw new Error('endpoint 恢复后普通调用没有自动重新探测并恢复 Ox');
    if (endpointCalls !== 2) throw new Error(`endpoint 重试次数错误: ${endpointCalls}`);
    if (sourceCalls !== 3) throw new Error(`短重试不应重拉模型源，实际 source=${sourceCalls}`);
    const body = await (await handleModels()).json();
    if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
      throw new Error('endpoint 恢复后模型目录没有重新展示 Ox');
    }
  } finally {
    setTestDynamicModels(null);
    resetTestModelRefreshFlight();
    fetchState.impl = null;
    fetchState.calls = [];
  }
});

await tAsync('已知可用 Ox 的 endpoint 瞬时失败保留旧状态并只重试 endpoint', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ], 0);
  setTestModelAvailability('stealth/ox-alpha', true);
  let endpointCalls = 0;
  let sourceCalls = 0;
  installModelRefreshFetch(() => {
    endpointCalls++;
    return endpointCalls === 1
      ? modelRefreshResponse(503, { error: { message: 'temporary endpoint outage' } })
      : modelRefreshResponse(200, { data: { id: 'stealth/ox-alpha', endpoints: [{ name: 'restored' }] } });
  });
  const originalImpl = fetchState.impl;
  fetchState.impl = (url, init) => {
    if (String(url).includes('free-agents.ts')
      || String(url).includes('freebuff-models.ts')
      || String(url).includes('freebuff-model-ids.ts')) sourceCalls++;
    return originalImpl(url, init);
  };

  try {
    await refreshDynamicModelsIfStale(true);
    const first = await resolveModelConfig('stealth/ox-alpha');
    if (!first) throw new Error('endpoint 瞬时失败不应撤下上次已确认可用的 Ox');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const resolved = await resolveModelConfig('stealth/ox-alpha');
    if (!resolved) throw new Error('endpoint 恢复后没有恢复 Ox 调用');
    if (endpointCalls !== 2) throw new Error(`endpoint 应只重试一次，实际 ${endpointCalls}`);
    if (sourceCalls !== 3) throw new Error(`endpoint 重试不应重拉模型源，实际 source=${sourceCalls}`);
  } finally {
    setTestDynamicModels(null);
    resetTestModelRefreshFlight();
    fetchState.impl = null;
    fetchState.calls = [];
  }
});

await tAsync('普通 Ox endpoint 重试与 Master 全量刷新共享同一探测请求', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ], 0);
  setTestModelAvailability('stealth/ox-alpha', true);
  let endpointCalls = 0;
  let releasePending;
  let markEndpointStarted;
  const endpointStarted = new Promise((resolve) => { markEndpointStarted = resolve; });
  installModelRefreshFetch(() => {
    endpointCalls++;
    if (endpointCalls === 1) {
      return modelRefreshResponse(503, { error: { message: 'temporary endpoint outage' } });
    }
    markEndpointStarted();
    return new Promise((resolve) => {
      releasePending = () => resolve(modelRefreshResponse(200, {
        data: { id: 'stealth/ox-alpha', endpoints: [{ name: 'shared' }] },
      }));
    });
  });

  try {
    await refreshDynamicModelsIfStale(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const direct = resolveModelConfig('stealth/ox-alpha');
    await endpointStarted;
    const forced = requestModelRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePending();
    const [resolved, response] = await Promise.all([direct, forced]);
    await response.json();
    if (!resolved) throw new Error('共享 endpoint 探测完成后 Ox 没有恢复');
    if (endpointCalls !== 2) throw new Error(`普通重试与强刷重复探测 endpoint: ${endpointCalls}`);
  } finally {
    setTestDynamicModels(null);
    resetTestModelRefreshFlight();
    fetchState.impl = null;
    fetchState.calls = [];
  }
});

await tAsync('模型源响应体卡住时刷新按超时回落旧快照', async () => {
  setTestDynamicModels([
    { id: 'legacy/stale-model', session: 'legacy/stale-model', agent: 'legacy-agent' },
  ], Date.now());
  fetchState.calls = [];
  const hangingBody = (signal) => new Promise((_, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
  });
  fetchState.impl = (url, init = {}) => {
    const value = String(url);
    if (value.includes('raw.githubusercontent.com')
      || value.includes('cdn.jsdelivr.net')
      || value.includes('freebuff-models.json')) {
      return {
        status: 200,
        ok: true,
        headers: {},
        text: () => hangingBody(init.signal),
        json: () => hangingBody(init.signal),
      };
    }
    return modelRefreshResponse(404, { error: { message: 'not found' } });
  };

  try {
    const outcome = await Promise.race([
      refreshDynamicModelsIfStale(true).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    resetTestModelRefreshFlight();
    if (outcome === 'timeout') throw new Error('响应体卡住时刷新单飞未按超时结束');
    const body = await (await handleModels()).json();
    if (!body.data.some((model) => model.id === 'legacy/stale-model')) {
      throw new Error('刷新超时后没有保留旧模型目录');
    }
  } finally {
    setTestDynamicModels(null);
    resetTestModelRefreshFlight();
    fetchState.impl = null;
    fetchState.calls = [];
  }
});

await tAsync('冷启动刷新进行中时普通模型目录等待完整首个快照', async () => {
  setTestDynamicModels(null);
  let markEndpointStarted;
  let releaseEndpoint;
  const endpointStarted = new Promise((resolve) => { markEndpointStarted = resolve; });
  installModelRefreshFetch(() => {
    markEndpointStarted();
    return new Promise((resolve) => {
      releaseEndpoint = () => modelRefreshResponse(200, {
        data: { id: 'stealth/ox-alpha', endpoints: [{ name: 'available' }] },
      }).then(resolve);
    });
  });

  const forcedRefresh = requestModelRefresh().then((response) => response.json());
  await endpointStarted;
  let regularSettled = false;
  const regularRequest = requestModels().then(async (response) => {
    const body = await response.json();
    regularSettled = true;
    return body;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const returnedIncompleteCatalog = regularSettled;

  releaseEndpoint();
  const [forcedBody, regularBody] = await Promise.all([forcedRefresh, regularRequest]);

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (returnedIncompleteCatalog) throw new Error('冷启动并发目录提前返回了硬编码残缺列表');
  for (const body of [forcedBody, regularBody]) {
    if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
      throw new Error('首轮刷新完成后并发目录没有拿到完整模型快照');
    }
  }
});

await tAsync('模型刷新单飞且原子发布，无关请求读旧快照、Ox 等待检查', async () => {
  setTestDynamicModels([
    { id: 'legacy/old-model', session: 'legacy/old-model', agent: 'legacy-agent' },
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  let markEndpointStarted;
  let releaseEndpoint;
  const endpointStarted = new Promise((resolve) => { markEndpointStarted = resolve; });
  installModelRefreshFetch(() => {
    markEndpointStarted();
    return new Promise((resolve) => {
      releaseEndpoint = () => modelRefreshResponse(200, {
        data: { id: 'stealth/ox-alpha', endpoints: [] },
      }).then(resolve);
    });
  });

  const forcedRefresh = requestModelRefresh().then((response) => response.json());
  await endpointStarted;

  let regularSettled = false;
  let staticSettled = false;
  let oxSettled = false;
  const regularRequest = requestModels().then(async (response) => {
    const body = await response.json();
    regularSettled = true;
    return body;
  });
  const staticResolution = resolveModelConfig('mimo/mimo-v2.5').then((model) => {
    staticSettled = true;
    return model;
  });
  const oxResolution = resolveModelConfig('stealth/ox-alpha').then((model) => {
    oxSettled = true;
    return model;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const blockedUnrelated = !regularSettled || !staticSettled;
  const leakedOxBeforeProbe = oxSettled;

  releaseEndpoint();
  const [forcedBody, regularBody, staticModel, resolvedOx] = await Promise.all([
    forcedRefresh, regularRequest, staticResolution, oxResolution,
  ]);
  const sourceFetches = fetchState.calls.filter((call) =>
    call.url.includes('free-agents.ts') || call.url.includes('freebuff-models.ts')
      || call.url.includes('freebuff-model-ids.ts'));
  const endpointFetches = fetchState.calls.filter((call) =>
    call.url.includes('/models/stealth/ox-alpha/endpoints'));

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (blockedUnrelated) throw new Error('手动刷新阻塞了与 endpoint 检查无关的静态目录/模型调用');
  if (leakedOxBeforeProbe) throw new Error('endpoint 检查完成前 Ox 调用看到了半成品模型缓存');
  if (sourceFetches.length !== 3 || endpointFetches.length !== 1) {
    throw new Error(`并发刷新没有复用同一轮请求: source=${sourceFetches.length}, endpoint=${endpointFetches.length}`);
  }
  // 旧快照里 Ox 上次已确认可用，普通目录请求可以继续读该原子快照；
  // 强刷完成后再整批切换到无 Ox 的新快照。
  if (!regularBody.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('刷新中的普通目录请求没有立即返回上次已发布的 Ox 快照');
  }
  if (!regularBody.data.some((model) => model.id === 'legacy/old-model')) {
    throw new Error('刷新中的普通目录请求没有读取上次已发布的模型目录');
  }
  if (!staticModel || staticModel.id !== 'mimo/mimo-v2.5') {
    throw new Error('刷新期间静态模型调用没有立即命中旧快照');
  }
  if (forcedBody.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('强刷完成后仍返回无 endpoints 的 Ox');
  }
  if (resolvedOx !== null) throw new Error('并发 Ox 调用仍解析到无 endpoints 的 Ox');
});

await tAsync('刷新中的旧目录快照绑定旧 availability，不混用新发布状态', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  let markEndpointStarted;
  let releaseEndpoint;
  const endpointStarted = new Promise((resolve) => { markEndpointStarted = resolve; });
  installModelRefreshFetch(() => {
    markEndpointStarted();
    return new Promise((resolve) => {
      releaseEndpoint = () => modelRefreshResponse(200, {
        data: { id: 'stealth/ox-alpha', endpoints: [] },
      }).then(resolve);
    });
  });

  const forcedRefresh = refreshDynamicModelsIfStale(true);
  await endpointStarted;
  const oldSnapshot = await refreshDynamicModelsIfStale();
  releaseEndpoint();
  await forcedRefresh;

  const oldOxAvailable = modelIsAvailable('stealth/ox-alpha', oldSnapshot.availability);
  const newOxAvailable = modelIsAvailable('stealth/ox-alpha');

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (!(oldSnapshot.availability instanceof Map)) {
    throw new Error('模型刷新结果没有携带与 cache 同版本的 availability 快照');
  }
  if (!oldOxAvailable) throw new Error('旧目录快照混用了新发布的 Ox availability');
  if (newOxAvailable) throw new Error('新快照没有发布 Ox 下架状态');
});

await tAsync('官方源码失败改走 Release 兜底时仍检查 Ox endpoints', async () => {
  setTestDynamicModels(null);
  fetchState.calls = [];
  fetchState.impl = (url) => {
    const value = String(url);
    if (value.includes('free-agents.ts') || value.includes('freebuff-models.ts')
      || value.includes('freebuff-model-ids.ts')) {
      return modelRefreshResponse(503, { error: { message: 'source unavailable' } });
    }
    if (value.includes('freebuff-models.json')) {
      return modelRefreshResponse(200, {
        models: [{ id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' }],
        pools: { premium: [], glm: [] },
      });
    }
    if (value.includes('/models/stealth/ox-alpha/endpoints')) {
      return modelRefreshResponse(200, { data: { id: 'stealth/ox-alpha', endpoints: [] } });
    }
    return modelRefreshResponse(404, { error: { message: 'not found' } });
  };

  const body = await (await requestModelRefresh()).json();
  if (!fetchState.calls.some((call) => call.url.includes('freebuff-models.json'))) {
    throw new Error('官方源码失败后没有进入 Release 兜底');
  }
  if (!fetchState.calls.some((call) => call.url.includes('/models/stealth/ox-alpha/endpoints'))) {
    throw new Error('Release 兜底提前返回，跳过了 Ox endpoints 检查');
  }
  if (body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('Release 兜底中的无端点 Ox 仍出现在目录');
  }
});

await tAsync('手动刷新全源失败时保留旧目录并明确标记未更新', async () => {
  setTestDynamicModels([
    { id: 'legacy/stale-model', session: 'legacy/stale-model', agent: 'legacy-agent' },
  ]);
  fetchState.calls = [];
  fetchState.impl = () => modelRefreshResponse(503, { error: { message: 'source unavailable' } });

  const body = await (await requestModelRefresh()).json();

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (body.refresh?.updated !== false || body.refresh?.source !== 'cache') {
    throw new Error('全源失败没有返回 stale refresh 状态: ' + JSON.stringify(body.refresh));
  }
  if (!body.data.some((model) => model.id === 'legacy/stale-model')) {
    throw new Error('全源失败不应丢弃上次模型目录');
  }
});

await tAsync('目录全源失败时连 Ox 可用性状态也完整保留', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  fetchState.calls = [];
  fetchState.impl = (url) => {
    const value = String(url);
    if (value.includes('/models/stealth/ox-alpha/endpoints')) {
      return modelRefreshResponse(200, { data: { id: 'stealth/ox-alpha', endpoints: [] } });
    }
    return modelRefreshResponse(503, { error: { message: 'source unavailable' } });
  };

  const body = await (await requestModelRefresh()).json();
  const endpointWasCalled = fetchState.calls.some((call) =>
    call.url.includes('/models/stealth/ox-alpha/endpoints'));

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (endpointWasCalled) throw new Error('目录源全失败时不应单独改写 endpoint availability');
  if (body.refresh?.updated !== false || body.refresh?.source !== 'cache') {
    throw new Error('目录全失败没有标记为旧快照: ' + JSON.stringify(body.refresh));
  }
  if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('目录全失败时旧快照里的可用 Ox 被部分更新撤下');
  }
});

await tAsync('分享 Key 携带 refresh=1 也不能绕过新鲜缓存强刷', async () => {
  setTestDynamicModels([
    { id: 'legacy/cached-model', session: 'legacy/cached-model', agent: 'legacy-agent' },
  ]);
  fetchState.calls = [];
  fetchState.impl = () => modelRefreshResponse(500, { error: { message: '不应发起网络请求' } });

  const response = await requestModelRefresh('shared-key', {
    FREEBUFF_API_KEY: 'owner-key',
    FREEBUFF_API_KEYS: [{ key: 'shared-key', name: 'friend', models: [] }],
  });
  const body = await response.json();
  const calls = fetchState.calls.length;

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (calls !== 0) throw new Error(`分享 Key 触发了远端强刷: ${calls} 次请求`);
  if ('refresh' in body) throw new Error('分享 Key 响应不应伪装成 Master Key 强刷结果');
  if (!body.data.some((model) => model.id === 'legacy/cached-model')) {
    throw new Error('分享 Key 没有使用新鲜缓存目录');
  }
});

await tAsync('Ox 可用性检查失败时保留上次可用状态', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  installModelRefreshFetch(() => modelRefreshResponse(503, { error: { message: 'temporary' } }));

  const body = await (await requestModelRefresh()).json();
  if (!fetchState.calls.some((call) => call.url.includes('/models/stealth/ox-alpha/endpoints'))) {
    throw new Error('强刷没有执行 ox-alpha 可用性检查');
  }
  if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('OpenRouter 瞬时失败误删了上次可用的 ox-alpha');
  }
});

await tAsync('Ox endpoints 恢复后重新进入模型目录', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', false);
  installModelRefreshFetch(() => modelRefreshResponse(200, {
    data: { id: 'stealth/ox-alpha', endpoints: [{ name: 'restored' }] },
  }));

  const body = await (await requestModelRefresh()).json();
  if (!fetchState.calls.some((call) => call.url.includes('/models/stealth/ox-alpha/endpoints'))) {
    throw new Error('强刷没有执行 ox-alpha 恢复检查');
  }
  if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('已有 endpoints 的 ox-alpha 没有恢复到目录');
  }
  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];
});

await tAsync('Ox endpoints 返回 404 时从模型目录和调用入口撤下', async () => {
  setTestDynamicModels([
    { id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base2-free-ox-alpha' },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  installModelRefreshFetch(() => modelRefreshResponse(404, {
    error: { message: 'model not found' },
  }));

  const body = await (await requestModelRefresh()).json();
  const resolved = await resolveModelConfig('stealth/ox-alpha');

  setTestDynamicModels(null);
  fetchState.impl = null;
  fetchState.calls = [];

  if (body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('endpoint 404 后 Ox 仍留在模型目录');
  }
  if (resolved !== null) throw new Error('endpoint 404 后 Ox 仍可进入调用入口');
});

// stealth/ox-alpha 已开放（官方 2026-08-24 放进 CLI/Desktop 目录并清空
// FREEBUFF_SERVICE_ONLY_MODEL_IDS，d534205ad39d）。动态源返回时必须正常出目录、
// 可解析；effort 走官方 ladder ['low','high','max'] 的 clamp-down——点名 max
// 原样透传（官方 Web UI 自己就发 max），不在 ladder 上的值下取到 high。
await tAsync('已开放的 ox-alpha 出现在目录、可经 ID 与短名调用、effort 按官方 ladder clamp', async () => {
  setTestDynamicModels([
    {
      id: 'stealth/ox-alpha', session: 'stealth/ox-alpha', agent: 'base3-free-ox-alpha',
      root_agent: 'base2-free-ox-alpha', upstream: 'stealth/ox-alpha',
    },
  ]);
  setTestModelAvailability('stealth/ox-alpha', true);
  const body = await (await handleModels()).json();
  if (!body.data.some((model) => model.id === 'stealth/ox-alpha')) {
    throw new Error('开放的 ox-alpha 必须出现在 /v1/models');
  }
  const mc = await resolveModelConfig('stealth/ox-alpha');
  if (!mc) throw new Error('ox-alpha 直接 ID 必须可解析');
  if (normalizeReasoningEffort('stealth/ox-alpha', 'max') !== 'max') {
    throw new Error('ox-alpha 点名 max 必须原样透传（官方 ladder 含 max）');
  }
  if (normalizeReasoningEffort('stealth/ox-alpha', 'low') !== 'low') {
    throw new Error('ox-alpha 点名 low 必须原样透传（官方 ladder 含 low）');
  }
  if (normalizeReasoningEffort('stealth/ox-alpha', 'medium') !== 'low'
    || normalizeReasoningEffort('stealth/ox-alpha', 'xhigh') !== 'high'
    || normalizeReasoningEffort('stealth/ox-alpha', 'ultra') !== 'max') {
    throw new Error('ox-alpha 不在 ladder 上的档位必须下取（medium→low，xhigh→high，ultra→max）');
  }
  const short = anthropicModelToOpenAI('ox-alpha');
  if (!short || !(await resolveModelConfig(short))) {
    throw new Error('Anthropic 短名 ox-alpha 必须可解析到该模型');
  }
  setTestDynamicModels(null);
});

// 官方 FREEBUFF_WEB_GOD_ONLY_MODELS（0766319c）= K3 Eco + luna-es：god 账号专属的
// Web/Cloud 路由，且都不在 CLI 目录 FREEBUFF_MODELS 里。普通 token 一定调不通，
// 所以按 fail closed 处理 —— 留在目录里只会让客户端反复选中它、白扣 admission。
await tAsync('god-only K3 Eco / luna-es 不出现在目录且不能经直接 ID、短名或别名调用', async () => {
  setTestDynamicModels([
    {
      id: 'crof/kimi-k3-eco', session: 'crof/kimi-k3-eco', agent: 'base2-free-kimi',
      root_agent: 'base2-free-kimi', upstream: 'crof/kimi-k3-eco', pool: 'premium',
    },
    {
      id: 'openai/gpt-5.6-luna-es', session: 'openai/gpt-5.6-luna-es', agent: 'base2-free-luna',
      root_agent: 'base2-free-luna', upstream: 'openai/gpt-5.6-luna-es',
    },
  ]);
  const body = await (await handleModels()).json();
  for (const id of ['crof/kimi-k3-eco', 'openai/gpt-5.6-luna-es']) {
    if (body.data.some((model) => model.id === id)) {
      throw new Error(`god-only ${id} 不得出现在 /v1/models`);
    }
    if (await resolveModelConfig(id) !== null) {
      throw new Error(`${id} 直接 ID 必须在请求解析入口被拒绝`);
    }
  }
  // 短名走 Anthropic 入口时仍会命中动态表，必须在 resolveModelConfig 兜住。
  if (await resolveModelConfig(anthropicModelToOpenAI('kimi-k3-eco')) !== null) {
    throw new Error('Anthropic 短名不得绕过 K3 Eco 闸门');
  }
  setTestAliases('old-kimi=crof/kimi-k3-eco');
  if (await resolveModelConfig('old-kimi') !== null) {
    throw new Error('别名不得绕过 K3 Eco 闸门');
  }
  setTestAliases('');
  setTestDynamicModels(null);
});

await tAsync('流式首 chunk 前客户端取消会停止上游并释放账号', async () => {
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let cancelCalls = 0;
  installSingleChatResponse(() => new Response(new ReadableStream({
    start() { startedResolve(); },
    cancel() { cancelCalls++; },
  })));
  const token = 'pre-response-cancel-123456';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const clientAbort = new AbortController();
  const pending = executeChat(env, { ...integrationChat, stream: true }, integrationModel, true, 'chat', clientAbort.signal);
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('上游 chat 未启动')), 5000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  clientAbort.abort(new Error('client disconnected'));
  const outcome = await Promise.race([
    pending.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  if (outcome === 'timeout') throw new Error('客户端取消后 executeChat 未结束');
  if (cancelCalls !== 1) throw new Error(`上游 reader.cancel 调用 ${cancelCalls} 次`);
  const available = pickToken(env, integrationModel.session, new Set());
  if (!available || available.token !== token) throw new Error('客户端取消后账号租约未释放');
  releaseToken(token);
});

// 清理锁：worker 内部 cooldowns 是 const Map，无法从外部 clear。
// 通过导出 inCooldown 验证锁确实生效即可；为隔离测试，换用不同 token 继续。

console.log('--- 集成：失效安全窗口（防 409 循环） ---');
await tAsync('连续 409 不无限重建 session', async () => {
  // 注入两次失效标记，第二次后 wasRecentlyInvalidated 应为 true（模拟循环场景）
  const mdl = 'deepseek/deepseek-v4-flash';
  markSessionInvalidated(T, mdl);
  // 模拟第一次失效重建后的第二次失效：在窗口内再标记
  markSessionInvalidated(T, mdl);
  // 此时 window 内应该判定"刚失效过"
  if (!wasRecentlyInvalidated(T, mdl)) throw new Error('窗口内应判定为 recently invalidated');
  // 且 deleteUpstreamSession 会跳过重复 DELETE（内部检查）
  console.log('       [OK] 窗口内防循环标记生效 ✓');
});

// ── mihomo 配置生成（server/proxy.mjs buildMihomoYaml） ─────────────────
console.log('--- buildMihomoYaml（出口代理配置） ---');
const { buildMihomoYaml } = await import(new URL('../server/proxy.mjs', import.meta.url));
t('订阅 URL 含特殊字符仍正确转义', () => {
  const y = buildMihomoYaml('https://sub.example.com/api/v1?token=a&b=c#x');
  if (!y.includes('https://sub.example.com/api/v1?token=a&b=c#x')) throw new Error('url 没转义好');
});
t('关键配置项齐全', () => {
  const y = buildMihomoYaml('https://sub.example.com/sub');
  for (const needle of [
    'mixed-port:',
    'external-controller:',
    'proxy-providers:',
    'type: select',
    'DOMAIN-SUFFIX,codebuff.com',
    'MATCH,DIRECT',
    "nameserver: [223.5.5.5, 119.29.29.29]",
  ]) {
    if (!y.includes(needle)) throw new Error('缺 ' + needle);
  }
});
t('账号出站生成独立 selector 与 mixed listener', () => {
  const y = buildMihomoYaml('https://sub.example.com/sub');
  for (const [lane, port] of [[0, 17900], [1, 17901], [63, 17963]]) {
    if (!y.includes(`name: freebuff-account-${lane}`)) throw new Error(`缺账号 selector lane ${lane}`);
    if (!y.includes(`name: freebuff-account-in-${lane}`)) throw new Error(`缺账号 listener lane ${lane}`);
    if (!y.includes(`port: ${port}`)) throw new Error(`缺账号 listener 端口 ${port}`);
    if (!y.includes(`proxy: freebuff-account-${lane}`)) throw new Error(`lane ${lane} 没有钉到自己的 selector`);
  }
  const groups = y.match(/name: freebuff-account-\d+/g) || [];
  const listeners = y.match(/name: freebuff-account-in-\d+/g) || [];
  if (groups.length !== 64 || listeners.length !== 64) {
    throw new Error(`账号 lane 数量错误: groups=${groups.length}, listeners=${listeners.length}`);
  }
  for (const [lane, port] of [[0, 17964], [1, 17965], [63, 18027]]) {
    for (const needle of [
      `name: freebuff-account-probe-${lane}`,
      `name: freebuff-account-probe-in-${lane}`,
      `port: ${port}`,
      `proxy: freebuff-account-probe-${lane}`,
    ]) {
      if (!y.includes(needle)) throw new Error(`缺隔离 probe lane ${lane}: ${needle}`);
    }
  }
  const probeGroups = y.match(/name: freebuff-account-probe-\d+/g) || [];
  const probeListeners = y.match(/name: freebuff-account-probe-in-\d+/g) || [];
  if (probeGroups.length !== 64 || probeListeners.length !== 64) {
    throw new Error(`probe lane 数量错误: groups=${probeGroups.length}, listeners=${probeListeners.length}`);
  }
  const localListeners = y.match(/listen: 127\.0\.0\.1/g) || [];
  if (localListeners.length !== 128) {
    throw new Error(`账号与 probe listener 必须全部仅监听本机: ${localListeners.length}/128`);
  }
});
t('空订阅抛错', () => {
  let threw = false;
  try { buildMihomoYaml(''); } catch { threw = true; }
  if (!threw) throw new Error('空订阅应该抛错');
});

// ── 调用日志（call-log 环形缓冲 + 用量归一 + 调度账号名） ─────────────
console.log('--- 调用日志（call-log） ---');
t('readCallUsage 吃 chat 与 Responses 两套字段', () => {
  const a = readCallUsage({ prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } });
  if (a.in !== 100 || a.out !== 40 || a.reasoning !== 12) throw new Error('chat 形状: ' + JSON.stringify(a));
  const b = readCallUsage({ input_tokens: 7, output_tokens: 3, output_tokens_details: { reasoning_tokens: 2 } });
  if (b.in !== 7 || b.out !== 3 || b.reasoning !== 2) throw new Error('responses 形状: ' + JSON.stringify(b));
});
t('readCallUsage 非对象 → null；缺字段 → 0', () => {
  if (readCallUsage(null) !== null || readCallUsage('x') !== null) throw new Error('非对象应返回 null');
  const c = readCallUsage({});
  if (c.in !== 0 || c.out !== 0 || c.reasoning !== 0) throw new Error('缺字段应归零');
});
t('accountLabel：命中映射→展示名，未命中不泄露 token，空 token→空串', () => {
  const env = { FREEBUFF_ACCOUNT_LABELS: { 'tok-abcdef123': '小明' } };
  if (accountLabel(env, 'tok-abcdef123') !== '小明') throw new Error('命中应返回展示名');
  if (accountLabel(env, 'zzzzzzzz9999') !== '未命名账号') throw new Error('未命中不得回落 token 前缀');
  if (accountLabel({}, 'abcdefgh') !== '未命名账号') throw new Error('无映射不得回落 token 前缀');
  if (accountLabel(env, '') !== '') throw new Error('空 token 应返回空串');
});
t('健康快照明细只返回 alive/state，不泄露 token 或 uid 前缀', () => {
  const summary = summarizeAccountHealth(
    [{ token: 'health-secret-token-123456' }],
    new Map([['health-secret-token-123456', { alive: true, state: 'ok', uid: 'private-user-id' }]]),
  );
  const detail = summary.account_details[0];
  if (detail.alive !== true || detail.state !== 'ok') throw new Error('健康状态字段不正确');
  for (const forbidden of ['token', 'uid']) {
    if (Object.hasOwn(detail, forbidden)) throw new Error(`健康快照泄露 ${forbidden}`);
  }
});
t('logCall：ttfb≤0 记 null，ms 取整，字段落库正确', () => {
  logCall({ account: 'A', model: 'm', effort: 'max', ttfb: 0, ms: 12.7, in: 1, out: 2, reasoning: 0 });
  const calls = callLogSnapshot().calls;
  const last = calls[calls.length - 1];
  if (last.ttfb !== null) throw new Error('ttfb=0 应记 null');
  if (last.ms !== 13) throw new Error('ms 应四舍五入: ' + last.ms);
  if (last.account !== 'A' || last.model !== 'm' || last.effort !== 'max') throw new Error('字段落库不对');
});
t('环形缓冲上限 200，超出丢最旧', () => {
  for (let i = 0; i < 250; i++) logCall({ account: 'x', model: 'ring-' + i, effort: '', ttfb: 5, ms: 5, in: 0, out: 0, reasoning: 0 });
  const calls = callLogSnapshot().calls;
  if (calls.length !== 200) throw new Error('应裁到 200，实际 ' + calls.length);
  if (calls[199].model !== 'ring-249') throw new Error('最新记录应在末尾');
  if (calls[0].model !== 'ring-50') throw new Error('最旧应被丢弃，首项应为 ring-50，实际 ' + calls[0].model);
});
t('callLogSnapshot 返回副本，外部改动不污染内部', () => {
  const snap = callLogSnapshot();
  const before = snap.calls.length;
  snap.calls.push({ model: 'injected' });
  snap.totals.rateLimited = 99999;
  if (callLogSnapshot().calls.length !== before) throw new Error('calls 应是副本');
  if (callLogSnapshot().totals.rateLimited === 99999) throw new Error('totals 应是副本');
});

// ── 概况累计（客户端请求口径：requests/success/fail + 各类 token） ───────
console.log('--- 概况累计（overview） ---');
t('readUsageFull：chat/responses 命名 + 缓存读写 + total 兜底', () => {
  const a = readUsageFull({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
    completion_tokens_details: { reasoning_tokens: 12 },
    prompt_tokens_details: { cached_tokens: 30, cache_creation_tokens: 5 } });
  if (a.promptTokens !== 100 || a.completionTokens !== 40 || a.reasoningTokens !== 12) throw new Error('chat 形状: ' + JSON.stringify(a));
  if (a.totalTokens !== 140 || a.cacheReadTokens !== 30 || a.cacheWriteTokens !== 5) throw new Error('缓存/总量: ' + JSON.stringify(a));
  const b = readUsageFull({ input_tokens: 7, output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 2 },
    input_tokens_details: { cached_tokens: 4 }, cache_creation_input_tokens: 9 });
  if (b.promptTokens !== 7 || b.completionTokens !== 3 || b.reasoningTokens !== 2) throw new Error('responses 形状: ' + JSON.stringify(b));
  if (b.totalTokens !== 10 || b.cacheReadTokens !== 4 || b.cacheWriteTokens !== 9) throw new Error('total 应回落 prompt+completion，缓存两套命名都吃: ' + JSON.stringify(b));
});
t('readUsageFull：空/非对象 → 全零', () => {
  for (const v of [null, undefined, 'x', 0]) {
    const u = readUsageFull(v);
    if (u.promptTokens || u.completionTokens || u.totalTokens || u.cacheReadTokens || u.cacheWriteTokens || u.reasoningTokens)
      throw new Error('空值应全零: ' + JSON.stringify(u));
  }
});
t('recordRequest：成功累加 token 与 success，byModel 分模型', () => {
  const b0 = callLogSnapshot();
  const req0 = b0.total.requests, ok0 = b0.total.success, tok0 = b0.total.totalTokens;
  recordRequest('m-ov-A', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, true);
  const s = callLogSnapshot();
  if (s.total.requests !== req0 + 1 || s.total.success !== ok0 + 1) throw new Error('总量 requests/success 应各 +1');
  if (s.total.totalTokens !== tok0 + 15) throw new Error('总量 token 应累加 15，实际 Δ=' + (s.total.totalTokens - tok0));
  if (!s.byModel['m-ov-A'] || s.byModel['m-ov-A'].success !== 1 || s.byModel['m-ov-A'].totalTokens !== 15)
    throw new Error('byModel 应按模型累计: ' + JSON.stringify(s.byModel['m-ov-A']));
  if (typeof s.startTime !== 'number' || s.lastRequest == null) throw new Error('startTime/lastRequest 应存在');
});
t('recordRequest：失败只 +fail，不动 token', () => {
  const b0 = callLogSnapshot();
  const req0 = b0.total.requests, bad0 = b0.total.fail, tok0 = b0.total.totalTokens;
  recordRequest('m-ov-B', null, false);
  const s = callLogSnapshot();
  if (s.total.requests !== req0 + 1 || s.total.fail !== bad0 + 1) throw new Error('失败应 requests/fail 各 +1');
  if (s.total.totalTokens !== tok0) throw new Error('失败不应改动 token 总量');
  if (!s.byModel['m-ov-B'] || s.byModel['m-ov-B'].fail !== 1 || s.byModel['m-ov-B'].success !== 0)
    throw new Error('byModel 失败计数不对: ' + JSON.stringify(s.byModel['m-ov-B']));
});
t('recordRequest：空模型名归到 unknown', () => {
  recordRequest('', { prompt_tokens: 1, completion_tokens: 1 }, true);
  const s = callLogSnapshot();
  if (!s.byModel['unknown']) throw new Error('空模型名应归到 unknown 键');
});
t('callLogSnapshot：total/byModel 是副本，外部改动不污染内部', () => {
  const snap = callLogSnapshot();
  const before = snap.total.requests;
  snap.total.requests = 88888;
  Object.values(snap.byModel)[0] && (Object.values(snap.byModel)[0].success = 77777);
  if (callLogSnapshot().total.requests !== before) throw new Error('total 应是副本');
  if (Object.values(callLogSnapshot().byModel).some((v) => v.success === 77777)) throw new Error('byModel 各项应是副本');
});

console.log('\n--- 出站 IP 被拒的归因回调（面板显示「节点被 freebuff 拒绝」）---');
// 判据：账号级失败（封号/token 失效/额度）换账号就能绕过，不该记到节点头上；
// 出站 IP 级失败（地区封禁 / IP 触顶 / 裸 403）换账号没用，必须回调给出口代理。
const rejects = [];
setTestEgressReject((info) => rejects.push(info));
for (const [name, status, body, expect] of [
  ['country_blocked → 回调', 403, '{"status":"country_blocked"}', 'country_blocked'],
  ['ip_capped → 回调', 200, '{"status":"ip_capped"}', 'ip_capped'],
  ['裸 403（无 status 体）→ 回调 blocked', 403, 'Forbidden', 'blocked'],
  ['403 free_mode_cli_required → 不回调（模式问题，不许冤枉节点）', 403, '{"status":"free_mode_cli_required"}', null],
  ['403 free_mode_invalid_agent_model → 不回调', 403, '{"status":"free_mode_invalid_agent_model"}', null],
  ['banned → 不回调（账号问题，换节点没用）', 403, '{"status":"banned"}', null],
  ['401 token 失效 → 不回调', 401, '{}', null],
  ['429 额度 → 不回调', 429, '{}', null],
  ['200 正常 → 不回调', 200, '{}', null],
]) {
  t(name, () => {
    rejects.length = 0;
    recordAccountObservation(`tok-${status}-${expect}`, status, body);
    const got = rejects[0]?.state ?? null;
    if (got !== expect) throw new Error(`expect ${expect}, got ${got}`);
  });
}
setTestEgressReject(null);

console.log('\n--- 账号隔离与严格选号（新契约）---');
t('banned resumes_at 仍按终态处理', () => {
  if (typeof parseCooldown !== 'function') throw new Error('parseCooldown 未导出');
  const now = Date.UTC(2030, 0, 1);
  const target = now + 2 * 3600 * 1000;
  for (const value of [
    new Date(target).toISOString(),
    String(Math.floor(target / 1000)),
    String(target),
  ]) {
    const got = parseCooldown(JSON.stringify({ status: 'banned', resumes_at: value }), 403, {}, now);
    if (got !== 0) throw new Error(`${value} -> ${got}`);
  }
});
t('banned 缺少 resumes_at 仍按终态处理', () => {
  const got = parseCooldown('{"status":"banned"}', 403, {}, Date.UTC(2030, 0, 1));
  if (got !== 0) throw new Error('got ' + got);
});
t('429 按 retryAfterMs、resetAt、Retry-After、短退避排序', () => {
  const now = Date.UTC(2030, 0, 1, 16, 0, 0);
  const direct = parseCooldown('{"retryAfterMs":123456}', 429, {}, now);
  if (direct !== 123456) throw new Error('retryAfterMs 未优先: ' + direct);
  const reset = parseCooldown(JSON.stringify({ resetAt: new Date(now + 234567).toISOString() }), 429, {}, now);
  if (Math.abs(reset - 234567) > 1000) throw new Error('resetAt 未生效: ' + reset);
  const header = parseCooldown('{}', 429, { 'Retry-After': '17' }, now);
  if (header !== 17000) throw new Error('Retry-After 未生效: ' + header);
  const human = parseCooldown('rate limited; try again in 5m', 429, {}, now);
  if (human !== 300000) throw new Error('文本冷却未保留兼容: ' + human);
  const generic = parseCooldown('{}', 429, {}, now);
  if (generic !== 60 * 1000) throw new Error('generic 429 短退避异常: ' + generic);
});
await tAsync('waiting-room 返回结构化 503 和 Retry-After', async () => {
  if (typeof waitingRoomResponse !== 'function') throw new Error('waitingRoomResponse 未导出');
  const response = waitingRoomResponse(45000);
  if (response.status !== 503) throw new Error('waiting-room 应返回 503');
  if (response.headers.get('Retry-After') !== '45') throw new Error('Retry-After 不正确');
  const body = await response.json();
  if (body.error?.type !== 'waiting_room') throw new Error('错误类型不正确: ' + JSON.stringify(body));
  if (!/Freebuff/.test(body.error.message)) throw new Error('文案必须点名上游 Freebuff（用户反馈会被误读成网关排队）');
  const hinted = waitingRoomResponse(45000, 'stealth/ox-alpha');
  if (!/模型 stealth\/ox-alpha /.test((await hinted.json()).error.message)) throw new Error('带 modelHint 的文案应包含模型名');
});
await tAsync('egress_unavailable 与 egress_rejected 文案必须分开归因', async () => {
  if (typeof egressRejectedResponse !== 'function') throw new Error('egressRejectedResponse 未导出');
  // egress_unavailable 是本地判定（lane 未就绪），不能说「被上游拒绝」甩锅上游。
  const local = await egressRejectedResponse('egress_unavailable').json();
  if (/被上游拒绝/.test(local.error.message)) throw new Error('本地未就绪不得说成被上游拒绝: ' + local.error.message);
  if (local.error.type !== 'egress_unavailable' || local.error.state !== 'egress_unavailable') throw new Error(JSON.stringify(local));
  // 真被上游拒出口时，文案要点名上游。
  const rejected = await egressRejectedResponse('egress_rejected').json();
  if (!/Freebuff/.test(rejected.error.message)) throw new Error('真拒绝文案必须点名 Freebuff: ' + rejected.error.message);
  if (rejected.error.state !== 'egress_rejected') throw new Error(JSON.stringify(rejected));
});
async function assertCanceledPipeCancelsUpstream(startPipe) {
  let cancelCalls = 0;
  let completeCalls = 0;
  const upstreamBody = {
    getReader: () => ({
      read: async () => ({ done: false, value: new TextEncoder().encode('data: {}\n\n') }),
      cancel: async () => { cancelCalls++; },
    }),
  };
  const writable = {
    getWriter: () => ({
      closed: new Promise(() => {}),
      write: async () => { throw new Error('client canceled'); },
      close: async () => {},
    }),
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('管道未完成收尾')), 1000);
    startPipe(upstreamBody, writable, () => {
      completeCalls++;
      clearTimeout(timer);
      resolve();
    });
  });
  if (cancelCalls !== 1) throw new Error(`上游 reader.cancel 调用 ${cancelCalls} 次`);
  if (completeCalls !== 1) throw new Error(`完成回调调用 ${completeCalls} 次`);
}
await tAsync('Chat SSE 客户端取消会取消上游 reader', async () => {
  await assertCanceledPipeCancelsUpstream((body, writable, onComplete) =>
    pipeUpstreamToClient(body, writable, onComplete));
});
await tAsync('Responses SSE 客户端取消会取消上游 reader', async () => {
  await assertCanceledPipeCancelsUpstream((body, writable, onComplete) =>
    pipeUpstreamToResponsesStream(body, writable, { id: 'test-model' }, onComplete));
});
async function assertPendingReadCancelsUpstream(startPipe) {
  let cancelCalls = 0;
  let completeCalls = 0;
  let rejectClosed;
  const upstreamBody = {
    getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: async () => { cancelCalls++; },
    }),
  };
  const writable = {
    getWriter: () => ({
      closed: new Promise((resolve, reject) => { rejectClosed = reject; }),
      write: async () => {},
      close: async () => {},
    }),
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pending read 未完成收尾')), 1000);
    startPipe(upstreamBody, writable, () => {
      completeCalls++;
      clearTimeout(timer);
      resolve();
    });
    setTimeout(() => rejectClosed(new Error('client disconnected')), 10);
  });
  if (cancelCalls !== 1) throw new Error(`pending read 时 reader.cancel 调用 ${cancelCalls} 次`);
  if (completeCalls !== 1) throw new Error(`pending read 时完成回调调用 ${completeCalls} 次`);
}
await tAsync('Chat SSE 下游断开会取消 pending upstream read', async () => {
  await assertPendingReadCancelsUpstream((body, writable, onComplete) =>
    pipeUpstreamToClient(body, writable, onComplete));
});
await tAsync('Responses SSE 下游断开会取消 pending upstream read', async () => {
  await assertPendingReadCancelsUpstream((body, writable, onComplete) =>
    pipeUpstreamToResponsesStream(body, writable, { id: 'test-model' }, onComplete));
});
t('Responses SSE 初始化失败会同步抛出供调用方释放租约', () => {
  let threw = false;
  let pending = null;
  try {
    pending = pipeUpstreamToResponsesStream(null, { getWriter: () => ({}) }, { id: 'test-model' }, () => {});
  } catch {
    threw = true;
  }
  if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  if (!threw) throw new Error('初始化异常被包装成未处理的 rejected Promise');
});
t('全池冷却时不删除记录、不强行放行账号', () => {
  const env = { FREEBUFF_TOKEN: 'strict-pool-a-123456,strict-pool-b-123456' };
  cooldown('strict-pool-a-123456', 60 * 60 * 1000, { reason: 'quota', retryAfterMs: 60000 });
  cooldown('strict-pool-b-123456', 2 * 60 * 60 * 1000, { reason: 'quota', retryAfterMs: 120000 });
  if (pickToken(env, null, new Set())) throw new Error('全池冷却时不应返回账号');
  if (!cooldownInfo('strict-pool-a-123456') || !cooldownInfo('strict-pool-b-123456')) throw new Error('冷却记录被删除');
});
t('持久封禁/凭据失效账号跳过，忙账号释放后可选', () => {
  const env = {
    FREEBUFF_TOKEN: 'strict-banned-123456,strict-invalid-123456,strict-live-123456',
    FREEBUFF_ACCOUNT_STATE: {
      'strict-banned-123456': { state: 'banned', until: Date.now() + 3600000 },
      'strict-invalid-123456': { state: 'token_invalid', until: null },
    },
  };
  const first = pickToken(env, null, new Set());
  if (!first || first.token !== 'strict-live-123456') throw new Error('未跳过持久隔离账号');
  if (pickToken(env, null, new Set())) throw new Error('忙账号不应再次被选');
  releaseToken(first.token);
  const again = pickToken(env, null, new Set());
  if (!again || again.token !== 'strict-live-123456') throw new Error('释放后账号不可选');
  releaseToken(again.token);
});
t('池耗尽分类为 403/429/503', () => {
  if (typeof accountPoolExhaustion !== 'function') throw new Error('accountPoolExhaustion 未导出');
  const banned = accountPoolExhaustion({ FREEBUFF_TOKEN: 'only-banned-123456', FREEBUFF_ACCOUNT_STATE: { 'only-banned-123456': { state: 'banned', until: Date.now() + 3600000 } } });
  if (banned.status !== 403) throw new Error('全封禁应 403: ' + JSON.stringify(banned));
  const quotaEnv = { FREEBUFF_TOKEN: 'only-quota-123456' };
  cooldown('only-quota-123456', 222000, { reason: 'quota', retryAfterMs: 222000 });
  const quota = accountPoolExhaustion(quotaEnv);
  if (quota.status !== 429 || quota.retryAfterMs < 221000 || quota.retryAfterMs > 222000) throw new Error('全限流应 429: ' + JSON.stringify(quota));
  const mixed = accountPoolExhaustion({ FREEBUFF_TOKEN: 'busy-mixed-123456' });
  if (mixed.status !== 503) throw new Error('混合/忙应 503: ' + JSON.stringify(mixed));
});
t('全凭据终态池耗尽应返回 403 而不是 account_pool_unavailable', () => {
  const env = {
    FREEBUFF_TOKEN: 'terminal-invalid-123456,terminal-manual-123456',
    FREEBUFF_ACCOUNT_STATE: {
      'terminal-invalid-123456': { state: 'token_invalid', until: null },
      'terminal-manual-123456': { state: 'manual_disabled', until: null },
    },
  };
  const result = accountPoolExhaustion(env);
  if (result.status !== 403 || result.type !== 'account_terminal') {
    throw new Error('全终态池应 403/account_terminal: ' + JSON.stringify(result));
  }
});
t('429 观测与额度冷却组合仍返回 429', () => {
  const token = 'observed-quota-123456';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {} };
  recordAccountObservation(token, 429, { status: 'rate_limited' });
  cooldown(token, 222000, { reason: 'quota', retryAfterMs: 222000 });
  const result = accountPoolExhaustion(env);
  if (result.status !== 429 || result.retryAfterMs < 221000 || result.retryAfterMs > 222000) {
    throw new Error('429 观测不应被健康状态改成 503: ' + JSON.stringify(result));
  }
});
await tAsync('429 冷却到期后账号重新进入可选池', async () => {
  const token = 'observed-quota-recovery-123456';
  const env = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {} };
  recordAccountObservation(token, 429, { status: 'rate_limited' });
  cooldown(token, 5, { reason: 'quota', retryAfterMs: 5 });
  if (pickToken(env, null, new Set())) throw new Error('冷却期间不应选中账号');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const recovered = pickToken(env, null, new Set());
  if (!recovered || recovered.token !== token) throw new Error('冷却到期后账号仍被永久摘除');
  releaseToken(recovered.token);
});
t('池耗尽 Retry-After 使用最早冷却的真实剩余时间', () => {
  const env = { FREEBUFF_TOKEN: 'remaining-a-123456,remaining-b-123456' };
  cooldown('remaining-a-123456', 2000, { reason: 'quota', retryAfterMs: 60000 });
  cooldown('remaining-b-123456', 5000, { reason: 'quota', retryAfterMs: 1000 });
  const result = accountPoolExhaustion(env);
  if (result.status !== 429 || result.retryAfterMs < 1700 || result.retryAfterMs > 2000) {
    throw new Error('未按真实截止时间选择最早恢复账号: ' + JSON.stringify(result));
  }
});
t('业务请求写入的封禁状态不会被同一请求的旧快照覆盖', () => {
  const writes = [];
  const token = 'stale-snapshot-banned-123456';
  const env = {
    FREEBUFF_TOKEN: token,
    FREEBUFF_ACCOUNT_STATE: {},
    FREEBUFF_ACCOUNT_STATE_SET: (t, state) => writes.push({ t, state }),
    FREEBUFF_ACCOUNT_STATE_CLEAR: () => {},
  };
  const lease = pickToken(env, null, new Set());
  if (!lease) throw new Error('测试账号应先可选');
  releaseToken(lease.token);
  recordAccountObservation(token, 403, '{"status":"banned"}');
  const exhausted = accountPoolExhaustion(env);
  if (exhausted.status !== 403) throw new Error('旧快照覆盖了刚写入的封禁: ' + JSON.stringify(exhausted));
  if (!writes.length || writes[0].t !== token) throw new Error('未调用持久化回调');
});
t('账号状态持久化失败会记录错误并保留内存隔离', () => {
  const token = 'persist-failure-banned-123456';
  const env = {
    FREEBUFF_TOKEN: token,
    FREEBUFF_ACCOUNT_STATE: {},
    FREEBUFF_ACCOUNT_STATE_SET: () => { throw new Error(`write failed for ${token}`); },
    FREEBUFF_ACCOUNT_STATE_CLEAR: () => {},
  };
  const originalError = sandbox.console.error;
  const errors = [];
  sandbox.console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const lease = pickToken(env, null, new Set());
    if (!lease) throw new Error('测试账号应先可选');
    releaseToken(lease.token);
    recordAccountObservation(token, 403, { status: 'banned' });
    if (pickToken(env, null, new Set())) throw new Error('写盘失败后内存隔离不应丢失');
    if (!errors.some((line) => line.includes('[account-state] persist set failed'))) {
      throw new Error('持久化失败被静默吞掉');
    }
    if (errors.some((line) => line.includes(token))) throw new Error('持久化错误日志泄露 token');
  } finally {
    sandbox.console.error = originalError;
  }
});
t('不同请求的旧账号状态快照不会覆盖新写入的封禁', () => {
  const token = 'stale-env-race-banned-123456';
  let revision = 0;
  const persisted = {};
  const makeEnv = (snapshot, snapshotRevision) => ({
    FREEBUFF_TOKEN: token,
    FREEBUFF_ACCOUNT_STATE: snapshot,
    FREEBUFF_ACCOUNT_STATE_REVISION: snapshotRevision,
    FREEBUFF_ACCOUNT_STATE_SET: (t, state) => {
      revision += 1;
      persisted[t] = { ...state };
      return { ...state, revision };
    },
    FREEBUFF_ACCOUNT_STATE_CLEAR: () => {},
  });
  const envA = makeEnv({}, 0);
  const lease = pickToken(envA, null, new Set());
  if (!lease) throw new Error('竞态测试账号应先可选');
  releaseToken(lease.token);
  recordAccountObservation(token, 403, { status: 'banned' });
  if (pickToken(envA, null, new Set())) throw new Error('封禁状态未在原请求隔离');
  const staleEnv = makeEnv({}, 0);
  if (pickToken(staleEnv, null, new Set())) throw new Error('旧快照覆盖了刚写入的封禁');
  const freshEnv = makeEnv({ [token]: persisted[token] }, revision);
  if (pickToken(freshEnv, null, new Set())) throw new Error('新快照不应解除封禁');
});
t('管理员成功探测清除持久隔离后，账号和健康状态都可恢复', () => {
  const token = 'manual-clear-recovery-123456';
  const envBefore = {
    FREEBUFF_TOKEN: token,
    FREEBUFF_ACCOUNT_STATE: {},
    FREEBUFF_ACCOUNT_STATE_REVISION: 0,
    FREEBUFF_ACCOUNT_STATE_SET: () => {},
    FREEBUFF_ACCOUNT_STATE_CLEAR: () => {},
  };
  const lease = pickToken(envBefore, null, new Set());
  if (!lease) throw new Error('恢复测试账号应先可选');
  releaseToken(lease.token);
  recordAccountObservation(token, 403, '{"status":"banned"}');
  if (pickToken(envBefore, null, new Set())) throw new Error('封禁状态未生效');
  const envAfterProbe = { FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_STATE: {}, FREEBUFF_ACCOUNT_STATE_REVISION: 1 };
  const recovered = pickToken(envAfterProbe, null, new Set());
  if (!recovered || recovered.token !== token) throw new Error('成功探测清除后仍不可选');
  releaseToken(recovered.token);
});

console.log('\n--- 概况统计持久化注入（worker 侧）---');
async function at(name, fn) {
  try { await fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '-', e.message); }
}

await at('注入适配器且开启时 recordRequest 触发 save（带最新快照）', async () => {
  const saves = [];
  configureUsagePersistence({ load: null, save: (s) => { saves.push(s); }, enabled: () => true });
  const before = callLogSnapshot().total.requests;
  recordRequest('m-persist-A', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, true);
  await new Promise((r) => setTimeout(r, 0)); // 让 save 钩子的微任务落地
  if (saves.length !== 1) throw new Error('save 应恰好被调一次，实际 ' + saves.length);
  const snap = saves[0];
  if (snap.total.requests !== before + 1) throw new Error('save 快照应含最新 requests');
  if (snap.byModel['m-persist-A'].success !== 1) throw new Error('save 快照应含 byModel 累计');
  if (snap.lastRequest == null) throw new Error('save 快照应含 lastRequest');
});

await at('save 钩子在返回前注册写队列，关停 flush 不会漏掉同一 tick 的统计', async () => {
  let started = false;
  configureUsagePersistence({
    load: null,
    save: () => { started = true; },
    enabled: () => true,
  });
  recordRequest('m-persist-sync', null, false);
  if (!started) throw new Error('save 不应等到下一个微任务才开始，否则关停时 flush 可能提前返回');
});

await at('注入适配器但关闭时 recordRequest 不触发 save', async () => {
  const saves = [];
  configureUsagePersistence({ load: null, save: (s) => { saves.push(s); }, enabled: () => false });
  recordRequest('m-persist-B', null, false);
  await new Promise((r) => setTimeout(r, 0));
  if (saves.length !== 0) throw new Error('关闭时不应调用 save，实际 ' + saves.length);
});

await at('概况关闭时仍触发独立的 Key 统计保存', async () => {
  const keySaves = [];
  configureUsagePersistence({
    load: null,
    save: null,
    saveKey: (byKey) => { keySaves.push(byKey); },
    enabled: () => false,
  });
  recordRequest('m-persist-key', { total_tokens: 4 }, true, {
    key: 'fbk-key-persist-test', name: 'Key 持久化', owner: false,
  });
  await new Promise((r) => setTimeout(r, 0));
  if (keySaves.length !== 1) throw new Error('Key 统计应独立保存，实际 ' + keySaves.length);
  const row = Object.values(keySaves[0]).find((v) => v.name === 'Key 持久化');
  if (!row || row.totalTokens !== 4) throw new Error('Key 保存快照缺少最新 token 统计');
});

await at('save 抛异常不阻断 recordRequest', async () => {
  configureUsagePersistence({ load: null, save: () => { throw new Error('disk full'); }, enabled: () => true });
  recordRequest('m-persist-C', null, false); // 不应抛
  await new Promise((r) => setTimeout(r, 0));
});

await at('restoreUsageSnapshot 覆盖初始累计（startTime/byModel/total）', async () => {
  configureUsagePersistence({ load: null, save: null, enabled: () => false });
  restoreUsageSnapshot({
    total: { requests: 11, success: 9, fail: 2, promptTokens: 100, completionTokens: 50, reasoningTokens: 0, totalTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 },
    byModel: { 'm-restore': { requests: 4, success: 4, fail: 0, promptTokens: 40, completionTokens: 20, reasoningTokens: 0, totalTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    startTime: 12345, lastRequest: 67890,
  });
  const s = callLogSnapshot();
  if (s.total.requests !== 11) throw new Error('total 未覆盖：' + s.total.requests);
  if (s.byModel['m-restore']?.requests !== 4) throw new Error('byModel 未覆盖');
  if (s.startTime !== 12345) throw new Error('startTime 未覆盖：' + s.startTime);
  if (s.lastRequest !== 67890) throw new Error('lastRequest 未覆盖');
});

await at('restoreUsageSnapshot 对畸形对象不破坏内部状态', async () => {
  restoreUsageSnapshot(null);
  restoreUsageSnapshot('garbage');
  restoreUsageSnapshot({ total: { requests: 'NaN' }, byModel: { x: 42 } });
  // 走到这里不抛即可；fields 用 num() 归一化，字符串 NaN → 0
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
