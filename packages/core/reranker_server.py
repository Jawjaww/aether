from fastapi import FastAPI
import uvicorn
from pydantic import BaseModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch
import numpy as np

# Try to import fastembed for lightweight embeddings
try:
    from fastembed import TextEmbedding
    embedding_model = TextEmbedding(model_name="nomic-ai/nomic-embed-text-v1.5")
    has_fastembed = True
except ImportError:
    has_fastembed = False

app = FastAPI()
model_id = "BAAI/bge-reranker-v2-m3"
device = "mps"
max_length = 512
max_batch_size = 32
model_ready = False

print(f"[Reranker] Loading {model_id} on MPS...")
tokenizer = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForSequenceClassification.from_pretrained(model_id).to(device)
model.eval()
model_ready = True

class RerankRequest(BaseModel):
    query: str
    documents: list[str]

class EmbeddingRequest(BaseModel):
    model: str = "nomic-embed-text"
    input: str | list[str]

@app.get("/health")
async def health_endpoint():
    return {
        "status": "ok" if model_ready else "loading", 
        "ready": model_ready, 
        "model": model_id,
        "embeddings_ready": has_fastembed
    }

def score_batch(query: str, documents: list[str]) -> list[float]:
    with torch.inference_mode():
        inputs = tokenizer(
            [query] * len(documents),
            documents,
            padding=True,
            truncation=True,
            return_tensors="pt",
            max_length=max_length,
        ).to(device)
        scores = model(**inputs, return_dict=True).logits.view(-1).float()
    return scores.cpu().tolist()

@app.post("/rerank")
async def rerank_endpoint(req: RerankRequest):
    if not req.documents:
        return {"results": []}

    results = []
    for start in range(0, len(req.documents), max_batch_size):
        batch_documents = req.documents[start:start + max_batch_size]
        batch_scores = score_batch(req.query, batch_documents)
        results.extend(
            {"index": start + i, "score": float(score)}
            for i, score in enumerate(batch_scores)
        )

    return {"results": results}

@app.post("/v1/embeddings")
async def embeddings_endpoint(req: EmbeddingRequest):
    if not has_fastembed:
        return {"error": "fastembed not installed", "code": 500}
    
    # We use the internal model regardless of what the client asks for (e.g. nomic)
    inputs = [req.input] if isinstance(req.input, str) else req.input
    embeddings = list(embedding_model.embed(inputs))
    
    data = []
    for i, emb in enumerate(embeddings):
        data.append({
            "object": "embedding",
            "index": i,
            "embedding": emb.tolist()
        })
    
    return {
        "object": "list",
        "data": data,
        "model": req.model,
        "usage": {"prompt_tokens": 0, "total_tokens": 0}
    }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8082)
