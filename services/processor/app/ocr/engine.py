"""Tesseract OCR with an adaptive multi-pass strategy for poor-quality scans.

Pass 1: normalised grayscale (scale + contrast + denoise + deskew).
If the result is weak (low confidence or very few words) we try, in order:
  - the other three 90° orientations (upside-down / sideways scans and phone photos),
  - an adaptively binarised variant (shadows, faded print, uneven lighting),
and keep whichever variant reads the most confident characters.
"""
from __future__ import annotations

import os
import shutil
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import pytesseract
from pytesseract import Output

from ..config import get_settings
from ..errors import OCR_UNAVAILABLE, ProcessingError
from ..layout import Word
from . import preprocess as pp

_semaphore: threading.BoundedSemaphore | None = None
_semaphore_lock = threading.Lock()


def _ocr_slot() -> threading.BoundedSemaphore:
    global _semaphore
    with _semaphore_lock:
        if _semaphore is None:
            _semaphore = threading.BoundedSemaphore(max(1, get_settings().ocr_concurrency))
        return _semaphore


def tesseract_version() -> str | None:
    if shutil.which("tesseract") is None:
        return None
    try:
        return str(pytesseract.get_tesseract_version())
    except Exception:  # pragma: no cover - depends on host
        return None


@dataclass
class OcrResult:
    words: list[Word]
    width: int
    height: int
    mean_conf: float
    variant: str
    steps: list[str] = field(default_factory=list)
    duration_ms: int = 0
    rotate90: int = 0  # clockwise rotation applied to make the page upright

    @property
    def quality(self) -> float:
        # "confident characters": rewards coverage and confidence together
        return sum((w.conf or 0.0) * len(w.text) for w in self.words if (w.conf or 0) >= 0.3)


OCR_CALL_TIMEOUT_S = 90


def _run(gray: np.ndarray, lang: str, psm: int = 6) -> tuple[list[Word], float]:
    """One Tesseract pass. A pathological image that times out yields an empty result so the
    caller can try another variant instead of failing the whole page."""
    with _ocr_slot():
        try:
            data = pytesseract.image_to_data(
                gray, lang=lang, config=f"--oem 1 --psm {psm}", output_type=Output.DICT, timeout=OCR_CALL_TIMEOUT_S
            )
        except RuntimeError as exc:  # pytesseract raises RuntimeError('Tesseract process timeout')
            if "timeout" in str(exc).lower():
                return [], 0.0
            raise
    words: list[Word] = []
    for i, raw in enumerate(data["text"]):
        text = (raw or "").strip()
        try:
            conf = float(data["conf"][i])
        except (TypeError, ValueError):
            conf = -1.0
        if not text or conf < 0:
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        words.append(Word(float(x), float(y), float(x + w), float(y + h), text, conf / 100.0))
    total = sum(len(w.text) for w in words)
    mean = sum((w.conf or 0) * len(w.text) for w in words) / total if total else 0.0
    return words, mean


def _is_junk(word: Word) -> bool:
    """Tokens Tesseract hallucinates from specks, rules and table borders."""
    text = word.text
    conf = word.conf or 0.0
    alnum = sum(c.isalnum() for c in text)
    if alnum == 0:
        return conf < 0.85 or len(text) > 3
    if alnum == 1 and len(text) <= 2 and conf < 0.6:
        return True
    return conf < 0.25


def _result(words: list[Word], mean: float, gray: np.ndarray, variant: str, steps: list[str]) -> OcrResult:
    kept = [w for w in words if not _is_junk(w)]
    real = [w for w in kept if sum(c.isalnum() for c in w.text) >= 2]
    total = sum(len(w.text) for w in real)
    page_conf = sum((w.conf or 0) * len(w.text) for w in real) / total if total else 0.0
    return OcrResult(words=kept, width=gray.shape[1], height=gray.shape[0], mean_conf=page_conf, variant=variant, steps=list(steps))


def _orientation_probe(gray: np.ndarray, lang: str) -> int:
    """Return the clockwise rotation (0/90/180/270) that reads best, using a fast downscaled OCR."""
    factor = min(1.0, 1400.0 / max(gray.shape))
    small = pp.resize(gray, factor) if factor < 1 else gray
    best_rot, best_score = 0, -1.0
    for rot in (0, 90, 180, 270):
        words, _ = _run(pp.rotate90(small, rot), lang, psm=6)
        score = sum((w.conf or 0) * len(w.text) for w in words if len(w.text) >= 3 and (w.conf or 0) >= 0.6)
        if score > best_score:
            best_rot, best_score = rot, score
    return best_rot


def ocr_image(img: np.ndarray, lang: str | None = None) -> OcrResult:
    if tesseract_version() is None:
        raise ProcessingError(OCR_UNAVAILABLE, "The tesseract binary is not installed.", 503, retryable=True)
    settings = get_settings()
    lang = lang or settings.ocr_lang
    started = time.perf_counter()
    steps: list[str] = []

    raw = pp.to_gray(img)
    grain = pp.background_noise(raw)  # measured before any filtering
    gray = pp.despeckle(raw)
    denoise_mode = os.environ.get("OCR_DENOISE", "scaled")
    if denoise_mode == "native":
        gray, denoise_step = pp.denoise(gray, grain)
        if denoise_step:
            steps.append(denoise_step)
    glyph = pp.estimate_glyph_height(gray)
    scale = pp.choose_scale(glyph, gray.shape)
    if abs(scale - 1.0) >= 0.05:
        gray = pp.resize(gray, scale)
        steps.append(f"scale x{scale:.2f} (glyph {glyph or 0:.0f}px)")
    if denoise_mode == "scaled":  # after upscaling, decimal points are big enough to survive
        gray, denoise_step = pp.denoise(gray, grain)
        if denoise_step:
            steps.append(denoise_step)
    gray, stretched = pp.stretch_contrast(gray)
    if stretched:
        steps.append("contrast-stretch")
    gray, removed = pp.remove_isolated_specks(gray, (glyph or 22.0) * scale)
    if removed:
        steps.append(f"specks-removed:{removed}")
    gray, angle = pp.deskew(gray)
    if angle:
        steps.append(f"deskew {angle:+.2f}deg")
    gray, ruled = pp.remove_ruling_lines(gray, (glyph or 22.0) * scale)
    if ruled:
        steps.append(f"lines-removed:{ruled:.3%}")

    words, mean = _run(gray, lang)
    best = _result(words, mean, gray, "gray", steps)

    weak = best.mean_conf < settings.ocr_retry_below_conf or len(best.words) < 15
    if weak:
        if best.mean_conf < 0.6 or len(best.words) < 15:
            rot = _orientation_probe(gray, lang)
            if rot:
                rotated = pp.rotate90(gray, rot)
                rotated, angle2 = pp.deskew(rotated)
                rotated, _ = pp.remove_ruling_lines(rotated, (glyph or 22.0) * scale)
                words, mean = _run(rotated, lang)
                extra = [f"rotate {rot}deg"] + ([f"deskew {angle2:+.2f}deg"] if angle2 else [])
                candidate = _result(words, mean, rotated, f"rotate{rot}", steps + extra)
                if candidate.quality > best.quality:
                    best, gray, steps = candidate, rotated, steps + extra
                    best.rotate90 = rot
        for variant, image, psm in (("binarized", pp.binarize(gray), 6), ("psm4", gray, 4)):
            words, mean = _run(image, lang, psm=psm)
            candidate = _result(words, mean, image, f"{best.variant.split('+')[0]}+{variant}", steps + [variant])
            candidate.rotate90 = best.rotate90
            if candidate.quality > best.quality * 1.03:
                best = candidate

    best.duration_ms = int((time.perf_counter() - started) * 1000)
    return best
