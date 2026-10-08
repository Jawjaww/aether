// packages/core/test/budget-engine.test.ts
//
// Tests de non-régression du knapsack budgétaire (audit octobre 2026, constat P2-1).
//
// Bug d'origine : `trySelect` testait le budget TOTAL (`remaining`) et non
// `astBudget`, donc la passe AST pouvait consommer 100 % du budget et affamer
// complètement le RAG. La « réserve RAG de 30 % » n'existait que dans un commentaire.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyBudget, type BudgetChunk } from "../src/budget/budget-engine.js";

const ast = (id: string, tokens: number, score: number, deps?: BudgetChunk["requiredChunks"]): BudgetChunk => ({
  id,
  text: `AST:${id}`,
  tokens,
  score,
  requiredChunks: deps,
});

const rag = (id: string, tokens: number, score: number): BudgetChunk => ({
  id,
  text: `RAG:${id}`,
  tokens,
  score,
});

test("le RAG conserve sa réserve même face à une montagne de chunks AST", async () => {
  // 20 chunks AST de 100 tokens (2 000 tokens disponibles) contre un budget de
  // 1 000, et de quoi remplir la réserve RAG (5 × 100 = 500 ≥ 300).
  // Avant le correctif, l'AST absorbait 10 chunks et il ne restait RIEN pour le RAG.
  const astChunks = Array.from({ length: 20 }, (_, i) => ast(`a${i}`, 100, 1 - i * 0.01));
  const ragChunks = Array.from({ length: 5 }, (_, i) => rag(`r${i}`, 100, 1 - i * 0.01));

  const result = await applyBudget(1000, astChunks, ragChunks);

  assert.equal(result.budgetUsed.ast, 700, "l'AST est borné à 70 % du budget");
  assert.equal(result.budgetUsed.rag, 300, "le RAG conserve sa réserve de 30 %");
  assert.equal(
    result.budgetUsed.ast + result.budgetUsed.rag,
    1000,
    "le budget est utilisé intégralement",
  );
  assert.ok(result.ragContext.includes("RAG:r0"), "les meilleurs chunks RAG passent");
});

test("le RAG n'est jamais affamé, quelle que soit la pression de l'AST", async () => {
  // Le RAG n'a qu'un chunk de 100 tokens face à une montagne d'AST : il doit
  // passer, et l'AST ne doit pas tout prendre.
  const astChunks = Array.from({ length: 20 }, (_, i) => ast(`a${i}`, 100, 1 - i * 0.01));
  const result = await applyBudget(1000, astChunks, [rag("seul", 100, 1)]);

  assert.ok(result.budgetUsed.rag > 0, "le RAG ne doit pas être affamé");
  assert.ok(result.ragContext.includes("RAG:seul"));
  assert.ok(
    result.budgetUsed.ast + result.budgetUsed.rag <= 1000,
    "le budget total ne doit jamais être dépassé",
  );
});

test("la réserve non consommée par le RAG revient à l'AST (« use it or lose it »)", async () => {
  // Un seul gros chunk AST de 900 tokens, aucun candidat RAG : il doit passer,
  // au lieu d'être écarté par une réserve de 30 % que personne n'utilise.
  const chunk = ast("gros", 900, 1);
  const result = await applyBudget(1000, [chunk], []);

  assert.ok(
    result.astContext.includes("AST:gros"),
    "un chunk AST prioritaire doit pouvoir utiliser la réserve RAG laissée vide",
  );
  assert.ok(result.budgetUsed.ast + result.budgetUsed.rag <= 1000);
});

test("le budget total est respecté quoi qu'il arrive", async () => {
  const astChunks = [ast("a", 700, 1), ast("b", 700, 0.9)];
  const ragChunks = [rag("r1", 700, 1), rag("r2", 700, 0.9)];

  for (const budget of [500, 1000, 4096, 16384]) {
    const result = await applyBudget(budget, astChunks, ragChunks);
    const used = result.budgetUsed.ast + result.budgetUsed.rag;
    assert.ok(used <= budget, `budget ${budget} dépassé : ${used}`);
  }
});

test("les dépendances AST accompagnent leur chunk parent", async () => {
  const impl = ast("impl", 500, 0.9, [{ id: "iface", depthHint: "sig" }]);
  const iface = ast("iface", 200, 0);

  const result = await applyBudget(1000, [impl, iface], []);

  assert.ok(result.astContext.includes("AST:impl"), "l'implémentation doit être retenue");
  assert.ok(result.astContext.includes("AST:iface"), "son interface doit suivre");
});

test("un chunk plus gros que le budget disponible est écarté proprement", async () => {
  const trop = ast("trop", 5000, 1);
  const result = await applyBudget(1000, [trop], []);

  assert.equal(result.budgetUsed.ast, 0);
  assert.equal(result.astContext, "");
});

test("un budget vide ne sélectionne rien et ne plante pas", async () => {
  const result = await applyBudget(0, [ast("a", 10, 1)], [rag("r", 10, 1)]);
  assert.equal(result.budgetUsed.ast + result.budgetUsed.rag, 0);
});
