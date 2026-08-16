import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf-8');

// worker.js 使用 ESM `export default {...}`，vm 沙箱不支持 ESM 语法。
// 把首处 `export default {` 替换为普通 const 声明，并在文件末尾附加导出赋值，
// 使内部函数在沙箱全局可见，供单测直接调用。
const wrapper = src.replace('export default {', 'const __workerDefault__ = {') +
  '\n\nglobalThis.__workerDefault__ = __workerDefault__;\n' +
  'globalThis.__unitTestApi__ = { normalizeChatThinking, anthropicThinkingToEffort, namedEffort, normalizeReasoningEffort, collectReasoningTexts, anthropicStopReason, anthropicModelToOpenAI, parseModelAliases, resolveModelAlias, resolveModelConfig, findModelConfig, setTestAliases: (raw) => { currentAliases = parseModelAliases(raw); }, cooldown, cooldownInfo, inCooldown, parseCooldown, nextPacificMidnight: typeof nextPacificMidnight === "function" ? nextPacificMidnight : null, pickToken, releaseToken: typeof releaseToken === "function" ? releaseToken : null, accountPoolExhaustion: typeof accountPoolExhaustion === "function" ? accountPoolExhaustion : null, waitingRoomResponse: typeof waitingRoomResponse === "function" ? waitingRoomResponse : null, pipeUpstreamToClient, pipeUpstreamToResponsesStream, markSessionInvalidated, wasRecentlyInvalidated, singleFlight, sessionRemainingMs, INVALIDATION_WINDOW_MS, SESSION_REUSE_SAFE_MS, SESSION_VERIFY_WINDOW_MS, executeChat, readCallUsage, accountLabel, logCall, callLogSnapshot, readUsageFull, recordRequest, blankUsageTotals, recordAccountObservation, setTestEgressReject: (fn) => { onEgressReject = fn; } };\n';

// 可编程 fetch mock：测试里可替换 sandbox.fetch，返回可定制的 Response 形状
// （worker 里用的是 { status, ok, headers, text() } 简化形状）。
const fetchState = { calls: [], impl: null };
const sandbox = {
  console, TextEncoder, TextDecoder, Set, Map, Date, Math, Number, String, JSON, Uint8Array, Object,
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

const { normalizeChatThinking, anthropicThinkingToEffort, namedEffort, normalizeReasoningEffort, collectReasoningTexts, anthropicStopReason, anthropicModelToOpenAI, parseModelAliases, resolveModelAlias, resolveModelConfig, findModelConfig, setTestAliases, cooldown, cooldownInfo, inCooldown, parseCooldown, nextPacificMidnight, pickToken, releaseToken, accountPoolExhaustion, waitingRoomResponse, pipeUpstreamToClient, pipeUpstreamToResponsesStream, markSessionInvalidated, wasRecentlyInvalidated, singleFlight, sessionRemainingMs, INVALIDATION_WINDOW_MS, SESSION_REUSE_SAFE_MS, SESSION_VERIFY_WINDOW_MS, executeChat, readCallUsage, accountLabel, logCall, callLogSnapshot, readUsageFull, recordRequest, blankUsageTotals, recordAccountObservation, setTestEgressReject } = sandbox.__unitTestApi__;

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
// 官方 efforts 表：deepseek-v4-* = [low, high, max]，gpt-5.6-luna = [low..max 含 xhigh]
t('max 在 deepseek-v4-pro 上原样保留', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-pro', 'max') !== 'max') throw new Error('nope');
});
t('xhigh 在 deepseek-v4-pro 上被下取成 high（所以 max 绝不能先折成 xhigh）', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-pro', 'xhigh') !== 'high') throw new Error('nope');
});
t('medium 在 deepseek-v4-flash 上被下取成 low（该模型无 medium 档）', () => {
  if (normalizeReasoningEffort('deepseek/deepseek-v4-flash', 'medium') !== 'low') throw new Error('nope');
});
t('max 在 gpt-5.6-luna 上原样保留', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'max') !== 'max') throw new Error('nope');
});
t('ultra 在 gpt-5.6-luna 上被下取成 max', () => {
  if (normalizeReasoningEffort('openai/gpt-5.6-luna', 'ultra') !== 'max') throw new Error('nope');
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

await tAsync('首次 401 凭据失效当次返回 503', async () => {
  const chatCalls = installSingleChatFailure(401, { status: 'unauthorized' });
  const env = { FREEBUFF_TOKEN: 'first-upstream-invalid-123456', FREEBUFF_DEBUG: 'false', FREEBUFF_ACCOUNT_STATE: {} };
  const response = await executeChat(env, integrationChat, integrationModel, false, 'chat');
  const body = await response.json();
  if (chatCalls() !== 1) throw new Error(`上游 chat 调用 ${chatCalls()} 次`);
  if (response.status !== 503 || body.error?.type !== 'account_pool_unavailable') {
    throw new Error(`首次 401 被误分类: ${response.status} ${JSON.stringify(body)}`);
  }
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
t('accountLabel：命中映射→展示名，未命中→token 前 6 位，空 token→空串', () => {
  const env = { FREEBUFF_ACCOUNT_LABELS: { 'tok-abcdef123': '小明' } };
  if (accountLabel(env, 'tok-abcdef123') !== '小明') throw new Error('命中应返回展示名');
  if (accountLabel(env, 'zzzzzzzz9999') !== 'zzzzzz…') throw new Error('未命中应回落短哈希: ' + accountLabel(env, 'zzzzzzzz9999'));
  if (accountLabel({}, 'abcdefgh') !== 'abcdef…') throw new Error('无映射也应回落短哈希');
  if (accountLabel(env, '') !== '') throw new Error('空 token 应返回空串');
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
t('banned resumes_at 支持 RFC3339、Unix 秒、Unix 毫秒', () => {
  if (typeof parseCooldown !== 'function') throw new Error('parseCooldown 未导出');
  const now = Date.UTC(2030, 0, 1);
  const target = now + 2 * 3600 * 1000;
  for (const value of [
    new Date(target).toISOString(),
    String(Math.floor(target / 1000)),
    String(target),
  ]) {
    const got = parseCooldown(JSON.stringify({ status: 'banned', resumes_at: value }), 403, {}, now);
    if (Math.abs(got - 2 * 3600 * 1000) > 1000) throw new Error(`${value} -> ${got}`);
  }
});
t('banned 缺少 resumes_at 时至少隔离 24 小时', () => {
  const got = parseCooldown('{"status":"banned"}', 403, {}, Date.UTC(2030, 0, 1));
  if (got < 24 * 3600 * 1000) throw new Error('got ' + got);
});
t('429 按 retryAfterMs、resetAt、Retry-After、太平洋午夜排序', () => {
  const now = Date.UTC(2030, 0, 1, 16, 0, 0);
  const direct = parseCooldown('{"retryAfterMs":123456}', 429, {}, now);
  if (direct !== 123456) throw new Error('retryAfterMs 未优先: ' + direct);
  const reset = parseCooldown(JSON.stringify({ resetAt: new Date(now + 234567).toISOString() }), 429, {}, now);
  if (Math.abs(reset - 234567) > 1000) throw new Error('resetAt 未生效: ' + reset);
  const header = parseCooldown('{}', 429, { 'Retry-After': '17' }, now);
  if (header !== 17000) throw new Error('Retry-After 未生效: ' + header);
  const human = parseCooldown('rate limited; try again in 5m', 429, {}, now);
  if (human !== 300000) throw new Error('文本冷却未保留兼容: ' + human);
  const midnight = parseCooldown('{}', 429, {}, now);
  if (!(midnight > 0 && midnight < 24 * 3600 * 1000)) throw new Error('太平洋午夜兜底异常: ' + midnight);
});
await tAsync('waiting-room 返回结构化 503 和 Retry-After', async () => {
  if (typeof waitingRoomResponse !== 'function') throw new Error('waitingRoomResponse 未导出');
  const response = waitingRoomResponse(45000);
  if (response.status !== 503) throw new Error('waiting-room 应返回 503');
  if (response.headers.get('Retry-After') !== '45') throw new Error('Retry-After 不正确');
  const body = await response.json();
  if (body.error?.type !== 'waiting_room') throw new Error('错误类型不正确: ' + JSON.stringify(body));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
