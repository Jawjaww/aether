// packages/gateway/src/server.ts
//
// Aether Gateway — OpenAI-compatible proxy between IDE and local LLM.
// The IDE points to http://127.0.0.1:8080/v1
// Aether intercepts, filters context, injects AST/RAG, and forwards to Ollama.

import Fastify from "fastify";
import { createConnection } from "node:net";
import { spawn, ChildProcess } from "node:child_process";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const GATEWAY_PORT = Number.parseInt(process.env.AETHER_PORT ?? "8080", 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:8081";
const PROJECT_ROOT = process.env.AETHER_PROJECT ?? process.cwd();
const TOKEN_BUDGET = Number.parseInt(process.env.TOKEN_BUDGET ?? "16384", 10);

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

// ─── Token counting (tiktoken fallback) ──────────────────────────────────────
let _tiktokenModule: any = null;

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

const countTokensText = async (
  text: string,
  model?: string,
): Promise<number> => {
  const mod = await ensureTiktoken();
  if (!mod) return Math.trunc(text.length / 4);
  try {
    let enc: any;
    if (typeof mod.encoding_for_model === "function") {
      enc = mod.encoding_for_model(model ?? "gpt-3.5-turbo");
    } else if (typeof mod.get_encoding === "function") {
      enc = mod.get_encoding("cl100k_base");
    } else {
      return Math.trunc(text.length / 4);
    }
    const arr = enc.encode(text);
    const len = arr.length;
    try {
      enc.free?.();
    } catch {}
    return len;
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

interface AetherContextResponse {
  tokenCount: number;
  confidence: number;
  sections: { astContext?: string; ragContext?: string };
  meta: {
    astFiles: string[];
    reasoning: "think" | "no_think";
    budgetUsed: { ast: number; rag: number; history: number };
  };
}

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

const requestAetherContext = (
  taskText: string,
  activeFilePath?: string,
  cursorLine?: number,
): Promise<AetherContextResponse | null> => {
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
    }, 3000);

    const payload = JSON.stringify({
      id: `gw-${Date.now()}`,
      type: "context:request",
      version: "1.0",
      ts: Date.now(),
      payload: { 
        taskText, 
        activeFilePath,
        cursorLine,
        tokenBudget: TOKEN_BUDGET 
      },
    });

    socket.on("connect", () => socket.write(payload + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "context:response") {
            clearTimeout(timeout);
            socket.destroy();
            resolve(msg.payload as AetherContextResponse);
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

// ─── Extract task from IDE messages ──────────────────────────────────────────

const extractTaskText = (
  messages: Array<{ role: string; content: unknown }>,
): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content.slice(0, 500);
    if (Array.isArray(msg.content)) {
      const textPart = (
        msg.content as Array<{ type: string; text?: string }>
      ).find((p) => p.type === "text");
      if (textPart?.text) return textPart.text.slice(0, 500);
    }
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
  cursorLine: number | undefined;
}

const engineerContext = (
  messages: Array<{ role: string; content: unknown }>
): ContextEngineeringResult => {
  let tokensRaw = 0;
  let tokensEngineered = 0;
  let blocksDropped = 0;
  const typeCounts: Record<string, number> = {};

  // Find cursor info and active file path in all system messages first
  let activeFilePath: string | undefined = undefined;
  let globalCursorLine: number | null = null;
  
  for (const m of messages) {
    if (m.role !== 'system') continue;
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    
    // Detect cursor
    const extractedCursorLine = extractCursorLineFromContent(c);
    if (extractedCursorLine !== undefined) {
      globalCursorLine = extractedCursorLine;
    }
    
    // Detect active file path from tags or environment
    const pathMatch = /active file:? ([^\s]+)/i.exec(c)
      ?? /<file_content[^>]*path=["']?([^"'\s>]+)["']?/i.exec(c);
    if (pathMatch?.[1]) {
      activeFilePath = pathMatch[1];
    }
  }

  // Classify all system blocks
  let sysIndex = 0;
  const processedMessages = messages.map(msg => {
    const contentStr =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content ?? '');

    tokensRaw += estimateBlockTokens(contentStr);

    if (msg.role !== 'system') {
      tokensEngineered += estimateBlockTokens(contentStr);
      return { msg, keep: true, content: contentStr };
    }

    const block = classifySystemBlock(contentStr, sysIndex++);
    typeCounts[block.type] = (typeCounts[block.type] ?? 0) + 1;

    if (!block.keep) {
      blocksDropped++;
      return { msg, keep: false, content: '' };
    }

    // Apply Compaction (Stage 3) - Only if we don't have Surgical AST logic ready
    let finalContent = block.compacted ?? block.content;
    
    // If it's a file content, we might drop it if we rely on Surgical Daemon injection
    if (block.type === 'active_file' || block.type === 'other_file') {
      // In surgical mode, we drop the IDE's version of the file content
      // to avoid massive redundancy. The Daemon will inject the surgical version.
      blocksDropped++;
      return { msg, keep: false, content: '' };
    }

    tokensEngineered += estimateBlockTokens(finalContent);
    return { msg: { ...msg, content: finalContent }, keep: true, content: finalContent };
  });

  const filteredMessages = processedMessages
    .filter(p => p.keep)
    .map(p => p.msg);

  const typesSummary = Object.entries(typeCounts)
    .map(([k, v]) => `${k}:${v}`).join(' ');

  return {
    messages: filteredMessages,
    tokensRaw,
    tokensEngineered,
    blocksDropped,
    blockTypesSummary: typesSummary,
    activeFilePath,
    cursorLine: globalCursorLine ?? undefined
  };
};


// ─── Context injection ────────────────────────────────────────────────────────

const injectAetherContext = (
  messages: Array<{ role: string; content: unknown }>,
  ctx: AetherContextResponse,
): Array<{ role: string; content: unknown }> => {
  const parts: string[] = [
    ...(ctx.meta.reasoning === "think" ? ["/think"] : []),
    ...(ctx.sections.astContext
      ? [
          "<aether_context>",
          ctx.sections.astContext,
          ...(ctx.sections.ragContext ? [ctx.sections.ragContext] : []),
          "</aether_context>",
        ]
      : []),
  ];

  if (parts.length === 0) return messages;

  const aetherMsg = {
    role: "system",
    content: parts.join("\n"),
  };

  const firstSystemIdx = messages.findIndex((m) => m.role === "system");
  const insertAt = firstSystemIdx >= 0 ? firstSystemIdx + 1 : 0;

  return [
    ...messages.slice(0, insertAt),
    aetherMsg,
    ...messages.slice(insertAt),
  ];
};

// ─── Tool shaping ─────────────────────────────────────────────────────────────

const IO_TOOL_PATTERNS =
  /^(read_file|write_file|list_dir|web_search|browser|fetch|http)/i;
const TASK_ACTION_REGEX =
  /\b(create|write|file|search|fetch|open)\b/i;

const shapeTools = (
  tools: unknown[] | undefined,
  taskText: string,
): unknown[] | undefined => {
  if (tools?.length) {
    if (TASK_ACTION_REGEX.test(taskText)) return tools;

    const filtered = tools.filter((t: unknown) => {
      const name =
        (t as { function?: { name?: string }; name?: string })?.function
          ?.name ??
        (t as { name?: string })?.name ??
        "";
      return !IO_TOOL_PATTERNS.test(name);
    });

    return filtered.length > 0 ? filtered : undefined;
  }

  return tools;
};

// ─── Forward to Ollama with SSE streaming ─────────────────────────────────────

const forwardToOllama = async (
  payload: Record<string, unknown>,
  reply: any,
  tStart: number,
  aetherCtx: any = null
): Promise<void> => {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Restore SSE headers
  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache");
  reply.header("X-Accel-Buffering", "no");

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
      lastStats.tps = genTime > 0.1 ? Math.round(tokenCount / genTime) : 0;
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
      lastStats.tps = genTime > 0.1 ? Math.round(tokenCount / genTime) : 0;
      if (aetherCtx) {
        lastStats.astTime = aetherCtx.meta?.astTime || 0;
        lastStats.ragTime = aetherCtx.meta?.ragTime || 0;
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
      id: "aether-gateway",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "aether",
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

  const taskText = extractTaskText(messages);
  const ctxResult = engineerContext(messages);
  const strippedMessages = ctxResult.messages;
  const shapedTools = shapeTools(tools, taskText);

  console.log(
    `[ctx-engine] raw=${ctxResult.tokensRaw}tok → engineered=${ctxResult.tokensEngineered}tok ` +
    `(dropped ${ctxResult.blocksDropped} blocks: ${ctxResult.blockTypesSummary})`
  );

  const modelName = (body.model as string | undefined) ?? undefined;
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
    const tContext_start = Date.now();
    const aetherCtx = taskText ? await requestAetherContext(taskText, ctxResult.activeFilePath, ctxResult.cursorLine) : null;
    lastStats.astTime = Date.now() - tContext_start;
    
    const enrichedMessages = aetherCtx
      ? injectAetherContext(strippedMessages, aetherCtx)
      : strippedMessages;
      
    tokensAfter = await countTokensForMessages(enrichedMessages, modelName);
    
    // Enforce TOKEN_BUDGET
    while (tokensAfter > TOKEN_BUDGET && enrichedMessages.length > 2) {
      enrichedMessages.splice(1, 1);
      tokensAfter = await countTokensForMessages(enrichedMessages, modelName);
    }

    const forwardPayload: Record<string, unknown> = {
      ...body,
      messages: enrichedMessages,
      stream,
      keep_alive: -1,
    };
    
    if (shapedTools == null) {
      delete forwardPayload.tools;
    } else {
      forwardPayload.tools = shapedTools;
    }

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
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {}
  return { modelPath: "", tokenBudget: TOKEN_BUDGET };
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

fastify.post("/aether/engine/start", async () => {
  if (engineStatus !== "stopped") return { status: engineStatus };
  engineStatus = "starting";
  
  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const modelPath = config.modelPath || "/Users/beij/models/Qwen3.6-35B-A3B-RotorQuant-MLX-8bit";
  
  console.log("[Engine] Starting MLX server...");
  addLog("[System] Starting MLX Server...");
  mlxProcess = spawn("python", ["-m", "mlx_lm.server", "--model", modelPath, "--port", "8081"], {
    detached: true,
  });
  mlxProcess.stdout?.on('data', (d) => addLog(`[MLX] ${d.toString()}`));
  mlxProcess.stderr?.on('data', (d) => addLog(`[MLX] ${d.toString()}`));
  mlxProcess.on('exit', () => addLog(`[System] MLX Server exited.`));
  
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

  console.log("[Engine] Starting Reranker Server...");
  addLog("[System] Starting Reranker Server...");
  const rerankerScript = path.resolve(rootDir, "packages/core/reranker_server.py");
  if (fs.existsSync(rerankerScript)) {
    rerankerProcess = spawn("python", [rerankerScript], {
      detached: true,
      cwd: rootDir
    });
    rerankerProcess.stdout?.on('data', (d) => addLog(`[Reranker] ${d.toString()}`));
    rerankerProcess.stderr?.on('data', (d) => addLog(`[Reranker] ${d.toString()}`));
    rerankerProcess.on('exit', (code) => addLog(`[System] Reranker Server exited (code: ${code}).`));
  } else {
    addLog("[System] ❌ Reranker script not found.");
  }

  void (async () => {
    const rerankerReady = await waitForHttpReady("http://127.0.0.1:8082/health", 120000, 1000);
    if (engineStatus !== "starting") {
      return;
    }

    if (!rerankerReady) {
      addLog("[System] ❌ Reranker did not become ready in time.");
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
