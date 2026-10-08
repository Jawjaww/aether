// packages/gateway/test/payload.test.ts
//
// Tests de non-régression des invariants P0 de l'audit d'octobre 2026.
// Chaque test correspond à un bug constaté dans le code d'origine.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AETHER_SYSTEM_PROMPT,
  buildCleanPayload,
  shapeTools,
  MAX_ACTIVE_TOOLS,
  type AetherContextResponse,
  type ChatMessage,
} from "../src/payload.js";

const ctx = (tag: string): AetherContextResponse => ({
  tokenCount: 100,
  confidence: 0.9,
  sections: {
    astContext: `<ast_context>\n// ${tag}\n</ast_context>`,
    ragContext: `<rag_context>\n// ${tag}\n</rag_context>`,
  },
  meta: {
    astFiles: ["a.ts"],
    reasoning: "no_think",
    budgetUsed: { ast: 50, rag: 50, history: 0 },
  },
});

const convo = (question: string): ChatMessage[] => [
  { role: "system", content: "systeme d'origine du harnais" },
  { role: "user", content: "tour précédent" },
  { role: "assistant", content: "réponse précédente" },
  { role: "user", content: question },
];

const messagesOf = (payload: Record<string, unknown>): ChatMessage[] =>
  payload.messages as ChatMessage[];

const textOf = (m: ChatMessage | undefined): string =>
  typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");

// ─── P0-2 : le contexte ne doit JAMAIS être injecté dans le message système ───

test("le message système reste constant, même avec du contexte", () => {
  const payload = buildCleanPayload({}, ctx("VOLATIL"), convo("Explique ce fichier"), true);
  const system = messagesOf(payload)[0];

  assert.equal(system?.role, "system");
  assert.equal(system?.content, AETHER_SYSTEM_PROMPT);
  assert.ok(
    !textOf(system).includes("VOLATIL"),
    "le message système ne doit pas embarquer le contexte volatil",
  );

  // Invariant clé : le message système est identique quel que soit le contexte.
  const autre = buildCleanPayload({}, ctx("AUTRE-CONTEXTE"), convo("Explique ce fichier"), true);
  assert.equal(
    textOf(system),
    textOf(messagesOf(autre)[0]),
    "le message système doit être bit-à-bit identique d'un tour à l'autre",
  );
});

test("le contexte volatil est placé en queue, dans le dernier message utilisateur", () => {
  const payload = buildCleanPayload({}, ctx("VOLATIL"), convo("Explique ce fichier"), true);
  const messages = messagesOf(payload);
  const last = messages[messages.length - 1];

  assert.equal(last?.role, "user");
  assert.ok(textOf(last).includes("<context>"), "le contexte doit être dans le dernier message");
  assert.ok(textOf(last).includes("Explique ce fichier"), "la question doit rester présente");
  assert.ok(
    textOf(last).indexOf("<context>") < textOf(last).indexOf("Explique ce fichier"),
    "le contexte doit précéder la question",
  );
});

test("le préfixe stable est identique entre deux tours à contexte différent", () => {
  const tour1 = buildCleanPayload({}, ctx("TOUR1"), convo("Question 1"), true);
  const tour2 = buildCleanPayload({}, ctx("TOUR2"), convo("Question 1"), true);

  const prefix = (p: Record<string, unknown>) => {
    const m = messagesOf(p);
    return JSON.stringify(m.slice(0, -1)); // tout sauf le dernier message utilisateur
  };

  assert.equal(
    prefix(tour1),
    prefix(tour2),
    "le préfixe (system + historique) doit être bit-à-bit identique pour que le cache tienne",
  );
  assert.notEqual(
    textOf(messagesOf(tour1)[messagesOf(tour1).length - 1]),
    textOf(messagesOf(tour2)[messagesOf(tour2).length - 1]),
    "seul le dernier message doit changer",
  );
});

test("sans contexte, le préfixe et le message système sont inchangés", () => {
  const payload = buildCleanPayload({}, null, convo("Bonjour"), true);
  const messages = messagesOf(payload);
  assert.equal(messages[0]?.content, AETHER_SYSTEM_PROMPT);
  assert.equal(messages.length, 4);
  assert.ok(!textOf(messages[3]).includes("<context>"));
});

test("gère un contenu multimodal sans casser la structure", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    {
      role: "user",
      content: [
        { type: "text", text: "regarde cette capture" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    },
  ];
  const payload = buildCleanPayload({}, ctx("V"), messages, true);
  const last = messagesOf(payload)[1];
  assert.ok(Array.isArray(last?.content));
  const parts = last?.content as Array<Record<string, unknown>>;
  assert.equal(parts[0]?.type, "text");
  assert.ok(String(parts[0]?.text).includes("<context>"));
  assert.ok(
    parts.some((p) => p.type === "image_url"),
    "la part image d'origine doit être préservée",
  );
  assert.ok(
    parts.some((p) => p.type === "text" && String(p.text).includes("regarde cette capture")),
    "le texte d'origine doit être préservé",
  );
});

// ─── P0-1 : les outils ne doivent jamais être supprimés ──────────────────────

test("les outils d'E/S survivent à une tâche sans verbe d'action", () => {
  const tools = [
    { type: "function", function: { name: "read_file" } },
    { type: "function", function: { name: "write_file" } },
    { type: "function", function: { name: "grep" } },
  ];
  const shaped = shapeTools(tools, "pourquoi ce test échoue-t-il ?");
  assert.ok(shaped && shaped.length > 0, "les outils ne doivent pas disparaître");
  assert.deepEqual(
    shaped.map((t) => (t as { function: { name: string } }).function.name),
    ["read_file", "write_file", "grep"],
  );
});

test("shapeTools borne la surface sans retirer les outils essentiels", () => {
  const tools = [
    ...Array.from({ length: 30 }, (_, i) => ({
      type: "function",
      function: { name: `mcp_serveur_${i}` },
    })),
    { type: "function", function: { name: "read_file" } },
    { type: "function", function: { name: "apply_patch" } },
  ];
  const shaped = shapeTools(tools, "refactorise ce module") ?? [];
  assert.ok(shaped.length <= MAX_ACTIVE_TOOLS);
  const names = shaped.map((t) => (t as { function: { name: string } }).function.name);
  assert.ok(names.includes("read_file"), "read_file doit être conservé");
  assert.ok(names.includes("apply_patch"), "apply_patch doit être conservé");
  // L'ordre d'origine des non-essentiels doit être préservé (cache de préfixe).
  const mcpNames = names.filter((n) => n.startsWith("mcp_serveur_"));
  assert.deepEqual(
    mcpNames,
    [...mcpNames].sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop())),
  );
});

test("shapeTools est idempotent et ne renvoie jamais undefined pour une entrée non vide", () => {
  const tools = [{ type: "function", function: { name: "read_file" } }];
  assert.deepEqual(shapeTools(tools, "x"), tools);
  assert.equal(shapeTools([], "x")?.length, 0);
  assert.equal(shapeTools(undefined, "x"), undefined);
});

// ─── Réglages : ne pas écraser ceux du serveur ───────────────────────────────

test("max_tokens n'est pas écrasé quand rien n'est configuré", () => {
  const payload = buildCleanPayload({}, null, convo("hi"), true, {});
  assert.ok(!("max_tokens" in payload), "la gateway ne doit pas imposer max_tokens");
});

test("max_tokens est appliqué quand il est explicitement configuré", () => {
  const payload = buildCleanPayload({}, null, convo("hi"), true, { maxOutputTokens: 8192 });
  assert.equal(payload.max_tokens, 8192);
});

test("le modèle n'est pas remplacé par une chaîne codée en dur", () => {
  const payload = buildCleanPayload({ model: "mon-modele" }, null, convo("hi"), true, {});
  assert.equal(payload.model, "mon-modele");
});

test("un modèle forcé par configuration est respecté", () => {
  const payload = buildCleanPayload({ model: "mon-modele" }, null, convo("hi"), true, {
    forcedModel: "Qwen3.6-35B-A3B-4bit",
  });
  assert.equal(payload.model, "Qwen3.6-35B-A3B-4bit");
});
