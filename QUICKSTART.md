# Aether — Quickstart

Aether is a **cache-safe prompt assembler and context governor** for local LLMs on
Apple Silicon. It sits between your IDE agent (KiloCode, Roo Code, OpenCode, any
OpenAI-compatible client) and oMLX, and it decides *what* goes into the prompt and
*where* — so that the engine's prefix cache actually survives between turns.

It is **not** an inference engine and **not** an agent: it retrieves context, keeps
it small and stable, and forwards the request with your tools intact.

> **Read this before tuning anything**: [`docs/AUDIT-2026-10.md`](docs/AUDIT-2026-10.md).
> It contains the measurements this design is based on, the known gaps, and the
> full list of fixes.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│  IDE agent (KiloCode / Roo Code / OpenCode / Cursor)         │
│  sends: system prompt + tool schemas + history + tools       │
└───────────────────────────┬──────────────────────────────────┘
                            │  OpenAI-compatible  http://127.0.0.1:8080/v1
┌───────────────────────────▼──────────────────────────────────┐
│  Aether Gateway (:8080)                                      │
│   • stable-prefix / volatile-tail payload assembly           │
│   • live tools preserved (never stripped)                    │
│   • token accounting, telemetry, dashboard                   │
└───────────┬──────────────────────────────┬───────────────────┘
            │ Unix socket                  │ HTTP
            │ ~/.aether/projects/<hash>/   │
┌───────────▼──────────────────┐  ┌────────▼───────────────────┐
│  Core Daemon                 │  │  Unified ML Server (:8082) │
│   • tree-sitter AST graph    │  │   • BGE-v2-m3 cross-encoder│
│   • signature repo-map       │  │     on MPS (optional)      │
│   • chunked RAG (LanceDB)    │  │   • FastEmbed embeddings   │
│   • incremental indexing     │  │     on MPS                 │
└──────────────────────────────┘  └────────────────────────────┘
                            │  OpenAI-compatible  http://127.0.0.1:8000
┌───────────────────────────▼──────────────────────────────────┐
│  oMLX (:8000) — inference                                    │
│   • MLX on Apple Silicon                                     │
│   • paged SSD prefix cache (must be enabled explicitly)      │
└──────────────────────────────────────────────────────────────┘
```

## The one invariant that matters

**Stable prefix, volatile tail.** oMLX caches prefixes as **256-token blocks keyed
by hash**. Anything that changes near the *start* of the prompt invalidates every
block after it.

So Aether assembles exactly this:

```text
[ system (constant) + <repo_map> (stable) ]   ← prefilled once, then reused
[ tool schemas (constant) ]
[ conversation history (append-only) ]
[ <context> retrieved for this turn ]         ← volatile, at the very end
[ the question ]
```

Measured on an M1 Max 64 GB with `Qwen3.6-35B-A3B` 8-bit, identical content and
identical prompt length:

| Placement of the retrieved context | Prefilled tokens | TTFT |
|---|---|---|
| **In the system message** (naive) | 14 400 | **48.3 s** |
| **In the tail, stable prefix** (Aether) | 2 112 (+12 288 reused) | **8.2 s** |
| Cold reference (no cache) | 14 400 | 52.1 s |

That is **×5.9 on TTFT** for free. It is the single most important behaviour in
this codebase, and it is covered by tests
(`packages/gateway/test/payload.test.ts`, and end-to-end in
`packages/gateway/test/e2e-smoke.mjs`).

## Requirements

- **macOS** on Apple Silicon (developed and measured on an M1 Max 64 GB).
- **Node.js 22+**
- **Python 3.11+** with `fastembed`, `transformers`, `torch`, `fastapi`,
  `uvicorn`, `numpy` — for the ML server on port 8082 (reranking + embeddings).
- **oMLX** installed (`/Applications/oMLX.app`) and a model in MLX format.
- `mlx-lm` is **only** needed by the measurement tools in `tools/`, not by Aether
  itself. Use an interpreter that supports your model architecture (see
  [`tools/README.md`](tools/README.md)).

## Install

```bash
npm install
npm run build

# Python side (the ML server). Adjust to your interpreter/venv.
pip install fastembed transformers torch fastapi uvicorn numpy
```

## Run oMLX with the prefix cache enabled

The paged SSD prefix cache is **disabled by default** in oMLX and must be turned on
explicitly. This is where most of the TTFT win comes from.

```bash
# The binary is `omlx-cli`, not `omlx`.
/Applications/oMLX.app/Contents/MacOS/omlx-cli serve \
  --model-dir  "$HOME/models" \
  --port 8000 --host 127.0.0.1 \
  --paged-ssd-cache-dir "$HOME/.omlx/cache" \
  --paged-ssd-cache-max-size 100GB \
  --hot-cache-max-size 8GB \
  --initial-cache-blocks 256 \
  --max-process-memory auto
```

Models are discovered as **subdirectories of `--model-dir`**: `~/models/My-Model`
is served under the id `My-Model`. Aether starts this automatically from the
dashboard's *Power On* button, using the same arguments.

> ⚠️ `omlx serve --model <path>` and `--kv-cache-size` **do not exist** — they are
> rejected by argparse, which is why older builds of Aether never managed to start
> the engine. Aether now issues the command above, and that command line has been
> verified against the real binary.

## Start Aether

```bash
aether start              # gateway + daemon + ML server
```

Then open the dashboard at <http://127.0.0.1:8080/> and press **Power On**, or let
the gateway launch the engine itself.

## Configure

Optional file: `~/.aether/config.json`

| Key | Meaning |
|---|---|
| `upstreamUrl` | oMLX base URL (default `http://127.0.0.1:8000`) |
| `modelsDir` | directory passed to oMLX `--model-dir` (default `~/models`) |
| `modelPath` | single model path; its parent directory is used if `modelsDir` is absent |
| `modelId` | force the model id sent to oMLX (bypasses client passthrough) |
| `maxTokens` | cap output tokens. **Unset by default**, so oMLX's per-model profile wins |
| `cacheDir` | prefix-cache directory (default `~/.omlx/cache`) |
| `cacheMaxSize` / `hotCacheMaxSize` | cache budget (defaults `100GB` / `8GB`) |
| `omlxBinary` | absolute path to `omlx-cli` if auto-detection fails |
| `bypassAether` | `true` = forward requests untouched (useful for A/B comparisons) |
| `tokenBudget` | read by `start-aether.sh` to seed `TOKEN_BUDGET` |

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AETHER_PORT` | `8080` | gateway port |
| `AETHER_PROJECT` | cwd | project root being indexed |
| `OLLAMA_URL` | config, else `http://127.0.0.1:8000` | upstream oMLX URL |
| `TOKEN_BUDGET` | `4096` | max tokens of **volatile** context injected per turn |
| `AETHER_CONTEXT_TIMEOUT_MS` | `3000` | hard budget for the daemon's context reply |
| `AETHER_REPO_MAP_TOKENS` | `1500` | size budget of the signature repo-map |
| `AETHER_REPO_MAP_IDLE_MS` | `60000` | idle delay before the repo-map may be refreshed |
| `AETHER_REPO_MAP_TIMEOUT_MS` | `2000` | hard budget for the repo-map reply |
| `AETHER_RERANK_TIMEOUT_MS` | `1500` | hard budget for the reranker call |
| `AETHER_MODEL` | unset | force the model id |
| `AETHER_MAX_TOKENS` | unset | cap output tokens |
| `AETHER_OMLX_BINARY` | unset | explicit `omlx-cli` path |
| `EMBEDDING_URL` | `http://127.0.0.1:8082` | embeddings endpoint |

**Why `TOKEN_BUDGET` is 4096 and not 16384**: the volatile block is re-prefilled
every turn, and prefill costs **~3.6 ms per token** on this class of machine — 16 k
tokens is ~58 s of TTFT. See the audit.

## IDE integration

Point any OpenAI-compatible client at:

- **Base URL**: `http://127.0.0.1:8080/v1`
- **Model**: any string, or the id of a model in your `--model-dir`. Set `modelId`
  in the config if your client sends a name oMLX does not know.
- **API key**: `abcde` (oMLX's default; the gateway adds it upstream when needed)

**Tools are forwarded.** Aether never strips your tool schemas — a coding agent
without tools can neither read nor write files. If a client sends a very large
tool catalogue (> 24 tools), Aether keeps the essential file/shell tools and
trims the rest, preserving their original order so the prefix cache still holds.

## What Aether does not do

Stated plainly, so you do not expect otherwise:

- **No dependency graph for Python / Go / Rust.** Those languages are covered by a
  heuristic signature extractor (`packages/core/src/indexer/heuristic-extractor.ts`),
  not by a real parser: signatures, imports and line ranges only. The npm
  tree-sitter grammars for them require tree-sitter ≥ 0.25 (ABI 15) while this
  project pins 0.21.1 (ABI 14). TypeScript/JavaScript *are* parsed properly.
- **No graph resolution for those languages either** — the repo-map lists them
  alphabetically, without importance weighting.
- **No speculative decoding of its own.** oMLX owns that; Aether's job is to keep
  the prompt cacheable.
- **The reranker is optional.** If the ML server is not running, retrieval falls
  back to AST graph order immediately (no blocking wait).

## Verify your setup

```bash
npm run typecheck     # 3 workspaces
npm test              # 49 tests (core + gateway)
npm run test:e2e      # 19 end-to-end checks against the real gateway process
python3 tools/omlx_doctor.py   # is your runtime up to date?
```

Measurement tooling is documented in [`tools/README.md`](tools/README.md).
