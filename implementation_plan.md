# Aether Architecture Audit Fixes

This implementation plan addresses the five critical/high/medium priority issues identified in your codebase audit to improve the reliability, precision, and performance of the Aether Context Engine.

## User Review Required

> [!IMPORTANT]
> - Adding `@dqbd/tiktoken` introduces a WASM dependency. It is well-supported but please confirm if there are any constraints with WASM in your environment.
> - The task classifier heuristically scores tasks into discrete categories instead of using the raw cyclomatic score. Review the categorization heuristics proposed in `selector.ts` below.
> - The reranker fallback behavior will now explicitly surface a warning instead of degraded results. The IDE client should be ready to handle the `reasoning: "reranker_unavailable"` meta flag.

## Open Questions

> [!WARNING]
> - **Dependency Graph:** When `chunk A` imports `chunk B`, does `chunk A` *require* `chunk B`'s full file text (`high_fid_...`) or just its AST signatures (`chunk.id`)? I will assume it requires the AST signatures (`chunk.id`) for contract visibility, unless you specify otherwise.
> - **Session Cache Key:** I plan to hash the `taskText`, `activeFilePath`, and `tokenBudget`. Is there any other state (like cursor position or diagnostic errors) that should invalidate the cache?

## Proposed Changes

---

### @aether/core

#### [MODIFY] `package.json`
- Add `@dqbd/tiktoken` to dependencies for precise token counting.

#### [MODIFY] `packages/core/src/budget/budget-engine.ts`
- **Tiktoken Integration:** Replace the naïve `length / 4` calculation with `@dqbd/tiktoken` `cl100k_base` encoding.
- **Dependency-Aware Knapsack:**
  - Add `requiredChunks?: string[]` to the `BudgetChunk` interface.
  - Before greedy selection, propagate the highest score from dependent chunks down to their dependencies so a required interface (`UserService`) inherits the high score of its implementation (`UserServiceImpl`).
  - Modify the loop to ensure that when a chunk is selected, its unresolved `requiredChunks` are also pulled into the budget (if they fit).

#### [MODIFY] `packages/core/src/reasoning/selector.ts`
- **Task Classifier:** Replace the cyclomatic-only thresholding with a heuristic `TaskType` classifier based on `taskText` (e.g., regex checks for words like "refactor", "bug", "explain", "test").
- **Dynamic Budgets:** Export a `BUDGET_BY_TASK` mapping (`read_local: 3000`, `write_local: 5000`, `cross_file: 10000`, `debug: 12000`, `generate_tests: 6000`).
- Update `shouldThink` to determine thinking requirement based on the classified task complexity rather than just the AST depth.

#### [MODIFY] `packages/core/src/indexer/reranker.ts`
- **Explicit Fallback:** Change the `catch` block to return `{ results: [], fallback: true, reason: "reranker_unavailable" }` instead of a dummy zero-score array.
- Update `RerankResult` interface to support these fallback fields.

#### [MODIFY] `packages/core/src/daemon.ts`
- **Session Cache:** Introduce a basic LRU or Map-based cache that hashes `(taskText + activeFilePath + tokenBudget)` and stores the generated context response. Skip extraction and reranking entirely if a cache hit occurs.
- **Reranker Integration:** Handle the explicit fallback flag from `rerankCandidates()`. If `fallback: true`, inject a warning in the response payload metadata so the IDE can inform the user.
- **Dependency Edge Translation:** When calling `buildTieredBudgetChunks`, map the `ASTGraph` dependency edges to the new `requiredChunks` property on `BudgetChunk`.
- **Task Classification Integration:** Pass `taskText` to the new task classifier from `selector.ts` to retrieve dynamic budget bounds and thinking requirements.

---

### Root / Infrastructure

#### [NEW] `pyproject.toml`
- Create a `pyproject.toml` file at the root (or under `packages/core/reranker/`) to define the Python dependencies (`torch`, `transformers`, `fastapi`, `uvicorn`, `pydantic`) for the reranker server, making it installable in one command.

#### [MODIFY] `AETHER_PLAN.md`
- Update Phase 2 of the roadmap to include:
  - Session context cache (hash-based reuse)
  - Heuristic task classifier for dynamic budgets
  - Real token counting (tiktoken)
  - Health check & circuit breaker for the reranker
  - AST dependency graph integration for knapsack coherence

## Verification Plan

### Automated Tests
- Run `npm run typecheck` and `npm run build` in `@aether/core` to verify TypeScript typings and build integrity.

### Manual Verification
1. Start the Aether daemon and trigger a context request to verify that the session cache returns instantly on the second identical request.
2. Monitor daemon logs to confirm that `budget-engine` correctly propagates scores for AST dependencies and includes them in the context.
3. Stop the Python reranker server to trigger the fallback state, and verify the daemon responds gracefully with the `fallback` flag in the metadata instead of zero-scored results.
