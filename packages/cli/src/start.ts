// packages/cli/src/start.ts

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import net from "node:net";
import {
  start as startDaemon,
  status,
  killProcessesOnPort,
} from "./daemon-manager.js";

export interface StartOptions {
  projectPath: string;
  port: number;
  ollamaUrl: string;
  timeout?: number;
}

const hashProject = (root: string) =>
  createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);

const getPaths = (projectRoot: string) => {
  const dir = path.join(
    os.homedir(),
    ".aether",
    "projects",
    hashProject(projectRoot),
  );
  fs.mkdirSync(dir, { recursive: true });
  return {
    pid: path.join(dir, "daemon.pid"),
    log: path.join(dir, "daemon.log"),
    dir,
  };
};

function waitForGateway(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.setTimeout(600, () => {
        req.destroy();
        setTimeout(check, 400);
      });
      req.on("error", () => setTimeout(check, 400));
    };
    check();
  });
}

export async function runStart(opts: StartOptions): Promise<void> {
  const {
    projectPath,
    port = 8080,
    ollamaUrl = "http://127.0.0.1:11434",
    timeout = 8000,
  } = opts;

  const { alive, pid } = status(projectPath);
  if (alive) {
    console.log(`\n  🟢 Daemon already active (PID: ${pid})`);
    console.log(`     Project   →  ${projectPath}`);
  }

  const cliDist = path.dirname(new URL(import.meta.url).pathname);
  const monoRoot = path.resolve(cliDist, "../../../");
  const gatewayScript = path.join(monoRoot, "packages/gateway/dist/server.js");

  if (!fs.existsSync(gatewayScript)) {
    console.error(`\n  ❌ Gateway script not found: ${gatewayScript}`);
    console.error(
      `     Run this first: npm run build --workspace=packages/gateway\n`,
    );
    process.exit(1);
  }
  // Check if port is already in use
  const portInUse = await new Promise<boolean>((resolve) => {
    const s = new net.Socket();
    let resolved = false;
    s.setTimeout(300);
    s.once("connect", () => {
      resolved = true;
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      if (!resolved) {
        resolved = true;
        s.destroy();
        resolve(false);
      }
    });
    s.once("error", () => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
    s.connect(port, "127.0.0.1");
  });

  if (portInUse) {
    console.warn(
      `\n  ⚠ Port ${port} is already in use — attempting to stop the current process...`,
    );
    try {
      // Forcefully try to free the port (best-effort)
      killProcessesOnPort(port, true);
    } catch (e) {
      console.warn(
        `     Automatic stop attempt failed: ${(e as Error).message}`,
      );
      console.warn(
        `     To force stop manually: lsof -ti :${port} | xargs kill -9`,
      );
      return;
    }

    // Re-check port
    const stillInUse = await new Promise<boolean>((resolve) => {
      const s = new net.Socket();
      let resolved = false;
      s.setTimeout(300);
      s.once("connect", () => {
        resolved = true;
        s.destroy();
        resolve(true);
      });
      s.once("timeout", () => {
        if (!resolved) {
          resolved = true;
          s.destroy();
          resolve(false);
        }
      });
      s.once("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
      s.connect(port, "127.0.0.1");
    });

    if (stillInUse) {
      console.warn(
        `     Port ${port} is still occupied after stop attempt.`,
      );
      console.warn(
        `     To force stop manually: lsof -ti :${port} | xargs kill -9`,
      );
      return;
    }
  }

  const paths = getPaths(projectPath);
  const logFd = fs.openSync(paths.log, "a");

  const child = spawn(process.execPath, [gatewayScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AETHER_PROJECT: projectPath,
      AETHER_PORT: String(port),
      OLLAMA_URL: ollamaUrl,
    },
    cwd: projectPath,
  });

  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    console.error(
      "\n  ❌ Failed to start the gateway (child.pid undefined)\n",
    );
    process.exit(1);
  }
  const gatewayPidPath = path.join(paths.dir, "gateway.pid");

  console.log(`\n  ⚡ Starting gateway (PID: ${child.pid})`);
  console.log(`     Project   →  ${projectPath}`);
  console.log(`     Gateway   →  http://127.0.0.1:${port}/v1`);
  console.log(`     Ollama    →  ${ollamaUrl}`);
  console.log(`\n  ⏳ Waiting for the gateway to respond…`);

  const ok = await waitForGateway(port, timeout);
  if (ok) {
    try {
      fs.writeFileSync(gatewayPidPath, child.pid.toString(), "utf8");
    } catch (e) {
      console.warn(
        `\n  ⚠ Failed to write gateway PID: ${(e as Error).message}`,
      );
    }

    console.log(`\n  ✅ Gateway ready!`);
    console.log(`\n  ─── Dashboard ────────────────────────────────────────`);
    console.log(`     URL       →  http://127.0.0.1:${port}/`);
    console.log(`\n  ─── Useful Commands ──────────────────────────────────`);
    console.log(`     aether dashboard .   — TUI monitoring`);
    console.log(`     aether logs .        — real-time logs`);
    console.log(`     aether status .      — check status`);
    console.log(`     aether stop .        — stop services\n`);

    // Auto-open browser on macOS
    if (process.platform === 'darwin') {
      import('node:child_process').then(({ exec }) => {
        exec(`open http://127.0.0.1:${port}/`);
      });
    }
  } else {
    console.warn(`\n  ⚠  Gateway unavailable after ${timeout / 1000}s`);
    console.warn(`     → run 'aether logs .' to diagnose\n`);
    try {
      process.kill(child.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      try {
        process.kill(child.pid, 0);
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    } catch {
      // ignore
    }
  }
}
