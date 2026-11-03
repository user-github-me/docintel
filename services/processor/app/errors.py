"""Typed processing errors. `code` is a stable machine-readable value the API stores on the document."""
from __future__ import annotations


class ProcessingError(Exception):
    """A failure with a stable error code.

    retryable=False means retrying the same input cannot succeed (corrupt file, wrong password, ...),
    so the orchestrator should fail the job immediately instead of burning retries.
    """

    def __init__(self, code: str, message: str, status_code: int = 422, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable

    def to_dict(self) -> dict:
        return {"error_code": self.code, "message": scrub_paths(self.message), "retryable": self.retryable}


def scrub_paths(message: str) -> str:
    """Never leak server file-system paths in client-facing messages."""
    import re

    message = re.sub(r"'?(?:/[\w.\-]+){2,}/?'?", "<file>", message)
    return re.sub(r"[A-Za-z]:\\(?:[\w.\-]+\\?)+", "<file>", message)


# Stable codes (documented in docs/ARCHITECTURE.md)
FILE_NOT_FOUND = "file_not_found"
INVALID_PATH = "invalid_path"
EMPTY_FILE = "empty_file"
UNSUPPORTED_FORMAT = "unsupported_format"
CORRUPTED_FILE = "corrupted_file"
ENCRYPTED_PDF = "encrypted_pdf"
FILE_TOO_LARGE = "file_too_large"
TOO_MANY_PAGES = "too_many_pages"
IMAGE_TOO_LARGE = "image_too_large"
OCR_UNAVAILABLE = "ocr_unavailable"
