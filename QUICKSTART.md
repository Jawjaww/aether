# 🚀 Aether — High-Fidelity Context Engine

Aether is a surgical context engineering layer for local LLMs, specifically optimized for Apple Silicon (M1 Max/Ultra). It replaces traditional "blind" context management with a high-fidelity 4-stage pipeline.

## 🏗️ Architecture (Supernova Pipeline)

```text
┌─────────────────────────────────────────────────────────┐
│                    IDE Client (VSCode-like)               │
├─────────────────────────────────────────────────────────┤
│  Aether Gateway (Port 8080) - Central Orchestrator       │
│   • File watchman / LSP proxy                             │
│   • Query batching & rate limiting                         │
│   • MCP server integration                                 │
├─────────────────────────────────────────────────────────┤
│  Core Daemons:                                             │
│   • AST extraction daemon (Swift/TS)                       │
│   • File watchman / LSP proxy                             │
│   • RAG indexing pipeline (LanceDB)                        │
├─────────────────────────────────────────────────────────┤
│  MLX Server (Port 8081) - Native Apple Silicon LLM        │
│   • Qwen3.6-35B / Qwen3.5-32B / Qwen2.5-7B               │
│   • GPU-accelerated inference via MPS                      │
│   • Context window management                              │
└─────────────────────────────────────────────────────────┘
```

## 🛠️ Setup

### 1. Requirements
- **OS**: macOS (Apple Silicon highly recommended).
- **Node.js**: v22+
- **Python**: 3.10+ with `torch`, `transformers`, `fastapi`, `uvicorn`, `mlx-lm`.
- **MLX Model**: Qwen3.6-35B (preconfigured for Dashboard).

### 2. Installation
```bash
# Install Node dependencies
npm install
npm run build

# Install Python dependencies
pip install mlx-lm fastapi uvicorn torch transformers pydantic
```

### 3. Running
```bash
# Start the full stack
aether start
```
Access the **Dashboard** at `http://127.0.0.1:8080` and click **"Start Engines"** to initialize the MLX and Reranker servers.

## 🧠 Tiered Context Strategy

Aether manages a strict **16,384 token budget** to maintain optimal TTFT (~8s) and avoid LLM reasoning degradation:

- **Tier 1 (Full)**: The active file (cursor-windowed) + Top 3 RAG-matched files are injected in their entirety.
- **Tier 2 (Surgical)**: RAG matches 4 to 15 are reduced to **AST Signatures** (function and class definitions only).
- **Surgical Reranking**: All candidates are re-ordered by the cross-encoder to ensure the most semantically relevant code is always at the head of the context.

## 📊 Telemetry & Dashboard
The React-based dashboard provides real-time visibility into:
- **AST/RAG Latency**: Time to fetch candidates.
- **Rerank Time**: Latency of the surgical scoring phase (usually 200-400ms on M1 Max).
- **Token Compression**: Visual representation of tokens saved vs. tokens injected.
- **Generation Speed**: Real-time tokens per second (t/s).

## 🔌 IDE Integration
Point **OpenCode**, **KiloCode**, or any OpenAI-compatible client to:
- **Base URL**: `http://127.0.0.1:8080/v1`
- **Model**: `mlx-model` (automatically routed).
