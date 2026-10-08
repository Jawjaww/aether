# Aether

Aether is a **cache-safe prompt assembler and context governor** for local LLMs on
Apple Silicon. It sits between your IDE agent (KiloCode, Roo Code, OpenCode, any
OpenAI-compatible client) and **oMLX**, decides what context to inject and where to
put it, and forwards the request with your tools intact.

Its single design invariant: **stable prefix, volatile tail**. oMLX caches prompt
prefixes as 256-token blocks keyed by hash, so anything that changes near the start
of the prompt throws the whole cache away. Measured on an M1 Max 64 GB, moving the
retrieved context out of the system message and into the tail took TTFT from
**48.3 s to 8.2 s** at identical content and length — see
[`docs/AUDIT-2026-10.md`](docs/AUDIT-2026-10.md).

## What it does

- **Stable-prefix payload assembly** — constant system prompt, a stable signature
  repo-map in the prefix, retrieved context at the very end. ([`payload.ts`](packages/gateway/src/payload.ts))
- **Tools preserved** — never stripped; large catalogues are trimmed to the
  essential file/shell tools without reordering. ([`payload.test.ts`](packages/gateway/test/payload.test.ts))
- **Signature repo-map** — a deterministic table of contents of the repository
  (functions, types, components), budgeted and priority-ordered by how many files
  import each one. ([`repo-map.ts`](packages/core/src/indexer/repo-map.ts))
- **Chunked RAG with line offsets** — files are split into ~400-token chunks that
  carry `startLine`/`endLine`, so the model can cite exact line ranges. Embeddings
  are batched, and failures are reported rather than swallowed.
  ([`rag-indexer.ts`](packages/core/src/indexer/rag-indexer.ts))
- **Incremental indexing** — a tree-sitter AST graph for TypeScript/JavaScript,
  heuristic signatures for Python/Go/Rust, watched and updated on change.
- **Unified ML server (:8082)** — BGE-v2-m3 cross-encoder reranking and FastEmbed
  embeddings on MPS. Optional: retrieval falls back immediately if it is down.
- **Bounded pre-processing** — every call to the daemon has a hard timeout, so
  Aether never adds unbounded latency to the time-to-first-token.
- **Dashboard** — telemetry, logs and engine control at <http://127.0.0.1:8080/>.

## Requirements

macOS on Apple Silicon · Node.js 22+ · Python 3.11+ (`fastembed`, `transformers`,
`torch`, `fastapi`, `uvicorn`, `numpy`) · oMLX with an MLX model.

## Quickstart

```bash
npm install && npm run build

# 1. Start oMLX WITH the prefix cache (it is off by default)
/Applications/oMLX.app/Contents/MacOS/omlx-cli serve \
  --model-dir "$HOME/models" --port 8000 \
  --paged-ssd-cache-dir "$HOME/.omlx/cache"

# 2. Start Aether
aether start
```

Then point your agent at `http://127.0.0.1:8080/v1` — full details, configuration
keys and environment variables in [QUICKSTART.md](QUICKSTART.md).

## Project layout

| Path | Role |
|---|---|
| `packages/gateway` | HTTP gateway, payload assembly, telemetry, dashboard serving |
| `packages/core` | daemon, AST extractor, repo-map, RAG indexer, reranker client |
| `packages/reranker` | packaging for the ML server (embeddings + cross-encoder) |
| `packages/dashboard` | web dashboard (React/Vite) |
| `packages/cli` | `aether` CLI and TUI |
| `tools/` | measurement and diagnostic scripts (see [tools/README.md](tools/README.md)) |
| `docs/AUDIT-2026-10.md` | the audit: measurements, prioritised findings, fixes |

## Verify

```bash
npm run typecheck     # 3 workspaces
npm test              # 49 tests
npm run test:e2e      # 19 end-to-end checks against the real gateway process
```

## Known limits

- Python / Go / Rust are covered **heuristically** (no dependency graph, no scope
  resolution) — the compatible tree-sitter grammars are not installable here.
- The reranker is an optimisation, not a dependency: without the ML server,
  retrieval order degrades to AST graph order, loudly.
- Aether performs no inference and no agentic loop of its own. It prepares prompts
  and forwards them.

## License

MIT (Aether). oMLX and any model you run are governed by their own licenses.
