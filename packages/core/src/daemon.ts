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
  INDEXED_EXTENSIONS,
  type ASTChunk,
} from "./indexer/ast-extractor.js"
import type { ASTGraph } from "./indexer/ast-extractor.js"
import { buildRepoMap } from "./indexer/repo-map.js"
import { deleteFile as deleteRAGFile, initRAG, indexFile, searchRAG } from "./indexer/rag-indexer.js"
import { applyBudget, estimateTokens } from "./budget/budget-engine.js"
import type { BudgetChunk } from "./budget/budget-engine.js"
import { initSelector, classifyTask, recordTelemetry } from "./reasoning/selector.js"
import type { ClassificationResult } from "./reasoning/selector.js"
import { rerank, initReranker, checkRerankerHealth } from "./indexer/reranker.js"
import type { RerankResponse } from "./indexer/reranker.js"
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
const DEFAULT_TOKEN_BUDGET = 4096
const MAX_AST_RERANK_CANDIDATES = 15
const MAX_RAG_RERANK_CANDIDATES = 15
const CURRENT_AST_VERSION = 1
const CURRENT_RAG_VERSION = 2 // Bumped to force re-index after port/auth fix
const MANIFEST_FLUSH_DELAY_MS = 1500
const INDEX_BATCH_SIZE = 6
const INDEX_THROTTLE_MS = 120
const STARTUP_HIGH_PRIORITY_LIMIT = 10

// ─── Session context cache ───────────────────────────────────────────────────
// Avoids re-running the full AST+RAG pipeline for identical requests.
// Cache key: SHA-1 of (taskText + activeFilePath + tokenBudget + fileModifiedAt).
// TTL: 5 minutes as a safety net for dependency-graph changes that don't touch
// the active file directly.

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const TTL_CLEANUP_INTERVAL_MS = 60 * 1000 // 1 minute
let ttlCleanupTimer: NodeJS.Timeout | null = null

interface CacheEntry {
  response: string
  cachedAt: number
  projectId: string
}

interface ProjectCacheStats {
  projectId: string
  entryCount: number
  totalSize: number
  lastAccessedAt: number
}

const PROJECT_CACHE_STATS = new Map<string, ProjectCacheStats>()
const contextCache = new Map<string, CacheEntry>()
const MAX_CACHE_SIZE = 50
const MAX_PROJECTS_TRACKED = 100

/**
 * Compteur monotone, incrémenté à CHAQUE mutation de l'index (ajout, mise à jour,
 * suppression de fichier).
 *
 * La clé de cache de session ne dépendait que du mtime du fichier **actif** : la
 * modification d'un autre fichier — ou d'un fichier servant de candidat RAG —
 * pouvait donc servir un contexte périmé pendant tout le TTL (5 minutes).
 */
let contentVersion = 0

const makeCacheKey = (taskText: string, activeFilePath: string | undefined, tokenBudget: number): string => {
  let fileModifiedAt = 0
  if (activeFilePath) {
    try {
      const absPath = path.isAbsolute(activeFilePath)
        ? activeFilePath
        : path.resolve(PROJECT_ROOT, activeFilePath)
      if (fs.existsSync(absPath)) {
        fileModifiedAt = fs.statSync(absPath).mtimeMs
      }
    } catch { /* ignore stat errors */ }
  }
  return createHash("sha1")
    .update(
      `${taskText}\x00${activeFilePath ?? ""}\x00${tokenBudget}\x00${fileModifiedAt}\x00${contentVersion}`,
    )
    .digest("hex")
}

const purgeProjectCache = (projectId: string): void => {
  const projectIdResolved = path.resolve(projectId || PROJECT_ROOT)
  const stats = PROJECT_CACHE_STATS.get(projectIdResolved)
  
  if (!stats) {
    return
  }

  const keysToDelete: string[] = []
  for (const [key, entry] of contextCache.entries()) {
    if (entry.projectId === projectIdResolved) {
      keysToDelete.push(key)
    }
  }

  keysToDelete.forEach((key) => contextCache.delete(key))
  
  PROJECT_CACHE_STATS.delete(projectIdResolved)
  
  console.log(`[Aether] Cache purgé pour le projet ${projectIdResolved?.slice(0, 40)}... (${keysToDelete.length} entrées supprimées)`)
}

const getCachedContext = (key: string): string | null => {
  const entry = contextCache.get(key)
  if (!entry) return null
  
  const projectId = entry.projectId
  const stats = PROJECT_CACHE_STATS.get(projectId)
  
  if (stats) {
    stats.lastAccessedAt = Date.now()
    stats.entryCount = [...contextCache.values()].filter((e) => e.projectId === projectId).length
  }
  
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    contextCache.delete(key)
    
    if (stats) {
      stats.entryCount = [...contextCache.values()].filter((e) => e.projectId === projectId).length
      if (stats.entryCount === 0) {
        PROJECT_CACHE_STATS.delete(projectId)
      }
    }
    
    return null
  }
  
  return entry.response
}

const registerProjectAccess = (projectId: string): void => {
  const projectIdResolved = path.resolve(projectId || PROJECT_ROOT)
  
  if (!PROJECT_CACHE_STATS.has(projectIdResolved)) {
    PROJECT_CACHE_STATS.set(projectIdResolved, {
      projectId: projectIdResolved,
      entryCount: 0,
      totalSize: 0,
      lastAccessedAt: Date.now()
    })
  }
  
  const stats = PROJECT_CACHE_STATS.get(projectIdResolved)
  if (stats) {
    stats.lastAccessedAt = Date.now()
  }
}

const setCachedContext = (key: string, response: string): void => {
  const projectId = PROJECT_ROOT
  registerProjectAccess(projectId)
  
  // Evict entries from different projects if at capacity
  if (contextCache.size >= MAX_CACHE_SIZE) {
    const projectKeys = [...contextCache.keys()].filter((k) => {
      const entry = contextCache.get(k)
      return entry?.projectId !== projectId
    })
    
    for (const k of projectKeys.slice(0, Math.ceil(projectKeys.length / 2))) {
      contextCache.delete(k)
    }
    
    if (contextCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = contextCache.keys().next().value
      if (oldestKey) contextCache.delete(oldestKey)
    }
  }
  
  contextCache.set(key, { response, cachedAt: Date.now(), projectId })
  
  const stats = PROJECT_CACHE_STATS.get(projectId)
  if (stats) {
    stats.entryCount = [...contextCache.values()].filter((e) => e.projectId === projectId).length
    stats.totalSize += response.length
  }
}

const purgeCurrentProject = (): void => {
  const projectId = PROJECT_ROOT
  purgeProjectCache(projectId)
}

const startTTLCleanup = (): void => {
  ttlCleanupTimer = setInterval(() => {
    const now = Date.now()
    let purged = 0
    
    for (const [key, entry] of contextCache.entries()) {
      if (now - entry.cachedAt > CACHE_TTL_MS) {
        contextCache.delete(key)
        purged++
       }
     }
    
    if (purged > 0) {
      console.log(`[Aether] TTL cleanup: ${purged} entrées expirées`)
     }
    
    // Periodically compact PROJECT_CACHE_STATS
    const expiredProjects: string[] = []
    for (const [projectId, stats] of PROJECT_CACHE_STATS.entries()) {
      if (stats.entryCount === 0) {
        expiredProjects.push(projectId)
       }
     }
    
    for (const projectId of expiredProjects) {
      PROJECT_CACHE_STATS.delete(projectId)
     }
    
    const activeProjects = [...PROJECT_CACHE_STATS.values()].filter(
      (s) => s.entryCount > 0 && now - s.lastAccessedAt < CACHE_TTL_MS * 2
    ).length
    
    if (purged > 0 || expiredProjects.length > 0) {
      console.log(`[Aether] Project cache stats: ${activeProjects}/${PROJECT_CACHE_STATS.size} projets actifs`)
     }
  }, TTL_CLEANUP_INTERVAL_MS)
}

const stopTTLCleanup = (): void => {
  if (ttlCleanupTimer) {
    clearInterval(ttlCleanupTimer)
    ttlCleanupTimer = null
   }
}

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
    contentVersion++;
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    removeFileFromGraph(absolutePath, graph);
    contentVersion++;
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  const rawContent = fs.readFileSync(absolutePath, "utf8");
  const chunk = extractFileFromSource(absolutePath, rawContent);
  if (!chunk) {
    removeFileFromGraph(absolutePath, graph);
    contentVersion++;
    manifest.delete(relativePath);
    await deleteRAGFile(absolutePath);
    scheduleManifestFlush();
    return;
  }

  upsertFileInGraph(chunk, graph);

  contentVersion++;
  const indexed = await indexFile(absolutePath, rawContent);
  if (indexed.chunks === 0) {
    console.warn(`[Aether] Aucun fragment RAG indexé pour ${relativePath} (fichier vide ?)`);
  }

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

        if (entry.isFile() && INDEXED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
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
      contentVersion++;
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

const buildRagCandidates = async (
  taskText: string,
): Promise<{ candidates: RerankCandidate[]; degraded: boolean; reason: string | undefined }> => {
  const { results, degraded, reason } = await searchRAG(taskText, 20);

  return {
    degraded,
    reason,
    candidates: results.map((result, i) => ({
      // Un fichier produit désormais PLUSIEURS fragments (un par plage de lignes) :
      // l'id doit rester unique, sinon le budget les déduplique entre eux.
      id: `rag_${result.filePath}_${result.startLine}_${i}`,
      // L'en-tête donne au modèle de quoi citer des lignes précises.
      text:
        `// ${path.basename(result.filePath)}:${result.startLine}-${result.endLine}\n` +
        result.content,
      filePath: result.filePath,
      isAST: false,
      score: 0,
    })),
  };
};

/**
 * Le reranker ne doit JAMAIS bloquer le chemin de la requête.
 *
 * L'ancienne implémentation attendait jusqu'à 45 s (polling toutes les 1,5 s) le
 * démarrage à froid du cross-encoder, AVANT même d'envoyer le prompt au LLM :
 * 45 s ajoutées au TTFT de la première requête. La santé est désormais suivie en
 * tâche de fond ; en cas d'indisponibilité on retombe immédiatement sur l'ordre
 * du graphe AST (qui reste pertinent), sans attendre.
 */
let rerankerHealthy = false;
let rerankerHealthCheckedAt = 0;
let rerankerHealthInflight: Promise<void> | null = null;
const RERANKER_HEALTH_TTL_MS = 10_000;

const refreshRerankerHealth = async (): Promise<void> => {
  if (rerankerHealthInflight) return rerankerHealthInflight;
  const now = Date.now();
  if (now - rerankerHealthCheckedAt < RERANKER_HEALTH_TTL_MS) return;
  rerankerHealthCheckedAt = now;
  rerankerHealthInflight = (async () => {
    try {
      rerankerHealthy = await checkRerankerHealth();
    } catch {
      rerankerHealthy = false;
    } finally {
      rerankerHealthInflight = null;
    }
  })();
  return rerankerHealthInflight;
};

const rerankCandidates = async (
  taskText: string,
  candidates: RerankCandidate[],
): Promise<{ candidates: RerankCandidate[]; rerankTime: number; rerankFallback: boolean }> => {
  if (candidates.length === 0) return { candidates: [], rerankTime: 0, rerankFallback: false };

  // Rafraîchissement non bloquant : on lit l'état connu, la vérification se fait
  // en arrière-plan pour les requêtes suivantes.
  refreshRerankerHealth();
  if (!rerankerHealthy) {
    return { candidates, rerankTime: 0, rerankFallback: true };
  }

  console.log(`[Aether] Reranking ${candidates.length} candidates...`);
  const rerankStartTime = Date.now();
  const rerankResponse: RerankResponse = await rerank(taskText, candidates.map((c) => c.text), 15);
  const rerankTime = Date.now() - rerankStartTime;

  if (rerankResponse.fallback) {
    // Explicit fallback: return candidates in their original retrieval order
    // (BM25 for RAG, graph-score for AST). The caller will surface the warning.
    console.warn(`[Aether] ⚠️  Reranker fallback active: ${rerankResponse.reason}`);
    rerankerHealthy = false;
    rerankerHealthCheckedAt = Date.now();
    return { candidates, rerankTime, rerankFallback: true };
  }

  const SCORE_THRESHOLD = 0.05;
  const MIN_CANDIDATES = 2;

  const scored = rerankResponse.results
    .map((result) => {
      const candidate = candidates[result.index];
      if (candidate) return { ...candidate, score: result.score };
      return null;
    })
    .filter((c): c is RerankCandidate => c !== null);

  // Sort by descending score
  scored.sort((a, b) => b.score - a.score);

  // Qualitative threshold + guaranteed fallback
  const finalCandidates = scored.filter(c => c.score >= SCORE_THRESHOLD).length >= MIN_CANDIDATES
    ? scored.filter(c => c.score >= SCORE_THRESHOLD)
    : scored.slice(0, MIN_CANDIDATES);

  console.log(`[Aether] Rerank survival: ${finalCandidates.length}/${candidates.length} chunks (threshold=${SCORE_THRESHOLD})`);
  return { candidates: finalCandidates, rerankTime, rerankFallback: false };
};

const buildTieredBudgetChunks = async (
  chunks: ASTChunk[],
  activeFilePath: string | undefined,
  ideFiles: string[],
  finalCandidates: RerankCandidate[],
): Promise<{ astChunks: BudgetChunk[]; ragChunks: BudgetChunk[] }> => {
  const astChunks: BudgetChunk[] = [];
  const ragChunks: BudgetChunk[] = [];

  // ─── Tier 1: Active File ──────────────────────────────────────────────────
  if (activeFilePath) {
    const content = getFullFileContent(activeFilePath);
    if (content) {
      const astNodes = Array.from(graph?.nodes.values() ?? []);
      const activeChunk = astNodes.find((c) => c.filePath === activeFilePath);
      
      const requiredChunks: BudgetChunk["requiredChunks"] = [];
      if (activeChunk) {
        for (const dep of activeChunk.imports) {
          const depPath = astNodes.find(n => n.filePath.endsWith(dep) || dep.endsWith(n.filePath))?.filePath;
          if (depPath) requiredChunks.push({ id: `sig_${depPath}`, depthHint: "sig" });
        }
      }

      astChunks.push({
        id: "active_file_full",
        text: `// ACTIVE FILE: ${activeFilePath}\n${content}`,
        tokens: await estimateTokens(content),
        score: 2000,
        requiredChunks,
      });
    }
  }

  // ─── Tier 2: Surgical IDE Files ───────────────────────────────────────────
  for (const ideFile of ideFiles) {
    if (ideFile === activeFilePath) continue;

    const ideChunk = Array.from(graph?.nodes.values() ?? []).find((chunk) =>
      chunk.filePath.endsWith(ideFile) || ideFile.endsWith(chunk.filePath)
    );

    if (ideChunk) {
      const content = [
        `// SURGICAL CONTEXT (IDE File): ${ideFile}`,
        ...ideChunk.types.map(t => t.body),
        ...ideChunk.functions.map(f => 
          `${f.isExported ? 'export ' : ''}${f.isAsync ? 'async ' : ''}function ${f.name}(${f.params})${f.returnType ? `: ${f.returnType}` : ''}`
        ),
      ].join("\n");
      
      astChunks.push({
        id: `ide_file_surgical_${Buffer.from(ideFile).toString('base64').slice(0, 8)}`,
        text: content,
        tokens: await estimateTokens(content),
        score: 1500,
      });
    }
  }

  // ─── Tier 3: RAG Candidates ───────────────────────────────────────────────
  const top3 = finalCandidates.slice(0, 3);
  for (const candidate of top3) {
    const content = getFullFileContent(candidate.filePath);
    ragChunks.push({
      id: `high_fid_${candidate.id}`,
      text: `// ${path.basename(candidate.filePath)} (Full Context)\n${content}`,
      tokens: await estimateTokens(content),
      score: 100 + candidate.score * 10,
    });
  }

  for (const candidate of finalCandidates.slice(3, 15)) {
    ragChunks.push({
      id: candidate.id,
      text: candidate.text,
      tokens: await estimateTokens(candidate.text),
      score: candidate.score,
    });
  }

  return { astChunks, ragChunks };
};

const buildContextResponse = async (
  msg: any,
  chunks: Awaited<ReturnType<typeof extractForTask>>,
  finalCandidates: RerankCandidate[],
  classification: ClassificationResult,
  activeFilePath: string | undefined,
  ideFiles: string[],
  rerankTime: number,
  rerankFallback: boolean,
  ragDegraded: boolean,
  ragReason: string | undefined,
): Promise<string> => {
  const { astChunks, ragChunks } = await buildTieredBudgetChunks(chunks, activeFilePath, ideFiles, finalCandidates);
  const budgetResult = await applyBudget(classification.budgetTokens, astChunks, ragChunks);
  const reasoning = classification.requiresThinking ? "think" : "no_think";
  console.log(`[Aether] Budget used: AST=${budgetResult.budgetUsed.ast} tok, RAG=${budgetResult.budgetUsed.rag} tok`);
  console.log(`[Aether] Final context lengths: AST=${budgetResult.astContext.length} chars, RAG=${budgetResult.ragContext.length} chars`);

  return JSON.stringify({
    id: msg.id,
    type: "context:response",
    ts: Date.now(),
    payload: {
      tokenCount: budgetResult.budgetUsed.ast + budgetResult.budgetUsed.rag,
      confidence: classification.confidence,
      sections: {
        astContext: (reasoning === "think" ? "/think\n\n" : "") + "<ast_context>\n" + budgetResult.astContext + "\n</ast_context>",
        ragContext: budgetResult.ragContext ? "<rag_context>\n" + budgetResult.ragContext + "\n</rag_context>" : undefined,
      },
      meta: {
        astFiles: chunks.map((chunk) => path.basename(chunk.filePath)),
        reasoning,
        budgetUsed: budgetResult.budgetUsed,
        rerankTime,
        taskType: classification.taskType,
        classifierConfidence: classification.confidence,
        rerankFallback,
        // Indisponibilité de l'index/embeddings : le client doit pouvoir le signaler
        // au lieu de croire à une absence de résultats pertinents.
        ragDegraded,
        ragReason,
      },
    },
  });
};

const handleContextRequest = async (msg: any): Promise<string> => {
  if (!graph) {
    return JSON.stringify({ id: msg.id, type: "error", payload: { message: "unknown" } });
  }

  const taskText: string = msg.payload.taskText ?? "";
  const activeFilePath: string | undefined = msg.payload.activeFilePath;
  const ideFiles: string[] = msg.payload.ideFiles ?? [];

  // ── 1. Classify the task to derive dynamic budget & thinking mode ──────────
  const classification = classifyTask(taskText);
  // Respect an explicit budget override from the IDE (e.g. user slider), but
  // never go below the classifier's recommendation.
  const requestedBudget: number = msg.payload.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  // Plancher abaissé de 8 000 à 2 048 : le contexte volatil est repayé à chaque
  // tour (il change), et le préfill coûte ~3,6 ms/token sur cette machine.
  const classifierBudget = Math.max(2048, classification.budgetTokens);
  const effectiveBudget = Math.min(requestedBudget, classifierBudget);
  const effectiveClassification: ClassificationResult = {
    ...classification,
    budgetTokens: effectiveBudget,
  };

  // ── 2. Session cache lookup ────────────────────────────────────────────────
   const projectId = PROJECT_ROOT
   registerProjectAccess(projectId)
   
   const cacheKey = makeCacheKey(taskText, activeFilePath, effectiveBudget);
   const cached = getCachedContext(cacheKey);
   if (cached) {
     console.log(`[Aether] Cache HIT for key ${cacheKey.slice(0, 8)}… (taskType=${classification.taskType})`);
     return cached;
    }
   console.log(`[Aether] Cache MISS for key ${cacheKey.slice(0, 8)}… (taskType=${classification.taskType})`);

  // ── 3. Context extraction ─────────────────────────────────────────────────
  const chunks = extractForTask(taskText, graph);

  const rag = await buildRagCandidates(taskText);
  if (rag.degraded) {
    console.warn(`[Aether] ⚠️  RAG dégradé : ${rag.reason ?? "raison inconnue"}`);
  }

  const candidates = [
    ...buildAstCandidates(chunks, activeFilePath).slice(0, MAX_AST_RERANK_CANDIDATES),
    ...rag.candidates.slice(0, MAX_RAG_RERANK_CANDIDATES),
  ];

  // ── 4. Reranking (with explicit fallback handling) ─────────────────────────
  const { candidates: reranked, rerankTime, rerankFallback } = await rerankCandidates(taskText, candidates);

  // ── 5. Build response ─────────────────────────────────────────────────────
  const response = await buildContextResponse(
    msg, chunks, reranked, effectiveClassification, activeFilePath, ideFiles,
    rerankTime, rerankFallback, rag.degraded, rag.reason,
  );

  // ── 6. Cache & telemetry ──────────────────────────────────────────────────
  setCachedContext(cacheKey, response);
  recordTelemetry(effectiveClassification, effectiveClassification.requiresThinking ? "think" : "no_think", true);

  return response;
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
           cacheSize: contextCache.size,
           projectsTracked: PROJECT_CACHE_STATS.size,
          },
        })
       }
     if (msg.type === "context:invalidate") {
       purgeCurrentProject()
       return JSON.stringify({ id: msg.id, type: "context:invalidated", ts: Date.now(), payload: {} })
       }
     if (msg.type === "context:request" && graph) {
       return handleContextRequest(msg)
       }
     // Repo-map par signatures : bloc *stable* destiné au préfixe du prompt.
     // Il change uniquement quand le code change, pas à chaque requête.
     if (msg.type === "repo:map" && graph) {
       const tokenBudget = Number.parseInt(String(msg.payload?.tokenBudget ?? 1500), 10)
       const map = buildRepoMap(graph, { tokenBudget })
       return JSON.stringify({
         id: msg.id,
         type: "repo:map:response",
         ts: Date.now(),
         payload: map,
       })
       }
     return JSON.stringify({ id: msg.id, type: "error", payload: { message: "unknown" } })
    } catch (err: any) {
     console.error("[Daemon] Request Error:", err)
     return JSON.stringify({ type: "error", payload: { message: "parse error" } })
    }
}

const startServer = async () => {
  await initReranker();

  // Sonde de santé NON bloquante. Le démarrage du daemon ne doit pas être
  // retardé par le chargement à froid du cross-encoder : le socket doit être
  // disponible immédiatement, et les requêtes retombent sur l'ordre du graphe
  // AST tant que le reranker n'est pas prêt.
  rerankerHealthCheckedAt = 0;
  await refreshRerankerHealth();
  console.log(
    `[Aether] Reranker health at startup: ${rerankerHealthy ? "✅ OK" : "⚠️  indisponible (repli sur l'ordre AST, sondage en tâche de fond)"}`,
  );
   startTTLCleanup()
   
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
     stopTTLCleanup()
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
    if (!INDEXED_EXTENSIONS.some((ext) => filename.endsWith(ext))) return;
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

