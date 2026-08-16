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
  return { total: blankTotal(), byModel: {}, startTime: DEFAULT_START, lastRequest: null };
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
  // 单次写失败后队列不中毒，后续写仍可重试。
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(() => {}, () => {});
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
  };
}
