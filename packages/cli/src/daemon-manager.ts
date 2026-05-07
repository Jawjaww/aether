// packages/cli/src/daemon-manager.ts

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ─── ESM compatible __dirname ─────────────────────────────────────────────────
// "type":"module" in package.json removes __dirname. Idiomatic replacement.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Project paths ────────────────────────────────────────────────────────────

const AETHER_DIR = path.join(os.homedir(), ".aether", "projects");
const LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB — rotation threshold

const hashProject = (root: string): string =>
  createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);

interface ProjectPaths {
  dir: string;
  pid: string;
  log: string;
  prev: string; // daemon.log.prev — rotated log kept for 1 cycle
  sock: string;
}

const getPaths = (projectRoot: string): ProjectPaths => {
  const hash = hashProject(projectRoot);
  const dir = path.join(AETHER_DIR, hash);
  return {
    dir,
    pid: path.join(dir, "daemon.pid"),
    log: path.join(dir, "daemon.log"),
    prev: path.join(dir, "daemon.log.prev"),
    sock: path.join(dir, "aether.sock"),
  };
};

// ─── Log rotation ─────────────────────────────────────────────────────────────
// Called once before each daemon start.
// If daemon.log > 50 MB: rename → daemon.log.prev, new empty file.
// No infinite rotation — .prev is always overwritten: hard cap at 100 MB total.

const rotateLogIfNeeded = (paths: ProjectPaths): void => {
  if (!fs.existsSync(paths.log)) return;
  try {
    const { size } = fs.statSync(paths.log);
    if (size >= LOG_MAX_BYTES) {
      if (fs.existsSync(paths.prev)) fs.unlinkSync(paths.prev);
      fs.renameSync(paths.log, paths.prev);
      // daemon.log will be recreated by fs.openSync with flag "a" right after
    }
  } catch {
    // Non-fatal stat/rename error — leave file as is
  }
};

const getPidCommand = (pid: number): string | null => {
  try {
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return (ps.stdout || "").trim();
  } catch {
    return null;
  }
};

const sendSignal = (
  pid: number,
  signal: NodeJS.Signals,
): { ok: boolean; missing: boolean } => {
  try {
    process.kill(pid, signal);
    return { ok: true, missing: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: false, missing: true };
    console.error(`❌ Failed ${signal} PID ${pid}: ${(err as Error).message}`);
    return { ok: false, missing: false };
  }
};

const forceKillIfAlive = (pid: number): void => {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
    console.log(`🔪 SIGKILL sent to PID ${pid}`);
  } catch {
    // ignore
  }
};

// ─── Port / Process utilities ─────────────────────────────────────────────────
const getPidsListeningOnPort = (port: number): number[] => {
  try {
    const res = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    const out = (res.stdout || "").trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
};

export const killProcessesOnPort = (port: number, force = false): void => {
  const pids = getPidsListeningOnPort(port);
  if (pids.length === 0) return;

  console.log(`⚠ Processes listening on port ${port}: ${pids.join(", ")}`);

  for (const pid of pids) {
    const cmd = getPidCommand(pid);
    const likelyGateway = cmd ? /gateway\/dist\/server\.js|aether|gateway/i.test(cmd) : false;

    if (cmd && !likelyGateway && !force) {
      console.log(
        `  PID ${pid} command="${cmd}" — ignored (not identified as gateway)`,
      );
      continue;
    }

    if (cmd && !likelyGateway && force) {
      console.log(
        `  PID ${pid} command="${cmd}" — not identified, forced by 'force' option`,
      );
    }

    const termResult = sendSignal(pid, "SIGTERM");
    if (!termResult.ok) {
      if (termResult.missing) {
        console.log(`⚪ PID ${pid} not found`);
      }
      continue;
    }

    console.log(
      `🛑 SIGTERM sent to PID ${pid} — attempting graceful shutdown`,
    );

    forceKillIfAlive(pid);
  }
};

// ─── status ───────────────────────────────────────────────────────────────────
// Returns true if the PID process is alive.
// Automatically cleans up stale files if the PID is dead.

export const status = (
  projectRoot: string,
): { alive: boolean; pid: number | null } => {
  const paths = getPaths(projectRoot);
  if (!fs.existsSync(paths.pid)) return { alive: false, pid: null };

  const pid = Number.parseInt(fs.readFileSync(paths.pid, "utf8").trim(), 10);
  if (Number.isNaN(pid)) return { alive: false, pid: null };

  try {
    process.kill(pid, 0); // Signal 0 = probe without killing
    return { alive: true, pid };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // PID non-existent → automatic cleanup of stale files
      for (const p of [paths.pid, paths.sock]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    // EPERM = PID exists but belongs to another user (rare, non-fatal)
    return { alive: false, pid: null };
  }
};

// ─── start ────────────────────────────────────────────────────────────────────

export const start = (projectRoot: string): void => {
  const { alive, pid } = status(projectRoot);
  if (alive) {
    console.log(`🟢 Daemon already active (PID: ${pid})`);
    return;
  }

  const paths = getPaths(projectRoot);
  fs.mkdirSync(paths.dir, { recursive: true });

  rotateLogIfNeeded(paths);

  // Absolute path to compiled daemon entry point
  // __dirname = packages/cli/dist → ../../core/dist/daemon.js
  const daemonEntry = path.resolve(__dirname, "../../core/dist/daemon.js");
  if (!fs.existsSync(daemonEntry)) {
    console.error(`❌ Daemon not found: ${daemonEntry}`);
    console.error(
      "   Run this first: npm run build --workspace=packages/core",
    );
    process.exit(1);
  }

  // fd opened in "a" (append) — never blocks OS buffer
  const logFd = fs.openSync(paths.log, "a");

  const child = spawn(
    process.execPath,
    [daemonEntry, path.resolve(projectRoot)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd], // stdin cut, stdout+stderr → log
    },
  );

  // fs.closeSync after spawn: fd is inherited by child, parent no longer needs it
  fs.closeSync(logFd);

  if (!child.pid) {
    console.error("❌ Failed to start daemon (child.pid undefined)");
    process.exit(1);
  }

  fs.writeFileSync(paths.pid, child.pid.toString(), "utf8");
  child.unref(); // CLI event loop can finish without waiting for child

  console.log(`🚀 Aether daemon started (PID: ${child.pid})`);
  console.log(`   Project : ${path.resolve(projectRoot)}`);
  console.log(`   Logs    : ${paths.log}`);
  console.log(`   Socket  : ${paths.sock}`);
};

// ─── stop ─────────────────────────────────────────────────────────────────────

export const stop = (projectRoot: string): void => {
  const paths = getPaths(projectRoot);

  // If some process is holding the common gateway port, try to stop it too.
  try {
    killProcessesOnPort(8080, true);
    killProcessesOnPort(8081, true);
  } catch {
    // best-effort — ignore failures
  }

  // helper: kill a PID and log
  const tryKill = (pid: number, label: string) => {
    try {
      process.kill(pid, "SIGTERM");
      console.log(
        `🛑 SIGTERM sent to ${label} (PID: ${pid}) — graceful shutdown in progress`,
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        console.log(`⚪ ${label} PID ${pid} not found`);
      } else {
        console.error(
          `❌ Failed to kill ${label} SIGTERM: ${(err as Error).message}`,
        );
      }
    }
  };

  // stop a process described by a pid file
  const stopByPidFile = (pidPath: string, label: string) => {
    if (!fs.existsSync(pidPath)) return;
    try {
      const raw = fs.readFileSync(pidPath, "utf8").trim();
      const p = Number.parseInt(raw, 10);
      if (!Number.isNaN(p)) tryKill(p, label);
    } catch {
      // ignore read errors
    } finally {
      try {
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
      } catch {}
    }
  };

  // 1) Stop the gateway if present
  stopByPidFile(path.join(paths.dir, "gateway.pid"), "gateway");

  // 2) Stop the daemon (as before)
  const { alive, pid } = status(projectRoot);

  if (!alive || pid === null) {
    console.log("⚪ No active daemon for this project");
    return;
  }

  tryKill(pid, "daemon");

  // Clean PID file — daemon handles .sock via its SIGTERM handler
  if (fs.existsSync(paths.pid)) fs.unlinkSync(paths.pid);
};

// ─── logs ─────────────────────────────────────────────────────────────────────
// Returns the path to the current log — the caller (cli.ts) can tail -f or read N lines.

export const getLogPath = (projectRoot: string): string | null => {
  const paths = getPaths(projectRoot);
  return fs.existsSync(paths.log) ? paths.log : null;
};
