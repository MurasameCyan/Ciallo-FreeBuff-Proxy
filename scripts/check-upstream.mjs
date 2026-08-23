#!/usr/bin/env node
// scripts/check-upstream.mjs — 官方契约漂移看门狗。
//
// 把 worker.js 运行时依赖（以及我们手工维护的解析器所针对）的 CodebuffAI/freebuff
// 常量/类型文件逐个抓下来做 sha256，与 scripts/upstream-pins.json 里钉死的哈希对比：
//
//   FILE                              STATUS
//   common/src/constants/free-agents.ts        SAME / DRIFT / MISSING
//
// 退出码：0 全部 SAME；1 有 DRIFT/MISSING（上游契约变了）；2 环境错误
// （网络失败等，不能证明漂移，CI 上不应标红为「需要跟版」）。
//
// 用法：
//   node scripts/check-upstream.mjs              # 对比，打印表格
//   node scripts/check-upstream.mjs --update     # 以当前上游内容重钉（人工复核后执行）
//   node scripts/check-upstream.mjs [pins路径]    # 第三参可覆盖 pins 文件（测试用）
//
// 设计取舍：
// - 不 clone 官方仓库：worker.js 本来就按文件粒度读 raw 源，看门狗对齐这个粒度，
//   抓取走与 worker 相同的「raw 主源 + jsDelivr 备源」链路。
// - 哈希前把 CRLF 归一成 LF：Windows 检出、代理注入都不该造成假漂移。
// - main 分支 HEAD 的 commit SHA 尽力获取（GitHub API），拿不到就标 `main@?`
//   继续对比 —— SHA 只是报告标签，不参与判定。
// - 判定为 DRIFT 后的人工动作见仓库 README「模型一览」：刷新 .local 钉死快照、
//   必要时重跑 gen-models-json、核对 worker 解析器，再 --update 重钉。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const DEFAULT_PINS = join(HERE, "upstream-pins.json");
const OWNER_REPO = "CodebuffAI/freebuff";
// HEAD 提交距现在不足这个窗口就视为「CDN 可能未同步」。
const FETCH_GRACE_MS = 10 * 60 * 1000;

// 与 worker.js 的 DYNAMIC_MODELS_SOURCES 同一套文件，外加两个我们已确认在消费
// （但 worker 尚未直接读取）的契约面：session gate 表和 Access Level 额度。
const PINNED_FILES = [
  {
    path: "common/src/constants/free-agents.ts",
    why: "Buffy 开头校验串（403 free_mode_cli_required 的判据）、agent 映射",
  },
  {
    path: "common/src/constants/freebuff-models.ts",
    why: "模型目录、premium/luna 池、per-model 上限、god-only/web-only 名单",
  },
  {
    path: "common/src/constants/freebuff-model-ids.ts",
    why: "deepseek/mimo 等 wire ID 常量（被 models.ts re-export）",
  },
  {
    path: "common/src/types/freebuff-session.ts",
    why: "session/gate wire 契约：banned、model_locked 等全部 gate code",
  },
  {
    path: "common/src/constants/freebuff-levels.ts",
    why: "Access Level → premiumSessionsPerDay 浮动额度（4~7）",
  },
];

export function normalizeLF(text) {
  return text.replace(/\r\n?/g, "\n");
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// statuses: [{ path, status: "SAME"|"DRIFT"|"MISSING"|"FETCH_ERROR", ... }]
// FETCH_ERROR 是环境问题不是漂移，单独归到退出码 2。
export function decide(statuses) {
  if (statuses.some((s) => s.status === "FETCH_ERROR")) return 2;
  if (statuses.some((s) => s.status !== "SAME")) return 1;
  return 0;
}

function sourcesFor(path) {
  return [
    `https://raw.githubusercontent.com/${OWNER_REPO}/main/${path}`,
    `https://cdn.jsdelivr.net/gh/${OWNER_REPO}@main/${path}`,
  ];
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!resp.ok) return { httpStatus: resp.status };
    return { text: await resp.text(), httpStatus: resp.status };
  } finally {
    clearTimeout(timer);
  }
}

// 依次试每个源；HTTP 404 视为官方真删了这个文件（MISSING），网络层失败才换备源，
// 备源也挂则返回 FETCH_ERROR。两者语义不同：前者要跟版，后者重跑即可。
async function fetchPinned(path) {
  let sawNotFound = false;
  for (const url of sourcesFor(path)) {
    try {
      const r = await fetchWithTimeout(url, 20000);
      if (r.text !== undefined) return { kind: "ok", text: r.text };
      if (r.httpStatus === 404) sawNotFound = true;
    } catch {}
  }
  return sawNotFound ? { kind: "missing" } : { kind: "fetch_error" };
}

async function fetchMainSha() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const resp = await fetch(`https://api.github.com/repos/${OWNER_REPO}/commits/main`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "ciallo-upstream-watchdog" },
        signal: ac.signal,
      });
      if (!resp.ok) return null;
      const j = await resp.json();
      return typeof j.sha === "string"
        ? { sha: j.sha.slice(0, 12), date: j.commit?.committer?.date || null }
        : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function loadPins(pinsFile) {
  try {
    return JSON.parse(readFileSync(pinsFile, "utf8"));
  } catch (e) {
    console.error(`check-upstream: 读不到或解析失败 ${pinsFile}: ${e.message}`);
    console.error("首次使用请跑 --update 生成。");
    process.exit(2);
  }
}

function printTable(rows) {
  const w = Math.max(...rows.map((r) => r.path.length)) + 2;
  console.log("FILE".padEnd(w) + "STATUS");
  for (const r of rows) console.log(r.path.padEnd(w) + r.status);
}

export async function run({ pinsFile = DEFAULT_PINS, update = false, log = console.log } = {}) {
  const mainInfo = await fetchMainSha();
  const mainSha = mainInfo ? mainInfo.sha : null;
  const label = mainSha ? `${OWNER_REPO}@${mainSha}` : `${OWNER_REPO}@main(SHA 未取到)`;

  // raw.githubusercontent / jsDelivr 是 CDN，边缘缓存可能落后于 API 报的 HEAD。
  // 今天就踩过：--update 时 API 已是 fe102b1、CDN 还在给上一个 commit 的内容，
  // 钉出「SHA 新、内容旧」的假基准。HEAD 提交时间晚于本次抓取开始时间说明
  // 官方刚推送、缓存大概率没跟上 —— 拒绝落盘/判定，稍后重跑。
  if (mainInfo?.date && Date.now() - Date.parse(mainInfo.date) < FETCH_GRACE_MS) {
    log(`check-upstream: 官方 HEAD ${mainSha} 是 ${Math.max(0, Math.round((Date.now() - Date.parse(mainInfo.date)) / 1000))}s 前的提交，CDN 可能还没同步。等几分钟再跑，避免钉到半新半旧的内容。`);
    return 2;
  }

  const rows = [];
  const fetched = {};
  for (const { path } of PINNED_FILES) {
    const r = await fetchPinned(path);
    if (r.kind === "ok") {
      fetched[path] = normalizeLF(r.text);
    } else {
      // missing = 官方真删了文件（要跟版）；fetch_error = 网络问题（重跑即可）。
      rows.push({ path, status: r.kind === "missing" ? "MISSING" : "FETCH_ERROR" });
    }
  }

  if (update) {
    // 部分失败时绝不落盘：否则会把没抓到的文件从 pins 里静默删掉，
    // 下次对比它们就成了 UNPINNED —— 看门狗自己制造盲区。
    if (Object.keys(fetched).length !== PINNED_FILES.length) {
      log(`check-upstream: 只取到 ${Object.keys(fetched).length}/${PINNED_FILES.length} 个文件，拒绝重钉（部分写入会丢 pin）。先解决网络再 --update。`);
      return 2;
    }
    const pins = {
      pinnedAgainst: mainSha || "main",
      pinnedAt: new Date().toISOString(),
      note: "由 scripts/check-upstream.mjs --update 生成；哈希基于 LF 归一化后的文件内容。",
      files: {},
    };
    for (const { path, why } of PINNED_FILES) {
      pins.files[path] = { why, sha256: sha256Hex(fetched[path]), bytes: Buffer.byteLength(fetched[path]) };
    }
    writeFileSync(pinsFile, JSON.stringify(pins, null, 2) + "\n");
    log(`check-upstream: 已写入 ${pinsFile}（对照 ${label}）`);
    return 0;
  }

  const pins = loadPins(pinsFile);
  for (const { path } of PINNED_FILES) {
    if (fetched[path] === undefined) continue; // MISSING/FETCH_ERROR 行已入表
    const pin = pins.files && pins.files[path];
    const now = sha256Hex(fetched[path]);
    const status = !pin ? "UNPINNED" : pin.sha256 === now ? "SAME" : "DRIFT";
    rows.push({ path, status });
  }

  log(`check-upstream: 对比 ${OWNER_REPO}${mainSha ? "@" + mainSha : "@main"}（pins 对照 ${(pins.pinnedAgainst || "?").slice(0, 12)}）`);
  printTable(rows);

  const code = decide(rows);
  if (code === 0) log("check-upstream: OK — 全部钉死文件与官方 main 一致。");
  if (code === 1) {
    log("check-upstream: 检测到漂移/缺失 —— 上游契约变了。");
    log("跟进步骤：刷新 .local 钉死快照 → 核对 worker 解析器/常量 → 必要时重新生成 freebuff-models.json → node scripts/check-upstream.mjs --update 重钉。");
  }
  if (code === 2) log("check-upstream: 网络环境错误，本次无法判定（重跑即可），不算漂移。");
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2).filter((a) => a !== "--update");
  const update = process.argv.includes("--update");
  const pinsArg = args[0];
  run({ pinsFile: pinsArg ? resolve(pinsArg) : DEFAULT_PINS, update })
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("check-upstream:", e);
      process.exit(2);
    });
}
