// packages/core/src/indexer/reranker.ts
//
// Surgical Reranking Client — calls the Python reranker server on port 8082.
//
// Key changes vs. original:
//  1. Explicit fallback: returns { results: [], fallback: true } instead of
//     zero-scored phantoms when the server is unreachable.
//  2. checkRerankerHealth() — proactive ping with 500 ms timeout for startup
//     health checks and Gateway /status exposure.
//  3. Type-safe RerankResult with fallback discriminant.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RerankResult {
  index: number;
  score: number;
}

export type RerankResponse =
  | { results: RerankResult[]; fallback: false }
  | { results: []; fallback: true; reason: string };

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Proactive health ping — safe to call at daemon startup and to expose via
 * the Gateway /aether/engine/status endpoint.
 * Uses a 500 ms timeout to avoid blocking the daemon boot sequence.
 */
export const checkRerankerHealth = async (): Promise<boolean> => {
  try {
    const res = await fetch("http://127.0.0.1:8082/health", {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// ─── Init ─────────────────────────────────────────────────────────────────────

export const initReranker = async (): Promise<void> => {
  const healthy = await checkRerankerHealth();
  if (healthy) {
    console.log("[Reranker] ✅ Python server reachable on 127.0.0.1:8082");
  } else {
    console.warn(
      "[Reranker] ⚠️  Python server not reachable on 127.0.0.1:8082 — will use fallback mode until it becomes available",
    );
  }
};

// ─── Rerank ───────────────────────────────────────────────────────────────────

/**
 * Call the Python cross-encoder to rerank `documents` for `query`.
 *
 * On success: returns scored, sorted results (top `topN`).
 * On failure: returns an explicit fallback object — the caller must handle
 *   the `fallback: true` case and surface a warning to the user instead of
 *   silently returning degraded (BM25-order, zero-scored) results.
 */
export const rerank = async (
  query: string,
  documents: string[],
  topN: number = 15,
): Promise<RerankResponse> => {
  if (documents.length === 0) return { results: [], fallback: false };

  try {
    // Budget strict : le reranker est une optimisation de précision, pas une
    // dépendance dure. Il est appelé dans le chemin du TTFT ; au-delà de cette
    // limite on préfère l'ordre du graphe AST à 8 s d'attente.
    const timeoutMs = Number.parseInt(process.env.AETHER_RERANK_TIMEOUT_MS ?? "1500", 10);
    const response = await fetch("http://127.0.0.1:8082/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { results: RerankResult[] };

    return {
      results: data.results.sort((a, b) => b.score - a.score).slice(0, topN),
      fallback: false,
    };
  } catch (err) {
    console.error("[Reranker] ❌ Rerank request failed — activating fallback mode:", err);
    return {
      results: [],
      fallback: true,
      reason: err instanceof Error ? err.message : "reranker_unavailable",
    };
  }
};
