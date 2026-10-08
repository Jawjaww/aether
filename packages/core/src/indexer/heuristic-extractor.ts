// packages/core/src/indexer/heuristic-extractor.ts
//
// Extraction de signatures pour les langages dont la grammaire tree-sitter
// n'est pas installable ici (Python, Go, Rust).
//
// POURQUOI HEURISTIQUE ET PAS tree-sitter : les grammaires publiées sur npm
// ciblent tree-sitter ≥ 0.25 (ABI 15) alors que le paquet installé est 0.21.1
// (ABI 14) ; les charger lèverait « Incompatible language version ». Plutôt
// qu'introduire une dépendance native incompatible, on extrait les symboles par
// analyse ligne à ligne — **moins fidèle qu'un AST**, assumé et documenté.
//
// Ce que ça apporte : un dépôt polyglotte cesse d'être invisible pour la repo-map
// et pour la récupération. Ce que ça ne fait pas : pas de graphe de dépendances
// résolu, pas de détection de composants, pas de portée réelle.

import type { FunctionSignature, TypeDeclaration } from "./ast-extractor.js";

export type HeuristicLanguage = "python" | "go" | "rust";

export interface HeuristicExtraction {
  language: HeuristicLanguage;
  functions: FunctionSignature[];
  types: TypeDeclaration[];
  imports: string[];
  cyclomaticScore: number;
}

type RawSymbol = {
  kind: "function" | "type";
  name: string;
  params: string;
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  typeKind?: TypeDeclaration["kind"];
  body?: string;
  /** 1-based. */
  startLine: number;
  indent: number;
};

/** Extension → langage couvert par cet extracteur. */
export const HEURISTIC_EXTENSIONS: Record<string, HeuristicLanguage> = {
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

const BRANCH_TOKENS =
  /\b(if|elif|else|for|while|case|catch|match|guard|when)\b|&&|\|\||\?/g;

const indentOf = (line: string): number => {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
};

/**
 * Lit un groupe équilibré `( … )` pouvant s'étaler sur plusieurs lignes.
 * `lineIdx`/`colIdx` pointent sur le caractère d'ouverture.
 */
const readBalanced = (
  lines: string[],
  lineIdx: number,
  colIdx: number,
  open = "(",
  close = ")",
  maxLines = 12,
): { text: string; endLine: number; endCol: number } | null => {
  let depth = 0;
  for (let l = lineIdx; l < Math.min(lines.length, lineIdx + maxLines); l++) {
    const line = lines[l] ?? "";
    for (let c = l === lineIdx ? colIdx : 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return { text: line.slice(colIdx + 1, c), endLine: l, endCol: c };
        }
      }
    }
  }
  return null;
};

/** Assigne à chaque symbole une fin de bloc plausible (avant le prochain de même niveau). */
const assignEndLines = (symbols: RawSymbol[], lastLine: number): void => {
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    let end = lastLine;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j]!;
      if (next.indent <= current.indent) {
        end = next.startLine - 1;
        break;
      }
    }
    current.startLine = current.startLine;
    (current as RawSymbol & { endLine?: number }).endLine = Math.max(current.startLine, end);
  }
};

// ─── Python ──────────────────────────────────────────────────────────────────

const PY_DEF = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*:/;
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\s+|import\s+([\w.]+))/;

const extractPython = (lines: string[]): Pick<HeuristicExtraction, "functions" | "types" | "imports"> => {
  const symbols: RawSymbol[] = [];
  const imports: string[] = [];
  const lastLine = lines.length;

  lines.forEach((line, idx) => {
    const imp = PY_IMPORT.exec(line);
    if (imp) {
      const target = imp[1] ?? imp[2];
      if (target) imports.push(target.replace(/\./g, "/"));
      return;
    }

    const cls = PY_CLASS.exec(line);
    if (cls) {
      const name = cls[2]!;
      symbols.push({
        kind: "type",
        name,
        params: "",
        returnType: null,
        isAsync: false,
        isExported: !name.startsWith("_"),
        typeKind: "class",
        body: `class ${name}${cls[3] ? cls[3] : ""}`,
        startLine: idx + 1,
        indent: indentOf(line),
      });
      return;
    }

    const def = PY_DEF.exec(line);
    if (def) {
      const name = def[3]!;
      const openCol = line.indexOf("(", def[0].length - 1);
      const params = openCol >= 0 ? readBalanced(lines, idx, openCol) : null;
      // Type de retour : après la parenthèse fermante, jusqu'au « : ».
      let returnType: string | null = null;
      if (params) {
        const tail = (lines[params.endLine] ?? "").slice(params.endCol + 1);
        const m = /^\s*->\s*([^:]+?)\s*:/.exec(tail);
        if (m) returnType = m[1]!.trim();
      }
      symbols.push({
        kind: "function",
        name,
        params: (params?.text ?? "").replace(/\s*\n\s*/g, " ").trim(),
        returnType,
        isAsync: Boolean(def[2]),
        isExported: !name.startsWith("_"),
        startLine: idx + 1,
        indent: indentOf(line),
      });
    }
  });

  return { ...splitSymbols(symbols, lastLine), imports };
};

// ─── Go ──────────────────────────────────────────────────────────────────────

const GO_FUNC = /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;
const GO_TYPE_ALIAS = /^type\s+([A-Za-z_]\w*)\s+([A-Za-z_[\].*]+)/;
const GO_IMPORT_SINGLE = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/;
const GO_IMPORT_LINE = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;

const extractGo = (lines: string[]): Pick<HeuristicExtraction, "functions" | "types" | "imports"> => {
  const symbols: RawSymbol[] = [];
  const imports: string[] = [];
  const lastLine = lines.length;
  let inImportBlock = false;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    if (!inImportBlock) {
      const single = GO_IMPORT_SINGLE.exec(trimmed);
      if (single) {
        imports.push(single[1]!);
        return;
      }
      if (/^import\s*\($/.test(trimmed)) {
        inImportBlock = true;
        return;
      }
    } else {
      if (trimmed === ")") {
        inImportBlock = false;
        return;
      }
      const inside = GO_IMPORT_LINE.exec(line);
      if (inside) imports.push(inside[1]!);
      return;
    }

    const typeDecl = GO_TYPE.exec(trimmed);
    if (typeDecl) {
      const name = typeDecl[1]!;
      symbols.push({
        kind: "type",
        name,
        params: "",
        returnType: null,
        isAsync: false,
        isExported: /^[A-Z]/.test(name),
        typeKind: typeDecl[2] === "interface" ? "interface" : "struct",
        body: `${typeDecl[2]} ${name}`,
        startLine: idx + 1,
        indent: indentOf(line),
      });
      return;
    }

    const alias = GO_TYPE_ALIAS.exec(trimmed);
    if (alias && alias[1] && alias[2] && !["struct", "interface"].includes(alias[2])) {
      symbols.push({
        kind: "type",
        name: alias[1],
        params: "",
        returnType: null,
        isAsync: false,
        isExported: /^[A-Z]/.test(alias[1]),
        typeKind: "type",
        body: `type ${alias[1]} ${alias[2]}`,
        startLine: idx + 1,
        indent: indentOf(line),
      });
      return;
    }

    const fn = GO_FUNC.exec(trimmed);
    if (fn) {
      const name = fn[2]!;
      // La parenthèse d'ouverture des paramètres : après le nom.
      const openCol = line.indexOf("(", line.indexOf(name) + name.length);
      const params = openCol >= 0 ? readBalanced(lines, idx, openCol) : null;
      let returnType: string | null = null;
      if (params) {
        const tail = (lines[params.endLine] ?? "").slice(params.endCol + 1);
        const stop = tail.search(/[{]|$/);
        const cleaned = tail.slice(0, stop === -1 ? undefined : stop).trim();
        if (cleaned) returnType = cleaned;
      }
      symbols.push({
        kind: "function",
        name,
        params: (params?.text ?? "").replace(/\s*\n\s*/g, " ").trim(),
        returnType,
        isAsync: false, // Go n'a pas d'async : la concurrence passe par `go`/channels.
        isExported: /^[A-Z]/.test(name),
        startLine: idx + 1,
        indent: indentOf(line),
      });
    }
  });

  return { ...splitSymbols(symbols, lastLine), imports };
};

// ─── Rust ────────────────────────────────────────────────────────────────────

const RS_FN = /^(\s*)(pub(?:\([^)]*\))?\s+)?(async\s+)?(?:const\s+|unsafe\s+)*fn\s+([A-Za-z_]\w*)/;
const RS_TYPE = /^(\s*)(pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/;
const RS_USE = /^\s*use\s+([^;]+);/;

const extractRust = (lines: string[]): Pick<HeuristicExtraction, "functions" | "types" | "imports"> => {
  const symbols: RawSymbol[] = [];
  const imports: string[] = [];
  const lastLine = lines.length;

  lines.forEach((line, idx) => {
    const use = RS_USE.exec(line);
    if (use?.[1]) {
      imports.push(use[1].split("::").slice(0, 2).join("/").replace(/[{}]/g, ""));
      return;
    }

    const typeDecl = RS_TYPE.exec(line);
    if (typeDecl) {
      const name = typeDecl[4]!;
      symbols.push({
        kind: "type",
        name,
        params: "",
        returnType: null,
        isAsync: false,
        isExported: Boolean(typeDecl[2]),
        typeKind: typeDecl[3] === "struct" ? "struct" : typeDecl[3] === "trait" ? "trait" : "enum",
        body: `${typeDecl[3]} ${name}`,
        startLine: idx + 1,
        indent: indentOf(line),
      });
      return;
    }

    const fn = RS_FN.exec(line);
    if (fn) {
      const name = fn[4]!;
      const openCol = line.indexOf("(", line.indexOf(name) + name.length);
      const params = openCol >= 0 ? readBalanced(lines, idx, openCol, "(", ")", 8) : null;
      let returnType: string | null = null;
      if (params) {
        const tailStart = (lines[params.endLine] ?? "").slice(params.endCol + 1);
        const arrow = /^\s*->\s*(.+)$/.exec(tailStart);
        if (arrow?.[1]) {
          const stop = arrow[1].search(/\bwhere\b|\{/);
          returnType = (stop === -1 ? arrow[1] : arrow[1].slice(0, stop)).trim();
        }
      }
      symbols.push({
        kind: "function",
        name,
        params: (params?.text ?? "").replace(/\s*\n\s*/g, " ").trim(),
        returnType,
        isAsync: Boolean(fn[3]),
        isExported: Boolean(fn[2]),
        startLine: idx + 1,
        indent: indentOf(line),
      });
    }
  });

  return { ...splitSymbols(symbols, lastLine), imports };
};

// ─── Mise en forme ───────────────────────────────────────────────────────────

const splitSymbols = (
  symbols: RawSymbol[],
  lastLine: number,
): { functions: FunctionSignature[]; types: TypeDeclaration[] } => {
  assignEndLines(symbols, lastLine);
  const withEnd = symbols as Array<RawSymbol & { endLine?: number }>;

  const functions: FunctionSignature[] = withEnd
    .filter((s) => s.kind === "function")
    .map((s) => ({
      name: s.name,
      params: s.params,
      returnType: s.returnType,
      isAsync: s.isAsync,
      isExported: s.isExported,
      startLine: s.startLine,
      endLine: s.endLine ?? s.startLine,
    }));

  const types: TypeDeclaration[] = withEnd
    .filter((s) => s.kind === "type")
    .map((s) => ({
      kind: s.typeKind ?? "type",
      name: s.name,
      body: s.body ?? s.name,
      isExported: s.isExported,
      startLine: s.startLine,
      endLine: s.endLine ?? s.startLine,
    }));

  return { functions, types };
};

// ─── Point d'entrée ──────────────────────────────────────────────────────────

/** Renvoie `null` si l'extension n'est pas couverte par l'extracteur heuristique. */
export const extractHeuristicSignatures = (
  filePath: string,
  source: string,
): HeuristicExtraction | null => {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const language = HEURISTIC_EXTENSIONS[ext];
  if (!language) return null;
  if (!source || source.trim().length === 0) {
    return { language, functions: [], types: [], imports: [], cyclomaticScore: 1 };
  }

  const lines = source.split("\n");
  const partial =
    language === "python"
      ? extractPython(lines)
      : language === "go"
        ? extractGo(lines)
        : extractRust(lines);

  const branches = source.match(BRANCH_TOKENS)?.length ?? 0;

  return { language, ...partial, cyclomaticScore: 1 + branches };
};
