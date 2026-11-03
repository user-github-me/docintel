"""Content-based file type detection (magic bytes), independent of the file extension.

Rules:
- The content decides the pipeline. A PNG saved as `.jpg` is processed as an image (with a warning).
- A file whose extension is a supported type but whose content matches nothing we can parse is
  `corrupted_file`; anything else unrecognised is `unsupported_format`.
"""
from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from .errors import CORRUPTED_FILE, EMPTY_FILE, UNSUPPORTED_FORMAT, ProcessingError

SUPPORTED_EXTENSIONS = {
    ".pdf": "pdf",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".tif": "image",
    ".tiff": "image",
    ".xlsx": "xlsx",
    ".xlsm": "xlsx",
    ".xls": "xls",
    ".csv": "csv",
    ".tsv": "csv",
    ".txt": "csv",
}

OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


@dataclass
class Detected:
    file_type: str  # pdf | image | xlsx | xls | csv
    mime: str
    image_format: str | None = None
    warnings: list[str] = field(default_factory=list)


def _looks_like_text(head: bytes) -> bool:
    if not head:
        return False
    if b"\x00" in head:
        # UTF-16 text has NULs; we do not accept UTF-16 CSVs unless BOM-marked
        return head.startswith((b"\xff\xfe", b"\xfe\xff"))
    sample = head[:8192]
    for encoding in ("utf-8", "cp1252", "latin-1"):
        try:
            text = sample.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - latin-1 always decodes
        return False
    printable = sum(ch.isprintable() or ch in "\r\n\t" for ch in text)
    return printable / max(len(text), 1) > 0.95


def _looks_like_markup(head: bytes) -> bool:
    lowered = head[:512].lstrip().lower()
    return lowered.startswith((b"<!doctype html", b"<html", b"<?xml", b"<svg"))


def detect_file_type(path: Path, original_name: str | None = None) -> Detected:
    size = path.stat().st_size
    if size == 0:
        raise ProcessingError(EMPTY_FILE, "The file is empty (0 bytes).")

    ext = Path(original_name or path.name).suffix.lower()
    expected = SUPPORTED_EXTENSIONS.get(ext)
    with path.open("rb") as fh:
        head = fh.read(8192)

    detected: Detected | None = None
    if b"%PDF-" in head[:1024]:
        detected = Detected("pdf", "application/pdf")
    elif head.startswith(b"\x89PNG\r\n\x1a\n"):
        detected = Detected("image", "image/png", "png")
    elif head.startswith(b"\xff\xd8\xff"):
        detected = Detected("image", "image/jpeg", "jpeg")
    elif head[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        detected = Detected("image", "image/tiff", "tiff")
    elif head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as zf:
                names = set(zf.namelist())
        except zipfile.BadZipFile as exc:
            raise ProcessingError(CORRUPTED_FILE, f"The ZIP container is damaged: {exc}") from exc
        if "xl/workbook.xml" in names:
            detected = Detected("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        elif expected == "xlsx":
            raise ProcessingError(CORRUPTED_FILE, "ZIP archive does not contain an Excel workbook (xl/workbook.xml).")
        else:
            raise ProcessingError(UNSUPPORTED_FORMAT, "ZIP-based document that is not an Excel workbook.")
    elif head.startswith(OLE2_MAGIC):
        detected = Detected("xls", "application/vnd.ms-excel")
    elif _looks_like_text(head) and not _looks_like_markup(head) and expected in (None, "csv"):
        detected = Detected("csv", "text/csv")

    if detected is None:
        if expected is not None:
            raise ProcessingError(
                CORRUPTED_FILE,
                f"The file has a '{ext}' extension but its content is not a readable {expected.upper()} file.",
            )
        raise ProcessingError(UNSUPPORTED_FORMAT, f"Unsupported file type '{ext or 'unknown'}'.")

    if expected is not None and expected != detected.file_type:
        detected.warnings.append(
            f"extension_mismatch: file is named '{ext}' but content is {detected.file_type}; processed as {detected.file_type}"
        )
    elif expected == "image" and detected.image_format and ext not in _IMAGE_EXTS[detected.image_format]:
        detected.warnings.append(
            f"extension_mismatch: file is named '{ext}' but content is {detected.image_format.upper()}"
        )
    return detected


_IMAGE_EXTS = {"png": {".png"}, "jpeg": {".jpg", ".jpeg"}, "tiff": {".tif", ".tiff"}}
