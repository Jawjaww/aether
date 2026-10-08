// packages/core/src/indexer/repo-map.ts
//
// Repo-map par signatures — la « table des matières » du dépôt.
//
// Pourquoi : dans une boucle agentique, l'exploration itérative (lire des fichiers
// entiers pour comprendre la structure) consomme 54 à 70 % de la fenêtre, là où une
// carte de signatures tient dans 4 à 6 % et donne ~90 % de la compréhension
// architecturale (mesures Aider / littérature 2026). C'est le levier qui réduit le
// plus le contexte *stable* — donc le préfill.
//
// Contrat : la carte est **déterministe**. Deux appels sur un graphe inchangé
// produisent exactement le même texte, ce qui permet de la placer dans le préfixe
// stable du prompt sans casser le cache de préfixe d'oMLX. Elle ne contient que
// des signatures : ni corps de fonction, ni corps d'interface (tronqué).

import { createHash } from "node:crypto";

import type { ASTGraph } from "./ast-extractor.js";

export interface RepoMapOptions {
  /** Budget approximatif en tokens (converti en caractères, ratio 4:1). */
  tokenBudget?: number;
  /** Nombre maximum de fichiers listés. */
  maxFiles?: number;
}

export interface RepoMap {
  /** Bloc texte prêt à insérer dans le prompt. */
  text: string;
  /** Empreinte du contenu : change si et seulement si la carte change. */
  version: string;
  files: number;
  symbols: number;
  truncated: boolean;
}

/** Ratio caractères→tokens utilisé par le reste du daemon en l'absence d'encodeur. */
const CHARS_PER_TOKEN = 4;

/** Tronque un corps de type à sa première ligne (une carte reste une carte). */
const firstLine = (text: string, max = 120): string => {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Construit la carte.
 *
 * Ordre de priorité des fichiers : **nombre de fichiers qui l'importent**
 * (in-degree du graphe), décroissant, puis chemin alphabétique pour garantir le
 * déterminisme. Un fichier très référencé est plus structurant qu'un fichier isolé,
 * et l'ordre alphabétique seul ferait gagner les fichiers de `src/a/` à chaque
 * troncature.
 */
export const buildRepoMap = (
  graph: ASTGraph,
  options: RepoMapOptions = {},
): RepoMap => {
  const charBudget = (options.tokenBudget ?? 1500) * CHARS_PER_TOKEN;
  const maxFiles = options.maxFiles ?? 400;

  const paths = [...graph.nodes.keys()];

  // Les fichiers sans nom de base exploitable ou hors du projet sont ignorés.
  const ranked = paths
    .map((filePath) => ({
      filePath,
      importers: graph.reverseEdges.get(filePath)?.size ?? 0,
      chunk: graph.nodes.get(filePath),
    }))
    .filter((entry) => entry.chunk !== undefined)
    .sort((a, b) => {
      if (b.importers !== a.importers) return b.importers - a.importers;
      return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
    });

  const blocks: string[] = [];
  let used = 0;
  let files = 0;
  let symbols = 0;
  let truncated = false;

  for (const { filePath, chunk } of ranked) {
    if (!chunk) continue;
    if (files >= maxFiles) {
      truncated = true;
      break;
    }

    const lines: string[] = [];

    for (const f of chunk.functions) {
      const marker = f.isExported ? "export " : "";
      const asyncKw = f.isAsync ? "async " : "";
      const ret = f.returnType ? `: ${f.returnType}` : "";
      lines.push(`  ${marker}${asyncKw}function ${f.name}(${f.params})${ret}`);
    }

    for (const c of chunk.components) {
      const marker = c.isDefault ? "export default " : "export ";
      const props = c.props ? `(${c.props})` : "()";
      lines.push(`  ${marker}component ${c.name}${props}`);
    }

    for (const t of chunk.types) {
      const marker = t.isExported ? "export " : "";
      lines.push(`  ${marker}${t.kind} ${t.name} ${firstLine(t.body)}`);
    }

    // Fichier sans symbole exposé : inutile dans une carte.
    if (lines.length === 0) continue;

    const block = `${filePath}\n${lines.join("\n")}`;

    // On dépasse le budget : on s'arrête proprement (le premier fichier est
    // toujours conservé, même s'il est à lui seul plus gros que le budget).
    if (blocks.length > 0 && used + block.length + 1 > charBudget) {
      truncated = true;
      break;
    }

    blocks.push(block);
    used += block.length + 1;
    files += 1;
    symbols += lines.length;
  }

  const text = blocks.join("\n");
  const version = createHash("sha256").update(text).digest("hex").slice(0, 16);

  return { text, version, files, symbols, truncated };
};
