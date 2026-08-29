import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

// ===========================================================================
// 共享 API Key 存储 —— 「发给别人用」的那些 key。
// ---------------------------------------------------------------------------
// 主 Key（credentials/server-key.txt 或 env.FREEBUFF_API_KEY）刻意不在这里：
// 它是部署自带的那一把，不限并发、不限模型、不计每日上限，行为与加多 key 之前
// 完全一致。这里只存额外发出去的 key，每条各自限并发/模型/每日上限。
//
// 每条记录：
//   key          fbk-... 随机串，创建时生成，之后不可改
//   name         备注名（给谁用的）。面板与调用日志按它归账，大小写不敏感唯一
//   concurrency  同时在跑的请求数上限，默认 1
//   models       可用模型 id 白名单，空数组 = 不限
//   dailyLimit   每日请求上限，0 = 不限
//   disabled     停用：记录留着，鉴权时当无效 key
// ===========================================================================

// 主 Key 在面板/日志里的显示名。worker.js 里有同一个字面量（它不能 import 服务端
// 模块，得留在单文件里跑 Cloudflare），改这里记得一起改。
export const OWNER_KEY_NAME = '主 Key';

function keyFingerprint(key) {
  return 'sha256-' + crypto.createHash('sha256')
    .update('freebuff-share-key-v1\0')
    .update(String(key || ''))
    .digest('hex');
}

const MAX_KEYS = 64;          // 一页看得完；也挡住脚本手滑把文件写爆
const MAX_NAME_LEN = 40;
const MAX_MODELS = 64;
const MAX_CONCURRENCY = 32;
const MAX_DAILY_LIMIT = 100000;
const PAUSED_MODEL_IDS = new Set([
  'minimax/minimax-m3',
  'deepseek/deepseek-v4-pro',
  'stealth/ox-alpha',
]);

function isPausedModelId(modelId) {
  const id = String(modelId ?? '').trim().toLowerCase();
  for (const base of PAUSED_MODEL_IDS) {
    if (id === base) return true;
    if (id.startsWith(base) && /^-\d{6,8}(?:$|[-:])/.test(id.slice(base.length))) return true;
  }
  return false;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_KEY_CONFIG' });
}

function cleanConcurrency(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n)));
}

function cleanDailyLimit(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(MAX_DAILY_LIMIT, Math.floor(n));
}

// 模型白名单：去空、去重、保序、限长。这里不校验模型是否存在 —— 动态模型表会变，
// 存下来的名字今天不在表里、明天上游放开了就在了，校验只会让配置无故失效。
function cleanModels(value, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw invalid('models 必须是数组');
  const out = [];
  for (const raw of value) {
    const id = String(raw ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('备注名不能为空');
  if (name.length > MAX_NAME_LEN) throw invalid(`备注名最长 ${MAX_NAME_LEN} 个字符`);
  if (name === OWNER_KEY_NAME) throw invalid(`备注名不能是「${OWNER_KEY_NAME}」（留给部署自带的那把）`);
  return name;
}

// 读盘时用的宽松归一化：手改过或旧版本写的文件也得能用，缺字段补默认值。
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key ?? '').trim();
  if (!key) return null;
  const name = String(raw.name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
  return {
    key,
    name: name || key.slice(0, 10),
    concurrency: cleanConcurrency(raw.concurrency),
    models: Array.isArray(raw.models)
      ? raw.models.map((m) => String(m ?? '').trim()).filter(Boolean).slice(0, MAX_MODELS)
      : [],
    dailyLimit: cleanDailyLimit(raw.dailyLimit),
    disabled: raw.disabled === true,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
  };
}

// 读一个候选文件；读不到或解析不出来返回 null（区别于「读到了但里面是空池」——
// `{"keys":[]}` 是合法状态，必须原样采用，不能掉进回退去捡旧副本，否则删掉的
// Key 会被旧副本复活）。
function readKeysFile(path) {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    const rows = Array.isArray(obj?.keys) ? obj.keys : [];
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const entry = normalizeStored(row);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push(entry);
    }
    return out;
  } catch (e) {
    console.error(`[server] load ${path} failed:`, e.message);
    return null;
  }
}

export function createApiKeyStore(file) {
  function load() {
    // 撕裂的正本不能当成「空池」——那会让所有已发出去的分享 Key 静默失效，
    // 面板列表变空、别人手里的 Key 全部 401，看起来像从来没发过 Key。
    // 完整的 .tmp/.bak 比一个截断的正本可信；正本有效时永远优先。
    // 三级回退与 account-state.mjs 对齐。
    const primary = readKeysFile(file);
    if (primary) return primary;
    const recovered = readKeysFile(file + '.tmp') || readKeysFile(file + '.bak');
    if (recovered) {
      console.error('[server] api-keys.json 正本不可用，已从副本恢复 '
        + `${recovered.length} 条 Key`);
      return recovered;
    }
    // 三者都不可用才当空池启动：坏文件不该让整个面板打不开。
    return [];
  }

  function save(keys) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const backup = file + '.bak';
    writeFileSync(tmp, JSON.stringify({ keys }, null, 2) + '\n', 'utf-8');
    // rename 是同分区上的原子替换：任何时刻正本要么是旧的完整内容、要么是新的。
    // 先写 .tmp 再拿它的内容普通写覆盖正本，只是把暴露窗口翻倍，收益为零。
    try {
      renameSync(tmp, file);
      try { unlinkSync(backup); } catch {}
      return;
    } catch {
      // Windows 的 renameSync 不能覆盖已存在的文件：先把旧正本挪去 .bak，
      // 再把完整的 .tmp 挪成正本。中途崩了 load() 能从 .tmp 或 .bak 捡回来。
      try { unlinkSync(backup); } catch {}
      if (existsSync(file)) renameSync(file, backup);
      try {
        renameSync(tmp, file);
        try { unlinkSync(backup); } catch {}
      } catch (error) {
        if (!existsSync(file) && existsSync(backup)) {
          try { renameSync(backup, file); } catch {}
        }
        throw error;
      }
    }
  }

  function assertNameFree(keys, name, exceptKey = null) {
    const lower = name.toLowerCase();
    for (const k of keys) {
      if (k.key !== exceptKey && k.name.toLowerCase() === lower) {
        throw invalid(`备注名「${name}」已被占用`);
      }
    }
  }

  return {
    file,
    list: load,
    fingerprint: keyFingerprint,

    /** 新发一把 key。返回完整记录（含明文 key，只有这一次能拿全）。 */
    add(patch = {}) {
      const keys = load();
      if (keys.length >= MAX_KEYS) throw invalid(`最多 ${MAX_KEYS} 个 key`);
      const name = cleanName(patch.name);
      assertNameFree(keys, name);
      const entry = {
        key: 'fbk-' + crypto.randomBytes(24).toString('base64url'),
        name,
        concurrency: cleanConcurrency(patch.concurrency),
        models: cleanModels(patch.models, []),
        dailyLimit: cleanDailyLimit(patch.dailyLimit),
        disabled: patch.disabled === true,
        createdAt: Date.now(),
      };
      keys.push(entry);
      save(keys);
      return entry;
    },

    /** 改一把 key 的配置。key 本身不可改（改了等于换一把，用删+加）。 */
    update(key, patch = {}) {
      const keys = load();
      const idx = keys.findIndex((k) => k.key === key);
      if (idx < 0) throw Object.assign(new Error('key 不存在'), { code: 'KEY_NOT_FOUND' });
      const cur = keys[idx];
      const next = { ...cur };
      if (patch.name !== undefined) {
        next.name = cleanName(patch.name);
        assertNameFree(keys, next.name, key);
      }
      if (patch.concurrency !== undefined) next.concurrency = cleanConcurrency(patch.concurrency, cur.concurrency);
      if (patch.models !== undefined) {
        const models = cleanModels(patch.models, cur.models);
        // 旧 Key 可能只允许已经暂停的模型。前端会把该模型显示为禁用，
        // 因而一次普通的“保存”不能把 models=[] 误解成“不限模型”。
        // 其他 Key 显式传空数组的既有语义保持不变。
        if (
          models.length === 0
          && cur.models.length > 0
          && cur.models.every(isPausedModelId)
        ) {
          throw invalid('该 Key 只允许已暂停模型，不能改成不限模型');
        }
        next.models = models;
      }
      if (patch.dailyLimit !== undefined) next.dailyLimit = cleanDailyLimit(patch.dailyLimit, cur.dailyLimit);
      if (patch.disabled !== undefined) next.disabled = patch.disabled === true;
      keys[idx] = next;
      save(keys);
      return next;
    },

    remove(key) {
      const keys = load();
      const next = keys.filter((k) => k.key !== key);
      if (next.length === keys.length) throw Object.assign(new Error('key 不存在'), { code: 'KEY_NOT_FOUND' });
      save(next);
      return true;
    },

    /** 喂给 worker 的鉴权表（就是存的那份，worker 只读不写）。 */
    descriptors() {
      return load().map(({ key, name, concurrency, models, dailyLimit, disabled }) => ({
        key, fingerprint: keyFingerprint(key), name, concurrency, models, dailyLimit, disabled,
      }));
    },
  };
}
