# AETHER PLAN

> **Status note (7 October 2026).** This document mixes the original vision with
> claims about what the code does. Several claims were found to be **false or
> aspirational** by the October 2026 audit — they are corrected inline below and
> marked `[audit]`. For measured reality, see
> [`docs/AUDIT-2026-10.md`](docs/AUDIT-2026-10.md). For the architecture actually
> implemented, see [QUICKSTART.md](QUICKSTART.md).

## Overview

Aether runs **alongside** an IDE agent (KiloCode, Roo Code, OpenCode, Cursor) —
it is not itself an IDE. `[audit]` It is a context layer between that agent and
oMLX: it retrieves context, keeps it small and stable, and assembles the prompt so
the engine's prefix cache survives between turns.

An IDE of its own was part of the original plan; the shipped artefact is the
gateway + daemon + dashboard described below.

---

## High-Level Architecture

```text
┌─────────────────────────────────────────────────────────┐
│         IDE agent (KiloCode / Roo Code / Cursor)         │
├─────────────────────────────────────────────────────────┤
│  Aether Gateway (:8080) - payload assembly & telemetry   │
│  • Stable-prefix / volatile-tail prompt assembly         │
│  • Tools preserved (never stripped)                      │
│  • Token accounting, JSONL logs, dashboard               │
├─────────────────────────────────────────────────────────┤
│  Core Daemon (Unix socket)                               │
│  • AST extraction (tree-sitter: TS/JS; heuristic: py/go/rs)│
│  • Signature repo-map (stable prefix block)              │
│  • Chunked RAG indexing (LanceDB, line offsets)          │
│  • File watchman, incremental re-index                   │
├─────────────────────────────────────────────────────────┤
│  Unified ML Server (:8082)                               │
│  • BGE-v2-m3 cross-encoder (MPS)                         │
│  • FastEmbed embeddings (MPS)                            │
├─────────────────────────────────────────────────────────┤
│  oMLX (:8000) — inference                                │
│  • MLX on Apple Silicon                                  │
│  • Paged SSD prefix cache (opt-in)                       │
└─────────────────────────────────────────────────────────┘
```

`[audit]` Corrections to this diagram:
- **AST extraction is not Swift.** It is tree-sitter for `.ts/.tsx/.js/.jsx/.mjs/.cjs`,
  plus a **heuristic** extractor for `.py/.go/.rs` (the compatible grammars are not
  installable — see QUICKSTART's "What Aether does not do").
- **Inference is not port 8081 and is not started with `mlx_lm.server`.** It is
  oMLX on port **8000**. Aether used to launch the engine with arguments oMLX does
  not accept, so the engine never started; the launch command is now correct and
  verified against the real binary.
- **The "LSP proxy" and "MCP server integration" boxes are aspirational.** There is
  no LSP proxy, and MCP servers are consumed as ordinary tools by the client, not
  hosted by Aether.

---

## The Supernova Pipeline

`[audit]` The pipeline below is the **original design**. What runs today is
simpler and its stages differ; each is annotated.

### 1. Classification

`[audit]` Implemented, but not as described. There is no
"Active Focus / Peripheral Awareness" split based on editor metadata. A heuristic
classifier maps the request text to a task type (`read_local`, `write_local`,
`cross_file`, `debug`, `generate_tests`) with a confidence score, which selects a
token budget and whether extended thinking is requested
(`packages/core/src/reasoning/selector.ts`).

### 2. Retrieval

Hybrid retrieval, as implemented:

- **AST signatures** via tree-sitter for the JS/TS family, heuristic signatures
  elsewhere. The graph is in memory, updated incrementally.
- **RAG candidates** from LanceDB — chunked (~400 tokens) with `startLine`/`endLine`
  so results can be cited precisely. `[audit]` Previously a single record per file,
  truncated to 3 000 characters.
- **Signature repo-map** — a deterministic table of contents, priority-ordered by
  how many files import each file. It lives in the **stable prefix**, not in the
  per-turn context.
- **File watchman** tracks changed files and re-indexes only those.

### 3. Surgical Reranking

Candidates are reranked by a BGE-v2-m3 cross-encoder on MPS. `[audit]` This is an
**optimisation, not a dependency**: the reranker is optional and its health is
polled in the background, never on the request path. When it is unavailable,
retrieval falls back to AST graph order immediately. The original code blocked the
request for up to 45 s waiting for a cold start, and the gateway waited another
60 s for the daemon; both are fixed and tested.

### 4. Budget Reconstruction

`[audit]` The budget is a single `TOKEN_BUDGET` (default **4 096**, not 16 384) for
the **volatile** block, allocated by a dependency-aware greedy knapsack with a 30 %
reserve for RAG. Why 4 096: prefill costs **~3.6 ms per token** on an M1 Max, so
16 k tokens is ~58 s of TTFT — measured, not estimated.

---

## Local LLM Integration

### Quantization Strategy

`[audit]` There is no "three-tier policy" and no "Qwen3.6-35B-Q4" default. Aether
does not quantize anything: you choose the model, oMLX serves it. What the audit
recommends for this class of machine is a 4-bit MLX build (~19 GB) rather than the
8-bit one (~34 GB) that was configured, both because it halves the bytes read per
token and because it removes the swap pressure.

### Context Window Management

- **Input window**: `[audit]` "16k max (practical limit for Apple Silicon)" was a
  2024–2025 assumption. It is no longer true — effective context is bounded by
  **prefill time**, not by an architectural limit.
- **Output window**: `[audit]` not imposed by Aether. `max_tokens` is only set when
  you configure it, so oMLX's per-model profile applies.
- **Prompt compression**: `[audit]` not implemented. Context reduction is done by
  selection (budget, repo-map, AST/RAG), not by summarisation.

---

## Performance Metrics

`[audit]` The original targets below were never measured, and some were
unreachable. Measured values from the audit (M1 Max 64 GB, Qwen3.6-35B-A3B 8-bit)
are given for comparison.

| Operation | Original target | Measured |
|-----------|----------------|----------|
| AST extraction | <50 ms | not measured; tree-sitter parse per file, incremental |
| Semantic search | <200 ms | bounded by a 3 s hard budget on the daemon reply |
| Reranking | <500 ms | 1.5 s hard timeout, then immediate fallback |
| LLM first token | <2 s | **8.2 s** with a warm stable prefix; **48–58 s** cold at 14–16 k tokens |
| Full response | <10 s | depends entirely on prefill + decode |

### Memory Budget

`[audit]` The original table (`Total: <12 GB`) does not match reality. Measured:

- **Gateway**: tens of MB (Node process) — the original 50 MB estimate is plausible.
- **Daemon**: 2 GB (AST graph + RAG) — plausible for medium repositories.
- **Inference**: **34 GB** with the 8-bit `Qwen3.6-35B-A3B` that was configured
  (38.5 GB peak at 32 k context), on a 64 GB machine that was already using
  **11–14 GB of swap**. A 4-bit build of the same model is ~19 GB.

---

## Security & Privacy

Largely accurate, with one correction.

### Data Isolation

- **Zero external API calls for inference**: true — everything runs locally.
- **Local vector store**: LanceDB under `~/.aether/projects/<hash>/lancedb`.
  `[audit]` *(not `./data/vector.db` as written here)*.
- **Sandboxed MCP servers**: `[audit]` not implemented. MCP servers are the
  client's business; Aether neither hosts nor sandboxes them.

### Model Integrity

- **No cloud dependencies**: true for model *inference*. `[audit]` Model
  *downloads* do happen (`huggingface-cli`/`hf`), and the engine is started with
  `HF_HUB_OFFLINE=1` to prevent runtime fetches.
- **SHA-256 verification of models**: `[audit]` **not implemented.** Reads come
  from local safetensors; there is no hash check against known-good values.

---

## Roadmap

Status as of 7 October 2026, corrected against the code.

### Phase 1 — Foundation `[done]`

- [x] AST extraction (TypeScript/JavaScript via tree-sitter; Python/Go/Rust heuristically)
- [x] LanceDB integration
- [x] Streaming responses
- [x] Incremental indexing with a file watchman

`[audit]` "Qwen3.6-35B-Q4 quantization" and "MCP server integration" were checked
but Aether does neither: it serves whatever oMLX has loaded, and tools/MCP come
from the client.

### Phase 2 — Reliability & Precision `[done, with corrections]`

- [x] **Token counting** — `[audit]` was silently falling back to `length / 4`
      because `encoding_for_model("Qwen3.6-…")` throws for non-OpenAI names. Now a
      memoised `cl100k_base` encoder. Still an approximation: cl100k is **not** the
      Qwen tokenizer.
- [x] **Reranker circuit-breaker** — `[audit]` the 8 s timeout existed, but the
      caller still blocked up to 45 s on cold start. Now non-blocking, 1.5 s budget.
- [x] **Task classifier** — heuristic task types driving the token budget.
- [x] **Unified ML server** — port 8082, BGE reranking + FastEmbed embeddings.
- [x] **oMLX integration** — `[audit]` the engine was launched with arguments oMLX
      rejects, so this never worked. Fixed and verified against the real binary;
      the SSD prefix cache is now enabled explicitly.

### Phase 3 — Advanced Optimization

- [x] **Cache-safe payload assembly** — `[audit]` the previous "surgical payload
      rebuilding" claimed *100 % KV-cache hit* while injecting the volatile context
      into the **system message**, which invalidates every cached block. Replaced by
      stable-prefix / volatile-tail assembly, measured at **×5.9 on TTFT**.
- [x] **Signature repo-map** in the stable prefix.
- [x] **Chunked RAG with line offsets.**
- [x] **Bounded pre-processing** — every daemon call has a hard timeout.
- [ ] Multi-LLM routing (routing tasks between Qwen variants by complexity).
- [ ] Real-time AST analysis for predictive completion.
- [ ] Cross-file refactoring engine.
- [ ] Telemetry auto-calibration loop.
- [ ] **Runtime currency** — the installed oMLX is 30 versions behind; several
      published fixes target this exact machine and model family.
