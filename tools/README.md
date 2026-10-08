# Outils de mesure et de diagnostic

Ces scripts servent à **trancher par la mesure** les questions de performance
locales (prefill, TTFT, cache de préfixe, quantification, MTP) sur cette machine.
Ils ne modifient rien : ils mesurent, comparent et diagnostiquent.

Ils requièrent l'interpréteur Python qui a `mlx_lm` **et** le support de
l'architecture du modèle (`qwen3_5_moe`) :

```bash
~/miniconda3/bin/python tools/<script>.py
```

> ⚠️ Le `mlx_lm` installé par Homebrew (0.30.4) **ne supporte pas** `qwen3_5_moe` :
> `load()` échoue avec `ValueError: Model type qwen3_5_moe not supported`.
> Utiliser l'interpréteur conda (0.31.3), ou mettre à jour vers ≥ 0.32.0.

---

## `bench_local.py` — courbe TTFT / prefill / décodage

Mesure le coût du contexte. C'est ce qui a produit la loi des **~3,6 ms de TTFT
par token de contexte** sur cette machine.

```bash
~/miniconda3/bin/python tools/bench_local.py \
  --model ~/models/Qwen3.6-35B-A3B-RotorQuant-MLX-8bit \
  --lengths 1024,4096,8192,16384,32768 --max-tokens 24 \
  --label 8bit --json tools/results/bench-8bit.json
```

Options utiles : `--prefill-step`, `--kv-bits`, `--quantized-kv-start`,
`--draft-model`, `--num-draft-tokens`.

## `bench_prefix_cache.py` — valeur d'un préfixe stable

Reproduit la sémantique du cache par blocs de 256 tokens d'oMLX pour chiffrer
l'écart entre « contexte volatil en tête » et « préfixe stable ». C'est la mesure
qui a établi le **×5,9 sur le TTFT**.

```bash
~/miniconda3/bin/python tools/bench_prefix_cache.py \
  --model ~/models/<modele> --json tools/results/bench-prefix.json
```

## `bench_compare.py` — comparaison et garde-fou de régression

Apparie deux campagnes par longueur de contexte et sort en **erreur (code 1)** si
une régression dépasse le seuil. Utilisable comme garde-fou avant/après un
changement de modèle ou de réglage.

```bash
python3 tools/bench_compare.py avant.json apres.json
python3 tools/bench_compare.py avant.json apres.json --max-regression 10
python3 tools/bench_compare.py avant.json apres.json --mode prefix
```

## `omlx_doctor.py` — état du runtime (lecture seule)

Compare la version d'oMLX installée aux versions publiées, vérifie la
compatibilité macOS, et liste les correctifs publiés depuis la version installée
qui concernent cette machine (prefill GDN/MoE, réutilisation de préfixe, MTP,
correctifs M1 Max). Affiche aussi le protocole d'A/B à exécuter.

```bash
python3 tools/omlx_doctor.py --json tools/results/omlx-state.json
```

---

## Protocole recommandé

1. **Diagnostic** : `omlx_doctor.py` → savoir ce qui manque côté moteur.
2. **Baseline** : `bench_local.py` sur la configuration actuelle.
3. **Candidat** : `bench_local.py` sur la nouvelle configuration, mêmes longueurs.
4. **Décision** : `bench_compare.py` (seuil 5 % par défaut).
5. **Cache** : `bench_prefix_cache.py` pour vérifier que le préfixe reste stable.

Les résultats bruts sont conservés dans `tools/results/`.
