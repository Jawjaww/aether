// packages/core/src/budget/budget-engine.ts

export interface BudgetChunk {
  id: string;
  text: string;
  tokens: number;
  score: number; // Importance (higher is better)
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

// Simple token estimation: 1 token ≈ 4 characters
export const estimateTokens = (text: string): number => {
  return Math.max(1, Math.floor(text.length / 4));
};

export const applyBudget = (
  tokenBudget: number,
  astChunks: BudgetChunk[],
  ragChunks: BudgetChunk[]
): BudgetResult => {
  // Sort by score descending for greedy knapsack
  const sortedAst = [...astChunks].sort((a, b) => b.score - a.score);
  const sortedRag = [...ragChunks].sort((a, b) => b.score - a.score);

  let remainingBudget = tokenBudget;
  let astTokensUsed = 0;
  let ragTokensUsed = 0;

  const selectedAst: string[] = [];
  const selectedRag: string[] = [];

  // Tier 1: AST (Highest priority)
  for (const chunk of sortedAst) {
    if (chunk.tokens <= remainingBudget) {
      selectedAst.push(chunk.text);
      remainingBudget -= chunk.tokens;
      astTokensUsed += chunk.tokens;
    }
  }

  // Tier 2: RAG
  for (const chunk of sortedRag) {
    if (chunk.tokens <= remainingBudget) {
      selectedRag.push(chunk.text);
      remainingBudget -= chunk.tokens;
      ragTokensUsed += chunk.tokens;
    }
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
