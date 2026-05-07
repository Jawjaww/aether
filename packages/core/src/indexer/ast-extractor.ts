// packages/core/src/indexer/ast-extractor.ts
//
// Deterministic extraction of TypeScript/TSX signatures via Tree-sitter.
// Feeds the Budget Engine (Tier 1) and the RAG Indexer (GranularChunk).
//
// Bimodal I/O architecture:
//   - Initial scan  : batches of 50 parallel files (max throughput, anti-EMFILE)
//   - Incremental watcher : 1 file at a time (clean debug, no saturation)

import Parser from "tree-sitter";
import TSLanguage from "tree-sitter-typescript";
import * as nodePath from "node:path";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";

// ─── Init parsers ─────────────────────────────────────────────────────────────
// tree-sitter-typescript exports { typescript, tsx } in CommonJS.
// Double assertion is necessary to consume it from strict ESM.

const _tsLang: any =
  (TSLanguage as any)?.typescript ?? (TSLanguage as any)?.default?.typescript;
const _tsxLang: any =
  (TSLanguage as any)?.tsx ?? (TSLanguage as any)?.default?.tsx;

const tsParser = new Parser();
const tsxParser = new Parser();
tsParser.setLanguage(_tsLang);
tsxParser.setLanguage(_tsxLang);

const getParser = (fp: string): { parser: Parser; lang: any } =>
  fp.endsWith(".tsx")
    ? { parser: tsxParser, lang: _tsxLang }
    : { parser: tsParser, lang: _tsLang };

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface FunctionSignature {
  name: string;
  params: string;
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface TypeDeclaration {
  kind: "interface" | "type" | "enum";
  name: string;
  body: string;
  isExported: boolean;
  startLine: number;
  endLine: number;
}

export interface ReactComponent {
  name: string;
  props: string | null;
  hooks: string[];
  isDefault: boolean;
}

export interface ReactNativeStyle {
  name: string;
  keys: string[];
}

export interface ASTChunk {
  filePath: string;
  fileHash: string;
  functions: FunctionSignature[];
  types: TypeDeclaration[];
  components: ReactComponent[];
  rnStyles: ReactNativeStyle[];
  imports: string[]; // Raw imported paths (for building edges)
  exports: string[];
  cyclicRefs: string[];

  // Metrics for Reasoning Selector (hydrated by computeGraphMetrics)
  dependencyDepth?: number;
  cyclomaticScore?: number;
  crossFileImports?: number;

  extractedAt: number;
}

export interface ASTGraph {
  nodes: Map<string, ASTChunk>;
  edges: Map<string, string[]>; // filePath → [resolved dependencies]
  reverseEdges: Map<string, Set<string>>;
  maxDepth: number;
  cyclicEdges: number;
  symbols: string[];
  crossFileRefs: number;
}

export const createEmptyGraph = (): ASTGraph => ({
  nodes: new Map(),
  edges: new Map(),
  reverseEdges: new Map(),
  maxDepth: 0,
  cyclicEdges: 0,
  symbols: [],
  crossFileRefs: 0,
});

// ─── Tree-sitter Queries (S-expressions validated on v0.21) ───────────────────
// Each query is compiled once at module load to be reused.

const makeQueries = (lang: any) => ({
  // ── Imports ─────────────────────────────────────────────────────────────────
  imports: new Parser.Query(
    lang,
    `
    (import_statement
      source: (string (string_fragment) @source))
  `,
  ),

  // ── Exported and local functions ────────────────────────────────────────────
  exportedFunctions: new Parser.Query(
    lang,
    `
    (export_statement
      (function_declaration
        name: (identifier) @name
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return))
  `,
  ),

  localFunctions: new Parser.Query(
    lang,
    `
    (function_declaration
      name: (identifier) @name
      parameters: (formal_parameters) @params
      return_type: (type_annotation)? @return)
  `,
  ),

  // ── Exported and local arrow functions ──────────────────────────────────────
  // formal_parameters or identifier (arrow with single param without parens)
  exportedArrows: new Parser.Query(
    lang,
    `
    (export_statement
      (lexical_declaration
        (variable_declarator
          name: (identifier) @name
          value: (arrow_function
            parameters: (_) @params
            return_type: (type_annotation)? @return))))
  `,
  ),

  localArrows: new Parser.Query(
    lang,
    `
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function
          parameters: (_) @params
          return_type: (type_annotation)? @return)))
  `,
  ),

  // ── Exported and local interfaces ───────────────────────────────────────────
  exportedInterfaces: new Parser.Query(
    lang,
    `
    (export_statement
      (interface_declaration
        name: (type_identifier) @name
        body: (interface_body) @body))
  `,
  ),

  localInterfaces: new Parser.Query(
    lang,
    `
    (interface_declaration
      name: (type_identifier) @name
      body: (interface_body) @body)
  `,
  ),

  // ── Type aliases ────────────────────────────────────────────────────────────
  exportedTypes: new Parser.Query(
    lang,
    `
    (export_statement
      (type_alias_declaration
        name: (type_identifier) @name
        value: (_) @body))
  `,
  ),

  localTypes: new Parser.Query(
    lang,
    `
    (type_alias_declaration
      name: (type_identifier) @name
      value: (_) @body)
  `,
  ),

  // ── Cyclomatic branching ────────────────────────────────────────────────────
  branches: new Parser.Query(
    lang,
    `
    [
      (if_statement)
      (ternary_expression)
      (for_statement)
      (for_in_statement)
      (while_statement)
      (do_statement)
      (switch_case)
      (catch_clause)
    ] @branch
  `,
  ),

  // ── React hooks calls ───────────────────────────────────────────────────────
  // Look for call_expression whose function starts with "use"
  hookCalls: new Parser.Query(
    lang,
    `
    (call_expression
      function: (identifier) @hook
      (#match? @hook "^use[A-Z]"))
  `,
  ),
});

// Cache for compiled queries by language (avoids recompiling for every file)
const queryCache = new Map<any, ReturnType<typeof makeQueries>>();

const getQueries = (lang: any) => {
  if (!queryCache.has(lang)) queryCache.set(lang, makeQueries(lang));
  return queryCache.get(lang)!;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const txt = (n: Parser.SyntaxNode | null | undefined): string =>
  n?.text?.trim() ?? "";

// Truncation that closes open braces to keep TypeScript syntactically readable
const truncateBody = (body: string, maxChars = 250): string => {
  if (body.length <= maxChars) return body;
  let open = 0;
  const cut = body.slice(0, maxChars);
  for (const c of cut) {
    if (c === "{") open++;
    else if (c === "}") open--;
  }
  return (
    cut.trimEnd() +
    (open > 0 ? " /* … */ " + "}".repeat(Math.max(0, open)) : " /* … */")
  );
};

// Heuristic detection of "async" keyword on the immediate parent node
const isAsyncNode = (node: Parser.SyntaxNode): boolean =>
  node.parent?.children.some((c: any) => c.type === "async") ?? false;

// React component detection: PascalCase + at least one JSX node in the body
const isPascalCase = (name: string): boolean =>
  /^[A-Z][a-zA-Z0-9]*$/.test(name);

const hasJSXDescendant = (node: Parser.SyntaxNode): boolean => {
  if (node.type === "jsx_element" || node.type === "jsx_self_closing_element")
    return true;
  for (let i = 0; i < node.childCount; i++) {
    if (hasJSXDescendant(node.child(i)!)) return true;
  }
  return false;
};

const findOuterDeclarationNode = (
  nameNode: Parser.SyntaxNode,
  allowedTypes: string[],
): Parser.SyntaxNode => {
  let outer = nameNode;
  while (outer.parent && !allowedTypes.includes(outer.type)) {
    outer = outer.parent;
  }
  if (outer.parent?.type === "export_statement") outer = outer.parent;
  return outer;
};

const collectFunctionSignatures = (
  root: Parser.SyntaxNode,
  queries: ReturnType<typeof getQueries>,
): FunctionSignature[] => {
  const functions: FunctionSignature[] = [];
  const seenFns = new Set<string>();

  const addFn = (m: Parser.QueryMatch, isExported: boolean) => {
    const nameNode = m.captures.find((c: any) => c.name === "name")?.node;
    if (!nameNode) return;

    const name = txt(nameNode);
    if (!name || seenFns.has(name)) return;

    seenFns.add(name);
    const params = txt(m.captures.find((c: any) => c.name === "params")?.node);
    const returnType =
      txt(m.captures.find((c: any) => c.name === "return")?.node).replace(/^:\s*/, "") || null;
    const outer = findOuterDeclarationNode(nameNode, [
      "function_declaration",
      "method_definition",
      "lexical_declaration",
      "variable_declaration",
      "arrow_function",
    ]);

    functions.push({
      name,
      params,
      returnType,
      isAsync: isAsyncNode(nameNode),
      isExported,
      startLine: outer.startPosition.row + 1,
      endLine: outer.endPosition.row + 1,
    });
  };

  for (const m of queries.exportedFunctions.matches(root)) addFn(m, true);
  for (const m of queries.localFunctions.matches(root)) addFn(m, false);
  for (const m of queries.exportedArrows.matches(root)) addFn(m, true);
  for (const m of queries.localArrows.matches(root)) addFn(m, false);

  return functions;
};

const collectTypeDeclarations = (
  root: Parser.SyntaxNode,
  queries: ReturnType<typeof getQueries>,
): TypeDeclaration[] => {
  const types: TypeDeclaration[] = [];
  const seenTypes = new Set<string>();

  const addType = (
    m: Parser.QueryMatch,
    kind: TypeDeclaration["kind"],
    isExported: boolean,
  ) => {
    const nameNode = m.captures.find((c: any) => c.name === "name")?.node;
    if (!nameNode) return;

    const name = txt(nameNode);
    if (!name || seenTypes.has(name)) return;

    seenTypes.add(name);
    const body = txt(m.captures.find((c: any) => c.name === "body")?.node);
    const outer = findOuterDeclarationNode(nameNode, [
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ]);

    types.push({
      kind,
      name,
      body: truncateBody(body),
      isExported,
      startLine: outer.startPosition.row + 1,
      endLine: outer.endPosition.row + 1,
    });
  };

  for (const m of queries.exportedInterfaces.matches(root)) addType(m, "interface", true);
  for (const m of queries.localInterfaces.matches(root)) addType(m, "interface", false);
  for (const m of queries.exportedTypes.matches(root)) addType(m, "type", true);
  for (const m of queries.localTypes.matches(root)) addType(m, "type", false);

  return types;
};

const collectImports = (root: Parser.SyntaxNode, queries: ReturnType<typeof getQueries>): string[] => {
  const imports: string[] = [];
  for (const m of queries.imports.matches(root)) {
    const src = txt(m.captures.find((c: any) => c.name === "source")?.node);
    if (src) imports.push(src);
  }
  return imports;
};

const collectReactComponents = (
  root: Parser.SyntaxNode,
  queries: ReturnType<typeof getQueries>,
  functions: FunctionSignature[],
): ReactComponent[] => {
  const components: ReactComponent[] = [];
  const fnAndArrow = [
    ...queries.exportedFunctions.matches(root),
    ...queries.localFunctions.matches(root),
    ...queries.exportedArrows.matches(root),
    ...queries.localArrows.matches(root),
  ];

  for (const m of fnAndArrow) {
    const nameNode = m.captures.find((c: any) => c.name === "name")?.node;
    const name = txt(nameNode);
    if (!name || !isPascalCase(name)) continue;

    const fnNode = nameNode?.parent ?? null;
    if (!fnNode || !hasJSXDescendant(fnNode)) continue;

    const hooks: string[] = [];
    for (const hm of queries.hookCalls.matches(fnNode)) {
      const hookName = txt(hm.captures.find((c: any) => c.name === "hook")?.node);
      if (hookName) hooks.push(hookName);
    }

    const params = txt(m.captures.find((c: any) => c.name === "params")?.node);
    const isDefault =
      fnNode.parent?.type === "export_statement" &&
      fnNode.parent?.children.some((c: any) => c.type === "default");

    components.push({
      name,
      props: params || null,
      hooks: [...new Set(hooks)],
      isDefault,
    });
  }

  return components;
};

const buildAstChunkFromSource = (
  filePath: string,
  source: string,
  fileHash: string,
): ASTChunk | null => {
  const ext = nodePath.extname(filePath);
  if (ext !== ".ts" && ext !== ".tsx") return null;

  const { parser, lang } = getParser(filePath);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch {
    return null;
  }

  const queries = getQueries(lang);
  const root = tree.rootNode;
  const functions = collectFunctionSignatures(root, queries);
  const types = collectTypeDeclarations(root, queries);
  const components = collectReactComponents(root, queries, functions);
  const imports = collectImports(root, queries);

  return {
    filePath,
    fileHash,
    functions,
    types,
    components,
    rnStyles: [],
    imports,
    exports: [
      ...functions.filter((f) => f.isExported).map((f) => f.name),
      ...types.filter((t) => t.isExported).map((t) => t.name),
      ...components.map((c) => c.name),
    ],
    cyclicRefs: [],
    cyclomaticScore: 1 + queries.branches.matches(root).length,
    extractedAt: Date.now(),
  };
};

// ─── File extraction ──────────────────────────────────────────────────────────

export const extractFile = async (
  filePath: string,
): Promise<ASTChunk | null> => {
  let source: string;
  try {
    source = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  return buildAstChunkFromSource(
    filePath,
    source,
    createHash("sha256").update(source).digest("hex").slice(0, 10),
  );
};

// ─── Import resolution → absolute path ────────────────────────────────────────
// Tries common extensions in order to find the real file.

const RESOLVE_EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx", ".d.ts"];

const resolveImport = async (
  fromFile: string,
  importPath: string,
): Promise<string | null> => {
  if (!importPath.startsWith(".")) return null; // Ignore node_modules
  const base = nodePath.resolve(nodePath.dirname(fromFile), importPath);
  for (const ext of RESOLVE_EXTS) {
    const candidate = base.endsWith(ext) ? base : base + ext;
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
};

export const extractFileFromSource = (
  filePath: string,
  source: string,
): ASTChunk | null => {
  return buildAstChunkFromSource(
    filePath,
    source,
    createHash("sha1").update(source).digest("hex"),
  );
};

export const createGraphFromChunks = (chunks: Iterable<ASTChunk>): ASTGraph => ({
  nodes: new Map([...chunks].map((chunk) => [chunk.filePath, chunk])),
  edges: new Map(),
  reverseEdges: new Map(),
  maxDepth: 0,
  cyclicEdges: 0,
  symbols: [],
  crossFileRefs: 0,
});

export const removeFileFromGraph = (filePath: string, graph: ASTGraph): void => {
  const previousDeps = graph.edges.get(filePath) ?? [];
  for (const dep of previousDeps) {
    const dependents = graph.reverseEdges.get(dep);
    if (!dependents) continue;
    dependents.delete(filePath);
    if (dependents.size === 0) graph.reverseEdges.delete(dep);
  }

  graph.nodes.delete(filePath);
  graph.edges.delete(filePath);
  graph.reverseEdges.delete(filePath);
};

export const upsertFileInGraph = (chunk: ASTChunk, graph: ASTGraph): void => {
  graph.nodes.set(chunk.filePath, chunk);
};

// ─── Computation of global graph metrics (DFS) ────────────────────────────────
// Called once after all files have been extracted.
// Hydrates dependencyDepth, crossFileImports and cyclicRefs on each chunk.

export const computeGraphMetrics = async (graph: ASTGraph): Promise<void> => {
  graph.edges.clear();
  graph.reverseEdges.clear();

  for (const chunk of graph.nodes.values()) {
    chunk.cyclicRefs = [];
  }

  // 1. Dependency resolution (edges) for each chunk
  await (async function buildResolvedEdges() {
    for (const [filePath, chunk] of graph.nodes) {
      const resolved: string[] = [];
      for (const imp of chunk.imports) {
        const target = await resolveImport(filePath, imp);
        if (target && graph.nodes.has(target)) resolved.push(target);
      }
      updateResolvedEdges(graph, filePath, resolved);
      chunk.crossFileImports = resolved.length;
    }
  })();

  // 2. Iterative DFS extracted as helper to calculate the depth of a node
  const depthCache = new Map<string, number>();
  const computeDepthForStart = (start: string): number => {
    if (depthCache.has(start)) return depthCache.get(start)!;
    const visited = new Set<string>();
    const stack: Array<{ node: string; depth: number }> = [
      { node: start, depth: 0 },
    ];
    let maxDepth = 0;

    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;
      if (visited.has(node)) {
        const chunk = graph.nodes.get(start);
        if (chunk && !chunk.cyclicRefs.includes(node))
          chunk.cyclicRefs.push(node);
        graph.cyclicEdges++;
        continue;
      }
      visited.add(node);
      if (depth > maxDepth) maxDepth = depth;

      for (const dep of graph.edges.get(node) ?? []) {
        stack.push({ node: dep, depth: depth + 1 });
      }
    }

    depthCache.set(start, maxDepth);
    return maxDepth;
  };

  // 3. Calculation of global metrics from computed depths
  let globalMax = 0;
  let totalCrossRefs = 0;
  for (const [filePath, chunk] of graph.nodes) {
    const depth = computeDepthForStart(filePath);
    chunk.dependencyDepth = depth;
    if (depth > globalMax) globalMax = depth;
    totalCrossRefs += chunk.crossFileImports ?? 0;
  }

  graph.maxDepth = globalMax;
  graph.crossFileRefs = totalCrossRefs;
  graph.symbols = [...graph.nodes.values()].flatMap((c) => c.exports);
};

const normalizeCandidate = (value: string): string => nodePath.normalize(value);

const importCouldResolveToTarget = (
  fromFile: string,
  importPath: string,
  targetPath: string,
): boolean => {
  if (!importPath.startsWith(".")) return false;

  const base = nodePath.resolve(nodePath.dirname(fromFile), importPath);
  const target = normalizeCandidate(targetPath);

  return RESOLVE_EXTS.some((ext) => {
    const candidate = normalizeCandidate(base.endsWith(ext) ? base : base + ext);
    return candidate === target;
  });
};

const updateResolvedEdges = (
  graph: ASTGraph,
  filePath: string,
  resolved: string[],
): void => {
  const previous = graph.edges.get(filePath) ?? [];
  for (const dep of previous) {
    const dependents = graph.reverseEdges.get(dep);
    if (!dependents) continue;
    dependents.delete(filePath);
    if (dependents.size === 0) graph.reverseEdges.delete(dep);
  }

  if (resolved.length === 0) {
    graph.edges.delete(filePath);
    return;
  }

  graph.edges.set(filePath, resolved);
  for (const dep of resolved) {
    let dependents = graph.reverseEdges.get(dep);
    if (!dependents) {
      dependents = new Set<string>();
      graph.reverseEdges.set(dep, dependents);
    }
    dependents.add(filePath);
  }
};

const buildResolvedEdgesForFile = async (
  filePath: string,
  graph: ASTGraph,
): Promise<string[]> => {
  const chunk = graph.nodes.get(filePath);
  if (!chunk) {
    updateResolvedEdges(graph, filePath, []);
    return [];
  }

  const resolved: string[] = [];
  for (const imp of chunk.imports) {
    const target = await resolveImport(filePath, imp);
    if (target && graph.nodes.has(target)) resolved.push(target);
  }

  updateResolvedEdges(graph, filePath, resolved);
  chunk.crossFileImports = resolved.length;
  return resolved;
};

const findPotentialImporters = (targetPath: string, graph: ASTGraph): string[] => {
  const importers = new Set<string>();

  for (const [sourcePath, chunk] of graph.nodes) {
    for (const imp of chunk.imports) {
      if (importCouldResolveToTarget(sourcePath, imp, targetPath)) {
        importers.add(sourcePath);
        break;
      }
    }
  }

  return [...importers];
};

const collectAffectedPaths = (graph: ASTGraph, seedPaths: Iterable<string>): Set<string> => {
  const affected = new Set<string>();
  const queue = [...seedPaths].filter((filePath) => graph.nodes.has(filePath));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (affected.has(current)) continue;
    affected.add(current);

    for (const dependent of graph.reverseEdges.get(current) ?? []) {
      if (!affected.has(dependent)) queue.push(dependent);
    }
  }

  return affected;
};

const recomputeDepthForPath = (
  filePath: string,
  graph: ASTGraph,
  affected: Set<string>,
  memo: Map<string, number>,
  visiting: Set<string>,
): number => {
  const chunk = graph.nodes.get(filePath);
  if (!chunk) return 0;
  if (!affected.has(filePath)) return chunk.dependencyDepth ?? 0;
  if (memo.has(filePath)) return memo.get(filePath)!;
  if (visiting.has(filePath)) return chunk.dependencyDepth ?? 0;

  visiting.add(filePath);
  let maxDepth = 0;

  for (const dep of graph.edges.get(filePath) ?? []) {
    const depDepth = affected.has(dep)
      ? recomputeDepthForPath(dep, graph, affected, memo, visiting)
      : graph.nodes.get(dep)?.dependencyDepth ?? 0;
    if (depDepth + 1 > maxDepth) maxDepth = depDepth + 1;
  }

  visiting.delete(filePath);
  memo.set(filePath, maxDepth);
  return maxDepth;
};

const recomputeGraphSummaries = (graph: ASTGraph): void => {
  let globalMax = 0;
  let totalCrossRefs = 0;
  let cyclicEdges = 0;
  const symbols: string[] = [];

  for (const chunk of graph.nodes.values()) {
    if ((chunk.dependencyDepth ?? 0) > globalMax) globalMax = chunk.dependencyDepth ?? 0;
    totalCrossRefs += chunk.crossFileImports ?? 0;
    cyclicEdges += chunk.cyclicRefs.length;
    symbols.push(...chunk.exports);
  }

  graph.maxDepth = globalMax;
  graph.crossFileRefs = totalCrossRefs;
  graph.cyclicEdges = cyclicEdges;
  graph.symbols = symbols;
};

export const updateGraphMetrics = async (
  graph: ASTGraph,
  changedPaths: Iterable<string>,
): Promise<void> => {
  const refreshTargets = new Set<string>();

  for (const changedPath of changedPaths) {
    refreshTargets.add(changedPath);
    for (const importer of findPotentialImporters(changedPath, graph)) {
      refreshTargets.add(importer);
    }
  }

  for (const filePath of refreshTargets) {
    if (graph.nodes.has(filePath)) {
      await buildResolvedEdgesForFile(filePath, graph);
    }
  }

  const affected = collectAffectedPaths(graph, refreshTargets);
  const depthMemo = new Map<string, number>();

  for (const filePath of affected) {
    const chunk = graph.nodes.get(filePath);
    if (chunk) chunk.cyclicRefs = [];
  }

  for (const filePath of affected) {
    const depth = recomputeDepthForPath(filePath, graph, affected, depthMemo, new Set<string>());
    const chunk = graph.nodes.get(filePath);
    if (chunk) chunk.dependencyDepth = depth;
  }

  recomputeGraphSummaries(graph);
};

// ─── Initial scan of a project (batch of 50) ──────────────────────────────────

const SCAN_BATCH = 50;

export const scanProject = async (projectRoot: string): Promise<ASTGraph> => {
  // Recursive discovery of all .ts/.tsx outside node_modules and dist
  const allFiles: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: any[];
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true })) as any[];
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const name = typeof e.name === "string" ? e.name : String(e.name);
        const full = nodePath.join(dir, name);
        if (e.isDirectory()) {
          if (["node_modules", "dist", ".git", ".aether"].includes(name))
            return;
          await walk(full);
        } else if (
          e.isFile() &&
          (name.endsWith(".ts") || name.endsWith(".tsx"))
        ) {
          allFiles.push(full);
        }
      }),
    );
  };
  await walk(projectRoot);

  // Batch processing by 50 — anti-EMFILE macOS
  const chunks = new Map<string, ASTChunk>();
  for (let i = 0; i < allFiles.length; i += SCAN_BATCH) {
    const batch = allFiles.slice(i, i + SCAN_BATCH);
    const results = await Promise.all(batch.map(extractFile));
    for (const chunk of results) {
      if (chunk) chunks.set(chunk.filePath, chunk);
    }
  }

  const graph: ASTGraph = {
    nodes: chunks,
    edges: new Map(),
    reverseEdges: new Map(),
    maxDepth: 0,
    cyclicEdges: 0,
    symbols: [],
    crossFileRefs: 0,
  };

  await computeGraphMetrics(graph);
  return graph;
};

// ─── Incremental extraction (watcher — 1 file) ────────────────────────────────

export const updateFileInGraph = async (
  filePath: string,
  graph: ASTGraph,
): Promise<void> => {
  const chunk = await extractFile(filePath);
  if (!chunk) {
    removeFileFromGraph(filePath, graph);
    return;
  }
  upsertFileInGraph(chunk, graph);
  // Incremental recalculation for the modified file and its downstream consumers.
  await updateGraphMetrics(graph, [filePath]);
};

// ─── Semantic filtering (context:request) ─────────────────────────────────────
// Returns the most relevant ASTChunks for a given task.

const MIN_NAME_LEN = 2;
const GENERIC_NAMES = new Set([
  "get",
  "set",
  "run",
  "app",
  "use",
  "init",
  "load",
  "data",
  "item",
  "fn",
  "cb",
  "el",
  "on",
  "to",
  "of",
  "is",
  "has",
  "do",
  "go",
  "id",
  "ok",
  "no",
]);

export const extractForTask = (
  taskText: string,
  graph: ASTGraph,
): ASTChunk[] => {
  const lower = taskText.toLowerCase();
  const scored: Array<{ chunk: ASTChunk; score: number }> = [];

  for (const chunk of graph.nodes.values()) {
    let score = 0;

    const check = (name: string, weight: number) => {
      if (name.length < MIN_NAME_LEN) return;
      if (GENERIC_NAMES.has(name.toLowerCase())) return;
      if (lower.includes(name.toLowerCase())) score += weight;
    };

    chunk.functions.forEach((f) => check(f.name, 3));
    chunk.components.forEach((c) => check(c.name, 3));
    chunk.types.forEach((t) => check(t.name, 2));

    const fileName = nodePath.basename(
      chunk.filePath,
      nodePath.extname(chunk.filePath),
    );
    check(fileName, 2);

    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5).map((s) => s.chunk);

  // Inclusion of direct dependencies (Extended Tier 1)
  const result = new Map<string, ASTChunk>(top.map((c) => [c.filePath, c]));
  for (const chunk of top) {
    for (const dep of graph.edges.get(chunk.filePath) ?? []) {
      const depChunk = graph.nodes.get(dep);
      if (depChunk && !result.has(dep)) result.set(dep, depChunk);
    }
  }

  return [...result.values()];
};
