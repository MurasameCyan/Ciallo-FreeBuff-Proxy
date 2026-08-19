import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 累计字段的固定集合：load() 只认这些键，缺失或非法一律归 0。
const TOTAL_KEYS = [
  'requests',
  'success',
  'fail',
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
];

// 空快照的 startTime 基准，损坏/缺失时回退到此值。
const DEFAULT_START = 123;

function blankTotal() {
  const t = {};
  for (const k of TOTAL_KEYS) t[k] = 0;
  return t;
}

function blankSnapshot() {
  return { total: blankTotal(), byModel: {}, byKey: {}, startTime: DEFAULT_START, lastRequest: null };
}

function isFiniteNonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function normalizeTotal(src) {
  const t = {};
  for (const k of TOTAL_KEYS) {
    t[k] = src && isFiniteNonNeg(src[k]) ? src[k] : 0;
  }
  return t;
}

function normalizeByKey(src) {
  const byKey = {};
  if (!src || typeof src !== 'object') return byKey;
  for (const [fingerprint, v] of Object.entries(src)) {
    const name = String(v?.name ?? '').trim();
    if (!name || !v || typeof v !== 'object' || v.owner === true || !isFiniteNonNeg(v.totalTokens)) continue;
    // 会话归账（今日会话集合 / 累计会话 / 最后一次）是可选段：老快照没有这几个字段，
    // 缺了就当没有，不要凭空补 0 —— 那会让「从没用过」和「今天真是 0」看起来一样。
    const day = String(v.day ?? '').trim();
    const daySessions = Array.isArray(v.daySessions)
      ? v.daySessions.filter((id) => typeof id === 'string' && id)
      : [];
    const seenIds = new Set();
    const seenSessions = Array.isArray(v.seenSessions)
      ? v.seenSessions.flatMap((raw) => {
        const id = typeof raw === 'string' ? raw : String(raw?.id ?? '');
        if (!id || seenIds.has(id)) return [];
        seenIds.add(id);
        const expiresAt = raw && typeof raw === 'object' && isFiniteNonNeg(raw.expiresAt)
          ? raw.expiresAt : null;
        return [{ id, expiresAt }];
      })
      : [];
    byKey[fingerprint] = {
      name,
      totalTokens: v.totalTokens,
      ...(v.owner === true ? { owner: true } : {}),
      ...(day ? { day, daySessions } : {}),
      ...(seenSessions.length ? { seenSessions } : {}),
      ...(isFiniteNonNeg(v.total) ? { total: v.total } : {}),
      ...(isFiniteNonNeg(v.lastAt) ? { lastAt: v.lastAt } : {}),
    };
  }
  return byKey;
}

function normalizeSnapshot(src) {
  if (!src || typeof src !== 'object') return blankSnapshot();
  const byModel = {};
  if (src.byModel && typeof src.byModel === 'object') {
    for (const [model, v] of Object.entries(src.byModel)) {
      if (v && typeof v === 'object') byModel[model] = normalizeTotal(v);
    }
  }
  return {
    total: normalizeTotal(src.total),
    byModel,
    byKey: normalizeByKey(src.byKey),
    startTime: isFiniteNonNeg(src.startTime) ? src.startTime : DEFAULT_START,
    lastRequest: isFiniteNonNeg(src.lastRequest) ? src.lastRequest : null,
  };
}

/**
 * 概况统计的 JSON 持久化存储。
 *
 * 文件格式固定为 `{ enabled, snapshot }`。`enabled()`/`load()` 是同步方法，
 * 因此在构造时同步读取一次文件；`setEnabled()`/`save()` 是异步的，写文件
 * 采用「临时文件 + rename」的原子方式，I/O 错误直接向上抛、不吞。
 */
export function createUsagePersistence(file) {
  let enabled = false;
  let snapshot = blankSnapshot();

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.enabled === true) enabled = true;
        snapshot = normalizeSnapshot(parsed.snapshot);
      }
    } catch {
      // 损坏或不可读：回退到关闭 + 空快照，不让启动中断。
      enabled = false;
      snapshot = blankSnapshot();
    }
  }

  async function writeState(nextSnapshot = snapshot) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify({ enabled, snapshot: nextSnapshot }), 'utf8');
    await rename(tmp, file);
  }

  // 所有写操作串行化：共用同一个 .tmp 路径，避免并发写互相覆盖；
  // 单次写失败后队列不中毒，后续写仍可重试。错误另存给 flush()，让关停
  // 能知道最后一次落盘是否成功，而不是被「继续排队」的尾链吞掉。
  let writeQueue = Promise.resolve();
  let pendingWriteError = null;
  function enqueueWrite(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(
      () => {},
      (error) => { pendingWriteError = error; },
    );
    return run;
  }

  return {
    enabled() {
      return enabled;
    },

    setEnabled(value) {
      enabled = value === true;
      return enqueueWrite(() => writeState());
    },

    load() {
      return snapshot;
    },

    save(next) {
      if (!enabled) return Promise.resolve();
      const normalized = normalizeSnapshot(next);
      return enqueueWrite(() => writeState(normalized)).then(() => {
        snapshot = normalized;
      });
    },

    // Key 统计独立于概况开关：只写稳定指纹、备注名、会话和 token 数，
    // 不把明文 Key 或上游凭据写入磁盘。按队列执行时再读取 snapshot，避免
    // 与同时发生的完整概况保存互相覆盖。
    saveByKey(byKey) {
      const normalizedByKey = normalizeByKey(byKey);
      return enqueueWrite(async () => {
        const next = normalizeSnapshot({ ...snapshot, byKey: normalizedByKey });
        await writeState(next);
        snapshot = next;
      });
    },

    // 等待已经排队的写入完成。worker 的 usageSaveHook 刻意不阻塞请求，
    // 因此 SIGTERM/SIGINT 退出前必须显式 flush，否则最后一次 Key 统计可能
    // 仍停在异步 rename 之前就被 process.exit 截断。队列会继续可用，但把
    // 最近一次 I/O 错误抛给关停调用方，避免静默丢数据。
    async flush() {
      await writeQueue;
      const error = pendingWriteError;
      pendingWriteError = null;
      if (error) throw error;
    },
  };
}
