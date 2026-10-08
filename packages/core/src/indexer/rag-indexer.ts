import * as lancedb from "@lancedb/lancedb";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Fragment de fichier indexable, avec sa position exacte dans le fichier. */
export interface RAGChunkPiece {
  content: string;
  /** 1-based, inclusif. */
  startLine: number;
  /** 1-based, inclusif. */
  endLine: number;
}

export interface RAGSearchResult {
  filePath: string;
  content: string;
  distance: number;
  startLine: number;
  endLine: number;
}

/**
 * Réponse de recherche. `degraded` remonte explicitement une indisponibilité
 * (index absent, serveur d'embeddings injoignable) au lieu de renvoyer une liste
 * vide silencieuse — même contrat que le reranker.
 */
export interface RAGSearchResponse {
  results: RAGSearchResult[];
  degraded: boolean;
  reason?: string;
}

export interface IndexFileResult {
  chunks: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Serveur ML unifié (embeddings + reranker) sur le port 8082.
const EMBEDDING_URL = process.env.EMBEDDING_URL ?? "http://127.0.0.1:8082";
// Le serveur normalise de toute façon sur son modèle interne
// (`nomic-ai/nomic-embed-text-v1.5`, 768 dimensions) : ce nom est informatif.
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;

/**
 * Nom de table versionné.
 *
 * Les tables antérieures stockaient **un seul enregistrement par fichier, tronqué
 * à 3 000 caractères** et sans position : un fichier de 2 000 lignes n'était
 * indexé que par son début, et le modèle ne pouvait citer aucune ligne.
 * On repart d'une table neuve plutôt que de migrer un schéma inutilisable.
 */
const RAG_TABLE = "rag_chunks_v3";
const LEGACY_TABLES = ["rag_chunks", "rag_chunks_v2"];

/** Taille visée d'un fragment, en caractères (~400 tokens). */
const CHUNK_TARGET_CHARS = 1600;
/** Borne dure : au-delà, on coupe même sans frontière naturelle (~800 tokens). */
const CHUNK_MAX_CHARS = 3200;
/** Lignes de recouvrement entre fragments, pour ne pas séparer une signature de son corps. */
const CHUNK_OVERLAP_LINES = 3;

let table: lancedb.Table | null = null;
let db: lancedb.Connection | null = null;

// ─── Découpage en fragments ───────────────────────────────────────────────────

/** Une ligne qui « ferme » une unité syntaxique est une bonne frontière de coupe. */
const isBoundary = (line: string): boolean => {
  const t = line.trim();
  if (t.length === 0) return true;
  if (t === "}" || t === "};" || t === "});" || t === ")" || t === "];") return true;
  if (t.endsWith("}") || t.endsWith("};") || t.endsWith(");") || t.endsWith(";")) return true;
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#")) return true;
  return false;
};

/**
 * Découpe un fichier en fragments déterministes, avec leurs numéros de ligne.
 *
 * Contrairement à l'ancien `content.slice(0, 3000)`, **aucune ligne n'est perdue** :
 * les fragments se recouvrent légèrement et couvrent tout le fichier. La fonction
 * est pure et sans dépendance, donc directement testable.
 */
export const chunkContent = (content: string): RAGChunkPiece[] => {
  if (!content || content.trim().length === 0) return [];

  const lines = content.split("\n");
  const pieces: RAGChunkPiece[] = [];

  let start = 0;
  let bufLen = 0;
  let lastBoundary = -1;
  let emittedEnd = -1;

  const emit = (endIdx: number): void => {
    const text = lines.slice(start, endIdx + 1).join("\n");
    if (text.trim().length > 0) {
      pieces.push({ content: text, startLine: start + 1, endLine: endIdx + 1 });
      emittedEnd = endIdx;
    }
    start = Math.max(start + 1, endIdx + 1 - CHUNK_OVERLAP_LINES);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    bufLen += line.length + 1;
    if (isBoundary(line)) lastBoundary = i;

    const hardStop = bufLen >= CHUNK_MAX_CHARS;
    const softStop = bufLen >= CHUNK_TARGET_CHARS && lastBoundary > start;

    if (hardStop || softStop) {
      emit(hardStop || lastBoundary <= start ? i : lastBoundary);

      // Le recouvrement a déjà été parcouru : on recompte sa longueur et sa
      // dernière frontière pour ne pas fausser le fragment suivant.
      bufLen = 0;
      lastBoundary = -1;
      for (let k = start; k <= i; k++) {
        const overlapLine = lines[k] ?? "";
        bufLen += overlapLine.length + 1;
        if (isBoundary(overlapLine)) lastBoundary = k;
      }
    }
  }

  // Queue du fichier : émise seulement s'il reste du contenu non couvert.
  if (start < lines.length && emittedEnd < lines.length - 1) {
    emit(lines.length - 1);
  }

  return pieces;
};

// ─── Embeddings (serveur ML unifié) ───────────────────────────────────────────

/** Échappe une valeur pour une chaîne littérale SQL (LanceDB / DataFusion). */
const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Embeddings par lots.
 *
 * L'endpoint accepte `input: string[]` ; envoyer un lot au lieu de N requêtes
 * réduit d'autant les allers-retours HTTP dans le chemin d'indexation.
 * En cas d'échec, **on lève** : l'appelant doit pouvoir le signaler. L'ancienne
 * version renvoyait un vecteur nul, ce qui faisait disparaître des fichiers de
 * l'index sans le moindre message.
 */
export const getEmbeddings = async (texts: string[]): Promise<number[][]> => {
  if (texts.length === 0) return [];

  const res = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer abcde",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  const payload = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };
  const rows = payload.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(
      `Embedding API a renvoyé ${rows.length} vecteurs pour ${texts.length} entrées`,
    );
  }

  // L'API renvoie les entrées dans un ordre non garanti : on les replace par index.
  const ordered: number[][] = new Array(texts.length);
  rows.forEach((row, fallbackIndex) => {
    const idx = typeof row.index === "number" ? row.index : fallbackIndex;
    const vector = row.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`Embedding API : vecteur vide pour l'entrée ${idx}`);
    }
    if (vector.length !== EMBED_DIM) {
      console.warn(
        `[RAG] Dimension inattendue : ${vector.length} au lieu de ${EMBED_DIM}. ` +
          `Le schéma LanceDB ne correspondra pas — réindexation nécessaire.`,
      );
    }
    ordered[idx] = vector;
  });

  return ordered;
};

const getEmbedding = async (text: string): Promise<number[]> => {
  const [vector] = await getEmbeddings([text]);
  if (!vector) throw new Error("Embedding API : aucun vecteur renvoyé");
  return vector;
};

// ─── Initialisation ───────────────────────────────────────────────────────────

export const initRAG = async (projectHash: string): Promise<void> => {
  const dbPath = path.join(
    os.homedir(),
    ".aether",
    "projects",
    projectHash,
    "lancedb",
  );
  fs.mkdirSync(dbPath, { recursive: true });

  db = await lancedb.connect(dbPath);

  const tableNames = await db.tableNames();

  // Purge des tables au schéma obsolète (contenu tronqué, pas d'offsets).
  for (const legacy of LEGACY_TABLES) {
    if (!tableNames.includes(legacy)) continue;
    try {
      await db.dropTable(legacy);
      console.log(`[RAG] Table héritée supprimée : ${legacy}`);
    } catch (err) {
      console.warn(`[RAG] Impossible de supprimer ${legacy}:`, err);
    }
  }

  if (tableNames.includes(RAG_TABLE)) {
    table = await db.openTable(RAG_TABLE);
    return;
  }

  // Enregistrement factice pour figer le schéma, puis suppression.
  table = await db.createTable(RAG_TABLE, [
    {
      filePath: "__init__",
      chunkIndex: 0,
      startLine: 0,
      endLine: 0,
      content: "",
      vector: new Array(EMBED_DIM).fill(0),
    },
  ]);
  await table.delete(`\`filePath\` = '__init__'`);
};

// ─── Indexation ───────────────────────────────────────────────────────────────

/**
 * Indexe un fichier entier, fragment par fragment.
 *
 * Lève en cas d'échec d'embedding : le job d'indexation du daemon journalise
 * l'erreur avec le chemin du fichier (plus de disparition silencieuse).
 */
export const indexFile = async (
  filePath: string,
  content: string,
): Promise<IndexFileResult> => {
  if (!table) return { chunks: 0 };

  const pieces = chunkContent(content);
  if (pieces.length === 0) {
    await deleteFile(filePath);
    return { chunks: 0 };
  }

  const vectors = await getEmbeddings(pieces.map((p) => p.content));

  const rows = pieces.map((piece, i) => ({
    filePath,
    chunkIndex: i,
    startLine: piece.startLine,
    endLine: piece.endLine,
    content: piece.content,
    vector: vectors[i],
  }));

  // Pas d'upsert par clé primaire en LanceDB : on remplace le fichier entier.
  await deleteFile(filePath);
  await table.add(rows);
  return { chunks: rows.length };
};

export const deleteFile = async (filePath: string): Promise<void> => {
  if (!table) return;
  await table.delete(`\`filePath\` = ${sqlString(filePath)}`);
};

// ─── Recherche ────────────────────────────────────────────────────────────────

export const searchRAG = async (
  query: string,
  limit: number = 3,
): Promise<RAGSearchResponse> => {
  if (!table) {
    return { results: [], degraded: true, reason: "index_unavailable" };
  }

  let queryVector: number[];
  try {
    queryVector = await getEmbedding(query);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "embedding_failed";
    console.warn(`[RAG] Recherche dégradée (embeddings indisponibles) : ${reason}`);
    return { results: [], degraded: true, reason };
  }

  const raw = await table.search(queryVector).limit(limit).toArray();

  return {
    degraded: false,
    results: raw.map((r: Record<string, unknown>) => ({
      filePath: String(r.filePath ?? ""),
      content: String(r.content ?? ""),
      distance: typeof r._distance === "number" ? r._distance : 0,
      startLine: typeof r.startLine === "number" ? r.startLine : 0,
      endLine: typeof r.endLine === "number" ? r.endLine : 0,
    })),
  };
};
