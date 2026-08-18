import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStateStore, tokenHash } from '../server/account-state.mjs';

test('新 banned 强制以 until:null 落盘，且只写 token 哈希并可跨实例恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-account-state-'));
  const file = join(dir, 'account-state.json');
  const token = 'account-state-secret-token-123456';
  try {
    const store = createAccountStateStore(file);
    assert.equal(store.revision(), 0);
    const written = store.set(token, { state: 'banned', until: 1893456000000, reason: 'upstream_banned' });
    assert.equal(written.until, null);
    assert.equal(written.revision, 1);
    assert.equal(store.revision(), 1);
    const raw = await readFile(file, 'utf8');
    assert.match(raw, new RegExp(tokenHash(token)));
    assert.doesNotMatch(raw, new RegExp(token));
    assert.equal(JSON.parse(raw).accounts[tokenHash(token)].until, null);

    const restored = createAccountStateStore(file);
    assert.deepEqual(restored.snapshot([token])[token], {
      state: 'banned',
      until: null,
      reason: 'upstream_banned',
    });
    assert.equal(restored.revision(), 0);
    const cleared = restored.clear(token);
    assert.deepEqual(cleared, { removed: true, revision: 1 });
    assert.deepEqual(restored.snapshot([token]), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('所有 terminal 状态都以永久隔离的 until:null 规范化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-terminal-state-'));
  const file = join(dir, 'account-state.json');
  const states = ['banned', 'token_invalid', 'manual_disabled'];
  try {
    const store = createAccountStateStore(file);
    for (const [index, state] of states.entries()) {
      const token = `terminal-state-${index}-123456`;
      const written = store.set(token, { state, until: 1893456000000, reason: 'test' });
      assert.equal(written.until, null, `${state} 必须永久隔离`);
      assert.equal(store.snapshot([token])[token].until, null);
    }
    const raw = JSON.parse(await readFile(file, 'utf8'));
    for (const record of Object.values(raw.accounts)) assert.equal(record.until, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('损坏的持久状态文件回退为空状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-account-state-'));
  const file = join(dir, 'account-state.json');
  try {
    await writeFile(file, '{broken', 'utf8');
    const store = createAccountStateStore(file);
    assert.deepEqual(store.snapshot(['some-token-123456']), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('主状态文件损坏或缺失时从完整临时副本恢复', async () => {
  const token = 'recoverable-account-state-123456';
  const record = { state: 'banned', until: 1893456000000, reason: 'upstream_banned', updatedAt: 1890000000000 };
  for (const suffix of ['.tmp', '.bak']) {
    const dir = await mkdtemp(join(tmpdir(), 'freebuff-account-state-recovery-'));
    const file = join(dir, 'account-state.json');
    try {
      if (suffix === '.bak') await writeFile(file, '{broken', 'utf8');
      await writeFile(file + suffix, JSON.stringify({ version: 1, accounts: { [tokenHash(token)]: record } }), 'utf8');
      const store = createAccountStateStore(file);
      assert.deepEqual(store.snapshot([token])[token], {
        state: 'banned',
        until: null,
        reason: 'upstream_banned',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('主状态文件是合法 JSON 但 schema 错误时回退到备份', async () => {
  const token = 'schema-recovery-account-state-123456';
  const record = { state: 'banned', until: 1893456000000, reason: 'upstream_banned', updatedAt: 1890000000000 };
  const invalidPrimaryValues = [
    {},
    [],
    { version: 1, accounts: null },
    { version: 2, accounts: {} },
  ];
  for (const primary of invalidPrimaryValues) {
    const dir = await mkdtemp(join(tmpdir(), 'freebuff-account-state-schema-'));
    const file = join(dir, 'account-state.json');
    try {
      await writeFile(file, JSON.stringify(primary), 'utf8');
      await writeFile(file + '.bak', JSON.stringify({ version: 1, accounts: { [tokenHash(token)]: record } }), 'utf8');
      const store = createAccountStateStore(file);
      assert.deepEqual(store.snapshot([token])[token], {
        state: 'banned',
        until: null,
        reason: 'upstream_banned',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('持久化写入失败时不提交内存状态或 revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'freebuff-account-state-write-failure-'));
  const file = join(dir, 'account-state.json');
  const tmp = file + '.tmp';
  const token = 'write-failure-account-state-123456';
  const record = { state: 'banned', until: 1893456000000, reason: 'upstream_banned' };
  try {
    const store = createAccountStateStore(file);
    await mkdir(tmp);
    assert.throws(() => store.set(token, record));
    assert.equal(store.revision(), 0);
    assert.deepEqual(store.snapshot([token]), {});

    await rm(tmp, { recursive: true, force: true });
    store.set(token, record);
    assert.equal(store.revision(), 1);

    await mkdir(tmp);
    assert.throws(() => store.clear(token));
    assert.equal(store.revision(), 1);
    assert.deepEqual(store.snapshot([token])[token], {
      state: 'banned',
      until: null,
      reason: 'upstream_banned',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
