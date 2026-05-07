# AETHER PLAN

## Overview

Aether is a native macOS IDE that uses the MLX framework to run quantized LLMs locally on Apple Silicon, prioritizing privacy and speed by avoiding external API calls. It features a surgical context extraction pipeline, a hybrid AST/RAG retrieval system, semantic reranking for precision, and dynamic budget-aware context management.

---

## High-Level Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                    IDE Client (VSCode-like)              │
├─────────────────────────────────────────────────────────┤
│  Aether Gateway (Port 8080) - Central Orchestrator       │
│  • File watchman / LSP proxy                            │
│  • Query batching & rate limiting                        │
│  • MCP server integration                                │
├─────────────────────────────────────────────────────────┤
│  Core Daemons:                                            │
│  • AST extraction daemon (Swift/TS)                      │
│  • File watchman / LSP proxy                            │
│  • RAG indexing pipeline (LanceDB)                       │
├─────────────────────────────────────────────────────────┤
│  MLX Server (Port 8081) - Native Apple Silicon LLM       │
│  • Qwen3.6-35B / Qwen3.5-32B / Qwen2.5-7B              │
│  • GPU-accelerated inference via MPS                     │
│  • Context window management                             │
└─────────────────────────────────────────────────────────┘
```

---

## The Supernova Pipeline

### 1. Classification

Input query is classified into either **Active Focus** (files directly in editor) or **Peripheral Awareness** (needs retrieval). The classification uses a lightweight heuristic:

- **Active Focus**: Query contains explicit file references or relates to visible tab
- **Peripheral Awareness**: General questions about codebase, refactoring, or cross-file relationships

Classification happens in the Gateway via metadata inspection of editor state rather than LLM analysis.

---

### 2. Retrieval

For **Peripheral Awareness** queries, the system performs hybrid retrieval:

- **AST Signatures**: Extract function signatures, class definitions, and imports via Tree-sitter
- **RAG Candidates**: Retrieve semantic embeddings from LanceDB (~20 candidates)
- **File Watchman**: Track recently modified files for fresh context

---

### 3. Surgical Reranking

All candidates undergo cross encoder reranking using BGE-V2-M3 running on MPS (Apple Neural Engine). This step filters irrelevant results with high precision.

---

### 4. Budget Reconstruction

The final context window is reconstructed considering:
- Full text of Active Focus files
- Top AST signatures from Reranked results
- AST Signatures of Reranked results
- Budget constraint: **~16k tokens**

---

## Local LLM Integration

### Quantization Strategy

Aether implements a three-tier quantization policy:

1. **Qwen3.5-32B-Q4** (Default): 4-bit quantization, optimal for most use cases
2. **Qwen3.6-35B-Q4**: 4-bit quantization, higher performance for complex tasks
3. **Qwen2.5-7B-Q8**: 8-bit quantization, faster inference for simpler tasks

### Context Window Management

- **Input Window**: 16k tokens max (practical limit for Apple Silicon)
- **Output Window**: 4k tokens max (balance between quality and latency)
- **Prompt Compression**: Semantic summarization of older context when budget exceeded

---

## Performance Metrics

### Latency Targets

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| AST Extraction | <50ms | Per file, native Swift |
| Semantic Search | <200ms | 10 nearest neighbors |
| Reranking | <500ms | 20 candidates, MPS |
| LLM Inference | <2s first token | Qwen3.6-35B Q4 |
| Full Response | <10s | Streaming response |

### Memory Budget

- **Gateway**: 50MB (node.js process)
- **MLX Server**: 8GB max (16k context window)
- **Core Process**: 2GB (AST + RAG)
- **Total**: <12GB for smooth operation

---

## Security & Privacy

### Data Isolation

- **Zero External API Calls**: All LLM inference happens locally on device
- **Local Vector Store**: Codebase embeddings stored in LanceDB (./data/vector.db)
- **Sandboxed MCP Servers**: Extension ecosystem runs in controlled environment

### Model Integrity

- **Quantized Models Only**: All models are 4/8-bit quantized versions of Qwen
- **No Cloud Dependencies**: No model downloads from external sources during runtime
- **SHA-256 Verification**: Models verified against known good hashes

---

## Future Roadmap

### Phase 1: Foundation (Current)

- [x] Basic AST extraction
- [x] LanceDB integration
- [x] Qwen3.6-35B-Q4 quantization
- [x] Streaming responses
- [x] MCP server integration

### Phase 2: Optimization

- [ ] Quantized Reranker (distill/distilbert-base-uncased)
- [ ] Multi-LLM routing (Qwen3.6-35B <=> Qwen2.5-7B)
- [ ] Context window compression
- [ ] Incremental RAG updates

### Phase 3: Advanced Features

- [ ] Real-time code analysis
- [ ] Cross-file refactoring
- [ ] Predictive code completion
