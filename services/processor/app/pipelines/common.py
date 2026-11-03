"""Shared result types for all pipelines."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..layout import Line, lines_to_text


@dataclass
class PageResult:
    page_number: int
    method: str  # text | ocr | empty | error
    lines: list[Line] = field(default_factory=list)
    ocr_confidence: float | None = None
    width: float = 0.0
    height: float = 0.0
    warnings: list[str] = field(default_factory=list)
    ocr_steps: list[str] = field(default_factory=list)
    duration_ms: int = 0

    @property
    def text(self) -> str:
        return lines_to_text(self.lines)

    def to_dict(self) -> dict:
        text = self.text
        return {
            "page_number": self.page_number,
            "method": self.method,
            "text": text,
            "char_count": len(text.replace(" ", "")),
            "lines": [ln.to_dict() for ln in self.lines if ln.text],
            "ocr_confidence": None if self.ocr_confidence is None else round(self.ocr_confidence, 4),
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "warnings": self.warnings,
            "ocr_steps": self.ocr_steps,
            "duration_ms": self.duration_ms,
        }
