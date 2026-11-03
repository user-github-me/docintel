"""Image clean-up before OCR: scale normalisation, contrast stretch, denoise, deskew, binarisation.

Every step is measured first and only applied when the measurement says it helps, so clean
pages stay fast and poor scans get the heavier treatment.
"""
from __future__ import annotations

import cv2
import numpy as np

cv2.setNumThreads(1)  # we parallelise at the process level; avoid oversubscription

# Tesseract is most accurate when glyphs are ~25-35 px tall.
TARGET_GLYPH_PX = 28.0


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        gray = img
    elif img.shape[2] == 4:
        rgb = img[:, :, :3].astype(np.float32)
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        composited = rgb * alpha + 255.0 * (1 - alpha)  # flatten transparency onto white
        gray = cv2.cvtColor(composited.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    else:
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    if gray.dtype != np.uint8:
        gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    return gray


def estimate_glyph_height(gray: np.ndarray) -> float | None:
    """Median height of character-like connected components (in pixels)."""
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, _, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
    if n <= 1:
        return None
    hs = stats[1:, cv2.CC_STAT_HEIGHT]
    ws = stats[1:, cv2.CC_STAT_WIDTH]
    areas = stats[1:, cv2.CC_STAT_AREA]
    # ignore specks and rules: real glyphs are at least ~7 px tall at any OCR-able resolution
    mask = (hs >= 7) & (hs <= 150) & (ws <= hs * 2.5) & (ws >= 2) & (areas >= 20)
    if int(mask.sum()) < 25:
        return None
    return float(np.median(hs[mask]))


MAX_LONG_SIDE = 5200  # px; bigger images only slow Tesseract down


def choose_scale(glyph_h: float | None, shape: tuple[int, ...] | None = None) -> float:
    scale = 1.0
    if glyph_h is not None:
        if glyph_h < 20:
            scale = min(2.5, TARGET_GLYPH_PX / glyph_h)
        elif glyph_h > 70:
            scale = max(0.4, 40.0 / glyph_h)
    if shape is not None:
        longest = max(shape[:2])
        scale = min(scale, MAX_LONG_SIDE / max(longest, 1))
    return float(scale)


def resize(gray: np.ndarray, scale: float) -> np.ndarray:
    if abs(scale - 1.0) < 0.05:
        return gray
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(gray, None, fx=scale, fy=scale, interpolation=interp)


def stretch_contrast(gray: np.ndarray) -> tuple[np.ndarray, bool]:
    """Map the ink level to black and the paper level to white for faded / washed-out scans.

    Levels come from an Otsu split (median of each class), not from global percentiles: on a page
    where text covers <1% of pixels, low percentiles are still paper, and stretching on them would
    amplify grain instead of ink contrast.
    """
    thresh, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = gray[gray <= thresh]
    light = gray[gray > thresh]
    if dark.size < 0.0005 * gray.size or light.size == 0:
        return gray, False
    ink = float(np.median(dark))
    paper = float(np.median(light))
    if paper - ink >= 150 or paper <= ink + 20:
        return gray, False
    out = np.clip((gray.astype(np.float32) - ink) * (255.0 / (paper - ink)), 0, 255).astype(np.uint8)
    return out, True


def noise_sigma(gray: np.ndarray) -> float:
    """Immerkær's fast noise estimate (text edges inflate it slightly; relative values matter)."""
    h, w = gray.shape
    if h < 3 or w < 3:
        return 0.0
    kernel = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
    conv = cv2.filter2D(gray.astype(np.float32), -1, kernel)
    return float(np.sum(np.abs(conv)) * np.sqrt(0.5 * np.pi) / (6.0 * (w - 2) * (h - 2)))


def despeckle(gray: np.ndarray) -> np.ndarray:
    """3x3 median: removes salt-and-pepper specks (which Tesseract reads as junk glyphs) while
    keeping full stops and decimal points, which are larger than 2x2 px at OCR resolution."""
    return cv2.medianBlur(gray, 3)


def background_noise(gray: np.ndarray) -> float:
    """Robust paper-grain estimate: 1.4826 x MAD of the residual after a 5x5 median, on background
    pixels away from text. MAD ignores anti-aliased glyph edges, which a plain std-dev would
    mistake for noise (and then over-smooth clean pages, erasing decimal points)."""
    small = gray[::2, ::2] if max(gray.shape) > 2000 else gray
    thresh, ink = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    near_text = cv2.dilate(ink, np.ones((7, 7), np.uint8)) > 0
    background = (small > min(255, thresh + 10)) & ~near_text
    if background.sum() < 1000:
        return 0.0
    residual = small.astype(np.int16) - cv2.medianBlur(small, 5).astype(np.int16)
    values = residual[background]
    mad = float(np.median(np.abs(values - np.median(values))))
    return 1.4826 * mad


def denoise(gray: np.ndarray, grain: float) -> tuple[np.ndarray, str | None]:
    """Non-local means for grainy scans/photos (strength follows the measured grain)."""
    if grain >= 4.5:
        h = float(min(28.0, 3.0 + grain * 1.1))
        out = cv2.fastNlMeansDenoising(gray, None, h=h, templateWindowSize=7, searchWindowSize=21)
        return out, f"denoise:nlmeans(grain={grain:.1f})"
    return gray, None


def remove_isolated_specks(gray: np.ndarray, glyph_h: float | None) -> tuple[np.ndarray, int]:
    """Erase small dark blobs that are far from any real glyph.

    Size alone cannot separate specks from decimal points/full stops; proximity can: punctuation
    sits next to digits and letters, specks float in white space.
    """
    gh = glyph_h or 22.0
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(bw, connectivity=8)
    if n <= 2:
        return gray, 0
    areas = stats[:, cv2.CC_STAT_AREA]
    hs = stats[:, cv2.CC_STAT_HEIGHT]
    ws = stats[:, cv2.CC_STAT_WIDTH]
    small = (areas < max(8.0, 0.06 * gh * gh)) & (hs < 0.4 * gh) & (ws < 0.4 * gh)
    small[0] = False
    big = ~small
    big[0] = False
    big_mask = big.astype(np.uint8)[labels]
    # Neighbourhood is wide along the text line (decimal points / thousands separators sit up
    # to ~1 glyph-width from their digits in monospaced fonts) and short across lines.
    kx = int(max(5, gh * 2.0)) | 1
    ky = int(max(3, gh * 0.8)) | 1
    near = cv2.dilate(big_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, ky)))
    h, w = gray.shape
    cx = np.clip(centroids[:, 0].astype(int), 0, w - 1)
    cy = np.clip(centroids[:, 1].astype(int), 0, h - 1)
    isolated = small & (near[cy, cx] == 0)
    count = int(isolated.sum())
    if count == 0:
        return gray, 0
    out = gray.copy()
    out[isolated.astype(bool)[labels]] = 255
    return out, count


def _rotate(img: np.ndarray, angle: float, border: int = 255, interp: int = cv2.INTER_CUBIC) -> np.ndarray:
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(img, m, (w, h), flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=border)


def estimate_skew(gray: np.ndarray, max_angle: float = 6.0) -> float:
    """Projection-profile deskew: the correct angle makes text rows produce the sharpest profile."""
    h, w = gray.shape
    factor = min(1.0, 900.0 / max(w, 1))
    small = cv2.resize(gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA) if factor < 1 else gray
    _, bw = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if bw.mean() < 0.5:  # blank page
        return 0.0

    def score(angle: float) -> float:
        rotated = _rotate(bw, angle, border=0, interp=cv2.INTER_NEAREST)
        profile = rotated.sum(axis=1, dtype=np.float64)
        return float(np.sum(np.diff(profile) ** 2))

    coarse = np.arange(-max_angle, max_angle + 0.001, 0.5)
    best = max(coarse, key=score)
    fine = np.arange(best - 0.5, best + 0.501, 0.1)
    best = max(fine, key=score)
    return float(round(best, 2))


def deskew(gray: np.ndarray) -> tuple[np.ndarray, float]:
    angle = estimate_skew(gray)
    if abs(angle) < 0.2:
        return gray, 0.0
    return _rotate(gray, angle), angle


def remove_ruling_lines(gray: np.ndarray, glyph_h: float | None = None) -> tuple[np.ndarray, float]:
    """Erase thin table borders and separator rules.

    Gridded tables are the classic Tesseract failure: cell borders get merged into glyphs or make
    the engine drop whole table regions. Long horizontal/vertical runs are found with
    morphological opening (kernels far longer than any glyph stroke); thick filled areas (colour
    bands, logos) are excluded so only thin rules are painted white. Returns the cleaned image and
    the fraction of pixels removed; implausibly large masks (noise) are ignored.
    """
    h, w = gray.shape
    gh = glyph_h or 24.0
    thick = int(max(5, gh * 0.4))
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    horizontal = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, w // 30), 1)))
    horizontal = cv2.subtract(horizontal, cv2.morphologyEx(horizontal, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, thick))))
    vertical = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, h // 40))))
    vertical = cv2.subtract(vertical, cv2.morphologyEx(vertical, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (thick, 1))))
    lines = cv2.bitwise_or(horizontal, vertical)
    fraction = float(np.count_nonzero(lines)) / lines.size
    if fraction < 0.0005 or fraction > 0.06:
        return gray, 0.0
    lines = cv2.dilate(lines, np.ones((3, 3), np.uint8))
    out = gray.copy()
    out[lines > 0] = 255
    return out, fraction


def rotate90(gray: np.ndarray, degrees_clockwise: int) -> np.ndarray:
    degrees_clockwise %= 360
    if degrees_clockwise == 90:
        return cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
    if degrees_clockwise == 180:
        return cv2.rotate(gray, cv2.ROTATE_180)
    if degrees_clockwise == 270:
        return cv2.rotate(gray, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return gray


def binarize(gray: np.ndarray) -> np.ndarray:
    """Adaptive threshold copes with uneven lighting, shadows and faded print."""
    block = max(15, (min(gray.shape) // 40) | 1)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 15)
