"""Resolve storage keys to files, refusing anything outside STORAGE_DIR (path traversal guard)."""
from __future__ import annotations

from pathlib import Path, PurePosixPath

from .config import get_settings
from .errors import FILE_NOT_FOUND, INVALID_PATH, ProcessingError


def resolve_storage_key(storage_key: str) -> Path:
    if not storage_key or "\x00" in storage_key:
        raise ProcessingError(INVALID_PATH, "storage_key is empty or invalid", 400)
    key = PurePosixPath(storage_key.replace("\\", "/"))
    if key.is_absolute() or any(part in ("..", "") for part in key.parts):
        raise ProcessingError(INVALID_PATH, "storage_key must be a relative path inside the storage root", 400)
    base = get_settings().storage_dir
    path = (base / Path(*key.parts)).resolve()
    if not path.is_relative_to(base):
        raise ProcessingError(INVALID_PATH, "storage_key escapes the storage root", 400)
    if not path.is_file():
        raise ProcessingError(FILE_NOT_FOUND, f"file not found: {storage_key}", 404)
    return path
