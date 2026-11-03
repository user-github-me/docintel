"""Corrupted / unreadable inputs used to test graceful failure handling."""
from __future__ import annotations

import numpy as np
import pymupdf

from .util import Rng


def _pdf_opens_with_pages(data: bytes) -> bool:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
        return doc.page_count > 0
    except Exception:
        return False


def truncated_pdf(valid_pdf: bytes) -> bytes:
    """Cut the file short enough that MuPDF cannot open it / finds no pages (download interrupted)."""
    pymupdf.TOOLS.mupdf_display_errors(False)
    try:
        for frac in (0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.12, 0.1, 0.08):
            cut = valid_pdf[: int(len(valid_pdf) * frac)]
            if not _pdf_opens_with_pages(cut):
                return cut
        return valid_pdf[:200]
    finally:
        pymupdf.TOOLS.mupdf_display_errors(True)


def random_bytes(rng: Rng, n: int = 24_000) -> bytes:
    gen = np.random.default_rng(rng.randint(0, 2**32 - 1))
    data = gen.integers(0, 256, size=n, dtype=np.uint8).tobytes()
    # make sure it does not accidentally start with a known signature
    return b"\x13\x37" + data[2:]


def truncated_png(valid_png: bytes) -> bytes:
    """PNG signature + partial IHDR: cannot even be identified/decoded."""
    return valid_png[:24]


def broken_zip(valid_zip: bytes) -> bytes:
    """Drop the central directory (end of file) of an xlsx container."""
    return valid_zip[: int(len(valid_zip) * 0.6)]


def garbage_text_xlsx(rng: Rng) -> bytes:
    lines = ["This file was exported incorrectly and is not a spreadsheet.",
             "Invoice register export failed: connection reset by peer",
             "".join(rng.choice("abcdefghijklmnopqrstuvwxyz0123456789 ") for _ in range(400))]
    return ("\n".join(lines) * 20).encode("utf-8")


def encrypted_pdf(valid_pdf: bytes, user_pw: str = "invoice2026") -> bytes:
    doc = pymupdf.open(stream=valid_pdf, filetype="pdf")
    data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner-" + user_pw, user_pw=user_pw,
                       permissions=int(pymupdf.PDF_PERM_PRINT), no_new_id=True)
    doc.close()
    return data


def html_document(title: str, body_lines: list[str]) -> bytes:
    body = "\n".join(f"<p>{line}</p>" for line in body_lines)
    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:Arial;margin:40px}} h1{{color:#1f4e79}}</style></head>
<body><h1>{title}</h1>
{body}
<p>To download the PDF version, please sign in to the supplier portal.</p>
</body></html>
"""
    return html.encode("utf-8")


def binary_garbage_csv(rng: Rng) -> bytes:
    gen = np.random.default_rng(rng.randint(0, 2**32 - 1))
    data = bytearray(gen.integers(0, 256, size=8_000, dtype=np.uint8).tobytes())
    for i in range(0, len(data), 37):
        data[i] = 0  # NUL bytes: definitely not text
    return b"\x00\x01" + bytes(data)
