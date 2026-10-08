#!/usr/bin/env python3
"""
omlx_doctor.py — diagnostic du runtime local (LECTURE SEULE).

Répond à une question simple : « le moteur que j'utilise est-il à jour, et quels
leviers de performance me manquent ? »

Il ne modifie RIEN : il lit la version installée du bundle oMLX, interroge les
versions publiées, et affiche l'écart ainsi que la liste des correctifs publiés
entre les deux qui concernent cette machine.

Contexte : l'audit d'octobre 2026 a constaté un écart de 0.3.8 → 0.7.0, avec des
correctifs portant précisément sur le prefill des modèles Qwen hybrides (GDN),
le prefill MoE, la réutilisation de préfixe et un bug de décodage propre au M1 Max.

Usage
-----
  tools/omlx_doctor.py
  tools/omlx_doctor.py --json /tmp/omlx-state.json
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

APP = Path("/Applications/oMLX.app")
BUNDLE = APP / "Contents/Resources/omlx"
RELEASES_API = "https://api.github.com/repos/jundot/omlx/releases?per_page=30"

# Correctifs publiés après 0.3.8 qui concernent directement un Mac M-series
# exécutant un modèle Qwen hybride MoE (Qwen3.5/3.6, GatedDeltaNet).
RELEVANT = [
    ("GDN prefill", "pipeline logiciel de la récurrence GDN : accélère le prefill Qwen3.5/3.6"),
    ("MoE prefill", "fusions gate/up + épilogue SwiGLU sur le chemin de prefill MoE"),
    ("prefix reuse", "les préfixes système/outils stables ne sont plus reprefillés à chaque requête"),
    ("SSD cache growth", "fuite d'une queue d'état complet par tour sur les modèles hybrides"),
    ("M1 Max", "limites de threadgroup déclarées : corrige l'attention de décodage native sur M1 Max"),
    ("Lightning MTP", "support MTP à l'inférence (absent des versions antérieures)"),
    ("expert offload", "lecture des experts déchargés recouvrée avec le calcul résident"),
]


def installed_version() -> tuple[str | None, str | None]:
    version = build = None
    vfile = BUNDLE / "_version.py"
    if vfile.exists():
        m = re.search(r'__version__\s*=\s*"([^"]+)"', vfile.read_text())
        if m:
            version = m.group(1)
    bfile = BUNDLE / "_build_info.py"
    if bfile.exists():
        m = re.search(r'build_number\s*=\s*"([^"]+)"', bfile.read_text())
        if m:
            build = m.group(1)
    return version, build


def semver(text: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", text or "")
    return tuple(int(n) for n in nums[:3]) or (0,)


def fetch_releases() -> list[dict]:
    req = urllib.request.Request(
        RELEASES_API,
        headers={"User-Agent": "aether-omlx-doctor", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


def macos_version() -> str:
    return platform.mac_ver()[0] or "?"


def main() -> int:
    ap = argparse.ArgumentParser(description="Diagnostic du runtime oMLX (lecture seule)")
    ap.add_argument("--json", default=None, help="écrit l'état dans un fichier JSON")
    args = ap.parse_args()

    state: dict = {"installed": None, "latest": None, "outdated": None, "macos": macos_version()}

    print("=== État du runtime ===")
    if not APP.exists():
        print("  ✖ oMLX.app introuvable dans /Applications")
        return 1

    version, build = installed_version()
    state["installed"] = {"version": version, "build": build}
    print(f"  oMLX installé : {version or '?'} (build {build or '?'})")
    print(f"  macOS         : {state['macos']}")

    try:
        releases = fetch_releases()
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        print(f"  ⚠️  Versions publiées injoignables ({err}) — diagnostic partiel.")
        releases = []

    if releases:
        stable = [r for r in releases if not re.search(r"(rc|dev|alpha|beta)", r["tag_name"], re.I)]
        latest = (stable or releases)[0]
        state["latest"] = {"tag": latest["tag_name"], "date": latest["published_at"][:10]}
        print(f"  oMLX courant  : {latest['tag_name']} ({latest['published_at'][:10]})")

        if version and semver(latest["tag_name"]) > semver(version):
            state["outdated"] = True
            gap = len([r for r in releases if semver(r["tag_name"]) > semver(version)])
            print(f"  → RETARD : {gap} version(s) publiée(s) depuis la tienne.")
        else:
            state["outdated"] = False
            print("  → à jour.")

        body = "\n".join((r.get("body") or "") for r in releases
                         if not version or semver(r["tag_name"]) > semver(version))
        print()
        print("=== Correctifs publiés depuis ta version, pertinents pour cette machine ===")
        found = 0
        for needle, why in RELEVANT:
            if needle.lower() in body.lower():
                found += 1
                print(f"  • {needle:18s} — {why}")
        if found == 0:
            print("  (aucun des correctifs suivis n'apparaît dans les notes)")

    print()
    print("=== Leviers à activer côté oMLX (indépendants de la version) ===")
    print("  • --paged-ssd-cache-dir   : cache de préfixe paginé (désactivé par défaut)")
    print("  • max_tool_result_tokens  : troncature des résultats d'outils, vrai tokenizer")
    print("  • specprefill_enabled     : prefill sparse au-delà de ~8k tokens")
    print("  • dflash_enabled / MTP    : à MESURER, historiquement négatif sur M1")

    print()
    print("=== Protocole d'A/B à exécuter après mise à jour ===")
    print("  1. baseline 8-bit   : tools/bench_local.py --model <8bit>  --lengths 4096,16384 --json r/8bit.json")
    print("  2. candidat 4-bit   : tools/bench_local.py --model <4bit>  --lengths 4096,16384 --json r/4bit.json")
    print("  3. comparer         : tools/bench_compare.py r/8bit.json r/4bit.json")
    print("  4. MTP on/off       : relancer 1 et 2 avec la tête MTP, puis comparer de même")
    print("  5. cache de préfixe : tools/bench_prefix_cache.py --json r/prefix.json")

    if args.json:
        Path(args.json).write_text(json.dumps(state, indent=2, ensure_ascii=False))
        print(f"\nÉtat écrit dans {args.json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
