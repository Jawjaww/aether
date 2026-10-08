// packages/core/test/multi-language.test.ts
//
// Couverture multi-langage de l'extracteur (audit octobre 2026, constat P1-4 :
// l'AST était limité à .ts/.tsx alors que le plan annonçait « Swift/TS »).
//
// Deux voies :
//   - famille TypeScript/JavaScript via tree-sitter (le parseur TS est un
//     sur-ensemble de JavaScript) ;
//   - Python / Go / Rust via l'extracteur heuristique (grammaires npm
//     incompatibles avec tree-sitter 0.21.1).

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractFileFromSource, CODE_EXTENSIONS } from "../src/indexer/ast-extractor.js";
import { extractHeuristicSignatures } from "../src/indexer/heuristic-extractor.js";

const names = (chunk: { functions: Array<{ name: string }> } | null): string[] =>
  (chunk?.functions ?? []).map((f) => f.name);

// ─── Famille JavaScript (via la grammaire TypeScript) ────────────────────────

test("un fichier .js est analysé par la grammaire TypeScript", () => {
  const src = [
    'const { readFile } = require("node:fs");',
    "",
    "export function greet(name) {",
    "  return `hello ${name}`;",
    "}",
    "",
    "const double = (x) => x * 2;",
    "",
    "class Store {",
    "  get(key) { return this.map[key]; }",
    "}",
    "",
  ].join("\n");

  const chunk = extractFileFromSource("/tmp/projet/src/util.js", src);
  assert.ok(chunk, "un chunk doit être produit");
  const found = names(chunk);
  assert.ok(found.includes("greet"), `greet manquant (${found.join(", ")})`);
  assert.ok(found.includes("double"), `double manquant (${found.join(", ")})`);
});

test("un fichier .jsx détecte les composants React", () => {
  const src = [
    'import React from "react";',
    "",
    "export function Button({ label }) {",
    '  return <button className="btn">{label}</button>;',
    "}",
    "",
  ].join("\n");

  const chunk = extractFileFromSource("/tmp/projet/src/Button.jsx", src);
  assert.ok(chunk, "un chunk doit être produit");
  const components = (chunk?.components ?? []).map((c) => c.name);
  assert.ok(components.includes("Button"), `composants : ${components.join(", ")}`);
});

test("les extensions de code annoncées sont bien couvertes", () => {
  for (const ext of CODE_EXTENSIONS) {
    assert.ok(ext.startsWith("."), `extension invalide : ${ext}`);
  }
  assert.ok(CODE_EXTENSIONS.includes(".js"));
  assert.ok(CODE_EXTENSIONS.includes(".py"));
  assert.ok(CODE_EXTENSIONS.includes(".go"));
  assert.ok(CODE_EXTENSIONS.includes(".rs"));
});

// ─── Python ──────────────────────────────────────────────────────────────────

test("l'extracteur Python remonte fonctions, classes et imports", () => {
  const src = [
    "import os",
    "from typing import List",
    "",
    "class Service:",
    "    def __init__(self, name):",
    "        self.name = name",
    "",
    "    async def fetch_items(self, limit: int) -> List[str]:",
    "        return []",
    "",
    "def _interne(x):",
    "    return x",
    "",
    "def api_publique(a, b=2):",
    "    return a + b",
    "",
  ].join("\n");

  const result = extractHeuristicSignatures("/tmp/projet/app/service.py", src);
  assert.ok(result, "le langage doit être reconnu");
  assert.equal(result?.language, "python");

  const fnNames = result!.functions.map((f) => f.name);
  assert.ok(fnNames.includes("fetch_items"), `fonctions : ${fnNames.join(", ")}`);
  assert.ok(fnNames.includes("api_publique"));
  assert.ok(fnNames.includes("_interne"));

  const fetch = result!.functions.find((f) => f.name === "fetch_items")!;
  assert.equal(fetch.isAsync, true, "async doit être détecté");
  assert.equal(fetch.returnType, "List[str]", "le type de retour doit être capturé");
  assert.ok(fetch.params.includes("limit"), `paramètres : ${fetch.params}`);

  const interne = result!.functions.find((f) => f.name === "_interne")!;
  assert.equal(interne.isExported, false, "un nom préfixé par _ n'est pas exporté");

  const typeNames = result!.types.map((t) => t.name);
  assert.ok(typeNames.includes("Service"), `types : ${typeNames.join(", ")}`);
  assert.equal(result!.types[0]?.kind, "class");

  assert.ok(result!.imports.includes("os"), `imports : ${result!.imports.join(", ")}`);
  assert.ok(result!.imports.includes("typing"));
});

// ─── Go ──────────────────────────────────────────────────────────────────────

test("l'extracteur Go distingue exporté/non exporté et lit les méthodes", () => {
  const src = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\t"os"',
    ")",
    "",
    "type Config struct {",
    "\tPort int",
    "}",
    "",
    "type Handler interface {",
    "\tHandle() error",
    "}",
    "",
    "func NewConfig(port int) *Config {",
    "\treturn &Config{Port: port}",
    "}",
    "",
    "func (c *Config) Start() error {",
    '\tfmt.Println(c.Port)',
    "\treturn nil",
    "}",
    "",
    "func main() {",
    "\tos.Exit(0)",
    "}",
    "",
  ].join("\n");

  const result = extractHeuristicSignatures("/tmp/projet/cmd/main.go", src);
  assert.ok(result);
  assert.equal(result?.language, "go");

  const fn = (n: string) => result!.functions.find((f) => f.name === n)!;
  assert.equal(fn("NewConfig").isExported, true, "majuscule = exporté");
  assert.equal(fn("main").isExported, false);
  assert.equal(fn("Start").isExported, true, "méthode avec receiver");
  assert.ok(fn("NewConfig").returnType?.includes("Config"), `retour : ${fn("NewConfig").returnType}`);

  const types = Object.fromEntries(result!.types.map((t) => [t.name, t.kind]));
  assert.equal(types.Config, "struct");
  assert.equal(types.Handler, "interface");

  assert.ok(result!.imports.includes("fmt"), `imports : ${result!.imports.join(", ")}`);
  assert.ok(result!.imports.includes("os"));
});

// ─── Rust ────────────────────────────────────────────────────────────────────

test("l'extracteur Rust lit pub/async, structs, traits et use", () => {
  const src = [
    "use std::collections::HashMap;",
    "",
    "pub struct Engine {",
    "    state: HashMap<String, u32>,",
    "}",
    "",
    "pub trait Runnable {",
    "    fn run(&self);",
    "}",
    "",
    "pub async fn process(input: &str) -> Result<usize, Error> {",
    "    Ok(0)",
    "}",
    "",
    "fn interne() {}",
    "",
  ].join("\n");

  const result = extractHeuristicSignatures("/tmp/projet/src/engine.rs", src);
  assert.ok(result);
  assert.equal(result?.language, "rust");

  const process = result!.functions.find((f) => f.name === "process")!;
  assert.equal(process.isAsync, true);
  assert.equal(process.isExported, true, "pub = exporté");
  assert.equal(process.returnType, "Result<usize, Error>");

  assert.equal(result!.functions.find((f) => f.name === "interne")!.isExported, false);
  assert.ok(
    result!.functions.some((f) => f.name === "run"),
    "les signatures de trait sont aussi des signatures",
  );

  const kinds = Object.fromEntries(result!.types.map((t) => [t.name, t.kind]));
  assert.equal(kinds.Engine, "struct");
  assert.equal(kinds.Runnable, "trait");

  assert.ok(
    result!.imports.some((i) => i.includes("std")),
    `imports : ${result!.imports.join(", ")}`,
  );
});

// ─── Cas limites ─────────────────────────────────────────────────────────────

test("une extension non couverte renvoie null (pas de faux symboles)", () => {
  assert.equal(extractHeuristicSignatures("/tmp/projet/src/app.swift", "func f() {}"), null);
  assert.equal(extractHeuristicSignatures("/tmp/projet/README.md", "# Titre"), null);
});

test("un fichier de code vide ne produit aucun symbole", () => {
  const result = extractHeuristicSignatures("/tmp/projet/vide.py", "");
  assert.ok(result);
  assert.deepEqual(result!.functions, []);
  assert.deepEqual(result!.types, []);
});

test("un fichier markdown produit un chunk valide mais sans symbole", () => {
  const chunk = extractFileFromSource("/tmp/projet/README.md", "# Titre\n\ndu texte\n");
  assert.ok(chunk, "un chunk minimal doit exister pour l'indexation RAG");
  assert.deepEqual(chunk?.functions, []);
  assert.deepEqual(chunk?.types, []);
});
