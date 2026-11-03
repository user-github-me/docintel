"""Image pipeline (JPG / PNG / TIFF incl. multi-page TIFF): decode safely, fix orientation, OCR."""
from __future__ import annotations

import io
import time

import numpy as np
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

from ..config import get_settings
from ..errors import CORRUPTED_FILE, IMAGE_TOO_LARGE, ProcessingError
from ..layout import build_lines, unrotate_lines
from ..ocr.engine import ocr_image
from .common import PageResult


def _open(path) -> Image.Image:
    Image.MAX_IMAGE_PIXELS = get_settings().max_image_pixels  # decompression-bomb guard
    try:
        with Image.open(path) as probe:
            probe.verify()  # structural check; the object is unusable afterwards
        img = Image.open(path)
        img.load()
        return img
    except Image.DecompressionBombError as exc:
        raise ProcessingError(IMAGE_TOO_LARGE, f"Image is too large to process safely ({exc}).") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ProcessingError(CORRUPTED_FILE, f"The image is damaged or truncated ({exc}).") from exc


def _to_array(frame: Image.Image) -> np.ndarray:
    frame = ImageOps.exif_transpose(frame) or frame
    if frame.mode in ("RGBA", "LA") or (frame.mode == "P" and "transparency" in frame.info):
        frame = frame.convert("RGBA")
        background = Image.new("RGBA", frame.size, (255, 255, 255, 255))
        frame = Image.alpha_composite(background, frame)
    if frame.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        arr = np.asarray(frame, dtype=np.float32)
        arr = (255 * (arr - arr.min()) / max(float(arr.max() - arr.min()), 1.0)).astype(np.uint8)
        return arr
    return np.asarray(frame.convert("L"))


def inspect_image(path) -> dict:
    img = _open(path)
    try:
        frames = getattr(img, "n_frames", 1) or 1
        dpi = img.info.get("dpi")
        return {
            "page_count": int(frames),
            "width": img.width,
            "height": img.height,
            "format": img.format,
            "mode": img.mode,
            "dpi": [round(float(d), 1) for d in dpi] if dpi else None,
            "warnings": [],
        }
    finally:
        img.close()


def extract_image(path, page_start: int, page_end: int | None) -> dict:
    img = _open(path)
    pages: list[dict] = []
    try:
        total = int(getattr(img, "n_frames", 1) or 1)
        start = max(1, page_start)
        end = min(total, page_end or total)
        for index, frame in enumerate(ImageSequence.Iterator(img), start=1):
            if index < start:
                continue
            if index > end:
                break
            started = time.perf_counter()
            warnings: list[str] = []
            arr = _to_array(frame.copy())
            ocr = ocr_image(arr)
            lines = unrotate_lines(build_lines(ocr.words, ocr.width, ocr.height), ocr.rotate90)
            if ocr.mean_conf < 0.6:
                warnings.append(f"low_ocr_confidence: {ocr.mean_conf:.2f}")
            pages.append(
                PageResult(
                    page_number=index, method="ocr" if lines else "empty", lines=lines,
                    ocr_confidence=ocr.mean_conf, width=ocr.width, height=ocr.height,
                    warnings=warnings, ocr_steps=ocr.steps,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                ).to_dict()
            )
        return {"page_count": total, "pages": pages, "sheets": [], "warnings": []}
    finally:
        img.close()


def render_image_page(path, page_number: int, max_side: int) -> bytes:
    img = _open(path)
    try:
        total = int(getattr(img, "n_frames", 1) or 1)
        if not 1 <= page_number <= total:
            raise ProcessingError("invalid_page_range", f"Page {page_number} does not exist.", 404)
        img.seek(page_number - 1)
        frame = ImageOps.exif_transpose(img.copy()) or img.copy()
        frame = frame.convert("RGB")
        frame.thumbnail((max_side, max_side))
        buf = io.BytesIO()
        frame.save(buf, format="JPEG", quality=82)
        return buf.getvalue()
    finally:
        img.close()
