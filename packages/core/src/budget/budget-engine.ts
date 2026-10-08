// packages/core/src/budget/budget-engine.ts
//
// Token-accurate budget engine for the Aether Context Pipeline.
//
// Key changes vs. original:
//  1. estimateTokens() now uses @dqbd/tiktoken (cl100k_base, Qwen-compatible)
//     via a lazy-initialized singleton to avoid async race at module load time.
//  2. BudgetChunk gains `requiredChunks?: { id: string; depthHint: "sig" | "full" }[]`
//     so the knapsack can enforce AST-dependency coherence.
//  3. applyBudget() is now async and dependency-aware:
//     before greedy selection it propagates scores from dependents down to their
//     dependencies so a required interface always enters the budget when its
//     concrete implementation does.

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single budgetable chunk of context. */
export interface BudgetChunk {
  id: string;
  text: string;
  tokens: number;
  score: number; // Higher is more important
  /**
   * AST dependencies that should accompany this chunk.
   * "sig" → include AST signatures only (interfaces, types, constants)
   * "full" → include full file text (concrete functions whose behaviour matters)
   */
  requiredChunks?: { id: string; depthHint: "sig" | "full" }[];
}

export interface BudgetResult {
  astContext: string;
  ragContext: string;
  budgetUsed: {
    ast: number;
    rag: number;
    history: number;
  };
}

// ─── Tiktoken singleton (lazy async) ─────────────────────────────────────────
//
// @dqbd/tiktoken loads WASM on first call. We defer initialisation until the
// first token count request so the module can be imported synchronously during
// daemon startup without triggering a race condition.

type TiktokenInstance = { encode: (text: string) => Uint32Array; free?: () => void };
let _enc: TiktokenInstance | null = null;
let _encPending: Promise<TiktokenInstance> | null = null;

const getEncoder = async (): Promise<TiktokenInstance> => {
  if (_enc) return _enc;
  if (_encPending) return _encPending;

  _encPending = (async () => {
    try {
      // @ts-ignore — optional peer dependency; may not be installed in all envs
      const { get_encoding } = await import("@dqbd/tiktoken");
      _enc = get_encoding("cl100k_base"); // Compatible with Qwen, GPT-4 family
      return _enc;
    } catch {
      // Graceful degradation: return a mock encoder that uses the length heuristic
      const fallback: TiktokenInstance = {
        encode: (text: string) => new Uint32Array(Math.max(1, Math.ceil(text.length / 4))),
      };
      _enc = fallback;
      return fallback;
    }
  })();

  return _encPending;
};

/**
 * Count tokens with high fidelity using cl100k_base encoding (Qwen-compatible).
 * Falls back to `length / 4` if tiktoken WASM is unavailable.
 */
export const estimateTokens = async (text: string): Promise<number> => {
  const enc = await getEncoder();
  try {
    return enc.encode(text).length;
  } catch {
    return Math.max(1, Math.ceil(text.length / 4));
  }
};

// ─── Dependency-aware greedy knapsack ─────────────────────────────────────────

/**
 * Propagate dependent scores down to required chunks so that if chunk A (score 0.9)
 * requires chunk B (score 0.3), B's effective score becomes max(0.3, 0.9 - ε).
 * This ensures B always enters the budget when A does.
 */
const propagateDependencyScores = (chunks: BudgetChunk[]): Map<string, number> => {
  const scoreMap = new Map<string, number>(chunks.map((c) => [c.id, c.score]));

  // Single-pass propagation (sufficient for one level of direct imports)
  for (const chunk of chunks) {
    if (!chunk.requiredChunks?.length) continue;
    const parentScore = scoreMap.get(chunk.id) ?? chunk.score;
    for (const dep of chunk.requiredChunks) {
      const current = scoreMap.get(dep.id) ?? 0;
      // Give the dependency a score just below the parent so it is selected after
      // the parent but before any unrelated lower-priority chunks.
      if (parentScore - 0.01 > current) {
        scoreMap.set(dep.id, parentScore - 0.01);
      }
    }
  }

  return scoreMap;
};

/**
 * Async, token-accurate, dependency-aware greedy knapsack budget allocation.
 *
 * Algorithm:
 *  1. Propagate scores through `requiredChunks` edges so dependencies inherit
 *     their dependent's priority.
 *  2. Sort by effective score descending.
 *  3. Greedily select chunks that fit in the remaining budget.
 *  4. When a selected chunk has `requiredChunks`, immediately try to insert
 *     the required chunks (if not already selected) to maintain AST coherence.
 */
export const applyBudget = async (
  tokenBudget: number,
  astChunks: BudgetChunk[],
  ragChunks: BudgetChunk[],
): Promise<BudgetResult> => {
  const effectiveScores = propagateDependencyScores([...astChunks, ...ragChunks]);

  const sortedAst = [...astChunks].sort(
    (a, b) => (effectiveScores.get(b.id) ?? b.score) - (effectiveScores.get(a.id) ?? a.score),
  );
  const sortedRag = [...ragChunks].sort(
    (a, b) => (effectiveScores.get(b.id) ?? b.score) - (effectiveScores.get(a.id) ?? a.score),
  );

  let remaining = tokenBudget;
  let astTokensUsed = 0;
  let ragTokensUsed = 0;

  const selectedIds = new Set<string>();
  const selectedAst: string[] = [];
  const selectedRag: string[] = [];

  const allChunksById = new Map<string, BudgetChunk>(
    [...astChunks, ...ragChunks].map((c) => [c.id, c]),
  );

  const trySelect = (chunk: BudgetChunk, targetList: string[], isAst: boolean): boolean => {
    if (selectedIds.has(chunk.id)) return true; // Already included
    if (chunk.tokens > remaining) return false;

    selectedIds.add(chunk.id);
    targetList.push(chunk.text);
    remaining -= chunk.tokens;
    if (isAst) astTokensUsed += chunk.tokens;
    else ragTokensUsed += chunk.tokens;
    return true;
  };

  // --- 1. Réserve RAG (30 % du budget total) ---
  //
  // Bug corrigé : `trySelect` testait `remaining`, c'est-à-dire le budget TOTAL.
  // L'AST pouvait donc consommer 100 % du budget et affamer complètement le RAG ;
  // `astBudget` n'était utilisé que dans une branche quasi morte. La passe AST est
  // désormais réellement bornée, et la réserve RAG est effective.
  const ragReserve = Math.floor(tokenBudget * 0.3);
  const astBudget = tokenBudget - ragReserve;

  /** Passe AST bornée par `limit` tokens, dépendances incluses si elles tiennent. */
  const astPass = (limit: number): void => {
    for (const chunk of sortedAst) {
      if (astTokensUsed + chunk.tokens > limit) continue;
      trySelect(chunk, selectedAst, true);

      for (const dep of chunk.requiredChunks ?? []) {
        const depChunk = allChunksById.get(dep.id);
        if (!depChunk) continue;
        if (astTokensUsed + depChunk.tokens <= limit) {
          trySelect(depChunk, selectedAst, true);
        }
      }
    }
  };

  astPass(astBudget);

  // --- 2. Passe RAG : la réserve de 30 % + ce que l'AST n'a pas consommé ---
  remaining = tokenBudget - astTokensUsed;
  for (const chunk of sortedRag) {
    trySelect(chunk, selectedRag, false);
  }

  // --- 3. « Use it or lose it » ---
  // Si le RAG n'a pas rempli sa réserve (peu de candidats, ou chunks trop gros),
  // l'AST récupère la place au lieu de la laisser vide. Sans cette passe, un gros
  // chunk AST utile était écarté alors que personne ne consommait le budget.
  if (ragTokensUsed < ragReserve) {
    astPass(tokenBudget - ragTokensUsed);
  }

  return {
    astContext: selectedAst.join("\n\n"),
    ragContext: selectedRag.join("\n\n"),
    budgetUsed: {
      ast: astTokensUsed,
      rag: ragTokensUsed,
      history: 0,
    },
  };
};
