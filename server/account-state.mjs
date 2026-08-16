import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const STATES = new Set(['banned', 'token_invalid', 'manual_disabled']);

export function tokenHash(token) {
  return 'sha256:' + crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || !STATES.has(value.state)) return null;
  const until = value.until == null ? null : Number(value.until);
  if (until !== null && (!Number.isFinite(until) || until < 0)) return null;
  return {
    state: value.state,
    until,
    ...(value.reason ? { reason: String(value.reason).slice(0, 160) } : {}),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

function parseState(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.version !== VERSION
      || !parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
      return null;
    }
    const accounts = parsed.accounts;
    const out = new Map();
    for (const [key, value] of Object.entries(accounts)) {
      if (!/^sha256:[a-f0-9]{64}$/.test(key)) continue;
      const record = normalizeRecord(value);
      if (record) out.set(key, record);
    }
    return out;
  } catch {
    return null;
  }
}

function readStateFile(file) {
  if (!existsSync(file)) return null;
  try { return parseState(readFileSync(file, 'utf8')); } catch { return null; }
}

function readState(file) {
  // A complete temp/backup file is safer than treating a torn primary write as
  // an empty state. The primary always wins when it is valid.
  return readStateFile(file)
    || readStateFile(file + '.tmp')
    || readStateFile(file + '.bak')
    || new Map();
}

function writeState(file, records) {
  mkdirSync(dirname(file), { recursive: true });
  const accounts = Object.fromEntries(records.entries());
  const tmp = file + '.tmp';
  const backup = file + '.bak';
  writeFileSync(tmp, JSON.stringify({ version: VERSION, accounts }, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, file);
    try { unlinkSync(backup); } catch {}
    return;
  } catch {
    // Windows cannot replace an existing file with renameSync. Move the old
    // file aside, then move the complete temp file into place. If the process
    // stops between these steps, readState() can recover .tmp or .bak.
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

export function createAccountStateStore(file) {
  if (!file) throw new TypeError('account state file is required');
  let records = readState(file);
  let revision = 0;

  return {
    file,
    revision() {
      return revision;
    },
    snapshot(tokens) {
      const out = {};
      for (const token of Array.isArray(tokens) ? tokens : []) {
        const record = records.get(tokenHash(token));
        if (record) {
          out[token] = {
            state: record.state,
            until: record.until,
            ...(record.reason ? { reason: record.reason } : {}),
          };
        }
      }
      return out;
    },
    set(token, value) {
      const key = tokenHash(token);
      const record = normalizeRecord(value);
      if (!token || !record) throw new TypeError('invalid account state');
      const next = new Map(records);
      next.set(key, record);
      writeState(file, next);
      records = next;
      revision += 1;
      return { ...record, revision };
    },
    clear(token) {
      const key = tokenHash(token);
      if (!records.has(key)) return { removed: false, revision };
      const next = new Map(records);
      next.delete(key);
      writeState(file, next);
      records = next;
      revision += 1;
      return { removed: true, revision };
    },
  };
}
