/**
 * mihomo.mjs —— 内核进程管理（Linux 容器版）。
 *
 * 移植自 Ciallo-Zen-Proxy server/mihomo.mjs（MIT）。
 *
 * 与 Zen 的差异：端口常量、数据目录、配置路径都来自 config.mjs（本目录），
 * 由 server.js 在启动时注入。只提供 start/stop/restart + /version 就绪判定，
 * 订阅解析完全交给内核的 proxy-providers（见 proxy.mjs 的 buildMihomoYaml）。
 *
 * 关键点（沿用 Zen 的踩坑结论）：
 * - 就绪判定问 external-controller 的 /version，而不是 TCP 通不通 mixed-port：
 *   端口 listen 了不代表配置加载完，provider 还在拉的时候连上去是白连。
 * - stderr 直接喂给日志（容器里日志文件没人看得见），SIGTERM 5s 不回再 SIGKILL。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

export function createMihomoManager({ bin, configPath, dataDir, ctrlPort, logger }) {
  let child = null;
  let lastErr = '';

  const isSpawned = () => !!child && child.exitCode === null;

  /** 问控制端口要版本号；拿不到就是还没就绪 */
  function getVersion() {
    return new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: ctrlPort, path: '/version', method: 'GET', timeout: 2000 },
        (resp) => {
          let d = '';
          resp.on('data', (c) => (d += c));
          resp.on('end', () => {
            try { resolve(JSON.parse(d).version || null); } catch { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  const isRunning = async () => (await getVersion()) !== null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function start() {
    if (await isRunning()) {
      logger('info', '[mihomo] 已在运行');
      return true;
    }
    if (!child && !existsSyncSafe(bin)) throw new Error(`找不到 mihomo 内核: ${bin}`);
    if (!existsSyncSafe(configPath)) throw new Error('还没有 mihomo 配置 —— 先填订阅地址');

    mkdirSafe(dataDir);
    logger('info', '[mihomo] 启动中...');
    lastErr = '';

    child = spawn(bin, ['-d', dataDir, '-f', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const feed = (level) => (buf) => {
      for (const line of buf.toString().split('\n')) {
        const s = line.trim();
        if (!s) continue;
        if (level === 'error') lastErr = s;
        logger(level, `[mihomo] ${s}`);
      }
    };
    child.stdout.on('data', feed('info'));
    child.stderr.on('data', feed('error'));

    // 闭包里捏住这一个进程。直接读模块级 child 会串：重启时旧进程的 exit
    // 往往在新进程 spawn 之后才到，那时把 child 清成 null 会把刚起来的新进程
    // 句柄丢掉 —— 之后 stop() 就杀不掉它了。
    const self = child;
    self.on('exit', (code, signal) => {
      if (child === self) child = null;
      if (!self.__stopping) logger('error', `[mihomo] 进程退出 code=${code} signal=${signal}`);
    });

    // 首次要拉订阅，给足 30 秒
    for (let waited = 0; waited < 30_000; waited += 500) {
      if (!isSpawned()) throw new Error(`mihomo 启动即退出${lastErr ? ': ' + lastErr : '(多半是订阅拉不下来或格式不对)'}`);
      if (await isRunning()) {
        logger('ok', `[mihomo] 已启动 (PID ${self.pid})`);
        return true;
      }
      await sleep(500);
    }
    await stop();
    throw new Error(`mihomo 启动超时${lastErr ? ': ' + lastErr : ''}`);
  }

  async function stop() {
    if (!isSpawned()) {
      child = null;
      return true;
    }
    const proc = child;
    proc.__stopping = true;
    proc.kill('SIGTERM');

    for (let waited = 0; waited < 5000; waited += 200) {
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      await sleep(200);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      logger('warn', '[mihomo] SIGTERM 没反应,改用 SIGKILL');
      proc.kill('SIGKILL');
      await sleep(300);
    }
    child = null;
    logger('ok', '[mihomo] 已停止');
    return true;
  }

  async function restart() {
    await stop();
    await sleep(300);
    return start();
  }

  // 端口是由 proxy service 封装管理的实现细节，但状态/日志层仍需要
  // 展示控制端口。用 getter 暴露只读值，避免调用方修改后与实际监听端口不一致。
  return {
    start,
    stop,
    restart,
    isRunning,
    getVersion,
    isSpawned,
    get ctrlPort() { return ctrlPort; },
  };
}

// 轻量 fs 辅助（避免顶部 import 一堆）
import { existsSync, mkdirSync } from 'node:fs';
function existsSyncSafe(p) { try { return existsSync(p); } catch { return false; } }
function mkdirSafe(p) { try { mkdirSync(p, { recursive: true }); } catch {} }
