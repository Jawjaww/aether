#!/usr/bin/env python3
"""
bench_prefix_cache.py — mesure l'impact du cache de préfixe sur le TTFT.

But : quantifier, sur la machine réelle, ce que coûte le choix d'architecture
d'Aether, qui injecte le contexte récupéré (volatil) DANS LE MESSAGE SYSTÈME,
c'est-à-dire en tête de requête.

oMLX met en cache les préfixes par blocs de 256 tokens (hash de bloc, cf.
omlx/cache/prefix_cache.py). Conséquence :
  - si le contenu volatil est en TÊTE  -> le bloc 0 change à chaque tour
    -> aucun bloc réutilisable -> prefill complet à chaque requête
  - si le contenu volatil est en QUEUE -> les blocs stables sont réutilisés
    -> seul le delta est préfillé

Protocole (sémantique identique à un cache de préfixe par blocs) :
  S = préfixe stable (system prompt + schémas d'outils), multiple de 256 tokens
  V = bloc volatil (contexte récupéré, ~2k tokens)
  Q = question

  1. "froid"      : cache neuf, prompt = S + V + Q        -> prefill complet
  2. "préfixe OK" : cache préchauffé sur S, puis prompt S + V' + Q
                    -> seuls V' + Q sont préfillés
  3. "tête volatil" (anti-patron Aether) : cache préchauffé sur V + S,
                    puis requête V' + S + Q -> préfixe commun = 0
                    -> prefill complet (aucun bloc réutilisable)

Sortie : tableau + JSON exploitable dans l'audit.

Interpréteur requis : celui qui a mlx_lm >= 0.31.4 et supporte qwen3_5_moe,
  ex. ~/miniconda3/bin/python tools/bench_prefix_cache.py ...
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import make_prompt_cache

FILLER_STABLE = (
    "# SYSTEM\nYou are an expert AI software engineer with access to tools.\n"
    "Available tools: read_file, write_file, list_dir, grep, run_tests.\n"
    "Always prefer surgical edits and cite file paths.\n"
)
FILLER_VOLATILE = (
    "// retrieved context chunk\nexport function handler(req: Request) {\n"
    "  return process(req.body);\n}\n"
)


def to_tokens(tokenizer: Any, text: str, n: int) -> list[int]:
    ids: list[int] = []
    while len(ids) < n:
        ids.extend(tokenizer.encode(text))
    return ids[:n]


def timed_generate(
    model: Any,
    tokenizer: Any,
    tokens: list[int],
    max_tokens: int,
    prompt_cache: Any = None,
    prefill_step: int = 2048,
) -> dict[str, Any]:
    """Génère et renvoie le TTFT + les tokens réellement préfillés."""
    mx.reset_peak_memory()
    t0 = time.perf_counter()
    ttft = None
    last = None
    n = 0
    for response in stream_generate(
        model,
        tokenizer,
        tokens,
        max_tokens=max_tokens,
        prompt_cache=prompt_cache,
        prefill_step_size=prefill_step,
    ):
        if ttft is None:
            ttft = time.perf_counter() - t0
        last = response
        n += 1
    total = time.perf_counter() - t0
    return {
        "prompt_tokens": getattr(last, "prompt_tokens", None),
        "ttft_s": round(ttft, 3) if ttft is not None else None,
        "prefill_tps": round(getattr(last, "prompt_tps", 0.0), 1),
        "decode_tps": round(getattr(last, "generation_tps", 0.0), 1),
        "total_s": round(total, 2),
        "peak_memory_gb": round(mx.get_peak_memory() / (1024**3), 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--stable-tokens", type=int, default=12288,
                    help="taille du préfixe stable (multiple de 256)")
    ap.add_argument("--volatile-tokens", type=int, default=2048)
    ap.add_argument("--question-tokens", type=int, default=64)
    ap.add_argument("--max-tokens", type=int, default=8)
    ap.add_argument("--prefill-step", type=int, default=2048)
    ap.add_argument("--block-size", type=int, default=256, help="taille de bloc du cache oMLX")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    stable = args.stable_tokens - (args.stable_tokens % args.block_size)
    print(f"[prefix] chargement {args.model}", flush=True)
    model, tokenizer = load(args.model)

    S = to_tokens(tokenizer, FILLER_STABLE, stable)
    V1 = to_tokens(tokenizer, FILLER_VOLATILE, args.volatile_tokens)
    # V2 doit différer dès le premier token pour simuler un contexte re-récupéré
    V2 = to_tokens(tokenizer, "// DIFFERENT chunk\n" + FILLER_VOLATILE, args.volatile_tokens)
    Q = to_tokens(tokenizer, "Explain the handler above and list its call sites.\n",
                  args.question_tokens)

    results: dict[str, Any] = {"stable_tokens": len(S), "volatile_tokens": len(V1),
                               "question_tokens": len(Q), "block_size": args.block_size}

    # ── 1. Froid : prefill complet
    cache = make_prompt_cache(model)
    r = timed_generate(model, tokenizer, S + V1 + Q, args.max_tokens, cache, args.prefill_step)
    r["scenario"] = "1. froid (aucun cache)"
    results["cold"] = r
    print(f"[prefix] {r['scenario']}: {r['prompt_tokens']} tok préfillés, TTFT={r['ttft_s']}s", flush=True)

    # ── 2. Préfixe stable réutilisé : on préchauffe S, puis on envoie le delta
    cache = make_prompt_cache(model)
    warm = timed_generate(model, tokenizer, S, 1, cache, args.prefill_step)
    print(f"[prefix] préchauffage du préfixe stable: {warm['prompt_tokens']} tok en {warm['ttft_s']}s", flush=True)
    r = timed_generate(model, tokenizer, V2 + Q, args.max_tokens, cache, args.prefill_step)
    r["scenario"] = "2. préfixe stable en tête (cible)"
    r["cache_hit_tokens"] = len(S)
    results["stable_prefix"] = r
    print(f"[prefix] {r['scenario']}: {r['prompt_tokens']} tok préfillés "
          f"(+{len(S)} réutilisés), TTFT={r['ttft_s']}s", flush=True)

    # ── 3. Anti-patron Aether : le volatil est en tête -> préfixe commun = 0
    cache = make_prompt_cache(model)
    warm = timed_generate(model, tokenizer, V1 + S, 1, cache, args.prefill_step)
    print(f"[prefix] préchauffage avec contexte volatil EN TÊTE: {warm['prompt_tokens']} tok", flush=True)
    # nouveau contexte -> divergence au token 0 -> cache inutilisable
    fresh = make_prompt_cache(model)
    r = timed_generate(model, tokenizer, V2 + S + Q, args.max_tokens, fresh, args.prefill_step)
    r["scenario"] = "3. contexte volatil en tête (anti-patron Aether)"
    r["cache_hit_tokens"] = 0
    results["volatile_head"] = r
    print(f"[prefix] {r['scenario']}: {r['prompt_tokens']} tok préfillés (0 réutilisé), "
          f"TTFT={r['ttft_s']}s", flush=True)

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
        print(f"[prefix] JSON écrit: {args.json}", flush=True)

    print("\n| scénario | tokens préfillés | tokens réutilisés | TTFT (s) | prefill (tok/s) |")
    print("|---|---|---|---|---|")
    for key in ("cold", "stable_prefix", "volatile_head"):
        r = results[key]
        print(f"| {r['scenario']} | {r['prompt_tokens']} | {r.get('cache_hit_tokens', 0)} | "
              f"{r['ttft_s']} | {r['prefill_tps']} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
