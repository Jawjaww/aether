"""Point d'entrée empaqueté du serveur ML unifié d'Aether.

Il n'existe qu'**une** implémentation : ``packages/core/reranker_server.py``, qui
sert à la fois le cross-encoder BGE-v2-m3 sur MPS (``/rerank``) et les embeddings
FastEmbed (``/v1/embeddings``) sur le port 8082.

Ce module n'est qu'un lanceur. Il remplace l'ancienne copie divergente du serveur,
qui n'avait pas l'endpoint ``/v1/embeddings`` et donnait donc un index RAG vide
quand on la lançait (audit octobre 2026, constat P2-2).

Usage :
    aether-reranker                 # après `pip install -e packages/reranker`
    python packages/reranker/reranker_server.py
"""

from __future__ import annotations

import runpy
from pathlib import Path

# packages/reranker/reranker_server.py -> packages/core/reranker_server.py
CANONICAL = Path(__file__).resolve().parents[1] / "core" / "reranker_server.py"


def main() -> None:
    if not CANONICAL.exists():
        raise SystemExit(
            f"Serveur canonique introuvable : {CANONICAL}\n"
            "Attendu : packages/core/reranker_server.py"
        )
    runpy.run_path(str(CANONICAL), run_name="__main__")


if __name__ == "__main__":
    main()
