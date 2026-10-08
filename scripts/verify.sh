#!/usr/bin/env bash
#
# verify.sh — vérification complète du dépôt, en une commande.
#
# Enchaîne : typecheck (3 workspaces) → build → tests unitaires et d'intégration
# → test de bout en bout du processus gateway.
#
# Usage :
#   scripts/verify.sh
#   scripts/verify.sh --skip-build
#   scripts/verify.sh --bench tools/results/avant.json tools/results/apres.json
#
# Sort en erreur (code non nul) à la première étape qui échoue.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

SKIP_BUILD=0
BENCH_BEFORE=""
BENCH_AFTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --bench)
      BENCH_BEFORE="${2:-}"; BENCH_AFTER="${3:-}"; shift 3 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

FAILED=0
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32m✔\033[0m %s\n' "$1"; }
ko()   { printf '   \033[31m✖\033[0m %s\n' "$1"; FAILED=1; }

# ── 1. Typecheck ──────────────────────────────────────────────────────────────
step "typecheck (3 workspaces)"
if npm run typecheck >/tmp/aether-verify-typecheck.log 2>&1; then
  ok "aucune erreur de type"
else
  ko "erreurs de type — voir /tmp/aether-verify-typecheck.log"
  grep -E "error TS" /tmp/aether-verify-typecheck.log | head -10
fi

# ── 2. Build ──────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "build"
  if npm run build >/tmp/aether-verify-build.log 2>&1; then
    ok "compilation réussie"
  else
    ko "échec de compilation — voir /tmp/aether-verify-build.log"
    tail -10 /tmp/aether-verify-build.log
  fi
else
  step "build (ignoré)"
fi

# ── 3. Tests unitaires et d'intégration ───────────────────────────────────────
step "tests (core + gateway)"
TEST_OUT=$(npm test 2>&1)
if echo "$TEST_OUT" | grep -qE "^ℹ fail 0" && ! echo "$TEST_OUT" | grep -qE "^ℹ fail [1-9]"; then
  PASSED=$(echo "$TEST_OUT" | grep -E "^ℹ pass " | awk '{s+=$3} END {print s}')
  ok "$PASSED tests passent"
else
  ko "des tests échouent"
  echo "$TEST_OUT" | grep -E "^✖|^ℹ (tests|pass|fail)" | head -20
fi

# ── 4. Bout en bout ───────────────────────────────────────────────────────────
step "test de bout en bout (processus gateway réel)"
E2E_OUT=$(cd packages/gateway && npm run test:e2e 2>&1)
if echo "$E2E_OUT" | grep -q "Toutes les vérifications de bout en bout passent"; then
  CHECKS=$(echo "$E2E_OUT" | grep -cE "^  ✔")
  ok "$CHECKS vérifications passent"
else
  ko "le test de bout en bout échoue"
  echo "$E2E_OUT" | grep -E "^  ✖" | head -10
fi

# ── 5. Comparaison de benchmarks (optionnelle) ────────────────────────────────
if [ -n "$BENCH_BEFORE" ] && [ -n "$BENCH_AFTER" ]; then
  step "comparaison de benchmarks"
  if python3 tools/bench_compare.py "$BENCH_BEFORE" "$BENCH_AFTER"; then
    ok "aucune régression au-delà du seuil"
  else
    ko "régression détectée (ou fichiers illisibles)"
  fi
fi

# ── Bilan ─────────────────────────────────────────────────────────────────────
printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m✔ Vérification complète : tout est vert.\033[0m\n'
else
  printf '\033[31m✖ Vérification incomplète : voir les étapes ci-dessus.\033[0m\n'
fi
exit "$FAILED"
