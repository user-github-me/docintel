"""Text embeddings for semantic search.

Default: BAAI/bge-small-en-v1.5 via fastembed (ONNX, CPU, 384-d, no PyTorch) running locally, so
document content never leaves the deployment for embedding. If the model cannot be loaded (e.g.
offline first start) we fall back to a deterministic feature-hashing embedder and report it, so
search degrades to lexical similarity instead of failing. Vectors are tagged with the model name
and the API only compares vectors produced by the same model.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import threading

import numpy as np

from .config import get_settings

log = logging.getLogger("processor.embeddings")
_lock = threading.Lock()
_model = None
_model_error: str | None = None
HASH_MODEL_NAME = "hash-384"


def _hash_embed(text: str, dim: int) -> list[float]:
    vec = np.zeros(dim, dtype=np.float32)
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    features = tokens + [f"{a}_{b}" for a, b in zip(tokens, tokens[1:])]
    for feat in features:
        h = int.from_bytes(hashlib.blake2b(feat.encode(), digest_size=8).digest(), "little")
        vec[h % dim] += 1.0 if (h >> 63) & 1 else -1.0
    norm = float(np.linalg.norm(vec))
    return (vec / norm).tolist() if norm else vec.tolist()


def _load_model():
    global _model, _model_error
    settings = get_settings()
    if settings.embedding_provider != "fastembed":
        return None
    with _lock:
        if _model is not None or _model_error is not None:
            return _model
        try:
            from fastembed import TextEmbedding

            _model = TextEmbedding(
                model_name=settings.embedding_model,
                cache_dir=os.environ.get("FASTEMBED_CACHE_PATH"),
                threads=1,
            )
            log.info("loaded embedding model %s", settings.embedding_model)
        except Exception as exc:  # offline, disk, etc.
            _model_error = f"{type(exc).__name__}: {exc}"
            log.warning("embedding model unavailable, using hash fallback: %s", _model_error)
        return _model


def status() -> dict:
    settings = get_settings()
    if settings.embedding_provider != "fastembed":
        return {"model": HASH_MODEL_NAME, "dim": settings.embedding_dim, "loaded": True, "degraded": False}
    return {
        "model": settings.embedding_model if _model is not None else (HASH_MODEL_NAME if _model_error else settings.embedding_model),
        "dim": settings.embedding_dim,
        "loaded": _model is not None,
        "degraded": _model_error is not None,
        "error": _model_error,
    }


def embed(texts: list[str], kind: str = "passage") -> tuple[str, list[list[float]]]:
    settings = get_settings()
    model = _load_model()
    if model is None:
        return HASH_MODEL_NAME, [_hash_embed(t, settings.embedding_dim) for t in texts]
    cleaned = [t if t.strip() else "(empty)" for t in texts]
    if kind == "query":
        vectors = list(model.query_embed(cleaned))
    else:
        vectors = list(model.passage_embed(cleaned, batch_size=32))
    out = []
    for v in vectors:
        arr = np.asarray(v, dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        out.append((arr / norm).tolist() if norm else arr.tolist())
    return settings.embedding_model, out
