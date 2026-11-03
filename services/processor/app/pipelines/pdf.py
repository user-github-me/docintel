"""PDF pipeline: native text layer when it is usable, OCR for scanned / image-only / garbled pages."""
from __future__ import annotations

import time

import numpy as np
import pymupdf

from ..config import get_settings
from ..errors import CORRUPTED_FILE, ENCRYPTED_PDF, TOO_MANY_PAGES, ProcessingError
from ..layout import Word, build_lines, unrotate_lines
from ..ocr.engine import ocr_image
from .common import PageResult

pymupdf.TOOLS.mupdf_display_errors(False)  # keep MuPDF repair chatter out of the logs

MAX_RENDER_PIXELS = 40_000_000
_SAFE_PUNCT = set(".,:;/-#$€£%()&@'+*=_")


def open_pdf(path) -> pymupdf.Document:
    try:
        doc = pymupdf.open(path, filetype="pdf")
    except Exception as exc:  # FileDataError, EmptyFileError, RuntimeError ...
        raise ProcessingError(CORRUPTED_FILE, f"The PDF is damaged and could not be opened ({exc}).") from exc
    if doc.needs_pass and not doc.authenticate(""):
        doc.close()
        raise ProcessingError(ENCRYPTED_PDF, "The PDF is password protected; upload an unprotected copy.")
    if doc.page_count == 0:
        doc.close()
        raise ProcessingError(CORRUPTED_FILE, "The PDF contains no pages.")
    if doc.page_count > get_settings().max_pdf_pages:
        n = doc.page_count
        doc.close()
        raise ProcessingError(TOO_MANY_PAGES, f"The PDF has {n} pages; the limit is {get_settings().max_pdf_pages}.")
    return doc


def text_layer_quality(text: str) -> float:
    """Share of plausible characters; garbled text layers (missing ToUnicode maps) score low."""
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0.0
    good = sum(c.isalnum() or c in _SAFE_PUNCT for c in chars)
    bad = text.count("�") + 5 * text.count("(cid:")
    return max(0, good - bad) / len(chars)


def image_coverage(page: pymupdf.Page) -> float:
    area = abs(page.rect)
    if area <= 0:
        return 0.0
    covered = 0.0
    try:
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"]) & page.rect
            covered += abs(r) if not r.is_empty else 0.0
    except Exception:
        return 0.0
    return min(1.0, covered / area)


def inspect_pdf(path) -> dict:
    doc = open_pdf(path)
    try:
        sample = min(doc.page_count, 5)
        text_pages = 0
        for i in range(sample):
            try:
                text = doc.load_page(i).get_text("text")
            except Exception:
                continue
            if sum(c.isalnum() for c in text) >= get_settings().ocr_min_text_chars:
                text_pages += 1
        meta = {k: v for k, v in (doc.metadata or {}).items() if v and k in ("title", "author", "producer", "creator")}
        warnings = ["pdf_repaired: the file had structural damage and was repaired on open"] if doc.is_repaired else []
        return {
            "page_count": doc.page_count,
            "encrypted": bool(doc.is_encrypted),
            "metadata": meta,
            "estimated_scanned_ratio": round(1 - text_pages / sample, 2) if sample else 0.0,
            "warnings": warnings,
        }
    finally:
        doc.close()


def _render_gray(page: pymupdf.Page, dpi: int) -> np.ndarray:
    w_in, h_in = page.rect.width / 72.0, page.rect.height / 72.0
    if w_in * h_in * dpi * dpi > MAX_RENDER_PIXELS:
        dpi = int((MAX_RENDER_PIXELS / (w_in * h_in)) ** 0.5)
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w).copy()


def _extract_page(doc: pymupdf.Document, index: int, ocr_mode: str) -> PageResult:
    started = time.perf_counter()
    settings = get_settings()
    try:
        page = doc.load_page(index)
    except Exception as exc:
        return PageResult(page_number=index + 1, method="error", warnings=[f"page_unreadable: {exc}"])

    rect = page.rect
    warnings: list[str] = []
    try:
        raw_words = page.get_text("words")
    except Exception as exc:
        raw_words = []
        warnings.append(f"text_layer_unreadable: {exc}")
    layer_text = " ".join(w[4] for w in raw_words)
    alnum = sum(c.isalnum() for c in layer_text)
    quality = text_layer_quality(layer_text)

    if ocr_mode == "force":
        need_ocr = True
    elif ocr_mode == "off":
        need_ocr = False
    else:
        need_ocr = (
            alnum < settings.ocr_min_text_chars
            or quality < 0.6
            or (alnum < 200 and image_coverage(page) > 0.6)
        )
        if need_ocr and alnum >= settings.ocr_min_text_chars:
            warnings.append(f"text_layer_rejected: quality={quality:.2f}, chars={alnum}")

    if not need_ocr:
        matrix = page.rotation_matrix
        words = []
        for w in raw_words:
            r = pymupdf.Rect(w[:4]) * matrix
            words.append(Word(r.x0, r.y0, r.x1, r.y1, w[4]))
        lines = build_lines(words, rect.width, rect.height)
        method = "text" if lines else "empty"
        return PageResult(
            page_number=index + 1, method=method, lines=lines, width=rect.width, height=rect.height,
            warnings=warnings, duration_ms=int((time.perf_counter() - started) * 1000),
        )

    image = _render_gray(page, settings.ocr_dpi)
    ocr = ocr_image(image)
    lines = unrotate_lines(build_lines(ocr.words, ocr.width, ocr.height), ocr.rotate90)
    if ocr.mean_conf < 0.6:
        warnings.append(f"low_ocr_confidence: {ocr.mean_conf:.2f}")
    return PageResult(
        page_number=index + 1, method="ocr" if lines else "empty", lines=lines, ocr_confidence=ocr.mean_conf,
        width=ocr.width, height=ocr.height, warnings=warnings, ocr_steps=ocr.steps,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )


def extract_pdf(path, page_start: int, page_end: int | None, ocr_mode: str) -> dict:
    doc = open_pdf(path)
    try:
        total = doc.page_count
        start = max(1, page_start)
        end = min(total, page_end or total)
        if start > end:
            raise ProcessingError("invalid_page_range", f"Page range {page_start}-{page_end} is outside 1-{total}.", 400)
        limit = get_settings().max_pages_per_request
        if end - start + 1 > limit:
            raise ProcessingError("invalid_page_range", f"At most {limit} pages per request.", 400)
        pages = [_extract_page(doc, i, ocr_mode).to_dict() for i in range(start - 1, end)]
        warnings = ["pdf_repaired: the file had structural damage and was repaired on open"] if doc.is_repaired else []
        return {"page_count": total, "pages": pages, "sheets": [], "warnings": warnings}
    finally:
        doc.close()


def render_pdf_page(path, page_number: int, dpi: int, max_side: int) -> bytes:
    doc = open_pdf(path)
    try:
        if not 1 <= page_number <= doc.page_count:
            raise ProcessingError("invalid_page_range", f"Page {page_number} does not exist.", 404)
        page = doc.load_page(page_number - 1)
        longest_in = max(page.rect.width, page.rect.height) / 72.0
        dpi = max(36, min(dpi, int(max_side / max(longest_in, 0.1))))
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        return pix.tobytes("jpg", jpg_quality=82)
    finally:
        doc.close()
