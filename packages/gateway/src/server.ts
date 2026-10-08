// packages/gateway/src/server.ts
//
// Aether Gateway — OpenAI-compatible proxy between IDE and local LLM.
// The IDE points to http://127.0.0.1:8080/v1
// Aether intercepts, filters context, injects AST/RAG, and forwards to Ollama.

import Fastify from "fastify";
import { createConnection } from "node:net";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildDashboardFilePath,
  extractCursorLineFromContent,
  extractFilePathFromContent,
  streamResponseBody,
  terminateProcessGroup,
} from "./server-utils.js";
import {
  buildCleanPayload,
  shapeTools,
  type AetherContextResponse,
} from "./payload.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_PORT = Number.parseInt(process.env.AETHER_PORT ?? "8080", 10);
const PROJECT_ROOT = process.env.AETHER_PROJECT ?? process.cwd();

/**
 * Budget du contexte *volatil* injecté en queue de prompt.
 *
 * Il n'est plus de 16 384 : mesuré sur M1 Max, le préfill coûte ~3,6 ms par token
 * (58 s de TTFT à 16 k tokens). Ce bloc change à chaque tour, il est donc
 * effectivement repayé à chaque tour. 4 096 tokens ≈ 15 s de prefill au pire.
 */
const TOKEN_BUDGET = Number.parseInt(
  process.env.TOKEN_BUDGET ?? "4096",
  10,
);

// Upstream URL: env var > saved config > default MLX port
const _GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".aether", "config.json");
const _savedCfg = (() => {
  try { return JSON.parse(fs.readFileSync(_GLOBAL_CONFIG_PATH, "utf8")); } catch { return {}; }
})();
const OLLAMA_URL: string =
  process.env.OLLAMA_URL ??
  (_savedCfg.upstreamUrl as string | undefined) ??
  "http://127.0.0.1:8000"; // oMLX default port
console.log(`[Config] Upstream LLM: ${OLLAMA_URL}`);
console.log(`[Config] Contexte volatil: ${TOKEN_BUDGET} tokens max`);

let lastStats = {
  astTime: 0,
  ragTime: 0,
  ttft: 0,
  tps: 0,
  totalTokens: 0,
  totalTime: 0,
  tokensRaw: 0,
  tokensBefore: 0,
  rerankTime: 0,
};

const hashProject = (root: string): string =>
  createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);

const getSocketPath = (): string => {
  const hash = hashProject(PROJECT_ROOT);
  return path.join(os.homedir(), ".aether", "projects", hash, "aether.sock");
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForHttpReady = async (
  url: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {}

    await sleep(intervalMs);
  }

  return false;
};

const waitForSocket = async (
  sockPath: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(sockPath)) {
      // The socket file exists, but we must verify the daemon is actually listening
      // otherwise it might be an orphaned socket from a previous crash.
      const status = await requestAetherDaemonStatus();
      if (status !== null) {
        return true;
      }
    }
    await sleep(intervalMs);
  }

  return false;
};

// ─── In-memory Stats ──────────────────────────────────────────────────────────

interface Stats {
  startedAt: number;
  requestsTotal: number;
  requestsOk: number;
  requestsError: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensRemovedTotal: number;
  tokensInjectedTotal: number;
  latencySum: number;
  latencies: number[];
  toolsRemoved: number;
  aetherBypass: number;
  lastRequestAt: number;
  currentRequestStart: number | null;
  history: Array<{
    id: number;
    ts: number;
    ok: boolean;
    latencyMs: number;
    tokensRaw: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensRemoved: number;
    tokensInjected: number;
    ttft: number;
    tps: number;
    astTime: number;
    ragTime: number;
    rerankTime: number;
  }>;
}

const stats: Stats = {
  startedAt: Date.now(),
  requestsTotal: 0,
  requestsOk: 0,
  requestsError: 0,
  tokensBefore: 0,
  tokensAfter: 0,
  tokensRemovedTotal: 0,
  tokensInjectedTotal: 0,
  latencySum: 0,
  latencies: [],
  toolsRemoved: 0,
  aetherBypass: 0,
  lastRequestAt: 0,
  currentRequestStart: null,
  history: [],
};

const recordRequest = (entry: {
  ok: boolean;
  latencyMs: number;
  tokensRaw: number;
  tokensBefore: number;
  tokensAfter: number;
  toolsBefore: number;
  toolsAfter: number;
  bypass: boolean;
}) => {
  stats.requestsTotal++;
  if (entry.ok) stats.requestsOk++;
  else stats.requestsError++;

  stats.tokensBefore += entry.tokensBefore;
  stats.tokensAfter += entry.tokensAfter;
  stats.latencySum += entry.latencyMs;
  stats.latencies.push(entry.latencyMs);
  if (stats.latencies.length > 100) stats.latencies.shift();

  stats.toolsRemoved += Math.max(0, entry.toolsBefore - entry.toolsAfter);
  // removed = IDE context filtered + budget truncation
  const removed = Math.max(0, entry.tokensRaw - entry.tokensAfter);
  const injected = Math.max(0, entry.tokensAfter - entry.tokensBefore);
  stats.tokensRemovedTotal += removed;
  stats.tokensInjectedTotal += injected;
  if (entry.bypass) stats.aetherBypass++;
  stats.lastRequestAt = Date.now();

  stats.history.unshift({
    id: stats.requestsTotal,
    ts: Date.now(),
    ok: entry.ok,
    latencyMs: entry.latencyMs,
    tokensRaw: entry.tokensRaw,
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    tokensRemoved: Math.max(0, entry.tokensRaw - entry.tokensAfter),
    tokensInjected: Math.max(0, entry.tokensAfter - entry.tokensBefore),
    ttft: lastStats.ttft,
    tps: lastStats.tps,
    astTime: lastStats.astTime,
    ragTime: lastStats.ragTime,
    rerankTime: lastStats.rerankTime,
  });

  if (stats.history.length > 20) {
    stats.history.pop();
  }
};

const computeP50 = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)] ?? 0;
};

// ─── Token counting (tiktoken) ───────────────────────────────────────────────
let _tiktokenModule: any = null;
let _encoder: any = null;

const ensureTiktoken = async (): Promise<any> => {
  if (_tiktokenModule) return _tiktokenModule;
  try {
    // @ts-ignore -- optional dependency: may not be installed in dev environment
    _tiktokenModule = await import("@dqbd/tiktoken");
    return _tiktokenModule;
  } catch {
    _tiktokenModule = null;
    return null;
  }
};

/**
 * Encodeur mémorisé.
 *
 * Deux bugs corrigés ici :
 *  1. `encoding_for_model("Qwen3.6-35B-A3B-…")` **lève** (tiktoken ne connaît que
 *     les noms OpenAI) ; l'exception était avalée par le `catch` et le comptage
 *     retombait silencieusement sur l'heuristique `length / 4`. Autrement dit, le
 *     « vrai comptage tiktoken » de la Phase 2 ne servait jamais pour ce modèle.
 *  2. L'encodeur WASM était recréé puis libéré à **chaque** appel (`enc.free()`),
 *     soit ~30 allocations par requête sur 30 chunks. Il est créé une seule fois.
 *
 * Limite connue : cl100k_base n'est pas le tokenizer de Qwen (vocab 248 320). Le
 * comptage reste une approximation, mais *stable* et bornée, au lieu d'un
 * `length / 4` silencieux.
 */
const getEncoder = async (): Promise<any> => {
  if (_encoder) return _encoder;
  const mod = await ensureTiktoken();
  if (!mod) return null;
  try {
    if (typeof mod.get_encoding === "function") {
      _encoder = mod.get_encoding("cl100k_base");
    } else if (typeof mod.encoding_for_model === "function") {
      _encoder = mod.encoding_for_model("gpt-3.5-turbo");
    }
  } catch {
    _encoder = null;
  }
  return _encoder;
};

const countTokensText = async (
  text: string,
  _model?: string,
): Promise<number> => {
  const enc = await getEncoder();
  if (!enc) return Math.trunc(text.length / 4);
  try {
    return enc.encode(text).length;
  } catch {
    return Math.trunc(text.length / 4);
  }
};

const countTokensForMessages = async (
  messages: Array<{ role: string; content: unknown }>,
  model?: string,
): Promise<number> => {
  let total = 0;
  for (const m of messages) {
    let contentStr = "";
    if (typeof m.content === "string") contentStr = m.content;
    else if (Array.isArray(m.content)) contentStr = JSON.stringify(m.content);
    else contentStr = JSON.stringify(m.content ?? "");
    total += await countTokensText(`${m.role}\n${contentStr}\n`, model);
  }
  return total;
};

// ─── Aether daemon socket client ─────────────────────────────────────────────

interface AetherDaemonStatusResponse {
  filesIndexed: number;
  queuePending: number;
  graphNodes: number;
}

const getProjectIndexRoot = (): string =>
  path.join(os.homedir(), ".aether", "projects", hashProject(PROJECT_ROOT));

const getDirectorySizeBytes = (rootPath: string): number => {
  if (!fs.existsSync(rootPath)) return 0;
  return walkDirectory(rootPath);
};

const walkDirectory = (rootPath: string): number => {
  let total = 0;
  const stack = [rootPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) continue;

    const statResult = tryStat(currentPath);
    if (!statResult) continue;

    if (statResult.isSymbolicLink()) continue;
    if (statResult.isFile()) {
      total += statResult.size;
      continue;
    }
    if (!statResult.isDirectory()) continue;

    total += statResult.size;
    pushEntries(currentPath, stack);
  }

  return total;
};

const tryStat = (path: string): fs.Stats | null => {
  try {
    return fs.lstatSync(path);
  } catch {
    return null;
  }
};

const pushEntries = (dirPath: string, stack: string[]): void => {
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      stack.push(path.join(dirPath, entry.name));
    }
  } catch {
    // ignore unreadable directories
  }
};

/**
 * Budgets maximaux accordés au daemon. Le daemon ne doit JAMAIS bloquer le TTFT.
 *
 * C'était 60 s (« to cover Reranker cold-starts ») : un cold-start du reranker
 * ajoutait donc jusqu'à une minute au TTFT, dans le chemin de la requête. Le
 * reranker n'attend plus (voir daemon.ts) ; ce budget n'a plus à couvrir que la
 * récupération à chaud (embedding + rerank ≤ 1,5 s + comptage du budget).
 * Au-delà, on préfère envoyer le prompt sans contexte Aether que faire attendre.
 */
const CONTEXT_TIMEOUT_MS = Number.parseInt(
  process.env.AETHER_CONTEXT_TIMEOUT_MS ?? "3000",
  10,
);
/** La repo-map est calculée en mémoire par le daemon : réponse quasi immédiate. */
const REPO_MAP_TIMEOUT_MS = Number.parseInt(
  process.env.AETHER_REPO_MAP_TIMEOUT_MS ?? "2000",
  10,
);

interface RepoMapResponse {
  text: string;
  version: string;
  files: number;
  symbols: number;
  truncated: boolean;
}

/**
 * Interroge le daemon sur son socket Unix et attend une réponse typée.
 * Toujours borné : c'est le seul contrat qui garantit que le pré-processing
 * d'Aether ne s'ajoute pas au TTFT de façon non déterministe.
 */
const askDaemon = <T>(
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T | null> => {
  return new Promise((resolve) => {
    const sockPath = getSocketPath();
    if (!fs.existsSync(sockPath)) {
      resolve(null);
      return;
    }

    const socket = createConnection(sockPath);
    let buffer = "";
    let timer: ReturnType<typeof setTimeout>;
    let done = false;

    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    timer = setTimeout(() => {
      console.warn(`[gateway] ${requestType} non rendu en ${timeoutMs} ms — poursuite sans.`);
      finish(null);
    }, timeoutMs);

    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          id: `gw-${requestType}-${Date.now()}`,
          type: requestType,
          version: "1.0",
          ts: Date.now(),
          payload,
        }) + "\n",
      ),
    );

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === responseType) {
            finish(msg.payload as T);
            return;
          }
        } catch {
          /* chunk incomplet, on attend la suite */
        }
      }
      buffer = lines.at(-1) ?? "";
    });

    socket.on("error", () => finish(null));
  });
};

const requestAetherContext = (
  taskText: string,
  activeFilePath?: string,
  ideFiles?: string[],
  cursorLine?: number,
): Promise<AetherContextResponse | null> =>
  askDaemon<AetherContextResponse>(
    "context:request",
    "context:response",
    { taskText, activeFilePath, ideFiles, cursorLine, tokenBudget: TOKEN_BUDGET },
    CONTEXT_TIMEOUT_MS,
  );

// ─── Repo-map : bloc stable du préfixe ────────────────────────────────────────
//
// La carte des signatures ne change que si le code change. Elle est donc placée
// dans le PRÉFIXE (juste après le prompt système) : préfillée une fois, réutilisée
// ensuite par le cache de blocs d'oMLX.
//
// Elle n'est rafraîchie qu'après une période d'inactivité, jamais pendant une
// session agentique : un changement de carte au milieu de l'historique
// invaliderait tout le préfixe et rejouerait un prefill complet.

const REPO_MAP_TOKEN_BUDGET = Number.parseInt(
  process.env.AETHER_REPO_MAP_TOKENS ?? "1500",
  10,
);
const REPO_MAP_IDLE_MS = Number.parseInt(
  process.env.AETHER_REPO_MAP_IDLE_MS ?? "60000",
  10,
);

let repoMapCache: { text: string; version: string; fetchedAt: number } | null = null;
let lastForwardAt = 0;

const ensureRepoMap = async (): Promise<string | undefined> => {
  const now = Date.now();
  const idle = now - lastForwardAt > REPO_MAP_IDLE_MS;
  const stale = !repoMapCache || now - repoMapCache.fetchedAt > REPO_MAP_IDLE_MS;

  if (idle && stale) {
    const fresh = await askDaemon<RepoMapResponse>(
      "repo:map",
      "repo:map:response",
      { tokenBudget: REPO_MAP_TOKEN_BUDGET },
      REPO_MAP_TIMEOUT_MS,
    );
    if (fresh) {
      const changed = repoMapCache?.version !== fresh.version;
      repoMapCache = { text: fresh.text, version: fresh.version, fetchedAt: now };
      console.log(
        `[gateway] repo-map ${changed ? "mise à jour" : "inchangée"} : ` +
          `${fresh.files} fichiers, ${fresh.symbols} symboles, v${fresh.version}` +
          `${fresh.truncated ? " (tronquée)" : ""}`,
      );
    }
  }

  return repoMapCache?.text || undefined;
};

const requestAetherDaemonStatus = (): Promise<AetherDaemonStatusResponse | null> => {
  return new Promise((resolve) => {
    const sockPath = getSocketPath();
    if (!fs.existsSync(sockPath)) {
      resolve(null);
      return;
    }

    const socket = createConnection(sockPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 1500);

    const payload = JSON.stringify({
      id: `gw-status-${Date.now()}`,
      type: "daemon:status",
      version: "1.0",
      ts: Date.now(),
      payload: {},
    });

    socket.on("connect", () => socket.write(payload + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "daemon:status") {
            clearTimeout(timeout);
            socket.destroy();
            resolve(msg.payload as AetherDaemonStatusResponse);
            return;
          }
        } catch {
          /* incomplete chunk, wait for more */
        }
      }
      buffer = lines.at(-1) ?? "";
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
};

// ─── Text extraction helpers ──────────────────────────────────────────────────

/**
 * Flatten any content value (string or OpenAI parts array) to a plain string.
 * Strips KiloCode noise tags from the result.
 */
const KILOCODE_NOISE_TAGS = [
  /<environment_details>[\s\S]*?<\/environment_details>/gi,
  /<open_tabs>[\s\S]*?<\/open_tabs>/gi,
  /<workspace_items>[\s\S]*?<\/workspace_items>/gi,
  /<file_content[^>]*>[\s\S]*?<\/file_content>/gi,
];

const extractPureText = (content: unknown): string => {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n");
  }
  for (const re of KILOCODE_NOISE_TAGS) {
    text = text.replace(re, "");
  }
  return text.trim();
};

/**
 * Extract the last user-facing task text (≤ 500 chars) for RAG/AST querying.
 */
const extractTaskText = (
  messages: Array<{ role: string; content: unknown }>,
): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const text = extractPureText(msg.content);
    if (text) return text.slice(0, 500);
  }
  return "";
};

// ─── Context Engineering Pipeline (4 stages) ─────────────────────────────────
//
// Stage 1: CLASSIFY  — identify each system block by XML tag signatures
// Stage 2: FILTER    — drop blocks that Aether's AST/RAG covers better  
// Stage 3: COMPACT   — trim oversized blocks around what matters (cursor context)
// Stage 4: (caller)  — inject Aether AST+RAG context via injectAetherContext

type BlockType =
  | 'persona'        // 1st system msg: instructions, persona — always keep
  | 'active_file'    // <file_content> for the file currently being edited — always keep  
  | 'diagnostics'    // <diagnostics>/<errors> — always keep (LSP errors crucial)
  | 'terminal'       // <terminal> output — keep if recent/small
  | 'workspace_tree' // <workspace_items>/<tree> — drop (AST does this better)
  | 'other_file'     // <file_content> for other files — drop (RAG does this better)
  | 'environment'    // <environment_details>/<open_tabs> — compact heavily
  | 'unknown';       // anything else — keep if small

interface ContextBlock {
  type: BlockType;
  content: string;
  keep: boolean;
  compacted?: string;
  tokensEstimate: number;
}

const estimateBlockTokens = (text: string): number => Math.ceil(text.length / 4);

const classifySystemBlock = (content: string, index: number): ContextBlock => {
  const est = estimateBlockTokens(content);

  // First system message = persona/instructions (no XML container)
  if (index === 0) {
    return { type: 'persona', content, keep: true, tokensEstimate: est };
  }

  const lower = content.toLowerCase();

  // Diagnostics: LSP errors, compiler warnings — CRUCIAL for bug fixing
  if (
    lower.includes('<diagnostics>') ||
    lower.includes('<errors>') ||
    lower.includes('<lsp_diagnostics>') ||
    lower.includes('typescript error') ||
    lower.includes('eslint')
  ) {
    return { type: 'diagnostics', content, keep: true, tokensEstimate: est };
  }

  // Terminal output — keep if small (recent errors/commands)
  if (lower.includes('<terminal>') || lower.includes('<terminal_output>')) {
    return { type: 'terminal', content, keep: est < 600, tokensEstimate: est };
  }

  // Workspace tree / file listing — Aether AST covers this better
  if (
    lower.includes('<workspace_items>') ||
    lower.includes('<tree>') ||
    lower.includes('<folder_structure>') ||
    lower.includes('<file_list>') ||
    // Heuristic: lots of ├─ / └─ box-drawing chars = file tree
    (content.match(/[├└│]/g) ?? []).length > 10
  ) {
    return { type: 'workspace_tree', content, keep: false, tokensEstimate: est };
  }

  // Environment details / open tabs — compact aggressively
  if (
    lower.includes('<environment_details>') ||
    lower.includes('<open_tabs>') ||
    lower.includes('open tabs') ||
    lower.includes('vscode') ||
    lower.includes('cursor position')
  ) {
    // Extract only: current file path, OS, cwd
    const lines = content.split('\n');
    const useful = lines.filter(l => {
      const ll = l.toLowerCase();
      return ll.includes('active') || ll.includes('current') ||
             ll.includes('file') || ll.includes('os:') ||
             ll.includes('cwd') || ll.includes('directory') ||
             ll.includes('cursor') || ll.includes('line ');
    }).slice(0, 20);
    const compacted = useful.length > 0 ? `<environment>\n${useful.join('\n')}\n</environment>` : '';
    return { type: 'environment', content, keep: compacted.length > 0, compacted, tokensEstimate: est };
  }

  // File content blocks — detect which file and whether it's the active one
  const filePathMatch = extractFilePathFromContent(content);
  
  if (filePathMatch || lower.includes('<file_content>') || lower.includes('```')) {
    // We can't reliably know which is the "active" file without cursor info.
    // Keep the FIRST file content block (most likely the active file from KiloCode).
    // Drop subsequent file content blocks (RAG covers them).
    // We use a large threshold: if it's huge, it's likely a secondary file dump.
    if (est < 4000) {
      // Small file content — likely the active file or a short snippet
      return { type: 'active_file', content, keep: true, tokensEstimate: est };
    } else {
      // Large file dump — expensive, drop in favour of RAG
      return { type: 'other_file', content, keep: false, tokensEstimate: est };
    }
  }

  // Unknown: keep if small, drop if huge (> 2000 tokens)
  return { type: 'unknown', content, keep: est < 2000, tokensEstimate: est };
};

const compactActiveFile = (content: string, cursorLine: number | null): string => {
  const lines = content.split('\n');
  if (lines.length <= 150) return content; // Small enough

  // If we have a cursor, keep a window around it
  if (cursorLine !== null && cursorLine > 0) {
    const start = Math.max(0, cursorLine - 60);
    const end = Math.min(lines.length, cursorLine + 60);
    const window = lines.slice(start, end);
    return [
      `// ... (${start} lines omitted)`,
      ...window,
      `// ... (${lines.length - end} lines omitted)`
    ].join('\n');
  }

  // No cursor: keep head and tail (often imports + exports/bottom)
  return [
    ...lines.slice(0, 80),
    `// ... (${lines.length - 130} lines omitted)`,
    ...lines.slice(-50)
  ].join('\n');
};

export interface ContextEngineeringResult {
  messages: Array<{ role: string; content: unknown }>;
  tokensRaw: number;       
  tokensEngineered: number;
  blocksDropped: number;
  blockTypesSummary: string;
  activeFilePath: string | undefined;
  ideFiles: string[];
  cursorLine: number | undefined;
}

const engineerContext = (
  messages: Array<{ role: string; content: unknown }>
): ContextEngineeringResult => {
  let tokensRaw = 0;

  // Mesure le raw total
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    tokensRaw += estimateBlockTokens(c);
  }

  // Extraire curseur + chemin du fichier actif en scannant TOUT le payload
  let activeFilePath: string | undefined;
  let cursorLine: number | undefined;

  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

    // Detection du curseur
    const cl = extractCursorLineFromContent(c);
    if (cl !== undefined) cursorLine = cl;

    // Detection du fichier actif (plusieurs patterns pour KiloCode)
    // On split par espace ou retour à la ligne immédiatement pour ne garder que le chemin
    const pm = /active file:?\s*([^\s\n\r\t]+)/i.exec(c)
      ?? /<file_content[^>]*path=["']?([^"'\s>\n]+)["']?/i.exec(c)
      ?? /Active file:\s*([^\s\n\r\t]+)/i.exec(c);

    if (pm?.[1]) {
      // Nettoyage radical : on prend tout jusqu'au premier caractère non-chemin
      const cleanPath = pm[1].split(/[\\n\\r\\t\s]/)[0];
      if (cleanPath) {
        activeFilePath = cleanPath.replace(/^aether\//, "").trim();
      }
    }
  }

  // NUKE: KiloCode envoie souvent des dizaines de messages 'system' avec des arbres de fichiers.
  // On ne garde que le TOUT PREMIER message system (les instructions de base)
  // et les messages de conversation réels.
  const firstSystem = messages.find(m => m.role === 'system');
  const conversationOnly = messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');

  // On limite l'historique à 10 messages pour éviter l'explosion à 44k tokens
  const history = conversationOnly.slice(-10);
  const kept = [...(firstSystem ? [firstSystem] : []), ...history];

  const tokensEngineered = kept.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    return sum + estimateBlockTokens(c);
  }, 0);

  return {
    messages: kept,
    tokensRaw,
    tokensEngineered,
    blocksDropped: messages.length - kept.length,
    blockTypesSummary: `kept:${kept.length}`,
    activeFilePath,
    ideFiles: [],
    cursorLine,
  };
};


// ─── Clean payload builder ────────────────────────────────────────────────────
//
// L'assemblage du payload est délégué à ./payload.ts (module pur, testé par
// payload.test.ts) : préfixe stable, suffixe volatil, outils préservés. C'est ce
// qui remplace injectAetherContext, dont l'insertion juste après le message
// système invalidait le cache de préfixe d'oMLX à chaque tour.

// ─── Forward to Ollama with SSE streaming ─────────────────────────────────────

const forwardToOllama = async (
  payload: Record<string, unknown>,
  reply: any,
  tStart: number,
  aetherCtx: any = null
): Promise<void> => {
  // MLX typically uses the model loaded at startup, but some versions require a match.
  // We keep the model name from the payload (or "default") to satisfy the server's validation.
  if (!payload.model) payload.model = "default";

  const messages = (payload.messages as any[]) || [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  console.log(`[payload-debug] last user msg: ${JSON.stringify(lastUser?.content)?.slice(0, 300)}`);
  console.log(`[payload-debug] total messages: ${messages.length}, model: ${payload.model}`);

  // Add Authorization header for oMLX (uses 'abcde' by default)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (OLLAMA_URL.includes("8000") || OLLAMA_URL.includes("localhost")) {
    headers['Authorization'] = 'Bearer abcde';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.error("[gateway] ⏱️ Generation timeout after 240s");
  }, 240_000);

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(payload),
    });
    clearTimeout(timeoutId);
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return reply.status(504).send({
        error: { message: "Generation timed out after 240s", type: "timeout" }
      });
    }
    throw err;
  }

  // Restore SSE headers
  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache, no-transform");
  reply.header("X-Accel-Buffering", "no");
  if (reply.raw.setNoDelay) {
    reply.raw.setNoDelay(true);
  }

  let tokenCount = 0;
  let tFirstToken = 0;
  let sseBuffer = ""; // buffer to handle partial SSE lines across chunk boundaries
  let debugChunks = 0;

  const processCompleteLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(trimmed.indexOf(':') + 1).trim();
    if (jsonStr === '[DONE]') return;
    try {
      const parsed = JSON.parse(jsonStr);
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) return;
      // Count both regular content and reasoning_content (for thinking models like Qwen)
      const content = delta.content ?? delta.reasoning_content ?? '';
      if (content.length > 0) tokenCount++;
    } catch {
      // incomplete JSON — will be retried when more data arrives
    }
  };

  const processSSEText = (text: string) => {
    sseBuffer += text;
    // SSE events are separated by double newlines; individual lines by single newlines
    const lines = sseBuffer.split('\n');
    // Keep the last element (may be incomplete)
    sseBuffer = lines.pop() ?? '';
    for (const line of lines) {
      processCompleteLine(line);
    }
  };

  const updateLiveStats = () => {
    lastStats.totalTokens = tokenCount;
    lastStats.totalTime = (Date.now() - tStart) / 1000;
    if (tFirstToken > 0) {
      const genTime = (Date.now() - tFirstToken) / 1000;
      lastStats.tps = genTime > 0.01 ? Math.round(tokenCount / genTime) : 0;
    }
  };

  try {
    await streamResponseBody(
      res.body,
      () => {
        lastStats.ttft = Date.now() - tStart;
        tFirstToken = Date.now();
      },
      (chunk, text) => {
        if (debugChunks < 3) {
          console.log(`[gateway] SSE chunk #${debugChunks}: ${text.slice(0, 200)}`);
          debugChunks++;
        }
        processSSEText(text);
        updateLiveStats();
        reply.raw.write(chunk);
      }
    );
    
    // Process any remaining buffer
    if (sseBuffer.trim()) processCompleteLine(sseBuffer);
    
    // Final stats
    lastStats.totalTime = Math.max(0, (Date.now() - tStart) / 1000);
    lastStats.totalTokens = tokenCount;
    lastStats.tokensRaw = lastStats.tokensRaw || 0;
    lastStats.tokensBefore = lastStats.tokensBefore || 0;
    if (tFirstToken > 0) {
      const genTime = (Date.now() - tFirstToken) / 1000;
      lastStats.tps = genTime > 0.01 ? Math.round(tokenCount / genTime) : 0;
      if (aetherCtx) {
        // astTime is already measured around requestAetherContext call.
        // ragTime is included in astTime for now.
        lastStats.ragTime = 0;
        lastStats.rerankTime = aetherCtx.meta?.rerankTime || 0;
        console.log(
          `[Gateway] [Aether] AST: ${lastStats.astTime}ms, RAG: ${lastStats.ragTime}ms, Rerank: ${lastStats.rerankTime}ms`
        );
      }
    }
    
    console.log(`Stream complete: ${tokenCount} tokens in ${lastStats.totalTime.toFixed(1)}s (${lastStats.tps} t/s, TTFT: ${(lastStats.ttft/1000).toFixed(1)}s)`);
    
    reply.raw.end();
  } catch (err: unknown) {
    console.error("[gateway] error streaming from Ollama:", err);
    try {
      reply.raw.end();
    } catch {}
    throw err;
  }
};

// ─── JSONL Logging ────────────────────────────────────────────────────────────

const LOG_PATH = path.join(
  os.homedir(),
  ".aether",
  "projects",
  hashProject(PROJECT_ROOT),
  "gateway.jsonl",
);

const logRequest = (entry: Record<string, unknown>): void => {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* non-fatal */
  }
};

// ─── Fastify Server ───────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false });

// Ensure config directories exist
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
} catch {}

fastify.addHook('onRequest', (request, reply, done) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE');
  reply.header('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') {
    reply.status(200).send();
  } else {
    done();
  }
});



fastify.get("/v1/models", async () => ({
  object: "list",
  data: [
    {
      id: "qwen3.6-35b-aether",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "aether",
    },
    {
      id: "/Users/beij/models/Qwen3.6-35B-A3B-RotorQuant-MLX-8bit",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "mlx",
    },
  ],
}));

fastify.post("/v1/chat/completions", async (request, reply: any) => {
  const t0 = Date.now();
  stats.currentRequestStart = t0;

  const body = request.body as Record<string, unknown>;
  const messages = (body.messages ?? []) as Array<{
    role: string;
    content: unknown;
  }>;
  const tools = body.tools as unknown[] | undefined;
  const stream = body.stream !== false;

  const modelName = (body.model as string | undefined) ?? undefined;
  
  const configPath = path.join(os.homedir(), ".aether", "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const isBypass = config.bypassAether === true 
    || (request.headers as Record<string, string>)['x-aether-bypass'] === 'full'
    || (body as any).__aether_bypass === true;

  // ─── BYPASS MODE ─────────────────────────────────────────────────────────
  if (isBypass) {
    stats.aetherBypass++;
    const tokensRaw = await countTokensForMessages(messages, modelName);
    lastStats = { 
      astTime: 0, ragTime: 0, ttft: 0, tps: 0, totalTokens: 0,
      totalTime: 0, tokensRaw, tokensBefore: tokensRaw, rerankTime: 0 
    };
    try {
      reply.hijack();
      const forwardPayload: Record<string, unknown> = { ...body, messages, stream, keep_alive: -1 };
      if (!tools) delete forwardPayload.tools;
      await forwardToOllama(forwardPayload, reply as unknown, t0, null);
    } finally {
      stats.currentRequestStart = null;
      recordRequest({
        ok: true, latencyMs: Date.now() - t0,
        tokensRaw, tokensBefore: tokensRaw, tokensAfter: tokensRaw,
        toolsBefore: tools?.length ?? 0, toolsAfter: tools?.length ?? 0,
        bypass: true,
      });
    }
    return;
  }

  // ─── PIPELINE NORMAL ───────────────────────────────────────────────────────
  const taskText = extractTaskText(messages);
  const ctxResult = engineerContext(messages);
    
  const strippedMessages = ctxResult.messages;
  const shapedTools = shapeTools(tools, taskText);

  console.log(
    `[ctx-engine] raw=${ctxResult.tokensRaw}tok → engineered=${ctxResult.tokensEngineered}tok ` +
    `(dropped ${ctxResult.blocksDropped} blocks: ${ctxResult.blockTypesSummary})`
  );

  // tokensBefore = post-engineering, pre-Aether-injection
  const tokensBefore = await countTokensForMessages(strippedMessages, modelName);

  let ok = true;
  let tokensAfter = tokensBefore;
  
  // Reset last prompt stats
  lastStats = { 
    astTime: 0, 
    ragTime: 0, 
    ttft: 0, 
    tps: 0, 
    totalTokens: 0, 
    totalTime: 0,
    tokensRaw: ctxResult.tokensRaw,
    tokensBefore: tokensBefore,
    rerankTime: 0
  };

  try {
    reply.hijack();
    
    let aetherCtx = null;
    if (taskText) {
      const tContext_start = Date.now();
      aetherCtx = await requestAetherContext(taskText, ctxResult.activeFilePath, ctxResult.ideFiles, ctxResult.cursorLine);
      lastStats.astTime = Date.now() - tContext_start;
    }
    
    // Repo-map : bloc stable du préfixe (rafraîchie uniquement hors session).
    const repoMap = await ensureRepoMap();
    lastForwardAt = Date.now();

    // Le « context engineering » est réellement appliqué : on repart des messages
    // filtrés (strippedMessages), pas des messages bruts. Auparavant le filtrage
    // n'était calculé que pour la télémétrie et n'était jamais envoyé.
    const forwardPayload = buildCleanPayload(body, aetherCtx, strippedMessages, stream, { repoMap });

    // Les outils sont transmis au modèle. Sans eux, un agent ne peut ni lire ni
    // écrire de fichier : le modèle est réduit à produire du texte.
    if (shapedTools?.length) {
      forwardPayload.tools = shapedTools;
    } else {
      delete forwardPayload.tools;
    }

    tokensAfter = await countTokensForMessages(
      forwardPayload.messages as Array<{ role: string; content: unknown }>,
      modelName,
    );

    await forwardToOllama(forwardPayload, reply as unknown, t0, aetherCtx);
  } catch (err) {
    ok = false;
    console.error("[gateway] Request failed:", err);
  } finally {
    stats.currentRequestStart = null;
    const latencyMs = Date.now() - t0;

    recordRequest({
      ok,
      latencyMs,
      tokensRaw: ctxResult.tokensRaw,
      tokensBefore,
      tokensAfter,
      toolsBefore: tools?.length ?? 0,
      toolsAfter: shapedTools?.length ?? tools?.length ?? 0,
      bypass: false,
    });
  }
});

fastify.get("/health", async () => ({
  status: "ok",
  project: PROJECT_ROOT,
  socket: getSocketPath(),
  daemon: fs.existsSync(getSocketPath()),
}));

fastify.get("/aether/stats", async () => {
  const uptimeSec = Math.floor((Date.now() - stats.startedAt) / 1000);
  const avgLatency =
    stats.requestsTotal > 0
      ? Math.round(stats.latencySum / stats.requestsTotal)
      : 0;
  const p50Latency = computeP50(stats.latencies);
  const savedPct =
    stats.tokensBefore > 0
      ? Math.round((1 - stats.tokensAfter / stats.tokensBefore) * 100)
      : 0;
  const lastReqSec =
    stats.lastRequestAt > 0
      ? Math.floor((Date.now() - stats.lastRequestAt) / 1000)
      : -1;

  const daemonStatus = await requestAetherDaemonStatus();
  const indexRoot = getProjectIndexRoot();
  const filesIndexed = daemonStatus?.filesIndexed ?? 0;
  const queuePending = daemonStatus?.queuePending ?? 0;
  const manifestPath = path.join(indexRoot, "sqlite", "manifest.sqlite");
  const lancedbPath = path.join(indexRoot, "lancedb");
  const indexSizeBytes = getDirectorySizeBytes(manifestPath) + getDirectorySizeBytes(lancedbPath);

  return {
    uptime_sec: uptimeSec,
    requests_total: stats.requestsTotal,
    requests_ok: stats.requestsOk,
    requests_error: stats.requestsError,
    requests_per_min:
      uptimeSec > 0 ? Math.round((stats.requestsTotal / uptimeSec) * 60) : 0,
    latency_avg_ms: avgLatency,
    latency_p50_ms: p50Latency,
    tokens_before_total: stats.tokensBefore,
    tokens_after_total: stats.tokensAfter,
    tokens_removed_total: stats.tokensRemovedTotal,
    tokens_injected_total: stats.tokensInjectedTotal,
    tokens_saved_pct: savedPct,
    tools_removed: stats.toolsRemoved,
    aether_bypass: stats.aetherBypass,
    current_request_start: stats.currentRequestStart,
    queue_pending: queuePending,
    queue_errors: stats.requestsError,
    queue_last_sec: lastReqSec,
    files_indexed: filesIndexed,
    index_size_bytes: indexSizeBytes,
    last_benchmark: lastStats,
    history: stats.history,
  };
});

fastify.post("/aether/stats/reset", async () => {
  stats.requestsTotal = 0;
  stats.requestsOk = 0;
  stats.requestsError = 0;
  stats.tokensBefore = 0;
  stats.tokensAfter = 0;
  stats.tokensRemovedTotal = 0;
  stats.tokensInjectedTotal = 0;
  stats.latencySum = 0;
  stats.latencies = [];
  stats.toolsRemoved = 0;
  stats.aetherBypass = 0;
  stats.lastRequestAt = 0;
  stats.startedAt = Date.now();

  return { reset: true };
});

const CONFIG_PATH = path.join(
  os.homedir(),
  ".aether",
  "config.json"
);

fastify.get("/aether/config", async () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return { modelPath: "", tokenBudget: TOKEN_BUDGET, upstreamUrl: OLLAMA_URL, ...cfg };
    }
  } catch {}
  return { modelPath: "", tokenBudget: TOKEN_BUDGET, upstreamUrl: OLLAMA_URL };
});

fastify.post("/aether/config", async (request) => {
  const body = request.body as any;
  const current = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const updated = { ...current, ...body };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return { success: true, config: updated };
});

fastify.post("/aether/util/pick-folder", async () => {
  if (process.platform !== "darwin") return { path: "" };
  
  return new Promise((resolve) => {
    const cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select Aether Model Folder")'`;
    const child = spawn("sh", ["-c", cmd]);
    let output = "";
    child.stdout?.on("data", (d) => (output += d.toString()));
    child.on("close", () => {
      resolve({ path: output.trim() });
    });
    child.on("error", () => resolve({ path: "" }));
  });
});

let mlxProcess: ChildProcess | null = null;
let coreProcess: ChildProcess | null = null;
let rerankerProcess: ChildProcess | null = null;
let engineStatus: "stopped" | "starting" | "running" = "stopped";
const log = (tag: string, msg: string) => addLog(`[${tag}] ${msg}`);

function findExecutable(name: string): string {
  try {
    const extendedPath = `/opt/homebrew/bin:/usr/local/bin:${process.env.HOME}/.local/bin:/Applications/oMLX.app/Contents/MacOS:${process.env.PATH}`;
    const res = spawnSync("which", [name], {
      env: { ...process.env, PATH: extendedPath },
      encoding: "utf8"
    });
    const foundPath = res.stdout?.trim();
    if (foundPath && fs.existsSync(foundPath)) {
      return foundPath;
    }
    return name;
  } catch {
    return name;
  }
}

/**
 * Résout le binaire oMLX.
 *
 * Le bundle oMLX installe `omlx-cli` (pas `omlx`) : l'ancienne recherche
 * `findExecutable("omlx")` échouait donc toujours et le moteur n'était jamais
 * démarré.
 */
function resolveOmlxBinary(): string | null {
  // Chemin explicite prioritaire : variable d'environnement, puis configuration.
  // (Le message d'erreur du démarrage promettait cette clé sans qu'elle soit lue.)
  const fromEnv = process.env.AETHER_OMLX_BINARY;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as { omlxBinary?: string };
    if (cfg.omlxBinary && fs.existsSync(cfg.omlxBinary)) return cfg.omlxBinary;
  } catch {
    /* pas de configuration : on continue avec la détection automatique */
  }

  const candidates = [
    `${process.env.HOME ?? ""}/.local/bin/omlx-cli`,
    "/opt/homebrew/bin/omlx-cli",
    "/usr/local/bin/omlx-cli",
    "/Applications/oMLX.app/Contents/MacOS/omlx-cli",
    "omlx-cli",
    "omlx",
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const found = findExecutable(candidate);
    if (found !== candidate) return found;
  }
  return null;
}

async function isPortAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok || res.status === 401; // 401 is OK for oMLX if key missing
  } catch {
    return false;
  }
}

const engineLogs: string[] = [];

const addLog = (msg: string) => {
  if (!msg) return;
  const lines = msg.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      engineLogs.push(trimmed);
      if (engineLogs.length > 200) engineLogs.shift();
    }
  }
};

// Redirect gateway console logs to the dashboard as well
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  originalLog(...args);
  addLog(`[Gateway] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
};
console.error = (...args) => {
  originalError(...args);
  addLog(`[Gateway] ❌ ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
};

fastify.get("/aether/engine/logs", async () => {
  return { logs: engineLogs };
});

fastify.get("/aether/engine/status", async () => {
  return { status: engineStatus };
});

const killPort = (port: number): Promise<void> =>
  new Promise((resolve) => {
    // macOS/Linux : lsof trouve le PID, kill -9 le tue
    const child = spawn("sh", ["-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`]);
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // non-fatal
  });

fastify.post("/aether/engine/start", async () => {
  if (engineStatus !== "stopped") return { status: engineStatus };
  engineStatus = "starting";

  // ─── Nettoyage préventif des ports zombies ────────────────────────────────
  addLog("[System] Cleaning up zombie processes on ports 8081, 8082...");
  await Promise.all([killPort(8081), killPort(8082)]);
  await new Promise(r => setTimeout(r, 500)); // laisser l'OS libérer les sockets
  addLog("[System] Ports cleared.");
  // ─────────────────────────────────────────────────────────────────────────
  
  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const modelPath: string = config.modelPath ?? "";
  const modelsDir: string =
    config.modelsDir || (modelPath ? path.dirname(modelPath) : path.join(os.homedir(), "models"));

  const startMLX = (cmd: string, args: string[]) => {
    const proc = spawn(cmd, args, {
      detached: true,
      shell: false,
      env: { ...process.env, HF_HUB_OFFLINE: "1" }
    });

    proc.on('error', (err: any) => {
      addLog(`[System] ❌ Error starting oMLX (${cmd}): ${err.message}`);
    });

    proc.stdout?.on('data', (d) => addLog(`[MLX] ${d.toString()}`));
    proc.stderr?.on('data', (d) => addLog(`[MLX] ${d.toString()}`));
    proc.on('exit', (code) => addLog(`[System] oMLX exited (code: ${code}).`));
    return proc;
  };

  // 1. Try to start oMLX if not already alive
  const omlxAlive = await isPortAlive("http://127.0.0.1:8000/v1/models");

  if (omlxAlive) {
    log("System", "✅ oMLX already running on port 8000 — skipping launch");
  } else {
    log("System", "Starting oMLX engine...");
    const omlxBinary = resolveOmlxBinary();

    if (!omlxBinary) {
      addLog(
        "[System] ❌ omlx-cli introuvable. Installe oMLX.app, ou renseigne son chemin absolu dans ~/.aether/config.json (clé « omlxBinary »).",
      );
    } else {
      // Cache de préfixe paginé sur SSD : c'est LE levier de TTFT d'oMLX.
      // Désactivé par défaut (`PagedSSDCacheConfig.enabled = False`), il doit
      // être activé explicitement par --paged-ssd-cache-dir.
      const cacheDir: string =
        config.cacheDir || path.join(os.homedir(), ".omlx", "cache");
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch (err) {
        addLog(`[System] ⚠️  Impossible de créer ${cacheDir}: ${String(err)}`);
      }

      log("System", `oMLX → ${omlxBinary}`);
      log("System", `Modèles: ${modelsDir} | cache préfixe: ${cacheDir}`);

      mlxProcess = startMLX(omlxBinary, [
        "serve",
        "--model-dir", modelsDir,
        "--port", "8000",
        "--host", "127.0.0.1",
        "--paged-ssd-cache-dir", cacheDir,
        "--paged-ssd-cache-max-size", String(config.cacheMaxSize ?? "100GB"),
        "--hot-cache-max-size", String(config.hotCacheMaxSize ?? "8GB"),
        // Le cache de préfixe d'oMLX fonctionne par blocs de 256 tokens :
        // 256 blocs = 65 536 tokens seulement. Pour un contexte de 128 k il faut
        // 512 blocs, sinon la table sature et le cache évince prématurément —
        // ce qui se paie directement en TTFT.
        "--initial-cache-blocks", String(config.initialCacheBlocks ?? 512),
        // oMLX 0.7.0 a REMPLACÉ --max-process-memory (disparu, rejeté par
        // argparse) par --memory-guard {off,safe,balanced,aggressive}.
        "--memory-guard", String(config.memoryGuard ?? "balanced"),
      ]);
    }
  }

  // 2. Try to start Reranker if not already alive
  const rerankerAlive = await isPortAlive("http://127.0.0.1:8082/health");
  if (rerankerAlive) {
    log("System", "✅ Reranker already running on port 8082 — skipping launch");
  } else {
    log("System", "Starting Reranker Server...");
    const rootDir = path.resolve(__dirname, "../../../");
    rerankerProcess = spawn("python", ["packages/core/reranker_server.py"], {
      cwd: rootDir,
      detached: true,
      env: { ...process.env, HF_HUB_OFFLINE: "1" }
    });
    rerankerProcess.stdout?.on('data', (d) => addLog(`[Reranker] ${d.toString()}`));
    rerankerProcess.stderr?.on('data', (d) => addLog(`[Reranker] ${d.toString()}`));
  }

  console.log("[Engine] Starting Core Daemon...");
  addLog("[System] Starting Core Daemon...");
  const rootDir = path.resolve(__dirname, "../../../");
  const daemonScript = path.resolve(rootDir, "packages/core/dist/daemon.js");

  if (fs.existsSync(daemonScript)) {
    coreProcess = spawn(process.execPath, [daemonScript, PROJECT_ROOT], {
      detached: true,
      cwd: rootDir
    });
    coreProcess.stdout?.on('data', (d) => addLog(`[Core] ${d.toString()}`));
    coreProcess.stderr?.on('data', (d) => addLog(`[Core] ${d.toString()}`));
    coreProcess.on('exit', (code) => addLog(`[System] Core Daemon exited (code: ${code}).`));
  } else {
    addLog("[System] ❌ Core daemon not found — run: npm run build --workspace=packages/core");
    console.error("[Engine] Core daemon not found:", daemonScript);
  }

  void (async () => {
    const [rerankerReady, daemonReady] = await Promise.all([
      waitForHttpReady("http://127.0.0.1:8082/health", 120000, 1000),
      waitForSocket(getSocketPath(), 120000, 1000)
    ]);
    
    if (engineStatus !== "starting") {
      return;
    }

    if (!rerankerReady || !daemonReady) {
      if (!rerankerReady) addLog("[System] ❌ Reranker did not become ready in time.");
      if (!daemonReady) addLog("[System] ❌ Core Daemon socket was never created. Did it crash?");
      engineStatus = "stopped";
      return;
    }

    engineStatus = "running";
  })();

  return { status: "starting" };
});

fastify.post("/aether/engine/stop", async () => {
  if (mlxProcess?.pid) {
    terminateProcessGroup(mlxProcess, "SIGTERM");
    mlxProcess = null;
  }
  if (coreProcess?.pid) {
    terminateProcessGroup(coreProcess, "SIGTERM");
    coreProcess = null;
  }
  if (rerankerProcess?.pid) {
    terminateProcessGroup(rerankerProcess, "SIGTERM");
    rerankerProcess = null;
  }
  engineStatus = "stopped";
  return { status: "stopped" };
});

const cleanup = () => {
  terminateProcessGroup(mlxProcess, "SIGKILL");
  terminateProcessGroup(coreProcess, "SIGKILL");
  terminateProcessGroup(rerankerProcess, "SIGKILL");
};
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

const dashboardDist = path.resolve(__dirname, "../../dashboard/dist");

if (fs.existsSync(dashboardDist)) {
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  // Serve static files from root (wildcard must be last)
  fastify.get("/*", async (request, reply) => {
    const rawUrl = request.url || "/";
    const filePath = buildDashboardFilePath(rawUrl);
    const fullPath = path.join(dashboardDist, filePath);
    
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath);
      reply.type(mimeTypes[ext] || "application/octet-stream");
      return fs.createReadStream(fullPath);
    }
    
    // Fallback to index.html for SPA routing or 404
    const index = path.join(dashboardDist, "index.html");
    if (fs.existsSync(index)) {
      reply.type("text/html");
      return fs.createReadStream(index);
    }
    
    reply.status(404).send({ error: "Dashboard not found" });
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await fastify.listen({ port: GATEWAY_PORT, host: "127.0.0.1" });
    console.log(`🌐 Aether Gateway  → http://127.0.0.1:${GATEWAY_PORT}/v1`);
    console.log(`🔌 Daemon socket   → ${getSocketPath()}`);
    console.log(`🚀 Ollama upstream → ${OLLAMA_URL}/v1`);
    console.log(`📂 Logs            → ${LOG_PATH}`);
    console.log();
    console.log("In OpenCode / KiloCode, point the Base URL to:");
    console.log(`  http://127.0.0.1:${GATEWAY_PORT}/v1`);
  } catch (err) {
    console.error("❌ Failed to start the Gateway:", err);
    process.exit(1);
  }
};

start();
