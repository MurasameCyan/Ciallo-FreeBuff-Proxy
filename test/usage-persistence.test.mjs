import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsagePersistence } from '../server/usage-persistence.mjs';

const blank = { total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, byModel: {}, startTime: 123, lastRequest: null };

test('默认关闭且不产生统计文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const store = createUsagePersistence(join(dir, 'usage.json'));
    assert.equal(store.enabled(), false);
    await store.save({ ...blank, startTime: 456 });
    await assert.rejects(readFile(join(dir, 'usage.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('开启后保存并可重新加载完整快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const first = createUsagePersistence(file);
    first.setEnabled(true);
    const snapshot = { ...blank, total: { ...blank.total, requests: 3, totalTokens: 99 }, byModel: { 'mimo/mimo-v2.5': { ...blank.total, requests: 3, success: 3 } }, startTime: 456, lastRequest: 789 };
    await first.save(snapshot);
    const second = createUsagePersistence(file);
    assert.equal(second.enabled(), true);
    assert.deepEqual(second.load(), snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('损坏文件回退到空快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    await writeFile(file, '{broken', 'utf8');
    const store = createUsagePersistence(file);
    assert.deepEqual(store.load(), blank);
    assert.equal(store.enabled(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('写入失败时保存明确拒绝且 store 仍可继续调用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    // 路径指向目录而非文件，rename 到该路径必然失败。
    const store = createUsagePersistence(dir);
    await assert.rejects(store.setEnabled(true));
    await assert.rejects(store.save({ ...blank, startTime: 456 }));
    // 失败后状态不受影响，仍可继续调用且保持开启。
    assert.equal(store.enabled(), true);
    assert.deepEqual(store.load(), blank);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('关闭后保存不会写入新数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const store = createUsagePersistence(file);
    const snapshot = { ...blank, startTime: 456 };
    await store.setEnabled(true);
    await store.save(snapshot);
    await store.setEnabled(false);
    const disabledState = await readFile(file, 'utf8');
    const persisted = JSON.parse(disabledState);
    assert.equal(persisted.enabled, false);
    assert.deepEqual(persisted.snapshot, snapshot);
    await store.save({ ...blank, startTime: 789 });
    assert.equal(await readFile(file, 'utf8'), disabledState);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
