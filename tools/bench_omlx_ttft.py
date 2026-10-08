#!/usr/bin/env python3
"""
bench_omlx_ttft.py — mesure le TTFT réel À TRAVERS oMLX, cache de préfixe compris.

Différence avec bench_prefix_cache.py (qui passe par mlx_lm) : ici on mesure le
moteur réellement utilisé par Aether, donc avec le cache de préfixe paginé, les
kernels de prefill GDN/MoE et — si activé — le MTP.

Trois scénarios, contenu et longueur identiques :

  1. froid        : premier envoi, cache vide
  2. préfixe chaud: même prompt renvoyé → les blocs de 256 tokens sont réutilisés
  3. tête volatile: la partie changeante est placée AU DÉBUT → le hash du bloc 0
                    change → aucun bloc réutilisable → retour au temps froid

Usage :
  python3 tools/bench_omlx_ttft.py --url http://127.0.0.1:18099 \
      --stable-chars 40000 --volatile-chars 8000 --json tools/results/bench-omlx.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

STABLE_FILLER = (
    "# SYSTEM\nYou are an expert AI software engineer with access to tools.\n"
    "Available tools: read_file, write_file, list_dir, grep, run_tests.\n"
    "Always prefer surgical edits and cite file paths.\n"
)
VOLATILE_FILLER = (
    "// retrieved context chunk\nexport function handler(req: Request) {\n"
    "  return process(req.body);\n"
    "}\n"
)
QUESTION = "Resume le handler ci-dessus et indique ses appelants."


def post_json(url: str, payload: dict[str, Any], timeout: float = 900.0):
    """Envoie la requête et rend (ttft_s, prompt_tokens, total_s, texte)."""
    req = urllib.request.Request(
        url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer abcde"},
        method="POST",
    )
    t0 = time.perf_counter()
    ttft = None
    prompt_tokens = None
    text_parts: list[str] = []

    with urllib.request.urlopen(req, timeout=timeout) as res:
        for raw in res:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                chunk = json.loads(body)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk.get("usage"), dict):
                prompt_tokens = chunk["usage"].get("prompt_tokens", prompt_tokens)
            for choice in chunk.get("choices", []):
                delta = choice.get("delta") or {}
                piece = delta.get("content")
                if piece:
                    if ttft is None:
                        ttft = time.perf_counter() - t0
                    text_parts.append(piece)

    return ttft, prompt_tokens, time.perf_counter() - t0, "".join(text_parts)


def build(stable_chars: int, volatile_chars: int, tag: str) -> tuple[str, str]:
    stable = (STABLE_FILLER * (stable_chars // len(STABLE_FILLER) + 1))[:stable_chars]
    volatile = ("// " + tag + "\n" + VOLATILE_FILLER * (volatile_chars // len(VOLATILE_FILLER) + 1))[
        :volatile_chars
    ]
    return stable, volatile


def payload_for(messages: list[dict[str, str]], model: str) -> dict[str, Any]:
    return {
        "model": model,
        "messages": messages,
        "stream": True,
        "max_tokens": 8,
        "temperature": 0.0,
        "stream_options": {"include_usage": True},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:18099")
    ap.add_argument("--stable-chars", type=int, default=40000)
    ap.add_argument("--volatile-chars", type=int, default=8000)
    ap.add_argument("--model", default="default",
                    help="id du modèle tel que servi par oMLX")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    stable, volatile = build(args.stable_chars, args.volatile_chars, "TOUR1")
    _, volatile2 = build(args.stable_chars, args.volatile_chars, "TOUR2")

    results: dict[str, Any] = {}

    def run(label: str, messages: list[dict[str, str]]) -> dict[str, Any]:
        try:
            ttft, ptok, total, _ = post_json(args.url, payload_for(messages, args.model))
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            print(f"  ✖ {label} : {err}")
            return {"error": str(err)}
        row = {
            "ttft_s": round(ttft, 3) if ttft is not None else None,
            "prompt_tokens": ptok,
            "total_s": round(total, 2),
        }
        print(f"  {label:34s} TTFT={row['ttft_s']}s  prompt={ptok} tok  total={row['total_s']}s")
        return row

    print(f"=== oMLX @ {args.url} ===")
    print(f"    préfixe stable ~{args.stable_chars} car | volatil ~{args.volatile_chars} car\n")

    # 1. FROID : préfixe stable en tête, volatil en queue — premier passage
    results["cold"] = run(
        "1. froid (cache vide)",
        [{"role": "system", "content": stable}, {"role": "user", "content": volatile + "\n" + QUESTION}],
    )

    # 2. PRÉFIXE CHAUD : même tête, contenu volatil différent
    results["warm_prefix"] = run(
        "2. préfixe stable réutilisé",
        [{"role": "system", "content": stable}, {"role": "user", "content": volatile2 + "\n" + QUESTION}],
    )

    # 3. TÊTE VOLATILE : le changeant est AU DÉBUT → bloc 0 invalidé
    results["volatile_head_cold"] = run(
        "3. tête volatile (1er envoi)",
        [{"role": "system", "content": volatile + stable}, {"role": "user", "content": QUESTION}],
    )
    results["volatile_head_again"] = run(
        "4. tête volatile (2e envoi)",
        [{"role": "system", "content": volatile2 + stable}, {"role": "user", "content": QUESTION}],
    )

    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nJSON écrit : {args.json}")

    print("\n| scénario | TTFT (s) | tokens de prompt |")
    print("|---|---|---|")
    for key, row in results.items():
        print(f"| {key} | {row.get('ttft_s')} | {row.get('prompt_tokens')} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
