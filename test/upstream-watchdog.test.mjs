// === 上游漂移看门狗的纯函数部分 ===
//
// 看门狗跑一次要联网抓 6 个官方文件，CI 里靠退出码说话；这里只锁不联网的判定逻辑：
//   · decide()      —— SAME / DRIFT / MISSING / FETCH_ERROR → 0 / 1 / 2
//   · diffSemantic() —— 语义快照的逐类 diff（模型/目录/池/三态名单）
// 语义层的价值：哈希全绿但 worker 解析器悄悄退回内置兜底时，只有它能报警
// （2026-10-03 实测：mimo/mimo-v2.6-pro 因 model-config.ts 未拉取而静默缺席）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, diffSemantic } from '../scripts/check-upstream.mjs';

test('decide：FETCH_ERROR 是环境错误(2)，漂移/缺失是契约变化(1)，全同才 0', () => {
  assert.equal(decide([{ path: 'a', status: 'SAME' }, { path: 'b', status: 'SAME' }]), 0);
  assert.equal(decide([{ path: 'a', status: 'DRIFT' }]), 1);
  assert.equal(decide([{ path: 'a', status: 'MISSING' }]), 1);
  assert.equal(decide([{ path: 'a', status: 'FETCH_ERROR' }]), 2);
  assert.equal(decide([{ path: 'a', status: 'FETCH_ERROR' }, { path: 'b', status: 'DRIFT' }]), 2,
    '网络不可判定优先于漂移：不能把抓取失败当成契约变化');
});

function snapshot(overrides = {}) {
  return {
    source: 'official',
    models: [
      { id: 'mimo/mimo-v2.5', pool: 'standard', premium: false },
      { id: 'openai/gpt-6-luna', pool: 'premium', premium: true },
    ],
    paused: ['openai/gpt-5.6-luna'],
    serviceOnly: [],
    godOnly: ['crof/kimi-k3-eco'],
    publicCatalog: ['mimo/mimo-v2.5', 'openai/gpt-6-luna'],
    premiumPool: ['openai/gpt-6-luna'],
    ...overrides,
  };
}

test('diffSemantic：完全一致时零变化', () => {
  assert.deepEqual(diffSemantic(snapshot(), snapshot()), []);
});

test('diffSemantic：模型增删、目录增删、名单三态与池漂移逐类报告', () => {
  const next = snapshot({
    models: [
      { id: 'mimo/mimo-v2.5', pool: 'standard', premium: false },
      { id: 'openai/gpt-6-luna', pool: 'premium', premium: true },
      { id: 'mimo/mimo-v2.6-pro', pool: null, premium: false },
    ],
    publicCatalog: ['mimo/mimo-v2.5', 'openai/gpt-6-luna', 'mimo/mimo-v2.6-pro'],
    paused: null,
    godOnly: [],
    premiumPool: ['openai/gpt-6-luna', 'openai/gpt-6.1-sol'],
  });
  const changes = diffSemantic(snapshot(), next);
  assert.ok(changes.includes('+ model: mimo/mimo-v2.6-pro'));
  assert.ok(changes.includes('+ publicCatalog: mimo/mimo-v2.6-pro'));
  assert.ok(changes.includes('- paused: openai/gpt-5.6-luna'),
    'null（源里没有这张表）与读过后的空列表在 diff 里也必须区分');
  assert.ok(changes.includes('- godOnly: crof/kimi-k3-eco'));
  assert.ok(changes.includes('+ premiumPool: openai/gpt-6.1-sol'));
});

test('diffSemantic：premium 标志与 pool 归属变化要单独报出来', () => {
  const next = snapshot({
    models: [
      { id: 'mimo/mimo-v2.5', pool: 'limited', premium: false },
      { id: 'openai/gpt-6-luna', pool: 'premium', premium: false },
    ],
  });
  const changes = diffSemantic(snapshot(), next);
  assert.ok(changes.includes('~ pool mimo/mimo-v2.5: standard → limited'));
  assert.ok(changes.includes('- premium: openai/gpt-6-luna'));
});
