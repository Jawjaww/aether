#!/usr/bin/env python3
"""
bench_local.py — mesure du goulot d'étranglement local (prefill / TTFT / decode).

Outil d'audit pour Aether : mesure, sur la machine réelle, l'effet de la longueur
de contexte et des réglages d'inférence sur :
  - le TTFT (temps jusqu'au premier token)  -> ce que l'utilisateur ressent
  - le prompt_tps (vitesse de prefill)      -> le pré-processing LLM
  - le generation_tps (vitesse de decode)   -> le débit, borné par la bande passante
  - la mémoire crête                        -> la pression sur la RAM unifiée

Il utilise mlx_lm.stream_generate, donc les knobs mesurés sont ceux réellement
exposés par MLX : prefill_step_size, kv_bits, kv_group_size, quantized_kv_start,
draft_model (speculative decoding).

Exemples:
  # courbe TTFT vs longueur de contexte
  bench_local.py --model ~/models/Qwen3.6-35B-A3B-RotorQuant-MLX-8bit \\
                 --lengths 1024,4096,8192,16384,32768 --max-tokens 24

  # effet de la quantification du KV cache
  bench_local.py --model ... --lengths 16384 --kv-bits 8 --quantized-kv-start 2048

  # effet de la taille de bloc de prefill
  bench_local.py --model ... --lengths 16384 --prefill-step 8192

  # speculative decoding
  bench_local.py --model ... --lengths 8192 --draft-model ~/models/Qwen3.5-1.7B-4bit

Sortie: tableau lisible + JSON (--json chemin.json) réutilisable dans l'audit.

Ce script doit tourner avec l'interpréteur qui a mlx_lm installé, par exemple:
  /opt/homebrew/Cellar/mlx-lm/0.30.4/libexec/bin/python tools/bench_local.py ...
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from typing import Any

import mlx.core as mx
from mlx_lm import load, stream_generate


# ─── Utilitaires système ───────────────────────────────────────────────────────

def vm_stat() -> dict[str, int]:
    """Retourne quelques compteurs vm_stat (pages) pour détecter le swap."""
    out: dict[str, int] = {}
    try:
        raw = subprocess.run(
            ["vm_stat"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return out
    for line in raw.splitlines():
        m = re.match(r'"?([^":]+)"?:\s+([0-9.]+)', line.strip())
        if m:
            key = m.group(1).strip().replace(" ", "_").lower()
            try:
                out[key] = int(float(m.group(2)))
            except ValueError:
                pass
    return out


def swap_used_mb() -> float:
    """Swap utilisé en Mo (sysctl vm.swapusage)."""
    try:
        raw = subprocess.run(
            ["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=10
        ).stdout
        m = re.search(r"used\s*=\s*([0-9.]+)([MG])", raw)
        if not m:
            return 0.0
        val = float(m.group(1))
        return val * 1024 if m.group(2) == "G" else val
    except Exception:
        return 0.0


# ─── Construction de prompts de longueur exacte ────────────────────────────────

FILLER = (
    "def process_request(payload: dict) -> dict:\n"
    "    \"\"\"Handle an incoming request and normalise the shape.\"\"\"\n"
    "    result = {}\n"
    "    for key, value in payload.items():\n"
    "        if isinstance(value, list):\n"
    "            result[key] = [item for item in value if item is not None]\n"
    "        else:\n"
    "            result[key] = value\n"
    "    return result\n\n"
)


def prompt_of_tokens(tokenizer: Any, n_tokens: int) -> list[int]:
    """Construit une liste d'exactement n_tokens tokens à partir d'un remplissage."""
    ids: list[int] = []
    while len(ids) < n_tokens:
        ids.extend(tokenizer.encode(FILLER))
    return ids[:n_tokens]


# ─── Mesure d'une configuration ────────────────────────────────────────────────

def measure(
    model: Any,
    tokenizer: Any,
    n_tokens: int,
    max_tokens: int,
    gen_kwargs: dict[str, Any],
) -> dict[str, Any]:
    prompt_ids = prompt_of_tokens(tokenizer, n_tokens)
    mx.reset_peak_memory()
    swap_before = swap_used_mb()

    t0 = time.perf_counter()
    ttft = None
    last = None
    n_generated = 0
    for response in stream_generate(model, tokenizer, prompt_ids, max_tokens=max_tokens, **gen_kwargs):
        if ttft is None:
            ttft = time.perf_counter() - t0
        last = response
        n_generated += 1
    total = time.perf_counter() - t0

    return {
        "requested_tokens": n_tokens,
        "prompt_tokens": getattr(last, "prompt_tokens", None),
        "ttft_s": round(ttft, 4) if ttft is not None else None,
        "prefill_tps": round(getattr(last, "prompt_tps", 0.0), 2),
        "decode_tps": round(getattr(last, "generation_tps", 0.0), 2),
        "generated_tokens": n_generated,
        "total_s": round(total, 3),
        "peak_memory_gb": round(mx.get_peak_memory() / (1024 ** 3), 2),
        "swap_used_mb_after": round(swap_used_mb(), 1),
        "swap_delta_mb": round(swap_used_mb() - swap_before, 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Benchmark local prefill/TTFT/decode (MLX)")
    ap.add_argument("--model", required=True, help="chemin du modèle MLX")
    ap.add_argument("--lengths", default="1024,4096,8192,16384",
                    help="longueurs de contexte (tokens), séparées par des virgules")
    ap.add_argument("--max-tokens", type=int, default=24, help="tokens à générer par mesure")
    ap.add_argument("--prefill-step", type=int, default=2048, help="prefill_step_size")
    ap.add_argument("--kv-bits", type=int, default=None, help="quantification du KV cache (4/8)")
    ap.add_argument("--kv-group-size", type=int, default=64)
    ap.add_argument("--quantized-kv-start", type=int, default=0)
    ap.add_argument("--draft-model", default=None, help="modèle draft (speculative decoding)")
    ap.add_argument("--num-draft-tokens", type=int, default=3)
    ap.add_argument("--warmup", type=int, default=256, help="tokens du warmup (0 = aucun)")
    ap.add_argument("--json", default=None, help="chemin de sortie JSON")
    ap.add_argument("--label", default=None, help="étiquette de cette configuration")
    args = ap.parse_args()

    gen_kwargs: dict[str, Any] = {"prefill_step_size": args.prefill_step}
    if args.kv_bits:
        gen_kwargs["kv_bits"] = args.kv_bits
        gen_kwargs["kv_group_size"] = args.kv_group_size
        gen_kwargs["quantized_kv_start"] = args.quantized_kv_start
    if args.draft_model:
        gen_kwargs["draft_model"] = load(args.draft_model)[0]
        gen_kwargs["num_draft_tokens"] = args.num_draft_tokens

    label = args.label or os.path.basename(os.path.normpath(args.model))
    print(f"[bench] chargement du modèle: {args.model}", flush=True)
    t_load = time.perf_counter()
    model, tokenizer = load(args.model)
    load_s = time.perf_counter() - t_load
    print(f"[bench] modèle chargé en {load_s:.1f}s — mémoire crête "
          f"{mx.get_peak_memory()/(1024**3):.2f} Go", flush=True)

    if args.warmup:
        list(stream_generate(model, tokenizer,
                             prompt_of_tokens(tokenizer, args.warmup),
                             max_tokens=4, **gen_kwargs))
        print(f"[bench] warmup {args.warmup} tokens fait", flush=True)

    results = []
    for n in [int(x) for x in args.lengths.split(",") if x.strip()]:
        r = measure(model, tokenizer, n, args.max_tokens, gen_kwargs)
        r["label"] = label
        results.append(r)
        print(f"[bench] ctx={r['prompt_tokens']}tok  TTFT={r['ttft_s']}s  "
              f"prefill={r['prefill_tps']}tok/s  decode={r['decode_tps']}tok/s  "
              f"peak={r['peak_memory_gb']}Go", flush=True)

    payload = {
        "label": label,
        "model": args.model,
        "load_s": round(load_s, 2),
        "gen_kwargs": {k: (v if k != "draft_model" else str(args.draft_model))
                       for k, v in gen_kwargs.items()},
        "hardware": {
            "mem_gb": round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1),
            "cpus": os.cpu_count(),
        },
        "results": results,
    }
    if args.json:
        with open(args.json, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"[bench] JSON écrit: {args.json}", flush=True)

    print("\n| contexte (tok) | TTFT (s) | prefill (tok/s) | decode (tok/s) | pic mémoire (Go) |")
    print("|---|---|---|---|---|")
    for r in results:
        print(f"| {r['prompt_tokens']} | {r['ttft_s']} | {r['prefill_tps']} | "
              f"{r['decode_tps']} | {r['peak_memory_gb']} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
