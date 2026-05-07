import * as lancedb from "@lancedb/lancedb";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface RAGChunk {
  filePath: string;
  content: string;
  vector: number[];
}

export interface RAGSearchResult {
  filePath: string;
  content: string;
  distance: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = "nomic-embed-text";
let table: lancedb.Table | null = null;
let db: lancedb.Connection | null = null;

// ─── Embeddings via Ollama ────────────────────────────────────────────────────

const getEmbedding = async (text: string): Promise<number[]> => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[RAG] Ollama Error (${res.status}): ${errorText}`);
      throw new Error(`Ollama API error: ${res.statusText}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0] || new Array(768).fill(0);
  } catch (err) {
    console.error(`[RAG] Failed to get embedding:`, err);
    return new Array(768).fill(0);
  }
};

// ─── Initialization ───────────────────────────────────────────────────────────

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
  if (tableNames.includes("rag_chunks")) {
    table = await db.openTable("rag_chunks");
  } else {
    // Create an empty table with a dummy record to define the schema
    const dummyVector = new Array(768).fill(0);
    table = await db.createTable("rag_chunks", [
      { filePath: "__init__", content: "", vector: dummyVector },
    ]);
    await table.delete("`filePath` = '__init__'");
  }
};

// ─── Indexing ─────────────────────────────────────────────────────────────────

export const indexFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  if (!table) return;

  // Simple heuristic: if content is huge, we should chunk it.
  // We reduce to 3000 chars to stay safely within Ollama's default context limits.
  const textToIndex = content.slice(0, 3000); 

  const vector = await getEmbedding(textToIndex);
  if (vector.every((v) => v === 0)) return; // skip if embedding failed

  // LanceDB doesn't have native upsert by primary key without schema definition tricks,
  // so we delete existing entry for the file and insert new.
  // Use backticks for DataFusion/LanceDB column quoting
  await table.delete(`\`filePath\` = '${filePath}'`);
  await table.add([{ filePath, content: textToIndex, vector }]);
};

export const deleteFile = async (filePath: string): Promise<void> => {
  if (!table) return;
  await table.delete(`\`filePath\` = '${filePath}'`);
};

// ─── Search ───────────────────────────────────────────────────────────────────

export const searchRAG = async (
  query: string,
  limit: number = 3,
): Promise<RAGSearchResult[]> => {
  if (!table) return [];

  const queryVector = await getEmbedding(query);
  if (queryVector.every((v) => v === 0)) return [];

  const results = await table
    .search(queryVector)
    .limit(limit)
    .toArray();

  return results.map((r: any) => ({
    filePath: r.filePath,
    content: r.content,
    distance: r._distance ?? 0,
  }));
};
