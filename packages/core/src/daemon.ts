// packages/core/src/daemon.ts
// Entry point for the Aether daemon.
// Launches the watcher, indexer, and Unix Socket server.

import * as net from "node:net"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createHash } from "node:crypto"
import {
  createEmptyGraph,
  createGraphFromChunks,
  computeGraphMetrics,
  extractFileFromSource,
  extractForTask,
  removeFileFromGraph,
  updateGraphMetrics,
  upsertFileInGraph,
} from "./indexer/ast-extractor.js"
import type { ASTGraph } from "./indexer/ast-extractor.js"
import { deleteFile as deleteRAGFile, initRAG, indexFile, searchRAG } from "./indexer/rag-indexer.js"
import { applyBudget, estimateTokens } from "./budget/budget-engine.js"
import type { BudgetChunk } from "./budget/budget-engine.js"
import { initSelector, shouldThink } from "./reasoning/selector.js"
import { rerank, initReranker } from "./indexer/reranker.js"
import {
  createEmptyManifest,
  loadManifest,
  removeFileMeta,
  saveManifest,
  updateFileMeta,
  type FileMeta,
} from "./indexer/file-manifest.js"

const PROJECT_ROOT = process.argv[2] ?? process.cwd()
const hash         = createHash("sha256").update(path.resolve(PROJECT_ROOT)).digest("hex").slice(0, 8)
const SOCK_PATH    = path.join(os.homedir(), ".aether", "projects", hash, "aether.sock")
const DEFAULT_TOKEN_BUDGET = 16384
const MAX_AST_RERANK_CANDIDATES = 15
const MAX_RAG_RERANK_CANDIDATES = 15
const CURRENT_AST_VERSION = 1
const CURRENT_RAG_VERSION = 1
const MANIFEST_FLUSH_DELAY_MS = 1500
const INDEX_BATCH_SIZE = 6
const INDEX_THROTTLE_MS = 120
const STARTUP_HIGH_PRIORITY_LIMIT = 10

type FileSnapshot = {
  path: string;
  relativePath: string;
  mtime: number;
  size: number;
};

type IndexReason = "NEW" | "CHANGED" | "DELETED" | "MANUAL";
type IndexPriority = "HIGH" | "LOW";

type IndexJob = {
  path: string;
  reason: IndexReason;
  priority: IndexPriority;
  queuedAt: number;
};

let graph: ASTGraph = createEmptyGraph();
let manifest = createEmptyManifest();
let manifestDirty = false;
let manifestSaveInFlight = false;
let manifestFlushTimer: NodeJS.Timeout | null = null;
let queueWorkerRunning = false;
const pendingJobs = new Map<string, IndexJob>();
const daemonBootAt = Date.now();

const manifestKeyFor = (absPath: string): string => path.relative(PROJECT_ROOT, absPath);

const snapshotToMeta = (
  snapshot: FileSnapshot,
  hashValue: string,
  astChunk: NonNullable<FileMeta["astChunk"]>,
): FileMeta => ({
  path: snapshot.relativePath,
  mtime: snapshot.mtime,
  size: snapshot.size,
  hash: hashValue,
  astVersion: CURRENT_AST_VERSION,
  ragVersion: CURRENT_RAG_VERSION,
  astChunk,
});

const scheduleManifestFlush = (): void => {
  manifestDirty = true;
  if (manifestFlushTimer) return;

  manifestFlushTimer = setTimeout(() => {
    manifestFlushTimer = null;
    void flushManifest();
  }, MANIFEST_FLUSH_DELAY_MS);
};

const flushManifest = async (): Promise<void> => {
  if (!manifestDirty || manifestSaveInFlight) return;
  manifestSaveInFlight = true;

  try {
    await saveManifest(hash, manifest);
    manifestDirty = false;
  } catch (err) {
    console.error("[Aether] Failed to save manifest:", err);
  } finally {
    manifestSaveInFlight = false;
    if (manifestDirty && !manifestFlushTimer) {
      scheduleManifestFlush();
    }
  }
};

const enqueueIndexJob = (job: IndexJob): void => {
  const existing = pendingJobs.get(job.path);
  if (existing?.priority === "HIGH" && job.priority === "LOW") {
    return;
  }
  pendingJobs.set(job.path, job);
  queueDrainSoon();
};

let queueDrainTimer: NodeJS.Timeout | null = null;
const queueDrainSoon = (): void => {
  if (queueDrainTimer || queueWorkerRunning) return;
  queueDrainTimer = setTimeout(() => {
    queueDrainTimer = null;
    void drainIndexQueue();
  }, 0);
};

const takeNextBatch = (): IndexJob[] => {
  const jobs = [...pendingJobs.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "HIGH" ? -1 : 1;
    return a.queuedAt - b.queuedAt;
  });

  const batch = jobs.slice(0, INDEX_BATCH_SIZE);
  for (const job of batch) {
    pendingJobs.delete(job.path);
  }
  return batch;
};

const indexFileJob = async (job: IndexJob): Promise<void> => {
  const absolutePath = path.isAbsolute(job.path) ? job.path : path.resolve(PROJECT_ROOT, job.path);
  const relativePath = manifestKeyFor(absolutePath);

  if (job.reason === "DELETED") {
    removeFileFromGraph(absolutePath, graph);
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    removeFileFromGraph(absolutePath, graph);
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  const rawContent = fs.readFileSync(absolutePath, "utf8");
  const chunk = extractFileFromSource(absolutePath, rawContent);
  if (!chunk) {
    removeFileFromGraph(absolutePath, graph);
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  upsertFileInGraph(chunk, graph);
  await indexFile(absolutePath, rawContent);

  const stat = await fsp.stat(absolutePath);
  updateFileMeta(
    manifest,
    relativePath,
    snapshotToMeta(
      {
        path: absolutePath,
        relativePath,
        mtime: stat.mtimeMs,
        size: stat.size,
      },
      createHash("sha1").update(rawContent).digest("hex"),
      chunk,
    ),
  );
  scheduleManifestFlush();
};

const drainIndexQueue = async (): Promise<void> => {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;

  try {
    while (pendingJobs.size > 0) {
      const batch = takeNextBatch();
      if (batch.length === 0) break;

      for (const job of batch) {
        try {
          await indexFileJob(job);
        } catch (err) {
          console.error(`[Aether] Failed to index ${job.path}:`, err);
        }
      }

      await updateGraphMetrics(graph, batch.map((job) => job.path));
      console.log(`[Aether] Indexed batch of ${batch.length}; ${pendingJobs.size} jobs remain`);

      if (pendingJobs.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, INDEX_THROTTLE_MS));
      }
    }
  } finally {
    queueWorkerRunning = false;
    if (pendingJobs.size > 0) {
      queueDrainSoon();
    }
  }
};

const scanProjectFiles = async (projectRoot: string): Promise<FileSnapshot[]> => {
  const discovered: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const name = typeof entry.name === "string" ? entry.name : String(entry.name);
        const fullPath = path.join(dir, name);

        if (entry.isDirectory()) {
          if (["node_modules", "dist", ".git", ".aether"].includes(name)) return;
          await walk(fullPath);
          return;
        }

        if (entry.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
          discovered.push(fullPath);
        }
      }),
    );
  };

  await walk(projectRoot);

  const snapshots: FileSnapshot[] = [];
  for (let i = 0; i < discovered.length; i += 50) {
    const batch = discovered.slice(i, i + 50);
    const stats = await Promise.all(
      batch.map(async (absPath) => {
        try {
          const stat = await fsp.stat(absPath);
          return {
            path: absPath,
            relativePath: manifestKeyFor(absPath),
            mtime: stat.mtimeMs,
            size: stat.size,
          } satisfies FileSnapshot;
        } catch {
          return null;
        }
      }),
    );

    for (const snapshot of stats) {
      if (snapshot) snapshots.push(snapshot);
    }
  }

  return snapshots;
};

const classifySnapshots = (
  snapshots: FileSnapshot[],
  currentManifest: Map<string, FileMeta>,
): {
  newFiles: FileSnapshot[];
  changedFiles: FileSnapshot[];
  deletedFiles: string[];
  unchangedFiles: FileSnapshot[];
} => {
  const seen = new Set<string>();
  const newFiles: FileSnapshot[] = [];
  const changedFiles: FileSnapshot[] = [];
  const unchangedFiles: FileSnapshot[] = [];

  for (const snapshot of snapshots) {
    seen.add(snapshot.relativePath);
    const meta = currentManifest.get(snapshot.relativePath);

    if (!meta) {
      newFiles.push(snapshot);
      continue;
    }

    const isStale =
      meta.astVersion !== CURRENT_AST_VERSION ||
      meta.ragVersion !== CURRENT_RAG_VERSION ||
      meta.mtime !== snapshot.mtime ||
      meta.size !== snapshot.size ||
      !meta.astChunk;

    if (isStale) changedFiles.push(snapshot);
    else unchangedFiles.push(snapshot);
  }

  const deletedFiles = [...currentManifest.keys()].filter((filePath) => !seen.has(filePath));

  return { newFiles, changedFiles, deletedFiles, unchangedFiles };
};

const hydrateGraphFromManifest = (currentManifest: Map<string, FileMeta>): ASTGraph => {
  const chunks = [...currentManifest.values()]
    .filter((entry) => entry.astChunk && entry.astVersion === CURRENT_AST_VERSION && entry.ragVersion === CURRENT_RAG_VERSION)
    .map((entry) => entry.astChunk!);

  return createGraphFromChunks(chunks);
};

const processStartupDiff = async (): Promise<void> => {
  const loadedManifest = await loadManifest(hash);
  manifest = loadedManifest;
  graph = hydrateGraphFromManifest(manifest);
  await computeGraphMetrics(graph);
  console.log(`[Aether] Hydrated ${graph.nodes.size} cached AST files from manifest`);
};

const reconcileStartupIndex = async (): Promise<void> => {
  try {
    const snapshots = await scanProjectFiles(PROJECT_ROOT);
    const { newFiles, changedFiles, deletedFiles, unchangedFiles } = classifySnapshots(snapshots, manifest);

    console.log(
      `[Aether] Index diff: ${newFiles.length} new, ${changedFiles.length} changed, ${deletedFiles.length} deleted, ${unchangedFiles.length} unchanged`,
    );

    for (const deletedPath of deletedFiles) {
      const absolutePath = path.resolve(PROJECT_ROOT, deletedPath);
      removeFileFromGraph(absolutePath, graph);
      await deleteRAGFile(absolutePath);
      removeFileMeta(manifest, deletedPath);
    }

    const startupJobs = [...newFiles, ...changedFiles].sort((a, b) => b.mtime - a.mtime);
    startupJobs.forEach((snapshot, index) => {
      enqueueIndexJob({
        path: snapshot.path,
        reason: manifest.has(snapshot.relativePath) ? "CHANGED" : "NEW",
        priority: index < STARTUP_HIGH_PRIORITY_LIMIT ? "HIGH" : "LOW",
        queuedAt: Date.now() + index,
      });
    });

    if (deletedFiles.length > 0) {
      scheduleManifestFlush();
    }

    console.log(
      `[Aether] Queued ${startupJobs.length} startup reindex jobs after hydrating ${graph.nodes.size} cached files`,
    );
  } catch (err) {
    console.error("[Aether] Startup reconciliation failed:", err);
  }
};

const getFullFileContent = (filePath: string): string => {
  try {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
    if (!fs.existsSync(absPath)) return `// File not found: ${filePath}`;
    return fs.readFileSync(absPath, "utf8");
  } catch (err) {
    return `// Error reading file: ${err}`;
  }
}

type RerankCandidate = {
  id: string;
  text: string;
  filePath: string;
  isAST: boolean;
  score: number;
};

const buildAstCandidates = (
  chunks: Awaited<ReturnType<typeof extractForTask>>,
  activeFilePath: string | undefined,
): RerankCandidate[] => {
  const candidates: RerankCandidate[] = [];

  for (const chunk of chunks) {
    if (activeFilePath && chunk.filePath.includes(activeFilePath)) continue;

    const text = [
      ...chunk.functions.map((f) => `${f.isAsync ? "async " : ""}function ${f.name}${f.params}${f.returnType ? ": " + f.returnType : ""}`),
      ...chunk.types.map((t) => `${t.kind} ${t.name} ${t.body}`),
    ].join("\n");

    candidates.push({
      id: chunk.filePath,
      text: `// ${path.basename(chunk.filePath)} (Signatures)\n${text}`,
      filePath: chunk.filePath,
      isAST: true,
      score: 0,
    });
  }

  return candidates;
};

const buildRagCandidates = async (taskText: string): Promise<RerankCandidate[]> => {
  const ragResults = await searchRAG(taskText, 20);
  return ragResults.map((result) => ({
    id: `rag_${result.filePath}`,
    text: result.content,
    filePath: result.filePath,
    isAST: false,
    score: 0,
  }));
};

const rerankCandidates = async (
  taskText: string,
  candidates: RerankCandidate[],
): Promise<{ candidates: RerankCandidate[]; rerankTime: number }> => {
  if (candidates.length === 0) return { candidates: [], rerankTime: 0 };

  console.log(`[Aether] Reranking ${candidates.length} candidates...`);
  const rerankStartTime = Date.now();
  const reranked = await rerank(taskText, candidates.map((candidate) => candidate.text), 15);
  const rerankTime = Date.now() - rerankStartTime;

  const finalCandidates = reranked
    .map((result) => {
      const candidate = candidates[result.index];
      if (candidate) {
        return { ...candidate, score: result.score };
      }
      return null;
    })
    .filter((candidate): candidate is RerankCandidate => candidate !== null);

  return { candidates: finalCandidates, rerankTime };
};

const buildTieredBudgetChunks = (
  chunks: Awaited<ReturnType<typeof extractForTask>>,
  activeFilePath: string | undefined,
  finalCandidates: RerankCandidate[],
): BudgetChunk[] => {
  const budgetChunks: BudgetChunk[] = [];

  if (activeFilePath) {
    const activeChunk = Array.from(graph?.nodes.values() ?? []).find((chunk) =>
      chunk.filePath.endsWith(activeFilePath) || activeFilePath.endsWith(chunk.filePath)
    );

    if (activeChunk) {
      const content = getFullFileContent(activeChunk.filePath);
      budgetChunks.push({
        id: "active_file_full",
        text: `// ACTIVE FILE: ${activeFilePath}\n${content}`,
        tokens: estimateTokens(content),
        score: 2000,
      });
    }
  }

  const top3 = finalCandidates.slice(0, 3);
  for (const candidate of top3) {
    const content = getFullFileContent(candidate.filePath);
    budgetChunks.push({
      id: `high_fid_${candidate.id}`,
      text: `// ${path.basename(candidate.filePath)} (Full Context)\n${content}`,
      tokens: estimateTokens(content),
      score: 100 + candidate.score * 10,
    });
  }

  for (const candidate of finalCandidates.slice(3, 15)) {
    budgetChunks.push({
      id: candidate.id,
      text: candidate.text,
      tokens: estimateTokens(candidate.text),
      score: candidate.score * 10,
    });
  }

  return budgetChunks;
};

const buildContextResponse = (
  msg: any,
  chunks: Awaited<ReturnType<typeof extractForTask>>,
  finalCandidates: RerankCandidate[],
  tokenBudget: number,
  activeFilePath: string | undefined,
  rerankTime: number,
): string => {
  const budgetChunks = buildTieredBudgetChunks(chunks, activeFilePath, finalCandidates);
  const budgetResult = applyBudget(tokenBudget, budgetChunks, []);
  const maxCyclomatic = chunks.reduce((max, chunk) => Math.max(max, chunk.cyclomaticScore ?? 1), 1);
  const reasoning = shouldThink(maxCyclomatic);

  return JSON.stringify({
    id: msg.id,
    type: "context:response",
    ts: Date.now(),
    payload: {
      tokenCount: budgetResult.budgetUsed.ast + budgetResult.budgetUsed.rag,
      confidence: 0.85,
      sections: {
        astContext: (reasoning === "think" ? "/think\n\n" : "") + "<ast_context>\n" + budgetResult.astContext + "\n</ast_context>",
        ragContext: budgetResult.ragContext ? "<rag_context>\n" + budgetResult.ragContext + "\n</rag_context>" : undefined,
      },
      meta: {
        astFiles: chunks.map((chunk) => path.basename(chunk.filePath)),
        reasoning,
        budgetUsed: budgetResult.budgetUsed,
        rerankTime,
      },
    },
  });
};

const handleContextRequest = async (msg: any): Promise<string> => {
  if (!graph) {
    return JSON.stringify({ id: msg.id, type: "error", payload: { message: "unknown" } });
  }

  const taskText = msg.payload.taskText ?? "";
  const tokenBudget = msg.payload.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const activeFilePath = msg.payload.activeFilePath;
  const chunks = extractForTask(taskText, graph);

  const candidates = [
    ...buildAstCandidates(chunks, activeFilePath).slice(0, MAX_AST_RERANK_CANDIDATES),
    ...(await buildRagCandidates(taskText)).slice(0, MAX_RAG_RERANK_CANDIDATES),
  ];

  const { candidates: reranked, rerankTime } = await rerankCandidates(taskText, candidates);

  return buildContextResponse(msg, chunks, reranked, tokenBudget, activeFilePath, rerankTime);
};

const handleRequest = async (raw: string): Promise<string> => {
  try {
    const msg = JSON.parse(raw)
    if (msg.type === "daemon:ping") {
      return JSON.stringify({ id: msg.id, type: "daemon:pong", ts: Date.now(), payload: {} })
    }
    if (msg.type === "daemon:status") {
      return JSON.stringify({
        id: msg.id,
        type: "daemon:status",
        ts: Date.now(),
        payload: {
          filesIndexed: manifest.size,
          queuePending: pendingJobs.size,
          graphNodes: graph.nodes.size,
        },
      })
    }
    if (msg.type === "context:request" && graph) {
      return handleContextRequest(msg)
    }
    return JSON.stringify({ id: msg.id, type: "error", payload: { message: "unknown" } })
  } catch (err: any) {
    console.error("[Daemon] Request Error:", err)
    return JSON.stringify({ type: "error", payload: { message: "parse error" } })
  }
}

const startServer = async () => {
  await initReranker();
  if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH)
  fs.mkdirSync(path.dirname(SOCK_PATH), { recursive: true })

  const server = net.createServer((socket) => {
    let buf = ""
    socket.on("data", async (chunk) => {
      buf += chunk.toString()
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim()) {
          const res = await handleRequest(line)
          socket.write(res + "\n")
        }
      }
    })
  })

  server.listen(SOCK_PATH, () => {
    fs.chmodSync(SOCK_PATH, 0o600)
    console.log(`[Aether] Daemon ready in ${Date.now() - daemonBootAt}ms — socket: ${SOCK_PATH}`)
  })

  process.on("SIGTERM", () => {
    server.close()
    if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH)
    process.exit(0)
  })
}

const startWatcher = () => {
  let debounceTimer: NodeJS.Timeout | null = null;
  const changedFiles = new Set<string>();

  const processChanges = async () => {
    const files = Array.from(changedFiles);
    changedFiles.clear();

    for (const filePath of files) {
      try {
        enqueueIndexJob({
          path: filePath,
          reason: fs.existsSync(filePath) ? "CHANGED" : "DELETED",
          priority: "HIGH",
          queuedAt: Date.now(),
        });
      } catch (err) {
        console.error(`[Aether] Error queueing ${filePath}:`, err);
      }
    }
  };

  // recursive: true is supported on macOS and Windows
  fs.watch(PROJECT_ROOT, { recursive: true }, (event, filename) => {
    if (!filename) return;
    // Basic filtering
    if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return;
    if (filename.includes("node_modules") || filename.includes("dist") || filename.includes(".git") || filename.includes(".aether")) return;

    const fullPath = path.join(PROJECT_ROOT, filename);
    changedFiles.add(fullPath);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processChanges, 300);
  });
};

const main = async () => {
  console.log(`[Aether] Initializing engines...`)
  try {
    await initRAG(hash);
    initSelector(hash);
  } catch (err: any) {
    console.error(`[Aether] Failed to init engines:`, err);
  }

  await processStartupDiff();
  startWatcher();

  await startServer();

  void reconcileStartupIndex();

  console.log(`[Aether] Background indexing worker armed`)
  queueDrainSoon();
}

try {
  await main();
} catch (err) {
  console.error("[Aether] Fatal daemon error:", err);
  process.exit(1);
}

