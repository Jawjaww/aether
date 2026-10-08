// packages/core/test/repo-map.test.ts
//
// La carte de signatures doit être déterministe : c'est la condition pour qu'elle
// puisse vivre dans le préfixe stable du prompt sans casser le cache d'oMLX.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRepoMap } from "../src/indexer/repo-map.js";
import type { ASTChunk, ASTGraph } from "../src/indexer/ast-extractor.js";

const chunk = (filePath: string, over: Partial<ASTChunk> = {}): ASTChunk => ({
  filePath,
  fileHash: "h",
  functions: [],
  types: [],
  components: [],
  rnStyles: [],
  imports: [],
  exports: [],
  cyclicRefs: [],
  extractedAt: 0,
  ...over,
});

const graphOf = (
  chunks: ASTChunk[],
  edges: Record<string, string[]> = {},
): ASTGraph => {
  const nodes = new Map(chunks.map((c) => [c.filePath, c]));
  const reverseEdges = new Map<string, Set<string>>();
  for (const [from, tos] of Object.entries(edges)) {
    for (const to of tos) {
      const set = reverseEdges.get(to) ?? new Set<string>();
      set.add(from);
      reverseEdges.set(to, set);
    }
  }
  return {
    nodes,
    edges: new Map(Object.entries(edges)),
    reverseEdges,
    maxDepth: 0,
    cyclicEdges: 0,
    symbols: [],
    crossFileRefs: 0,
  };
};

test("la carte est déterministe pour un graphe inchangé", () => {
  const graph = graphOf([
    chunk("src/b.ts", {
      functions: [{ name: "beta", params: "", returnType: null, isAsync: false, isExported: true, startLine: 1, endLine: 2 }],
    }),
    chunk("src/a.ts", {
      functions: [{ name: "alpha", params: "x: number", returnType: "string", isAsync: true, isExported: true, startLine: 1, endLine: 5 }],
    }),
  ]);

  const first = buildRepoMap(graph);
  const second = buildRepoMap(graph);

  assert.equal(first.text, second.text);
  assert.equal(first.version, second.version);
  assert.equal(first.files, 2);
  assert.equal(first.symbols, 2);
});

test("les fichiers les plus importés passent en premier", () => {
  const graph = graphOf(
    [
      chunk("src/isolated.ts", {
        functions: [{ name: "seul", params: "", returnType: null, isAsync: false, isExported: true, startLine: 1, endLine: 1 }],
      }),
      chunk("src/central.ts", {
        functions: [{ name: "central", params: "", returnType: null, isAsync: false, isExported: true, startLine: 1, endLine: 1 }],
      }),
    ],
    { "src/a.ts": ["src/central.ts"], "src/b.ts": ["src/central.ts"] },
  );

  const map = buildRepoMap(graph);
  assert.ok(
    map.text.indexOf("src/central.ts") < map.text.indexOf("src/isolated.ts"),
    "le fichier le plus importé doit apparaître en premier",
  );
});

test("seules les signatures sont incluses, jamais les corps", () => {
  const graph = graphOf([
    chunk("src/x.ts", {
      functions: [{ name: "f", params: "a: string", returnType: "void", isAsync: false, isExported: true, startLine: 1, endLine: 40 }],
      types: [
        {
          kind: "interface",
          name: "Big",
          body: "interface Big {\n  a: string;\n  b: number;\n}",
          isExported: true,
          startLine: 50,
          endLine: 55,
        },
      ],
    }),
  ]);

  const map = buildRepoMap(graph);
  assert.ok(map.text.includes("function f(a: string): void"));
  assert.ok(map.text.includes("interface Big"));
  assert.ok(!map.text.includes("b: number"), "le corps du type ne doit pas être recopié");
});

test("la carte respecte le budget et signale la troncature", () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    chunk(`src/fichier_${String(i).padStart(3, "0")}.ts`, {
      functions: [
        {
          name: `fonction_${i}`,
          params: "argumentUn: string, argumentDeux: number",
          returnType: "Promise<Resultat>",
          isAsync: true,
          isExported: true,
          startLine: 1,
          endLine: 3,
        },
      ],
    }),
  );

  const map = buildRepoMap(graphOf(many), { tokenBudget: 300 });

  assert.ok(map.truncated, "la troncature doit être signalée");
  assert.ok(
    map.text.length <= 300 * 4 + 200,
    `la carte doit tenir dans le budget (obtenu ${map.text.length} caractères)`,
  );
  assert.ok(map.files > 0, "au moins un fichier doit être listé");
});

test("un graphe vide produit une carte vide et stable", () => {
  const map = buildRepoMap(graphOf([]));
  assert.equal(map.text, "");
  assert.equal(map.files, 0);
  assert.equal(map.symbols, 0);
  assert.equal(map.truncated, false);
  assert.equal(map.version, buildRepoMap(graphOf([])).version);
});

test("un fichier sans symbole n'encombre pas la carte", () => {
  const map = buildRepoMap(graphOf([chunk("src/vide.ts")]));
  assert.equal(map.text, "");
  assert.equal(map.files, 0);
});
