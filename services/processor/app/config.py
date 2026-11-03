"""Runtime configuration (environment variables)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    storage_dir: Path
    # PDF / OCR
    ocr_dpi: int
    ocr_lang: str
    ocr_min_text_chars: int
    ocr_retry_below_conf: float
    ocr_concurrency: int
    max_pdf_pages: int
    max_pages_per_request: int
    max_image_pixels: int
    # Spreadsheets
    max_sheet_rows: int
    max_xlsx_uncompressed_mb: int
    max_csv_mb: int
    # Embeddings
    embedding_provider: str
    embedding_model: str
    embedding_dim: int


@lru_cache
def get_settings() -> Settings:
    return Settings(
        storage_dir=Path(os.environ.get("STORAGE_DIR", "../../storage")).resolve(),
        ocr_dpi=_int("OCR_DPI", 300),
        ocr_lang=os.environ.get("OCR_LANG", "eng"),
        ocr_min_text_chars=_int("OCR_MIN_TEXT_CHARS", 25),
        ocr_retry_below_conf=_float("OCR_RETRY_BELOW_CONF", 0.80),
        ocr_concurrency=_int("OCR_CONCURRENCY", 2),
        max_pdf_pages=_int("MAX_PDF_PAGES", 5000),
        max_pages_per_request=_int("MAX_PAGES_PER_REQUEST", 200),
        max_image_pixels=_int("MAX_IMAGE_PIXELS", 150_000_000),
        max_sheet_rows=_int("MAX_SHEET_ROWS", 200_000),
        max_xlsx_uncompressed_mb=_int("MAX_XLSX_UNCOMPRESSED_MB", 512),
        max_csv_mb=_int("MAX_CSV_MB", 100),
        embedding_provider=os.environ.get("EMBEDDING_PROVIDER", "fastembed"),
        embedding_model=os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
        embedding_dim=_int("EMBEDDING_DIM", 384),
    )
