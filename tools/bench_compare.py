#!/usr/bin/env python3
"""
bench_compare.py — compare deux campagnes de mesure et détecte les régressions.

Prend deux JSON produits par tools/bench_local.py (ou bench_prefix_cache.py),
apparie les mesures par longueur de contexte et affiche les écarts. Utilisable
comme garde-fou : sort en erreur si un seuil de régression est dépassé.

Exemples
--------
  # 8-bit vs 4-bit, seuil par défaut (toute régression > 5 % échoue)
  tools/bench_compare.py tools/results/bench-8bit.json tools/results/bench-4bit.json

  # A/B du MTP : on tolère une régression tant que le décodage gagne
  tools/bench_compare.py a.json b.json --max-regression 10 --label-b "MTP on"

  # Comparer deux scénarios d'un bench de cache de préfixe
  tools/bench_compare.py before.json after.json --mode prefix
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def load(path: str) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def pick_metric(row: dict[str, Any], name: str) -> float | None:
    key = {
        "ttft": "ttft_s",
        "prefill": "prefill_tps",
        "decode": "decode_tps",
        "peak": "peak_memory_gb",
    }[name]
    value = row.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def delta_pct(before: float | None, after: float | None, lower_is_better: bool) -> float | None:
    if before in (None, 0) or after is None:
        return None
    change = (after - before) / before * 100.0
    return -change if lower_is_better else change


def compare_lengths(a: dict[str, Any], b: dict[str, Any], max_regression: float) -> int:
    rows_a = {r["prompt_tokens"]: r for r in a.get("results", []) if r.get("prompt_tokens")}
    rows_b = {r["prompt_tokens"]: r for r in b.get("results", []) if r.get("prompt_tokens")}
    shared = sorted(set(rows_a) & set(rows_b))

    if not shared:
        print("✖ Aucune longueur de contexte commune entre les deux fichiers.")
        return 2

    print(f"A: {a.get('label', '?')}")
    print(f"B: {b.get('label', '?')}")
    print()
    print("| contexte | TTFT A→B (s) | gain | prefill A→B (tok/s) | gain | decode A→B (tok/s) | gain | pic A→B (Go) |")
    print("|---|---|---|---|---|---|---|---|")

    failures: list[str] = []
    metrics = [
        ("ttft", "ttft_s", True),
        ("prefill", "prefill_tps", False),
        ("decode", "decode_tps", False),
        ("peak", "peak_memory_gb", True),
    ]

    for n in shared:
        ra, rb = rows_a[n], rows_b[n]
        cells = [f"{n}"]
        for name, _key, lower_is_better in metrics:
            va, vb = pick_metric(ra, name), pick_metric(rb, name)
            gain = delta_pct(va, vb, lower_is_better)
            fmt = (lambda v: "—" if v is None else (f"{v:.2f}" if name != "peak" else f"{v:.1f}"))
            cells.append(f"{fmt(va)} → {fmt(vb)}")
            if gain is None:
                cells.append("—")
            else:
                cells.append(f"{gain:+.1f} %")
                # Une régression = un gain négatif au-delà du seuil.
                if gain < -max_regression:
                    failures.append(f"ctx={n} {name}: {gain:+.1f} %")
        print("| " + " | ".join(cells) + " |")

    print()
    if failures:
        print(f"✖ {len(failures)} régression(s) au-delà de {max_regression} % :")
        for f in failures:
            print("   -", f)
        return 1

    print(f"✔ Aucune régression au-delà de {max_regression} %.")
    return 0


def compare_prefix(a: dict[str, Any], b: dict[str, Any], max_regression: float) -> int:
    keys = ["cold", "stable_prefix", "volatile_head"]
    print(f"A: {a.get('label', '?')}   B: {b.get('label', '?')}")
    print()
    print("| scénario | TTFT A→B (s) | gain | tokens réutilisés A→B |")
    print("|---|---|---|---|")

    failures: list[str] = []
    for key in keys:
        ra, rb = a.get(key), b.get(key)
        if not isinstance(ra, dict) or not isinstance(rb, dict):
            continue
        va, vb = ra.get("ttft_s"), rb.get("ttft_s")
        gain = delta_pct(va, vb, True)
        reused_a = ra.get("cache_hit_tokens", 0)
        reused_b = rb.get("cache_hit_tokens", 0)
        label = ra.get("scenario", key)
        gain_txt = "—" if gain is None else f"{gain:+.1f} %"
        print(f"| {label} | {va} → {vb} | {gain_txt} | {reused_a} → {reused_b} |")
        if gain is not None and gain < -max_regression:
            failures.append(f"{key}: {gain:+.1f} %")

    print()
    if failures:
        print(f"✖ régression(s) : {', '.join(failures)}")
        return 1
    print(f"✔ Aucune régression au-delà de {max_regression} %.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Compare deux campagnes de mesure MLX")
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--mode", choices=["lengths", "prefix"], default="lengths",
                    help="lengths = bench_local.py, prefix = bench_prefix_cache.py")
    ap.add_argument("--max-regression", type=float, default=5.0,
                    help="seuil de régression toléré, en pourcentage (défaut 5)")
    args = ap.parse_args()

    try:
        a, b = load(args.before), load(args.after)
    except (OSError, json.JSONDecodeError) as err:
        print(f"✖ Lecture impossible : {err}")
        return 2

    if args.mode == "prefix":
        return compare_prefix(a, b, args.max_regression)
    return compare_lengths(a, b, args.max_regression)


if __name__ == "__main__":
    sys.exit(main())
