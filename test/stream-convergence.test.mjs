// 思考循环收敛护栏（锚点 commit 268b2b2）。
//
// 背景：ds4p/ds4f 偶发推理自环。循环本身是上游模型行为，不是网关造成的，但我们原先
// 有两处让它没法收场：
//   1. 流式主路径只跟客户端 signal，服务端没有任何时间上限 —— 上游一直吐
//      reasoning_content 时连接永久活着，账号租约被无限占用。
//   2. normalizeMessages 原样透传历史消息里的 reasoning_content，把上一轮未收束的
//      思考回灌给模型（DeepSeek 官方要求多轮不要带回），第二轮更易复现。
//
// 这组测试锁住两条收敛判据的行为，并确认它们不伤正常路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const workerWrapper = workerSource.replace('export default {', 'const __workerDefault__ = {')
  + '\n\nglobalThis.__convApi__ = { guardStreamConvergence, normalizeMessages, '
  + 'streamTruncationReason, logCall, callLogSnapshot, usageTotals, recordChatCall, '
  + 'STREAM_IDLE_TIMEOUT_MS, STREAM_MAX_DURATION_MS };\n';

function loadApi() {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, TextDecoder, Set, Map, Date, Math, Number, String, JSON,
    Uint8Array, Object, Array, Promise, Error, URL, setTimeout, clearTimeout,
    AbortController, ReadableStream, TransformStream, Response, Request, Headers,
    fetch: async () => ({ ok: false, status: 500, headers: {}, text: async () => '' }),
    AbortSignal: { timeout: () => ({}) },
    crypto: { randomUUID: () => 'conv-test-uuid' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerWrapper, sandbox);
  return sandbox.__convApi__;
}

const api = loadApi();
const enc = new TextEncoder();
const dec = new TextDecoder();

// 把若干 chunk 做成上游 body；delayMs 为发出该 chunk 前的等待。
function fakeUpstream(chunks) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      const item = chunks[i++];
      const delayMs = item.delayMs || 0;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(enc.encode(item.text));
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

// ── 默认阈值：不能被误设成「短到会伤正常长回答」 ──────────────────────────
test('默认空闲阈值 60s / 总时长上限 10min', () => {
  assert.equal(api.STREAM_IDLE_TIMEOUT_MS, 60000);
  assert.equal(api.STREAM_MAX_DURATION_MS, 600000);
});

// ── 正常流：护栏必须完全透明 ──────────────────────────────────────────────
test('正常流原样透传，一个字节都不改', async () => {
  const body = fakeUpstream([
    { text: 'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' },
    { text: 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' },
    { text: 'data: [DONE]\n\n' },
  ]);
  const out = await drain(api.guardStreamConvergence(body, 'test'));
  assert.equal(out,
    'data: {"choices":[{"delta":{"content":"He"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'
    + 'data: [DONE]\n\n');
});

test('chunk 间隔小于空闲阈值时不截断（慢但活着的流是合法的）', async () => {
  const body = fakeUpstream([
    { text: 'a' },
    { text: 'b', delayMs: 60 },
    { text: 'c', delayMs: 60 },
  ]);
  const out = await drain(api.guardStreamConvergence(body, 'test', { idleMs: 400, maxMs: 60000 }));
  assert.equal(out, 'abc');
});

// ── 空闲卡死：优雅结束，不抛错 ────────────────────────────────────────────
test('空闲超阈值 → 关闭下游，已收到的字节保留', async () => {
  const body = fakeUpstream([
    { text: 'partial' },
    { text: 'never-arrives', delayMs: 5000 },
  ]);
  const out = await drain(api.guardStreamConvergence(body, 'test', { idleMs: 120, maxMs: 60000 }));
  assert.equal(out, 'partial');
});

test('空闲截断走 close 而非 error（下游 pipe 的 finally 必须照常记账）', async () => {
  const body = fakeUpstream([{ text: 'x' }, { text: 'y', delayMs: 5000 }]);
  const reader = api.guardStreamConvergence(body, 'test', { idleMs: 100, maxMs: 60000 }).getReader();
  await reader.read();
  const second = await reader.read();
  assert.equal(second.done, true, '空闲应表现为 done，不是 reject');
});

// ── 总时长上限：拦住「一直在吐字节」的自环 ────────────────────────────────
test('总时长超上限 → 关闭（空闲判据对持续输出的循环无效，这条才是兜底）', async () => {
  const body = fakeUpstream([
    { text: '1' },
    { text: '2', delayMs: 60 },
    { text: '3', delayMs: 60 },
    { text: '4', delayMs: 60 },
    { text: '5', delayMs: 60 },
  ]);
  const out = await drain(api.guardStreamConvergence(body, 'test', { idleMs: 5000, maxMs: 100 }));
  assert.ok(out.length < 5, '应在上限处截断，实际收到 ' + JSON.stringify(out));
  assert.ok(out.startsWith('1'), '截断前的字节要保留');
});

// ── 截断信号：护栏掐断的流必须记 fail，不能记成 success ────────────────────
//
// 为什么要有这组（审查发现 2026-08-29）：护栏关流走的是「正常 close」，下游 pipe
// 的 finally 分辨不出这是截断还是上游自己收尾，于是无条件 recordRequest(success)。
// 后果是客户端拿到 200 + 不完整回答，而面板 fail 计数器不动、看着一切健康。
// 这里锁三件事：截断有信号、正常收尾没有、信号在 onComplete 跑之前就已是终态。

test('空闲截断留下 idle 信号，正常收尾不留信号', async () => {
  const stalled = api.guardStreamConvergence(
    fakeUpstream([{ text: 'partial' }, { text: 'never', delayMs: 5000 }]),
    'trunc-idle', { idleMs: 80, maxMs: 60000 });
  await drain(stalled);
  assert.equal(api.streamTruncationReason(stalled), 'idle',
    '空闲截断必须能被识别出来，否则空回答会被记成 success');

  const normal = api.guardStreamConvergence(
    fakeUpstream([{ text: 'a' }, { text: 'b' }]), 'trunc-none', { idleMs: 5000, maxMs: 60000 });
  const out = await drain(normal);
  assert.equal(out, 'ab', '正常路径一个字节都不能少');
  assert.equal(api.streamTruncationReason(normal), null,
    '正常收尾不许留截断信号 —— 否则成功的调用会被误记成失败');
});

test('时长上限截断留下 duration_cap 信号', async () => {
  const capped = api.guardStreamConvergence(
    fakeUpstream([{ text: '1' }, { text: '2', delayMs: 60 }, { text: '3', delayMs: 60 }]),
    'trunc-cap', { idleMs: 5000, maxMs: 100 });
  await drain(capped);
  assert.equal(api.streamTruncationReason(capped), 'duration_cap',
    '两种截断要能区分：空闲卡死与持续吐字节的自环，处置和排查方向都不同');
});

test('截断原因在流关闭时已是终态（onComplete 在 finally 里读得到）', async () => {
  // pipe 的 finally 是在 reader 读到 done 之后才跑的。这条锁住「读到 done 的那一刻
  // 信号就已经写好了」——否则 onDone 读到 null，fail 照样记不上。
  const stream = api.guardStreamConvergence(
    fakeUpstream([{ text: 'x' }, { text: 'y', delayMs: 5000 }]),
    'trunc-order', { idleMs: 80, maxMs: 60000 });
  const reader = stream.getReader();
  let reasonAtDone = 'not-read';
  while (true) {
    const { done } = await reader.read();
    if (done) { reasonAtDone = api.streamTruncationReason(stream); break; }
  }
  assert.equal(reasonAtDone, 'idle', 'done 到达时截断原因必须已经可读');
});

test('裸 body 不经护栏时没有信号，且信号字段不可枚举（不泄进 JSON）', async () => {
  const bare = fakeUpstream([{ text: 'a' }]);
  assert.equal(api.streamTruncationReason(bare), null, '没经过护栏的流不该被判成截断');
  assert.equal(api.streamTruncationReason(null), null);

  const guarded = api.guardStreamConvergence(fakeUpstream([{ text: 'a' }]), 'enum', { idleMs: 5000 });
  assert.deepEqual(Object.keys(guarded), [], '挂在流上的内部字段不能可枚举');
  await drain(guarded);
});

test('recordChatCall：截断记 fail，正常记 success，两者都留一行调用日志', () => {
  const before = { requests: api.usageTotals.requests, success: api.usageTotals.success, fail: api.usageTotals.fail };
  const mc = { id: 'test/model', session: 'test/model' };
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  api.recordChatCall({}, 'tok-normal', mc, 'high', Date.now() - 1000, Date.now() - 900, usage, null, null);
  assert.equal(api.usageTotals.success, before.success + 1, '正常收尾仍要记 success');
  assert.equal(api.usageTotals.fail, before.fail, '正常收尾不许动 fail');

  api.recordChatCall({}, 'tok-trunc', mc, 'high', Date.now() - 1000, Date.now() - 900, usage, null, 'idle');
  assert.equal(api.usageTotals.fail, before.fail + 1,
    '截断必须记 fail —— 这正是「面板全绿而用户拿到空回答」的根因');
  assert.equal(api.usageTotals.success, before.success + 1, '截断不许再计入 success');
  assert.equal(api.usageTotals.requests, before.requests + 2, '两次都算一次请求');

  // 调用日志要能看出是哪一条被截断的，否则排查时只看到 fail 数字涨了
  const calls = api.callLogSnapshot().calls;
  assert.equal(calls[calls.length - 1].truncated, 'idle', '截断行要带原因');
  assert.equal(calls[calls.length - 2].truncated, '', '正常行的 truncated 是空串');
});

// ── 边界：非流 body 原样返回 ──────────────────────────────────────────────
test('body 为 null 时原样返回，不炸', () => {
  assert.equal(api.guardStreamConvergence(null, 'test'), null);
});

// ── 改动 2：历史里的思考痕迹不回灌上游 ────────────────────────────────────
test('assistant 历史里的 reasoning_content 被剥掉', () => {
  const out = api.normalizeMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'answer', reasoning_content: '上一轮没收束的思考…' },
  ]);
  const assistant = out.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, undefined);
  assert.equal(assistant.content, 'answer', '正文不能动');
});

test('我们自己打的 reasoning_used_as_content 标记也不外发', () => {
  const out = api.normalizeMessages([
    { role: 'assistant', content: '思考被当成正文那次', reasoning_used_as_content: true },
  ]);
  const assistant = out.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_used_as_content, undefined);
});

test('剥离不改动其他字段（tool_calls / tool_call_id 都要留）', () => {
  const out = api.normalizeMessages([
    { role: 'assistant', content: '', reasoning_content: 'x', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ]);
  const assistant = out.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, undefined);
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  const tool = out.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_1');
  assert.equal(tool.content, 'result');
});

test('不修改调用方传入的原始对象（无副作用）', () => {
  const original = { role: 'assistant', content: 'a', reasoning_content: 'keep-mine' };
  api.normalizeMessages([original]);
  assert.equal(original.reasoning_content, 'keep-mine', '入参必须保持不变');
});

test('Buffy 前缀注入仍然生效（剥离没有破坏既有契约）', () => {
  const out = api.normalizeMessages([{ role: 'user', content: 'hi' }]);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.startsWith('You are Buffy, the strategic coding assistant.'));
});
