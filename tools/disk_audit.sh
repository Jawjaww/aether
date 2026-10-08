#!/usr/bin/env bash
#
# disk_audit.sh — audit de l'espace disque, EN LECTURE SEULE.
#
# Ne supprime rien, ne déplace rien. Affiche seulement où sont les octets.
# Usage :  bash tools/disk_audit.sh
#
set -uo pipefail

h() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
sh_() { printf '  %-64s %s\n' "$(printf '%s' "$1" | sed "s|$HOME|~|")" "$(du -sh "$1" 2>/dev/null | cut -f1)"; }

h "Vue générale"
df -h /System/Volumes/Data | tail -1

h "Dossier personnel : top 20"
du -h -d 1 "$HOME" 2>/dev/null | sort -h | tail -20

h "~/Library : top 10"
du -h -d 1 "$HOME/Library" 2>/dev/null | sort -h | tail -10

h "~/Library/Application Support : top 10"
du -h -d 1 "$HOME/Library/Application Support" 2>/dev/null | sort -h | tail -10

h "~/Library/Containers : top 8"
du -h -d 1 "$HOME/Library/Containers" 2>/dev/null | sort -h | tail -8

h "~/Documents/LLM : détail"
du -h -d 2 "$HOME/Documents/LLM" 2>/dev/null | sort -h | tail -12

h "Caches LLM et outils de développement"
for d in \
  "$HOME/models" \
  "$HOME/.cache/huggingface" \
  "$HOME/.cache/huggingface/hub" \
  "$HOME/.cache/huggingface/xet" \
  "$HOME/.ollama" \
  "$HOME/.lmstudio" \
  "$HOME/.aether" \
  "$HOME/.cache/openwhispr" \
  "$HOME/Library/Application Support/coreMLCache" \
  "$HOME/Library/Containers/com.inferencer" \
  "$HOME/Library/Containers/com.docker.docker" \
  "$HOME/.colima" \
  "$HOME/.npm" \
  "$HOME/.gradle" \
  "$HOME/.android" \
  "$HOME/Library/Android" \
  "$HOME/Downloads" \
  "$HOME/.Trash" ; do
  [ -e "$d" ] && sh_ "$d"
done

h "Dépôts présents dans le cache Hugging Face"
du -sh "$HOME/.cache/huggingface/hub"/* 2>/dev/null | sort -h | tail -15

h "Modèles Ollama"
if command -v ollama >/dev/null 2>&1; then
  ollama list 2>/dev/null || echo "  (démon ollama arrêté — lancez 'ollama serve' ou l'app)"
else
  echo "  (ollama non installé)"
fi

h "Docker : ce qui est récupérable"
if docker system df >/dev/null 2>&1; then
  docker system df
else
  echo "  (démon docker arrêté — démarrez Docker/Colima pour mesurer)"
fi

h "Volumes Docker non utilisés (les plus gros)"
if docker volume ls -q >/dev/null 2>&1; then
  docker volume ls --filter dangling=true --format '{{.Name}}' | head -20
else
  echo "  (démon docker arrêté)"
fi

printf '\n\033[1mAudit terminé — rien n'"'"'a été modifié.\033[0m\n'
