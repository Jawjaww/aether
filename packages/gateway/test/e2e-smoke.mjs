#!/usr/bin/env node
// packages/gateway/test/e2e-smoke.mjs
//
// Test de bout en bout du VRAI processus gateway, avec :
//   - un faux daemon Aether (socket Unix) qui rend un contexte balisé,
//   - un faux oMLX (HTTP) qui capture le payload réellement transmis.
//
// Il vérifie les invariants P0 de l'audit d'octobre 2026 dans des conditions
// réelles (pas des tests unitaires) :
//   P0-1  les outils sont transmis au modèle, y compris sans verbe d'action
//   P0-2  le message système reste constant et ne contient pas le contexte volatil
//   P0-3  aucune régression de forme
//   P1-7  max_tokens n'est pas imposé, le modèle n'est pas remplacé
//   P0-6  un daemon qui ne répond pas ne bloque pas la requête indéfiniment
//
// Usage : npm run test:e2e   (nécessite `npm run build` au préalable)

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const GATEWAY = path.join(ROOT, "packages/gateway/dist/server.js");

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitForHealth = async (port, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(150);
  }
  return false;
};

// ─── Faux oMLX : capture le payload, répond en SSE ───────────────────────────

const received = [];
let upstream;
const startUpstream = async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push(null);
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "stub",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "stub",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  return upstream.address().port;
};

// ─── Faux daemon Aether (socket Unix) ────────────────────────────────────────

const CONTEXT = {
  tokenCount: 42,
  confidence: 0.8,
  sections: {
    astContext: "<ast_context>\n// AST-E2E-MARKER\n</ast_context>",
    ragContext: "<rag_context>\n// RAG-E2E-MARKER\n</rag_context>",
  },
  meta: {
    astFiles: ["exemple.ts"],
    reasoning: "no_think",
    budgetUsed: { ast: 21, rag: 21, history: 0 },
  },
};

let daemonDelayMs = 0;
let daemonRequests = 0;
let daemon;
const startFakeDaemon = async (sockPath) => {
  daemon = net.createServer((socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        daemonRequests++;
        if (daemonDelayMs > 0) await sleep(daemonDelayMs);
        socket.write(
          JSON.stringify({
            id: msg.id,
            type: "context:response",
            ts: Date.now(),
            payload: CONTEXT,
          }) + "\n",
        );
      }
    });
  });
  await new Promise((r) => daemon.listen(sockPath, r));
};

// ─── Scénario ────────────────────────────────────────────────────────────────

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "lit un fichier" } },
  { type: "function", function: { name: "apply_patch", description: "écrit un patch" } },
  { type: "function", function: { name: "grep", description: "cherche" } },
];

const main = async () => {
  if (!fs.existsSync(GATEWAY)) {
    console.error(`✖ ${GATEWAY} absent — lancez « npm run build » d'abord.`);
    process.exit(2);
  }

  // HOME isolé : le daemon, les logs et la config restent hors du vrai ~.
  // Chemin court obligatoire : sun_path est limité à ~104 caractères sur macOS.
  const HOME = fs.mkdtempSync("/tmp/aether-e2e-");
  const PROJECT = path.join(HOME, "projet");
  fs.mkdirSync(PROJECT, { recursive: true });

  const hash = createHash("sha256").update(path.resolve(PROJECT)).digest("hex").slice(0, 8);
  const socketDir = path.join(HOME, ".aether", "projects", hash);
  fs.mkdirSync(socketDir, { recursive: true });
  const sockPath = path.join(socketDir, "aether.sock");

  const upstreamPort = await startUpstream();
  await startFakeDaemon(sockPath);
  const gwPort = await freePort();
  const CONTEXT_TIMEOUT_MS = 1500;

  const gw = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      HOME,
      OLLAMA_URL: `http://127.0.0.1:${upstreamPort}`,
      AETHER_PORT: String(gwPort),
      AETHER_PROJECT: PROJECT,
      AETHER_CONTEXT_TIMEOUT_MS: String(CONTEXT_TIMEOUT_MS),
      TOKEN_BUDGET: "4096",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gwLog = [];
  gw.stdout.on("data", (d) => gwLog.push(d.toString()));
  gw.stderr.on("data", (d) => gwLog.push(d.toString()));

  const call = async (question) => {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mon-modele-e2e",
        stream: true,
        messages: [
          { role: "system", content: "prompt système du harnais" },
          { role: "user", content: question },
        ],
        tools: TOOLS,
      }),
    });
    await res.text();
    return { status: res.status, ms: Date.now() - t0 };
  };

  try {
    const healthy = await waitForHealth(gwPort);
    check("la gateway démarre et répond sur /health", healthy);
    if (!healthy) throw new Error("gateway indisponible");

    const r1 = await call("explique ce module");
    await sleep(200);
    const r2 = await call("explique cette autre partie");

    check("requête 1 : HTTP 200", r1.status === 200, `status=${r1.status}`);
    check("requête 2 : HTTP 200", r2.status === 200, `status=${r2.status}`);
    check("le daemon a bien été interrogé", daemonRequests >= 2, `daemonRequests=${daemonRequests}`);
    check("le faux oMLX a reçu 2 payloads", received.length === 2, `reçus=${received.length}`);

    const [p1, p2] = received;
    check("payload 1 parsable", !!p1);
    check("payload 2 parsable", !!p2);

    if (p1 && p2) {
      // P0-1 — les outils survivent à une tâche sans verbe d'action
      check(
        "P0-1 les 3 outils sont transmis (tâche sans verbe d'action)",
        Array.isArray(p1.tools) && p1.tools.length === 3,
        `tools=${Array.isArray(p1.tools) ? p1.tools.length : "absent"}`,
      );
      check(
        "P0-1 les outils sont inchangés",
        JSON.stringify(p1.tools) === JSON.stringify(TOOLS),
      );

      const sys1 = p1.messages.find((m) => m.role === "system");
      const sys2 = p2.messages.find((m) => m.role === "system");

      // P0-2 — message système constant, sans contexte volatil
      check(
        "P0-2 le message système est constant entre deux tours",
        sys1 && sys2 && sys1.content === sys2.content,
      );
      check(
        "P0-2 le message système ne contient pas le contexte volatil",
        sys1 && !String(sys1.content).includes("AST-E2E-MARKER"),
      );

      // P0-2 — le contexte est en queue, juste avant la question
      const last1 = p1.messages[p1.messages.length - 1];
      const lastText = String(last1?.content ?? "");
      check("P0-2 le contexte est dans le dernier message", lastText.includes("AST-E2E-MARKER"));
      check("P0-2 la question est préservée", lastText.includes("explique ce module"));
      check(
        "P0-2 le contexte précède la question",
        lastText.indexOf("AST-E2E-MARKER") < lastText.indexOf("explique ce module"),
      );
      check(
        "P0-2 le préfixe stable est identique entre les deux tours",
        JSON.stringify(p1.messages.slice(0, -1)) === JSON.stringify(p2.messages.slice(0, -1)),
      );

      // P1-7 — pas de réglages imposés
      check("P1-7 le modèle demandé n'est pas remplacé", p1.model === "mon-modele-e2e", `model=${p1.model}`);
      check("P1-7 max_tokens n'est pas imposé", !("max_tokens" in p1));
      check("la température par défaut est appliquée", p1.temperature === 0.1);
    }

    // P0-6 — un daemon muet ne bloque pas la requête indéfiniment
    daemonDelayMs = 10000;
    const slow = await call("explique encore autre chose");
    check(
      `P0-6 un daemon muet ne bloque pas (budget ${CONTEXT_TIMEOUT_MS} ms)`,
      slow.status === 200 && slow.ms < CONTEXT_TIMEOUT_MS + 2500,
      `latence=${slow.ms} ms`,
    );
    daemonDelayMs = 0;
  } finally {
    gw.kill("SIGKILL");
    upstream?.close();
    daemon?.close();
    try {
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch {}
  }

  console.log("");
  if (failures > 0) {
    console.error(`✖ ${failures} vérification(s) en échec`);
    console.error(gwLog.join("").slice(-2000));
    process.exit(1);
  }
  console.log("✔ Toutes les vérifications de bout en bout passent");
};

main().catch((err) => {
  console.error("✖ E2E en échec :", err);
  process.exit(1);
});
