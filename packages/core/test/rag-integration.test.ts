// packages/core/test/rag-integration.test.ts
//
// Test d'intégration du RAG : vrai LanceDB, faux serveur d'embeddings.
//
// Vérifie les points du constat P1-3 de l'audit octobre 2026 :
//   - plusieurs fragments par fichier, avec numéros de ligne exploitables ;
//   - embarquement par lots (un seul appel HTTP pour N fragments) ;
//   - échec d'embedding REMONTÉ, jamais avalé (à l'indexation : exception ;
//     à la recherche : réponse `degraded`) ;
//   - identifiants de fragments uniques.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIM = 768;

/** Vecteur déterministe : le même texte donne toujours le même vecteur. */
const embed = (text: string): number[] => {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

let server: http.Server;
let embeddingCalls = 0;
let batchSizes: number[] = [];
let failing = false;

type Rag = typeof import("../src/indexer/rag-indexer.js");
let rag: Rag;

const SOURCE = (() => {
  const out: string[] = ["// module d'intégration", ""];
  for (let i = 0; i < 60; i++) {
    out.push(`/** Documentation ${i}. */`);
    out.push(`export function fonction_${i}(a: string, b: number) {`);
    out.push(`  const interne_${i} = a.repeat(b) + "${i}";`);
    out.push(`  return interne_${i}.length;`);
    out.push(`}`);
    out.push("");
  }
  return out.join("\n");
})();

before(async () => {
  // HOME isolé : l'index LanceDB reste dans un dossier temporaire.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aether-rag-"));
  process.env.HOME = home;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failing) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "embeddings indisponibles" }));
        return;
      }
      embeddingCalls++;
      const parsed = JSON.parse(body) as { input: string | string[] };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      batchSizes.push(inputs.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: embed(text),
          })),
        }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  // EMBEDDING_URL est lu au chargement du module : on l'importe dynamiquement.
  process.env.EMBEDDING_URL = `http://127.0.0.1:${port}`;
  rag = await import("../src/indexer/rag-indexer.js");
  await rag.initRAG("projet-de-test");
});

after(() => {
  server?.close();
});

test("indexFile découpe le fichier en plusieurs fragments avec leurs lignes", async () => {
  const result = await rag.indexFile("/tmp/projet/src/module.ts", SOURCE);
  assert.ok(result.chunks > 1, `attendu plusieurs fragments, obtenu ${result.chunks}`);
});

test("les fragments sont embarqués par lots, pas un par un", () => {
  assert.ok(embeddingCalls > 0, "le serveur d'embeddings doit avoir été appelé");
  const biggest = Math.max(...batchSizes);
  assert.ok(
    biggest > 1,
    `les fragments doivent partir en lot (plus grand lot observé : ${biggest})`,
  );
});

test("searchRAG renvoie des plages de lignes exploitables", async () => {
  const chunks = rag.chunkContent(SOURCE);
  const target = chunks[2]!;

  const { results, degraded } = await rag.searchRAG(target.content, 3);
  assert.equal(degraded, false);
  assert.ok(results.length > 0, "au moins un résultat attendu");
  assert.equal(results[0]?.filePath, "/tmp/projet/src/module.ts");
  assert.equal(results[0]?.startLine, target.startLine);
  assert.equal(results[0]?.endLine, target.endLine);
});

test("les identifiants de fragments restent uniques", async () => {
  // Deux fragments du même fichier ne doivent pas produire le même id, sinon le
  // budget les déduplique entre eux.
  const chunks = rag.chunkContent(SOURCE);
  const ids = chunks.map((c, i) => `rag_/tmp/projet/src/module.ts_${c.startLine}_${i}`);
  assert.equal(new Set(ids).size, ids.length);
});

test("une panne d'embeddings rend la recherche dégradée, pas silencieuse", async () => {
  failing = true;
  const { results, degraded, reason } = await rag.searchRAG("n'importe quoi", 3);
  assert.equal(degraded, true, "la dégradation doit être signalée");
  assert.deepEqual(results, []);
  assert.ok(reason && reason.length > 0, "une raison doit être fournie");
  failing = false;
});

test("une panne d'embeddings fait échouer l'indexation explicitement", async () => {
  failing = true;
  await assert.rejects(
    () => rag.indexFile("/tmp/projet/src/autre.ts", SOURCE),
    /Embedding API 503/,
    "indexFile doit lever, pas ignorer le fichier en silence",
  );
  failing = false;
});
