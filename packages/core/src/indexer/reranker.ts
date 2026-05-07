import * as path from "node:path";

export interface RerankResult {
  index: number;
  score: number;
}

/**
 * Surgical Reranking Client
 * Calls the local Python Reranker Server (port 8082)
 */
export const initReranker = async () => {
  console.log("[Reranker] Client configured for Python Server (127.0.0.1:8082)");
  // No local initialization needed anymore as it's a remote service
};

export const rerank = async (
  query: string,
  documents: string[],
  topN: number = 15
): Promise<RerankResult[]> => {
  if (documents.length === 0) return [];

  try {
    const response = await fetch("http://127.0.0.1:8082/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents }),
    });

    if (!response.ok) {
      throw new Error(`Reranker server error: ${response.statusText}`);
    }

    const data = await response.json() as { results: RerankResult[] };
    
    return data.results
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  } catch (err) {
    console.error("[Reranker] Client error. Falling back to standard order.", err);
    // Fallback: return first N documents in original order
    return documents.slice(0, topN).map((_, i) => ({ index: i, score: 0 }));
  }
};
