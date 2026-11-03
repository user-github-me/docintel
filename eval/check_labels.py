#!/usr/bin/env python3
"""QA for generated ground truth: every labeled value must actually be present in the document.

Checks (per invoice) for digital PDFs, spreadsheets and CSVs:
  * invoice_number, supplier_name, customer_name appear verbatim (whitespace-normalised)
  * subtotal / tax / discount / shipping / total and every line-item amount appear in the
    document's own number format (or as a numeric cell for spreadsheets)
  * invoice_date appears in the document's date format (or as a date cell)
Scanned PDFs/images have no text layer and are skipped (their labels come from the same specs).

    uv run python check_labels.py data            # labels.jsonl + generation_meta.jsonl
    uv run python check_labels.py ../fixtures      # labels.json
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import warnings
from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)
sys.path.insert(0, str(Path(__file__).resolve().parent))

import openpyxl  # noqa: E402
import pymupdf  # noqa: E402
import xlrd  # noqa: E402

from datagen.formats import NUMBER_FORMATS, fmt_amount, fmt_date  # noqa: E402

WS = re.compile(r"\s+")


def norm(s: str) -> str:
    return WS.sub(" ", s).strip()


def load(root: Path):
    if (root / "labels.jsonl").exists():
        labels = [json.loads(l) for l in (root / "labels.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
        meta_path = root / "generation_meta.jsonl"
    else:
        labels = json.loads((root / "labels.json").read_text(encoding="utf-8"))
        meta_path = root / "_generation_meta.jsonl"
    meta = {}
    if meta_path.exists():
        for line in meta_path.read_text(encoding="utf-8").splitlines():
            m = json.loads(line)
            meta[m["doc_id"]] = m
    recon = root / "reconciliation" / "reconciliation_labels.json"
    if recon.exists():
        for pair in json.loads(recon.read_text(encoding="utf-8")):
            labels.append(pair["left"])
            labels.append(pair["right"])
    return labels, meta


class Content:
    """Searchable view of a document: normalised text + numeric/date cell values."""

    def __init__(self, text: str, numbers: set[Decimal] | None = None, dates: set[date] | None = None):
        self.text = norm(text)
        self.numbers = numbers or set()
        self.dates = dates or set()


def pdf_content(path: Path) -> Content:
    doc = pymupdf.open(path)
    return Content("\n".join(p.get_text() for p in doc))


def xlsx_content(path: Path) -> Content:
    wb = openpyxl.load_workbook(path, data_only=True)
    texts, nums, dts = [], set(), set()
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for v in row:
                if v is None:
                    continue
                if isinstance(v, datetime):
                    dts.add(v.date())
                elif isinstance(v, date):
                    dts.add(v)
                elif isinstance(v, (int, float)):
                    nums.add(Decimal(str(round(v, 2))).quantize(Decimal("0.01")))
                texts.append(str(v))
    return Content(" | ".join(texts), nums, dts)


def xls_content(path: Path) -> Content:
    book = xlrd.open_workbook(str(path))
    texts, nums, dts = [], set(), set()
    for sh in book.sheets():
        for r in range(sh.nrows):
            for c in range(sh.ncols):
                cell = sh.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    dts.add(xlrd.xldate.xldate_as_datetime(cell.value, book.datemode).date())
                elif cell.ctype == xlrd.XL_CELL_NUMBER:
                    nums.add(Decimal(str(round(cell.value, 2))).quantize(Decimal("0.01")))
                    texts.append(str(cell.value))
                elif cell.ctype == xlrd.XL_CELL_TEXT:
                    texts.append(cell.value)
    return Content(" | ".join(texts), nums, dts)


def csv_content(path: Path, meta: dict) -> Content:
    raw = path.read_bytes()
    text = raw.decode(meta.get("encoding", "utf-8"))
    rows = list(csv.reader(io.StringIO(text), delimiter=meta.get("delimiter", ",")))
    return Content(" | ".join(" | ".join(r) for r in rows))


def amount_variants(value: str, nfs: set[str]) -> list[str]:
    d = Decimal(value)
    out = []
    for nf in nfs:
        base = nf.replace("_symbol", "") if nf.endswith("_symbol") else nf
        if base not in NUMBER_FORMATS:
            base = "us"
        s = fmt_amount(abs(d), base)
        out.append(s)
    return out


def date_variants(iso: str, dfs: set[str]) -> list[str]:
    d = date.fromisoformat(iso)
    return [fmt_date(d, df) for df in dfs]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    labels, meta = load(root)
    stats = defaultdict(Counter)
    failures = []
    skipped = Counter()
    for lab in labels:
        if lab["expect_failure"]:
            skipped["expected_failure"] += 1
            continue
        m = meta.get(lab["doc_id"], {})
        if m.get("scanned") or (lab["degradation"] is not None):
            skipped["scanned/image"] += 1
            continue
        path = root / lab["file"]
        ft = lab["file_type"]
        if ft == "pdf":
            content = pdf_content(path)
        elif ft == "xlsx":
            content = xlsx_content(path)
        elif ft == "xls":
            content = xls_content(path)
        elif ft == "csv":
            content = csv_content(path, m)
        else:
            skipped[ft] += 1
            continue
        inv_meta = m.get("invoices", [{}] * len(lab["invoices"]))
        doc_nf = {m["number_format"]} if "number_format" in m else set()
        doc_df = {m["date_format"]} if "date_format" in m else set()
        for i, inv in enumerate(lab["invoices"]):
            im = inv_meta[i] if i < len(inv_meta) else {}
            nfs = set(doc_nf) or {im.get("number_format", "us")}
            if ft in ("pdf",):
                nfs = {im.get("number_format", "us")}
            dfs = set(doc_df) or {im.get("date_format", "iso")}
            cat = lab["category"]

            def check(kind: str, ok: bool, detail: str):
                stats[cat][kind + ("_ok" if ok else "_fail")] += 1
                if not ok:
                    failures.append(f"{lab['doc_id']} inv#{i} {kind}: {detail}")

            for field in ("invoice_number", "supplier_name", "customer_name"):
                v = inv[field]
                if v is not None:
                    check(field, norm(v) in content.text, repr(v))
            for field in ("subtotal", "tax", "discount", "shipping", "total"):
                v = inv[field]
                if v is None:
                    continue
                ok = any(s in content.text for s in amount_variants(v, nfs)) or \
                    Decimal(v).copy_abs() in {n.copy_abs() for n in content.numbers}
                check("amount", ok, f"{field}={v} formats={sorted(nfs)}")
            for li in inv["line_items"]:
                ok = any(s in content.text for s in amount_variants(li["amount"], nfs)) or \
                    Decimal(li["amount"]).copy_abs() in {n.copy_abs() for n in content.numbers}
                check("line_amount", ok, f"{li['amount']} ({li['description'][:30]})")
                check("line_description", norm(li["description"]) in content.text, li["description"][:40])
            if inv["invoice_date"]:
                d = date.fromisoformat(inv["invoice_date"])
                ok = d in content.dates or any(s in content.text for s in date_variants(inv["invoice_date"], dfs))
                check("invoice_date", ok, f"{inv['invoice_date']} formats={sorted(dfs)}")
    total_ok = sum(v for c in stats.values() for k, v in c.items() if k.endswith("_ok"))
    total_fail = sum(v for c in stats.values() for k, v in c.items() if k.endswith("_fail"))
    print(f"checked values: {total_ok + total_fail}   passed: {total_ok}   failed: {total_fail}")
    for cat, c in sorted(stats.items()):
        ok = sum(v for k, v in c.items() if k.endswith("_ok"))
        bad = sum(v for k, v in c.items() if k.endswith("_fail"))
        print(f"  {cat:<20} {ok:>6} ok  {bad:>4} failed  ({100.0 * ok / max(1, ok + bad):.1f}%)")
    print(f"skipped documents: {dict(skipped)}")
    for f in failures[:40]:
        print("  FAIL", f)
    rate = 100.0 * total_ok / max(1, total_ok + total_fail)
    print(f"PASS RATE: {rate:.2f}%")
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
