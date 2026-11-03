"""Test setup: isolated storage dir, repo fixtures, and small generated documents."""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

_STORAGE = Path(tempfile.mkdtemp(prefix="docintel-proc-test-"))
os.environ["STORAGE_DIR"] = str(_STORAGE)
os.environ.setdefault("EMBEDDING_PROVIDER", "hash")  # no model download in unit tests

import pymupdf  # noqa: E402
import pytest  # noqa: E402

def _fixtures_dir() -> Path:
    if os.environ.get("FIXTURES_DIR"):
        return Path(os.environ["FIXTURES_DIR"])
    here = Path(__file__).resolve()
    return here.parents[3] / "fixtures" if len(here.parents) > 3 else Path("/fixtures")


FIXTURES = _fixtures_dir()


def _copy_fixtures() -> None:
    target = _STORAGE / "fixtures"
    target.mkdir(parents=True, exist_ok=True)
    if FIXTURES.is_dir():
        for f in FIXTURES.iterdir():
            if f.is_file():
                shutil.copy(f, target / f.name)


_copy_fixtures()


@pytest.fixture(scope="session")
def storage() -> Path:
    return _STORAGE


def write(storage: Path, name: str, data: bytes) -> str:
    path = storage / "generated" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return f"generated/{name}"


def make_invoice_pdf(pages: int = 1, number: str = "INV-1001") -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), "ACME SUPPLIES LTD", fontsize=18)
        page.insert_text((400, 80), "INVOICE", fontsize=18)
        page.insert_text((60, 130), f"Invoice No: {number}", fontsize=11)
        page.insert_text((60, 150), "Invoice Date: 14/03/2026", fontsize=11)
        page.insert_text((60, 200), "Description", fontsize=11)
        page.insert_text((300, 200), "Qty", fontsize=11)
        page.insert_text((360, 200), "Unit Price", fontsize=11)
        page.insert_text((470, 200), "Amount", fontsize=11)
        page.insert_text((60, 222), "Home nursing visit", fontsize=11)
        page.insert_text((300, 222), "2", fontsize=11)
        page.insert_text((360, 222), "115.00", fontsize=11)
        page.insert_text((470, 222), "230.00", fontsize=11)
        page.insert_text((360, 270), "Total", fontsize=11)
        page.insert_text((470, 270), "230.00", fontsize=11)
        page.insert_text((470, 800), f"Page {i + 1} of {pages}", fontsize=9)
    return doc.tobytes()


def render_png(pdf_bytes: bytes, dpi: int = 200, rotate: int = 0) -> bytes:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    if rotate:
        page.set_rotation(rotate)
    return page.get_pixmap(dpi=dpi).tobytes("png")
