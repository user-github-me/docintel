"""DocIntel processor: stateless HTTP service used by the API workers.

Files are passed by storage key (shared volume / object store), never re-uploaded, so a
1,000-page PDF can be processed as many parallel page-range requests.
"""
from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import embeddings
from .config import get_settings
from .detect import detect_file_type
from .errors import ProcessingError, scrub_paths
from .ocr.engine import tesseract_version
from .pipelines import image as image_pipeline
from .pipelines import pdf as pdf_pipeline
from .pipelines import spreadsheet as sheet_pipeline
from .storage import resolve_storage_key

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("processor")

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load the embedding model in the background so the first search is not slow.
    threading.Thread(target=embeddings._load_model, daemon=True).start()
    yield


app = FastAPI(title="DocIntel Processor", version="1.0.0", docs_url="/docs", redoc_url=None, lifespan=lifespan)

FileType = Literal["pdf", "image", "xlsx", "xls", "csv"]


class InspectRequest(BaseModel):
    storage_key: str
    original_name: str | None = None


class ExtractRequest(BaseModel):
    storage_key: str
    original_name: str | None = None
    page_start: int = Field(1, ge=1)
    page_end: int | None = Field(None, ge=1)
    ocr: Literal["auto", "force", "off"] = "auto"


class RenderRequest(BaseModel):
    storage_key: str
    original_name: str | None = None
    page: int = Field(1, ge=1)
    dpi: int = Field(110, ge=36, le=300)
    max_side: int = Field(1600, ge=200, le=4000)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=256)
    kind: Literal["passage", "query"] = "passage"


@app.exception_handler(ProcessingError)
async def processing_error_handler(_: Request, exc: ProcessingError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unexpected processor error")
    return JSONResponse(
        status_code=500,
        content={"error_code": "internal_error", "message": scrub_paths(f"{type(exc).__name__}: {exc}"), "retryable": True},
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "tesseract": tesseract_version(),
        "embedding": embeddings.status(),
        "storage_dir": str(get_settings().storage_dir),
    }


@app.post("/v1/inspect")
def inspect(req: InspectRequest) -> dict:
    started = time.perf_counter()
    path = resolve_storage_key(req.storage_key)
    detected = detect_file_type(path, req.original_name)
    if detected.file_type == "pdf":
        info = pdf_pipeline.inspect_pdf(path)
    elif detected.file_type == "image":
        info = image_pipeline.inspect_image(path)
    else:
        info = sheet_pipeline.inspect_spreadsheet(path, detected.file_type)
    info["warnings"] = detected.warnings + info.get("warnings", [])
    return {
        "file_type": detected.file_type,
        "mime_type": detected.mime,
        "size_bytes": path.stat().st_size,
        **info,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


@app.post("/v1/extract")
def extract(req: ExtractRequest) -> dict:
    started = time.perf_counter()
    path = resolve_storage_key(req.storage_key)
    detected = detect_file_type(path, req.original_name)
    if detected.file_type == "pdf":
        result = pdf_pipeline.extract_pdf(path, req.page_start, req.page_end, req.ocr)
    elif detected.file_type == "image":
        result = image_pipeline.extract_image(path, req.page_start, req.page_end)
    else:
        result = sheet_pipeline.extract_spreadsheet(path, detected.file_type)
    result["warnings"] = detected.warnings + result.get("warnings", [])
    return {
        "file_type": detected.file_type,
        **result,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


@app.post("/v1/render")
def render(req: RenderRequest) -> Response:
    path = resolve_storage_key(req.storage_key)
    detected = detect_file_type(path, req.original_name)
    if detected.file_type == "pdf":
        data = pdf_pipeline.render_pdf_page(path, req.page, req.dpi, req.max_side)
    elif detected.file_type == "image":
        data = image_pipeline.render_image_page(path, req.page, req.max_side)
    else:
        raise ProcessingError("not_renderable", "Spreadsheets have no page images.", 400)
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.post("/v1/embed")
def embed(req: EmbedRequest) -> dict:
    started = time.perf_counter()
    model, vectors = embeddings.embed(req.texts, req.kind)
    return {
        "model": model,
        "dim": len(vectors[0]) if vectors else get_settings().embedding_dim,
        "vectors": vectors,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }
