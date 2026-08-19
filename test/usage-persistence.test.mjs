import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsagePersistence } from '../server/usage-persistence.mjs';

const blank = { total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, byModel: {}, byKey: {}, startTime: 123, lastRequest: null };

test('默认关闭且不产生统计文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const store = createUsagePersistence(join(dir, 'usage.json'));
    assert.equal(store.enabled(), false);
    await store.save({ ...blank, startTime: 456 });
    await assert.rejects(readFile(join(dir, 'usage.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('概况开关关闭时，分享 Key 统计仍独立落盘并可恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const store = createUsagePersistence(file);
    assert.equal(store.enabled(), false);
    const byKey = {
      keyFingerprint: {
        name: '小明', totalTokens: 12, day: '2026-08-20',
        daySessions: ['session-a'], total: 1, lastAt: 1755000000000,
      },
      ownerFingerprint: { name: '主 Key', owner: true, totalTokens: 999 },
    };
    await store.saveByKey(byKey);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.enabled, false, '概况开关仍应保持关闭');
    const expected = { keyFingerprint: byKey.keyFingerprint };
    assert.deepEqual(persisted.snapshot.byKey, expected, 'Master Key 不得进入持久化文件');
    assert.deepEqual(createUsagePersistence(file).load().byKey, expected);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('开启后保存并可重新加载完整快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const first = createUsagePersistence(file);
    first.setEnabled(true);
    const snapshot = {
      ...blank,
      total: { ...blank.total, requests: 3, totalTokens: 99 },
      byModel: { 'mimo/mimo-v2.5': { ...blank.total, requests: 3, success: 3 } },
      byKey: { 'key-fingerprint': { name: '小明', totalTokens: 99 } },
      startTime: 456,
      lastRequest: 789,
    };
    await first.save(snapshot);
    const second = createUsagePersistence(file);
    assert.equal(second.enabled(), true);
    assert.deepEqual(second.load(), snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('分享 Key 的会话归账随快照落盘：今日集合、累计与最后一次都要活过重启', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const first = createUsagePersistence(file);
    await first.setEnabled(true);
    const row = {
      name: '小明',
      totalTokens: 99,
      day: '2026-08-20',
      daySessions: ['enhanced-aaaaaaaabbbbbbbb', 'enhanced-ccccccccdddddddd'],
      seenSessions: [
        { id: 'enhanced-aaaaaaaabbbbbbbb', expiresAt: 1755003600000 },
        { id: 'enhanced-ccccccccdddddddd', expiresAt: null },
      ],
      total: 7,
      lastAt: 1755000000000,
    };
    await first.save({ ...blank, byKey: { 'key-fingerprint': row } });
    assert.deepEqual(createUsagePersistence(file).load().byKey, { 'key-fingerprint': row });

    // 脏字段一律不落盘，但不能连整行的 token 累计一起丢。
    await first.save({
      ...blank,
      byKey: {
        dirty: { name: '脏值', totalTokens: 5, day: '  ', daySessions: ['ok', 3, '', null], total: -1, lastAt: 'x' },
      },
    });
    assert.deepEqual(createUsagePersistence(file).load().byKey, { dirty: { name: '脏值', totalTokens: 5 } },
      'day 为空时整段会话归账都不保留：凭空补 0 会让「从没用过」和「今天真是 0」看起来一样');
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
    await assert.rejects(store.flush(), 'flush 必须暴露已排队写入的 I/O 失败');
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

test('flush 等待尚未完成的保存，进程退出前不会丢掉最新快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const store = createUsagePersistence(file);
    await store.setEnabled(true);
    const snapshot = { ...blank, total: { ...blank.total, totalTokens: 123 } };

    // 模拟 SIGTERM 紧跟在 usageSaveHook 后：调用方不会再持有 save() 的 promise，
    // 只能通过 flush 等待内部写队列，否则直接 process.exit 会截断异步 rename。
    store.save(snapshot);
    await store.flush();

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(persisted.snapshot, snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('并发 save 按调用顺序落盘，后一次 Key 统计不会被旧快照覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-usage-'));
  try {
    const file = join(dir, 'usage.json');
    const store = createUsagePersistence(file);
    await store.setEnabled(true);
    const first = { ...blank, byKey: { first: { name: '第一把', totalTokens: 1 } } };
    const second = { ...blank, byKey: { second: { name: '第二把', totalTokens: 2 } } };
    await Promise.all([store.save(first), store.save(second)]);
    await store.flush();
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(persisted.snapshot, second);
    assert.deepEqual(store.load(), second, 'flush 返回时内存快照也必须已更新');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
