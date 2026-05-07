from fastapi import FastAPI
import uvicorn
from pydantic import BaseModel
from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch

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


@app.get("/health")
async def health_endpoint():
    return {"status": "ok" if model_ready else "loading", "ready": model_ready, "model": model_id}


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

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8082)
