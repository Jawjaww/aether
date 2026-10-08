// packages/core/test/rag-chunker.test.ts
//
// Tests du découpage RAG (audit octobre 2026, constat P1-3).
//
// Bug d'origine : `content.slice(0, 3000)`, un seul enregistrement par fichier,
// sans numéros de ligne. Un fichier de 2 000 lignes n'était indexé que par son
// début, et le modèle ne pouvait citer aucune ligne.

import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkContent } from "../src/indexer/rag-indexer.js";

/** Contenu réaliste : des fonctions séparées par des lignes vides. */
const makeSource = (functions: number): string => {
  const out: string[] = ["// module de test", "import { x } from './x';", ""];
  for (let i = 0; i < functions; i++) {
    out.push(`/** Doc de la fonction ${i}. */`);
    out.push(`export async function fonction_${i}(entree: string, options: Options) {`);
    out.push(`  const resultat = await traiter(entree, options.value, ${i});`);
    out.push(`  if (!resultat) { throw new Error("échec ${i}"); }`);
    out.push(`  return resultat.map((v) => v * 2);`);
    out.push(`}`);
    out.push("");
  }
  return out.join("\n");
};

test("un contenu vide ne produit aucun fragment", () => {
  assert.deepEqual(chunkContent(""), []);
  assert.deepEqual(chunkContent("   \n\n  \t\n"), []);
});

test("un petit fichier tient en un seul fragment", () => {
  const src = "const a = 1;\nconst b = 2;\n";
  const pieces = chunkContent(src);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0]?.startLine, 1);
  assert.equal(pieces[0]?.endLine, 3);
  assert.equal(pieces[0]?.content, src);
});

test("un gros fichier est découpé en plusieurs fragments", () => {
  const pieces = chunkContent(makeSource(120));
  assert.ok(pieces.length > 1, `attendu plusieurs fragments, obtenu ${pieces.length}`);
});

test("aucune ligne du fichier n'est perdue", () => {
  const src = makeSource(120);
  const lines = src.split("\n");
  const pieces = chunkContent(src);

  const covered = new Set<number>();
  for (const p of pieces) {
    for (let line = p.startLine; line <= p.endLine; line++) covered.add(line);
  }

  const missing: number[] = [];
  lines.forEach((text, idx) => {
    if (text.trim().length === 0) return;
    if (!covered.has(idx + 1)) missing.push(idx + 1);
  });

  assert.deepEqual(missing, [], `lignes non couvertes : ${missing.slice(0, 10).join(", ")}`);
});

test("les fragments sont déterministes", () => {
  const src = makeSource(60);
  const a = chunkContent(src);
  const b = chunkContent(src);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "deux appels doivent produire le même découpage");
});

test("les fragments progressent et se recouvrent", () => {
  const pieces = chunkContent(makeSource(120));
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]!;
    const cur = pieces[i]!;
    assert.ok(
      cur.startLine > prev.startLine,
      `le début doit progresser (${prev.startLine} → ${cur.startLine})`,
    );
    assert.ok(
      cur.startLine <= prev.endLine,
      `les fragments doivent se recouvrir (${prev.endLine} → ${cur.startLine})`,
    );
  }
});

test("la taille des fragments reste bornée", () => {
  const src = makeSource(200);
  const maxLine = Math.max(...src.split("\n").map((l) => l.length));
  for (const p of chunkContent(src)) {
    assert.ok(
      p.content.length <= 3200 + maxLine + 2,
      `fragment trop gros : ${p.content.length} caractères`,
    );
  }
});

test("une ligne unique gigantesque ne bloque pas la progression", () => {
  const monstre = `const data = "${"x".repeat(20000)}";`;
  const pieces = chunkContent(monstre);
  assert.ok(pieces.length >= 1);
  assert.equal(pieces[0]?.startLine, 1);
  assert.equal(pieces[pieces.length - 1]?.endLine, 1);
});

test("les plages de lignes sont cohérentes (1-based, inclusives)", () => {
  const pieces = chunkContent(makeSource(30));
  for (const p of pieces) {
    assert.ok(p.startLine >= 1, `startLine doit être ≥ 1 (obtenu ${p.startLine})`);
    assert.ok(p.endLine >= p.startLine, "endLine doit être ≥ startLine");
  }
});
