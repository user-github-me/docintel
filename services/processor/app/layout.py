"""Rebuild reading-order text lines from positioned words (PDF text layer or OCR boxes).

The output keeps horizontal alignment (similar to `pdftotext -layout`): words are placed at a
character column proportional to their x position, and wide gaps become 2+ spaces. Downstream
extractors rely on this to read tables ("Description   Qty   Price   Amount") and
label-above-value blocks, and the LLM reads tables far better from aligned text than from a
flattened word stream.
"""
from __future__ import annotations

from dataclasses import dataclass
from statistics import median


@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    conf: float | None = None  # 0..1 for OCR words, None for text-layer words

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return max(self.y1 - self.y0, 0.1)


@dataclass
class Line:
    text: str
    bbox: tuple[float, float, float, float]  # normalised 0..1 (x0, y0, x1, y1)
    conf: float | None

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "bbox": [round(v, 4) for v in self.bbox],
            "conf": None if self.conf is None else round(self.conf, 3),
        }


MAX_COLUMNS = 220


def _group_into_rows(words: list[Word], med_h: float) -> list[list[Word]]:
    """Cluster words into visual rows by vertical centre.

    The tolerance is relative to the *smaller* glyph height, so a large title never swallows the
    small-print address line printed beside it, while mixed font sizes on one baseline (bold
    totals, larger amounts) and slight OCR skew still join the same row.
    """
    words = sorted(words, key=lambda w: (w.cy, w.x0))
    rows: list[list[Word]] = []
    row_cy = row_h = 0.0
    for w in words:
        if rows and abs(w.cy - row_cy) <= 0.45 * min(w.h, row_h):
            row = rows[-1]
            row.append(w)
            row_cy += (w.cy - row_cy) / len(row)
            row_h = median(x.h for x in row)
            continue
        rows.append([w])
        row_cy, row_h = w.cy, w.h
    return rows


def build_lines(words: list[Word], page_width: float, page_height: float) -> list[Line]:
    words = [w for w in words if w.text and w.text.strip()]
    if not words or page_width <= 0 or page_height <= 0:
        return []

    med_h = median(w.h for w in words)
    char_widths = [(w.x1 - w.x0) / len(w.text) for w in words if len(w.text) >= 2 and w.x1 > w.x0]
    char_w = median(char_widths) if char_widths else med_h * 0.5
    char_w = max(char_w, 0.5)
    # Very wide pages would produce enormous lines; compress the column scale if needed.
    scale = max(1.0, (page_width / char_w) / MAX_COLUMNS)
    col_w = char_w * scale

    lines: list[Line] = []
    prev_bottom: float | None = None
    for row in _group_into_rows(words, med_h):
        row.sort(key=lambda w: w.x0)
        parts: list[str] = []
        col = 0
        prev: Word | None = None
        for w in row:
            target = int(round(w.x0 / col_w))
            if prev is None:
                pad = target
            else:
                gap_px = w.x0 - prev.x1
                # A word space scales with the font: compare against the local glyph height so
                # large letterhead type is not split into columns (and body text still is).
                local_h = max(min(prev.h, w.h), 0.6 * max(prev.h, w.h))
                if gap_px < max(1.2 * char_w, 1.25 * local_h):
                    pad = 1
                else:
                    pad = max(2, target - col)
            parts.append(" " * pad + w.text)
            col += pad + len(w.text)
            prev = w
        text = "".join(parts).rstrip()

        top = min(w.y0 for w in row)
        bottom = max(w.y1 for w in row)
        # Blank line between visually separated blocks helps segment headers / tables / totals.
        if prev_bottom is not None and top - prev_bottom > 1.3 * med_h:
            lines.append(Line("", (0.0, 0.0, 0.0, 0.0), None))
        prev_bottom = bottom

        confs = [w.conf for w in row if w.conf is not None]
        weights = [len(w.text) for w in row if w.conf is not None]
        conf = (sum(c * k for c, k in zip(confs, weights)) / sum(weights)) if confs else None
        bbox = (
            max(0.0, min(w.x0 for w in row) / page_width),
            max(0.0, top / page_height),
            min(1.0, max(w.x1 for w in row) / page_width),
            min(1.0, bottom / page_height),
        )
        lines.append(Line(text, bbox, conf))
    return lines


def unrotate_lines(lines: list[Line], rotate90: int) -> list[Line]:
    """Map normalised boxes from the upright (OCR) frame back to the original image orientation, so
    evidence highlights land on the right spot of the page image the user sees."""
    r = rotate90 % 360
    if not r:
        return lines
    out = []
    for ln in lines:
        x0, y0, x1, y1 = ln.bbox
        if ln.text and r == 90:
            box = (y0, 1 - x1, y1, 1 - x0)
        elif ln.text and r == 180:
            box = (1 - x1, 1 - y1, 1 - x0, 1 - y0)
        elif ln.text and r == 270:
            box = (1 - y1, x0, 1 - y0, x1)
        else:
            box = ln.bbox
        out.append(Line(ln.text, box, ln.conf))
    return out


def lines_to_text(lines: list[Line]) -> str:
    return "\n".join(line.text for line in lines)
