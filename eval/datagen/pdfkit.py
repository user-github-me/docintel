"""reportlab helpers shared by the invoice templates."""
from __future__ import annotations

import io
from xml.sax.saxutils import escape

import reportlab.rl_config
from reportlab.graphics.shapes import Circle, Drawing, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import BaseDocTemplate, Frame, NextPageTemplate, PageTemplate, Paragraph

reportlab.rl_config.invariant = 1  # deterministic PDF bytes

BRAND_COLORS = ["#1f4e79", "#0f766e", "#6d28d9", "#b45309", "#be123c", "#1d4ed8", "#065f46",
                "#334155", "#9a3412", "#4338ca", "#0e7490", "#7f1d1d"]


def esc(text) -> str:
    return escape(str(text))


def P(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def PT(text: str, style: ParagraphStyle) -> Paragraph:
    """Paragraph from plain (escaped) text."""
    return Paragraph(esc(text), style)


def styles(font: str = "Helvetica", bold: str = "Helvetica-Bold", base: float = 9.0) -> dict[str, ParagraphStyle]:
    grey = colors.HexColor("#333333")
    return {
        "normal": ParagraphStyle("normal", fontName=font, fontSize=base, leading=base * 1.28),
        "small": ParagraphStyle("small", fontName=font, fontSize=base - 1.5, leading=(base - 1.5) * 1.3, textColor=grey),
        "tiny": ParagraphStyle("tiny", fontName=font, fontSize=base - 2.5, leading=(base - 2.5) * 1.3, textColor=grey),
        "bold": ParagraphStyle("bold", fontName=bold, fontSize=base, leading=base * 1.28),
        "label": ParagraphStyle("label", fontName=bold, fontSize=base - 1, leading=(base - 1) * 1.3, textColor=grey),
        "h1": ParagraphStyle("h1", fontName=bold, fontSize=base + 13, leading=(base + 13) * 1.15),
        "h2": ParagraphStyle("h2", fontName=bold, fontSize=base + 4, leading=(base + 4) * 1.2),
        "h3": ParagraphStyle("h3", fontName=bold, fontSize=base + 1.5, leading=(base + 1.5) * 1.25),
        "cell": ParagraphStyle("cell", fontName=font, fontSize=base - 0.5, leading=(base - 0.5) * 1.22),
        "right": ParagraphStyle("right", fontName=font, fontSize=base, leading=base * 1.28, alignment=TA_RIGHT),
        "right_bold": ParagraphStyle("right_bold", fontName=bold, fontSize=base, leading=base * 1.28, alignment=TA_RIGHT),
        "center": ParagraphStyle("center", fontName=font, fontSize=base, leading=base * 1.28, alignment=TA_CENTER),
        "center_small": ParagraphStyle("center_small", fontName=font, fontSize=base - 1.5, leading=(base - 1.5) * 1.3, alignment=TA_CENTER, textColor=grey),
        "center_bold": ParagraphStyle("center_bold", fontName=bold, fontSize=base + 1, leading=(base + 1) * 1.25, alignment=TA_CENTER),
        "left": ParagraphStyle("left", fontName=font, fontSize=base, leading=base * 1.28, alignment=TA_LEFT),
    }


def initials(name: str) -> str:
    words = [w for w in name.replace("&", " ").split() if w[:1].isalpha()]
    return "".join(w[0] for w in words[:2]).upper() or "CO"


def logo(text: str, color: str, shape: str = "square", size: float = 15 * mm) -> Drawing:
    d = Drawing(size, size)
    c = colors.HexColor(color)
    if shape == "circle":
        d.add(Circle(size / 2, size / 2, size / 2, fillColor=c, strokeColor=None))
    elif shape == "diamond":
        d.add(Polygon([size / 2, 0, size, size / 2, size / 2, size, 0, size / 2], fillColor=c, strokeColor=None))
    elif shape == "ring":
        d.add(Circle(size / 2, size / 2, size / 2, fillColor=None, strokeColor=c, strokeWidth=3))
        c = colors.HexColor(color)
    else:
        d.add(Rect(0, 0, size, size, rx=3, ry=3, fillColor=c, strokeColor=None))
    fill = c if shape == "ring" else colors.white
    d.add(String(size / 2, size / 2 - 4, text, fontName="Helvetica-Bold", fontSize=11, fillColor=fill, textAnchor="middle"))
    return d


def numbered_canvas(footer):
    """Canvas class that knows the total page count when drawing footers."""

    class _NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                if footer:
                    footer(self, self._pageNumber, total)
                super().showPage()
            super().save()

    return _NumberedCanvas


def _noop(canvas, doc):
    return None


def build_pdf(pagesize, margins, story, *, on_first=None, on_later=None, footer=None,
              first_top_extra: float = 0.0, later_top_extra: float = 8 * mm,
              left_extra: float = 0.0) -> bytes:
    """Render a platypus story with separate first/later page templates."""
    buf = io.BytesIO()
    lm, rm, tm, bm = margins
    W, H = pagesize
    doc = BaseDocTemplate(buf, pagesize=pagesize, leftMargin=lm, rightMargin=rm, topMargin=tm,
                          bottomMargin=bm, title="Invoice", author="", subject="", creator="")
    fw = W - lm - rm - left_extra
    f1 = Frame(lm + left_extra, bm, fw, H - tm - bm - first_top_extra, id="first",
               leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    f2 = Frame(lm + left_extra, bm, fw, H - tm - bm - later_top_extra, id="later",
               leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="first", frames=[f1], onPage=on_first or _noop),
        PageTemplate(id="later", frames=[f2], onPage=on_later or _noop),
    ])
    doc.build([NextPageTemplate("later")] + list(story), canvasmaker=numbered_canvas(footer))
    return buf.getvalue()


def frame_width(pagesize, margins, left_extra: float = 0.0) -> float:
    W, _ = pagesize
    lm, rm, _, _ = margins
    return W - lm - rm - left_extra


HEX = colors.HexColor
