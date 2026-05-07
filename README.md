# Aether

Aether is a native macOS IDE that runs quantized LLMs locally (MLX). It provides a surgical AST/RAG retrieval pipeline, incremental indexing, and local LLM inference for privacy and speed.

## Quickstart

Prerequisites: Node.js (18+), npm, Git. Optional: `gh` CLI and an SSH key for GitHub.

Clone (if needed):

```bash
git clone git@github.com:jawjaww/aether.git
cd aether
```

Install and build:

```bash
npm ci
# build individual packages
npm run build --workspace=packages/core
npm run build --workspace=packages/gateway
npm run build --workspace=packages/dashboard
npm run build --workspace=packages/cli
```

Start the full stack (recommended):

```bash
./start-aether.sh
```

Or run components individually for development:

```bash
# daemon (core)
npm --workspace=packages/core run start

# gateway
npm --workspace=packages/gateway run start

# CLI dashboard / TUI
npm --workspace=packages/cli run start
```

## Project layout

- `packages/core` — core daemon, indexer, AST/RAG pipeline
- `packages/gateway` — HTTP gateway and context engineering
- `packages/dashboard` — web dashboard
- `packages/cli` — CLI and TUI tools
- `onnx-bge-reranker-v2-m3/` — model artifacts (ignored by git)

## Notes for developers

- Manifest DB path: `~/.aether/projects/<hash>/sqlite/manifest.sqlite`
- Use the provided `start-aether.sh` for a quick local run
- To reset gateway stats: `curl -X POST http://127.0.0.1:8080/aether/stats/reset`

## See also

- Detailed project plan: `AETHER_PLAN.md`
- Quickstart & scripts: `QUICKSTART.md`

## License

Add a `LICENSE` file if you want to publish this repository.
