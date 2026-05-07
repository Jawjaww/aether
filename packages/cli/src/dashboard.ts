// packages/cli/src/dashboard.ts
//
// TUI Dashboard — real-time monitoring of the Aether daemon
// Displays: status, gateway metrics, queue, indexed files, recent logs
//
// Layout (pure ANSI terminal, zero dependencies):
//
//   ┌─ AETHER DASHBOARD ── project: /path ── 12:34:56 ─────────────────────┐
//   │  Daemon  🟢 PID 12345   Gateway  http://127.0.0.1:8080               │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │  REQUESTS         LATENCY         TOKENS FILTERED    INDEXED FILES   │
//   │  142 total        38 ms avg       84 % saved         312 files       │
//   │  12 /min          12 ms p50                          1.2 MB total    │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │  QUEUE                            RECENT LOGS                        │
//   │  3 pending     0 errors           [12:34:55] req POST /v1/chat...    │
//   │  last req: 2s                     [12:34:53] context filter 84%      │
//   └──────────────────────────────────────────────────────────────────────┘
//   q = quit      r = reset stats   l = view full logs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { status, getLogPath } from "./daemon-manager.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GatewayStats {
  requests_total: number;
  requests_per_min: number;
  latency_avg_ms: number;
  latency_p50_ms: number;
  tokens_saved_pct: number;
  tokens_removed_total?: number;
  tokens_injected_total?: number;
  queue_pending: number;
  queue_errors: number;
  queue_last_sec: number;
  files_indexed: number;
  index_size_bytes: number;
  uptime_sec: number;
}

interface DashboardState {
  stats: GatewayStats | null;
  logs: string[];
  fetchErr: string | null;
  lastTick: Date;
  gatewayHealth?: {
    status?: string;
    project?: string;
    socket?: string;
    daemon?: boolean;
  } | null;
}

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const A = {
  clear: "\x1b[2J\x1b[H",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgDark: "\x1b[48;5;234m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

function col(text: string, ...codes: string[]) {
  return codes.join("") + text + A.reset;
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  const spaces = " ".repeat(Math.max(0, n - str.length));
  return right ? spaces + str : str + spaces;
}

function bar(value: number, max: number, width = 12): string {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  const empty = width - filled;
  return col("█".repeat(filled), A.green) + col("░".repeat(empty), A.dim);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 ** 2).toFixed(2)} MB`;
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Fetch stats depuis /aether/stats ─────────────────────────────────────────

function fetchStats(port: number): Promise<GatewayStats> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/aether/stats`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(data) as GatewayStats);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Invalid JSON from /aether/stats"));
        }
      });
    });
    req.setTimeout(1500, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

// ─── Lecture des N dernières lignes du log ────────────────────────────────────

function tailLog(logPath: string, n = 8): string[] {
  try {
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

type Health = {
  status?: string;
  project?: string;
  socket?: string;
  daemon?: boolean;
};

function fetchHealth(port: number): Promise<Health | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === "object") resolve(parsed as Health);
          else resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

// ─── Rendu du dashboard ───────────────────────────────────────────────────────

// Helpers extracted to reduce cognitive complexity and improve clarity
function getLatencyColor(latMs: number): string {
  if (latMs < 100) return A.green;
  if (latMs < 300) return A.yellow;
  return A.red;
}

function renderMetrics(stats: GatewayStats, W: number, separator: string) {
  const tokenPct = stats.tokens_saved_pct ?? 0;
  const tokenBar = bar(tokenPct, 100, 10);
  const tokensRemoved = stats.tokens_removed_total ?? 0;
  const tokensInjected = stats.tokens_injected_total ?? 0;
  const latAvg = stats.latency_avg_ms ?? 0;
  const latColor = getLatencyColor(latAvg);
  const requestsTotal = stats.requests_total ?? 0;
  const requestsPerMin = stats.requests_per_min ?? 0;
  const p50 = stats.latency_p50_ms ?? 0;
  const filesIndexed = stats.files_indexed ?? 0;
  const indexSize = stats.index_size_bytes ?? 0;

  console.log(
    "  " +
      col(pad("REQUESTS", 18), A.bold) +
      col(pad("LATENCY", 18), A.bold) +
      col(pad("TOKENS FILTERED", 18), A.bold) +
      col("INDEXED FILES", A.bold),
  );

  console.log(
    "  " +
      col(pad(`${requestsTotal} total`, 18), A.white) +
      col(pad(`${latAvg} ms avg`, 18), latColor) +
      tokenBar +
      " " +
      col(tokenPct + "%", A.cyan) +
      " " +
      col(`-${tokensRemoved.toLocaleString()}`, A.green) +
      " " +
      col(`+${tokensInjected.toLocaleString()}`, A.yellow) +
      " " +
      col(filesIndexed + " files", A.white),
  );

  console.log(
    "  " +
      col(pad(`${requestsPerMin} /min`, 18), A.dim) +
      col(pad(`${p50} ms p50`, 18), A.dim) +
      pad("saved vs raw", 20) +
      col(fmtBytes(indexSize), A.dim),
  );

  console.log(separator);

  // Queue + uptime
  const queueColor = stats.queue_pending > 0 ? A.yellow : A.green;
  const errorColor = stats.queue_errors > 0 ? A.red : A.dim;
  const uptimeLabel = col(`⏱ uptime ${fmtUptime(stats.uptime_sec)}`, A.dim);

  console.log(
    "  " +
      col("QUEUE  ", A.bold) +
      col(`${stats.queue_pending} pending`, queueColor) +
      "  " +
      col(`${stats.queue_errors} errors`, errorColor) +
      "  " +
      col(`last req: ${stats.queue_last_sec}s`, A.dim) +
      "   " +
      uptimeLabel,
  );

  console.log(separator);
}

function renderLogs(logs: string[], W: number) {
  console.log(col("  RECENT LOGS", A.bold));
  if (logs.length === 0) {
    console.log(col("  (no logs available)", A.dim));
    return;
  }

  for (const line of logs) {
    const colored = line
      .replaceAll(/\bERROR\b/g, col("ERROR", A.red, A.bold))
      .replaceAll(/\bWARN\b/g, col("WARN", A.yellow))
      .replaceAll(/\bINFO\b/g, col("INFO", A.cyan))
      .replaceAll(/\bDEBUG\b/g, col("DEBUG", A.dim));
    console.log("  " + col(colored.slice(0, W - 4), A.dim));
  }
}

function render(projectRoot: string, state: DashboardState, port: number) {
  const { stats, logs, fetchErr, lastTick, gatewayHealth } = state;
  const { alive, pid } = status(projectRoot);
  const daemonAlive = alive || Boolean(gatewayHealth?.daemon);
  const W = Math.min(process.stdout.columns || 80, 100);
  const separator = col("─".repeat(W), A.dim);
  const now = lastTick.toLocaleTimeString("fr-FR");
  const projectName = path.basename(projectRoot);

  process.stdout.write(A.clear);
  process.stdout.write(A.hideCursor);

  // ── Header ──────────────────────────────────────────────────────────────────
  const title = col(" ⬡ AETHER DASHBOARD ", A.bold, A.cyan);
  const projLabel = col(` ${projectName} `, A.dim);
  const timeLabel = col(` ${now} `, A.dim);
  console.log(title + projLabel + timeLabel);
  console.log(separator);

  // ── Status daemon + gateway ──────────────────────────────────────────────────
  const daemonStatus = daemonAlive
    ? col(`🟢 PID ${pid ?? "?"}`, A.green)
    : col("🔴 inactive", A.red);
  const gatewayStatus = gatewayHealth
    ? col(`http://127.0.0.1:${port}  ✓`, A.green)
    : col(`⚠ ${fetchErr ?? "unreachable"}`, A.yellow);

  console.log(
    `  ${col("Daemon", A.bold)}  ${daemonStatus}` +
      `   ${col("Gateway", A.bold)}  ${gatewayStatus}`,
  );
  console.log(separator);

  if (stats) {
    renderMetrics(stats, W, separator);
  } else {
    console.log(col("\n  Waiting for metrics…\n", A.dim));
  }

  // Logs
  renderLogs(logs, W);

  console.log(separator);
  console.log(
    col("  q", A.bold) +
      " quit      " +
      col("r", A.bold) +
      " reset stats   " +
      col("l", A.bold) +
      " full logs",
  );
}

// ─── Export principal ─────────────────────────────────────────────────────────

export async function runDashboard(
  projectRoot: string,
  port: number = 8080,
  refreshMs: number = 2000,
): Promise<void> {
  const logPath = getLogPath(projectRoot);

  const state: DashboardState = {
    stats: null,
    logs: [],
    fetchErr: null,
    lastTick: new Date(),
  };

  // ── Rendu initial ────────────────────────────────────────────────────────────
  const tick = async () => {
    state.lastTick = new Date();

    // Gateway stats
    try {
      state.stats = await fetchStats(port);
      state.fetchErr = null;
    } catch (err: any) {
      state.stats = null;
      state.fetchErr = err?.message ?? "connection refused";
    }

    // Health endpoint (gateway)
    // `fetchHealth` never rejects (resolves `null` on error), so no try/catch needed.
    state.gatewayHealth = await fetchHealth(port);

    // Recent logs
    if (logPath) {
      state.logs = tailLog(logPath, 8);
    }

    render(projectRoot, state, port);
  };

  await tick();
  const interval = setInterval(tick, refreshMs);

  // ── Input clavier ────────────────────────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", async (key: string) => {
      // Ctrl+C ou q
      if (key === "\u0003" || key === "q") {
        cleanup(interval);
      }

      // r = reset stats (appel API)
      if (key === "r") {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = http.request(
              {
                hostname: "127.0.0.1",
                port,
                path: "/aether/stats/reset",
                method: "POST",
              },
              (res) => {
                res.resume();
                resolve();
              },
            );
            req.on("error", reject);
            req.end();
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          state.fetchErr = `Reset stats failed: ${msg}`;
        }
        await tick();
      }

      // l = show full logs in pager
      if (key === "l" && logPath) {
        cleanup(interval, false);
        const { spawnSync } = await import("node:child_process");
        spawnSync("less", ["+G", logPath], { stdio: "inherit" });
        // Relaunch dashboard after pager
        await runDashboard(projectRoot, port, refreshMs);
      }
    });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  const cleanup = (iv: ReturnType<typeof setInterval>, exit = true) => {
    clearInterval(iv);
    process.stdout.write(A.showCursor);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    if (exit) process.exit(0);
  };

  process.on("SIGINT", () => cleanup(interval));
  process.on("SIGTERM", () => cleanup(interval));
}
