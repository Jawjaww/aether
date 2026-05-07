#!/usr/bin/env node
// packages/cli/src/cli.ts
//
// Single entry point for the Aether CLI.
// Usage:
//   aether start     [projectRoot]   — Starts the daemon + gateway
//   aether stop      [projectRoot]   — Graceful shutdown
//   aether status    [projectRoot]   — Checks the status
//   aether logs      [projectRoot] [n] — Real-time tail of daemon.log
//   aether restart   [projectRoot]   — stop + start
//   aether dashboard [projectRoot]   — Launches the TUI dashboard
//   aether help                      — Displays help
//

import { runDashboard } from "./dashboard.js";
import { runStart } from "./start.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { stop, status, getLogPath } from "./daemon-manager.js";

// ─── Argument Parsing ─────────────────────────────────────────────────────────

const [, , command = "help", rawRoot] = process.argv;
const projectRoot = rawRoot ? path.resolve(rawRoot) : process.cwd();

if (!fs.existsSync(projectRoot)) {
  console.error(`❌ Directory not found: ${projectRoot}`);
  process.exit(1);
}

// ─── Router ───────────────────────────────────────────────────────────────────

switch (command) {
  case "start": {
    await runStart({
      projectPath: projectRoot,
      port: 8080,
      ollamaUrl: "http://127.0.0.1:11434",
    });
    break;
  }

  case "stop": {
    stop(projectRoot);
    break;
  }

  case "restart": {
    stop(projectRoot);
    await new Promise((r) => setTimeout(r, 800));
    await runStart({
      projectPath: projectRoot,
      port: 8080,
      ollamaUrl: "http://127.0.0.1:11434",
    });
    break;
  }

  case "status": {
    const { alive, pid } = status(projectRoot);
    if (alive) {
      console.log(`🟢 Daemon active   (PID: ${pid})`);
      console.log(`   Project : ${projectRoot}`);
    } else {
      console.log("⚪ Daemon inactive");
    }
    break;
  }

  case "logs": {
    const logPath = getLogPath(projectRoot);
    if (!logPath) {
      console.log(
        "⚪ No log file found. Has the daemon been started previously?",
      );
      process.exit(0);
    }

    const lines = process.argv[4] ?? "50";
    console.log(
      `📋 Logs from ${logPath} (last ${lines} lines, Ctrl+C to quit)\n`,
    );

    const tail = spawnSync("tail", [`-n`, lines, `-f`, logPath], {
      stdio: "inherit",
    });
    if (tail.error) {
      const content = fs.readFileSync(logPath, "utf8");
      const allLines = content.split("\n");
      const from = Math.max(0, allLines.length - Number.parseInt(lines, 10));
      console.log(allLines.slice(from).join("\n"));
    }
    break;
  }

  case "dashboard": {
    await runDashboard(projectRoot);
    break;
  }

  case "help":
  default: {
    console.log(`
  ╔═══════════════════════════════════════════════╗
  ║          Aether — Context Daemon CLI          ║
  ╚═══════════════════════════════════════════════╝

  Usage: aether <command> [projectRoot]

  Commands:
    start       [root]     Starts daemon + gateway (port 8080)
    stop        [root]     Graceful shutdown via SIGTERM
    restart     [root]     stop + start
    status      [root]     Check if daemon is active
    logs        [root] [n] Tail daemon.log (default: 50 lines)
    dashboard   [root]     Launch the TUI dashboard

  [root] is optional — default: current directory

  Examples:
    aether start
    aether start ~/projects/my-app
    aether dashboard .
    aether logs . 100
    aether status
    aether stop
`);
    break;
  }
}
