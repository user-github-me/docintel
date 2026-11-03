"""Scan / photo simulation: rasterize PDF pages and degrade them realistically."""
from __future__ import annotations

import io

import numpy as np
import pymupdf
from PIL import Image, ImageFilter

from .util import Rng

LEVELS = ("clean", "light", "medium", "heavy")


def sample_degradation(level: str, rng: Rng, *, allow_rotate90: bool = False) -> dict:
    if level == "clean":
        p = dict(dpi=300, rotation_deg=0.0, rotate90=0, noise_sigma=0.0, blur=0.0, contrast=1.0, jpeg_quality=92, salt_pepper=0.0)
    elif level == "light":
        p = dict(dpi=rng.choice([200, 220, 250]), rotation_deg=round(rng.uniform(-1.0, 1.0), 2), rotate90=0,
                 noise_sigma=round(rng.uniform(3, 7), 1), blur=round(rng.uniform(0.3, 0.6), 2),
                 contrast=round(rng.uniform(0.9, 1.0), 2), jpeg_quality=rng.randint(80, 90),
                 salt_pepper=round(rng.uniform(0.0003, 0.001), 4))
    elif level == "medium":
        sign = -1 if rng.chance(0.5) else 1
        p = dict(dpi=rng.choice([150, 170, 200]), rotation_deg=round(sign * rng.uniform(1.5, 3.0), 2), rotate90=0,
                 noise_sigma=round(rng.uniform(9, 14), 1), blur=round(rng.uniform(0.6, 0.9), 2),
                 contrast=round(rng.uniform(0.75, 0.88), 2), jpeg_quality=rng.randint(60, 75),
                 salt_pepper=round(rng.uniform(0.001, 0.0025), 4))
    else:  # heavy
        sign = -1 if rng.chance(0.5) else 1
        p = dict(dpi=rng.choice([120, 135, 150, 150]), rotation_deg=round(sign * rng.uniform(2.5, 4.5), 2), rotate90=0,
                 noise_sigma=round(rng.uniform(14, 19), 1), blur=round(rng.uniform(0.8, 1.1), 2),
                 contrast=round(rng.uniform(0.62, 0.72), 2), jpeg_quality=rng.randint(40, 52),
                 salt_pepper=round(rng.uniform(0.0025, 0.004), 4))
        if allow_rotate90:
            p["rotate90"] = rng.choice([90, 180, 270])
    p["level"] = level
    return p


def rasterize(pdf_bytes: bytes, dpi: int) -> list[Image.Image]:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    for page in doc:
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
        pages.append(Image.frombytes("L", (pix.width, pix.height), pix.samples))
    return pages


def degrade(img: Image.Image, p: dict, rng: Rng) -> Image.Image:
    """Apply scanner-like artefacts. Positive angles rotate counter-clockwise."""
    nrng = np.random.default_rng(rng.randint(0, 2**32 - 1))
    if p["level"] == "clean":
        return img
    if p["rotation_deg"]:
        img = img.rotate(p["rotation_deg"], resample=Image.BICUBIC, expand=True, fillcolor=255)
    if p["blur"] > 0:
        img = img.filter(ImageFilter.GaussianBlur(p["blur"]))
    arr = np.asarray(img).astype(np.float32)
    # faded ink + slightly grey paper
    c = p["contrast"]
    paper = 255.0 - (6 if p["level"] == "light" else 14 if p["level"] == "medium" else 24)
    arr = paper - (paper - arr * (paper / 255.0)) * c
    if p["level"] == "heavy":
        h, w = arr.shape
        gy = np.linspace(0, 1, h, dtype=np.float32)[:, None]
        gx = np.linspace(0, 1, w, dtype=np.float32)[None, :]
        shade = 1.0 - 0.10 * (0.6 * gx + 0.4 * gy)  # uneven illumination
        arr = arr * shade
    if p["noise_sigma"] > 0:
        arr = arr + nrng.normal(0, p["noise_sigma"], arr.shape).astype(np.float32)
    sp = p["salt_pepper"]
    if sp > 0:
        mask = nrng.random(arr.shape)
        arr[mask < sp / 2] = 0
        arr[mask > 1 - sp / 2] = 255
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    out = Image.fromarray(arr, "L")
    if p.get("rotate90"):
        out = out.rotate(p["rotate90"], expand=True)
    return out


def jpeg_roundtrip(img: Image.Image, quality: int) -> Image.Image:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    return Image.open(buf).convert("L")


def jpeg_bytes(img: Image.Image, quality: int, dpi: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, dpi=(dpi, dpi))
    return buf.getvalue()


def scanned_pages(pdf_bytes: bytes, p: dict, rng: Rng) -> list[Image.Image]:
    return [degrade(im, p, rng.child("page", i)) for i, im in enumerate(rasterize(pdf_bytes, p["dpi"]))]


def images_to_pdf(images: list[Image.Image], p: dict, page_sizes_pt: list[tuple[float, float]] | None = None) -> bytes:
    """Image-only PDF (no text layer) - what a document scanner produces."""
    doc = pymupdf.open()
    for i, im in enumerate(images):
        data = jpeg_bytes(im, p["jpeg_quality"], p["dpi"])
        w_pt = im.width * 72.0 / p["dpi"]
        h_pt = im.height * 72.0 / p["dpi"]
        page = doc.new_page(width=w_pt, height=h_pt)
        page.insert_image(page.rect, stream=data)
    doc.set_metadata({"producer": "ScanSnap Manager", "creator": "Scanner"})
    out = doc.tobytes(garbage=3, deflate=True, no_new_id=True)
    doc.close()
    return out


def binarize(img: Image.Image, speckle: float = 0.0, seed: int = 0) -> Image.Image:
    """Scanner-style bilevel conversion: denoise, Otsu threshold, then sparse speckle."""
    arr = np.asarray(img.convert("L").filter(ImageFilter.MedianFilter(3)))
    hist = np.bincount(arr.ravel(), minlength=256).astype(np.float64)
    total = arr.size
    sum_all = np.dot(np.arange(256), hist)
    w_b = sum_b = 0.0
    best, thr = -1.0, 128
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b, m_f = sum_b / w_b, (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best, thr = between, t
    out = np.where(arr > thr, 255, 0).astype(np.uint8)
    if speckle > 0:
        rnd = np.random.default_rng(seed).random(out.shape)
        out[rnd < speckle / 4] = 0
    return Image.fromarray(out, "L").convert("1")


def save_image(images: list[Image.Image], fmt: str, p: dict) -> bytes:
    """jpg/png/tiff bytes. PNG/TIFF get a JPEG round-trip first (scanner pipelines often do)."""
    buf = io.BytesIO()
    dpi = (p["dpi"], p["dpi"])
    if fmt == "jpg":
        images[0].save(buf, format="JPEG", quality=p["jpeg_quality"], optimize=True, dpi=dpi)
    elif fmt == "png":
        im = images[0] if p["level"] == "clean" else jpeg_roundtrip(images[0], p["jpeg_quality"])
        im.save(buf, format="PNG", optimize=True, dpi=dpi)
    elif fmt == "tiff":
        frames = [im if p["level"] == "clean" else jpeg_roundtrip(im, p["jpeg_quality"]) for im in images]
        if p["level"] == "heavy":
            # fax-style bilevel G4 TIFF
            frames = [binarize(f, p["salt_pepper"], seed=i) for i, f in enumerate(frames)]
            frames[0].save(buf, format="TIFF", compression="group4", save_all=True, append_images=frames[1:], dpi=dpi)
        else:
            frames[0].save(buf, format="TIFF", compression="tiff_lzw", save_all=True, append_images=frames[1:], dpi=dpi)
    else:
        raise ValueError(fmt)
    return buf.getvalue()
