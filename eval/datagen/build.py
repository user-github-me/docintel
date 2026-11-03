"""Dataset assembly: profiles, categories, anomaly scheduling, labels and manifest."""
from __future__ import annotations

import copy
import io
import json
import time
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import openpyxl
import pymupdf
from PIL import Image

from . import corrupt, sheets
from .content import InvoiceSpec, apply_totals
from .factory import ANOMALIES, InvoiceFactory
from .labels import doc_label, invoice_label
from .scan import images_to_pdf, sample_degradation, save_image, scanned_pages, LEVELS
from .templates import TEMPLATE_INFO, render
from .util import D, Rng, q2

DEV = ["T1", "T2", "T3", "T4", "T5", "T6"]
HELDOUT = ["T7", "T8"]
ALL_T = DEV + HELDOUT
REGISTER_ANOMALIES = ["total_mismatch", "missing_invoice_number", "missing_date", "missing_tax",
                      "negative_amount", "future_date", "duplicate_invoice"]
DOC_ANOMALIES = ANOMALIES + ["duplicate_invoice"]


def split_of(template: str) -> str:
    return TEMPLATE_INFO[template]["split"] if template in TEMPLATE_INFO else "dev"


def page_count(pdf: bytes) -> int:
    return pymupdf.open(stream=pdf, filetype="pdf").page_count


class DatasetBuilder:
    def __init__(self, out: Path, profile: str, seed: int = 42, perf_pages: int = 1000,
                 perf_scanned_pages: int = 100, anomaly_rate: float = 0.15):
        self.out = out
        self.profile = profile
        self.seed = seed
        self.flat = profile == "fixtures"
        self.files_dir = out if self.flat else out / "files"
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.factory = InvoiceFactory(seed)
        self.labels: list[dict] = []
        self.meta: list[dict] = []
        self.recon: list[dict] = []
        self.pool: list[tuple[InvoiceSpec, str]] = []
        self.counters: Counter = Counter()
        self.anomaly_rate = anomaly_rate
        self.perf_pages = perf_pages
        self.perf_scanned_pages = perf_scanned_pages
        self._anom_rng = Rng.seeded(seed, profile, "anomalies")
        self._anom_queue: dict[str, list[str]] = defaultdict(list)

    # ------------------------------------------------------------------ infra
    def rng(self, *parts) -> Rng:
        return Rng.seeded(self.seed, self.profile, *parts)

    def next_id(self, category: str, template: str | None) -> str:
        key = f"{category}-{template or 'NA'}"
        self.counters[key] += 1
        return f"{key}-{self.counters[key]:04d}"

    def write(self, name: str, data: bytes) -> str:
        (self.files_dir / name).write_bytes(data)
        return name if self.flat else f"files/{name}"

    def pick_anomaly(self, category: str, allowed: list[str], template: str | None = None) -> str | None:
        if self.anomaly_rate <= 0 or self._anom_rng.random() >= self.anomaly_rate:
            return None
        allowed = list(allowed)
        if "duplicate_invoice" in allowed and not self._pool_candidates(template):
            allowed.remove("duplicate_invoice")
        q = self._anom_queue[category]
        for _ in range(2):
            for i, a in enumerate(q):
                if a in allowed:
                    return q.pop(i)
            fresh = list(DOC_ANOMALIES)
            self._anom_rng.shuffle(fresh)
            q.extend(fresh)
        return None

    def _pool_candidates(self, template: str | None, plain_only: bool = False):
        return [(s, d) for s, d in self.pool if (template is None or s.template == template)
                and not (plain_only and (s.discount or s.shipping))]

    def take_from_pool(self, template: str | None, rng: Rng, plain_only: bool = False) -> InvoiceSpec | None:
        cands = self._pool_candidates(template, plain_only)
        if not cands:
            return None
        spec, _ = rng.choice(cands)
        self.pool = [(s, d) for s, d in self.pool if s is not spec]  # each original duplicated at most once
        return self.factory.duplicate_of(spec)

    def remember(self, spec: InvoiceSpec, doc_id: str) -> None:
        if spec.invoice_number and not spec.anomalies:
            self.pool.append((spec, doc_id))

    def new_spec(self, template: str, rng: Rng, category: str, *, allowed: list[str] | None = None,
                 n_items: int | None = None, extras: bool = True, **kw) -> InvoiceSpec:
        anomaly = self.pick_anomaly(category, allowed if allowed is not None else DOC_ANOMALIES, template)
        if anomaly == "duplicate_invoice":
            dup = self.take_from_pool(template, rng)
            if dup is not None:
                return dup
            anomaly = None
        return self.factory.make(template, rng, n_items=n_items, anomaly=anomaly, extras=extras, **kw)

    def add(self, label: dict, meta: dict | None = None, recon: bool = False) -> None:
        if not recon:
            self.labels.append(label)
        m = {"doc_id": label["doc_id"]}
        m.update(meta or {})
        self.meta.append(m)

    @staticmethod
    def spec_meta(spec: InvoiceSpec) -> dict:
        return {"template": spec.template, "locale": spec.locale.code,
                "number_format": spec.locale.number_format,
                "date_format": spec.extra.get("date_format") or spec.locale.date_format}

    # ------------------------------------------------------------------ single-invoice documents
    def single_doc(self, category: str, template: str, *, level: str | None = None, fmt: str = "pdf",
                   n_items: int | None = None, allow_rotate90: bool = False, name_hint: str | None = None,
                   anomalies_allowed: list[str] | None = None) -> dict:
        doc_id = self.next_id(category, template)
        rng = self.rng(doc_id)
        allowed = anomalies_allowed
        if allowed is None:
            allowed = [a for a in DOC_ANOMALIES if not (category == "pdf_digital" and a == "duplicate_invoice")]
        spec = self.new_spec(template, rng, category, allowed=allowed, n_items=n_items)
        pdf = render(spec, rng)
        n_pages = page_count(pdf)
        degradation = None
        if category == "pdf_digital":
            data, ext, ftype = pdf, "pdf", "pdf"
        else:
            degradation = sample_degradation(level, rng, allow_rotate90=allow_rotate90)
            pages = scanned_pages(pdf, degradation, rng)
            if category == "pdf_scanned" or fmt == "pdf":
                data, ext, ftype = images_to_pdf(pages, degradation), "pdf", "pdf"
            else:
                if fmt in ("jpg", "png") and len(pages) > 1:
                    raise RuntimeError(f"{doc_id}: multi-page invoice cannot be stored as {fmt}")
                data, ext, ftype = save_image(pages, fmt, degradation), fmt, "image"
        fname = f"{name_hint or doc_id}.{ext}"
        rel = self.write(fname, data)
        inv = invoice_label(spec, pages=list(range(1, n_pages + 1)))
        label = doc_label(doc_id=name_hint or doc_id, file=rel, file_type=ftype, category=category, template=template,
                          split=split_of(template), degradation=degradation, invoices=[inv])
        self.add(label, {"scanned": category != "pdf_digital", "invoices": [self.spec_meta(spec)]})
        self.remember(spec, label["doc_id"])
        return label

    # ------------------------------------------------------------------ multi-invoice PDFs
    def compose(self, specs: list[InvoiceSpec], rngs: list[Rng]) -> tuple[bytes, list[list[int]]]:
        merged = pymupdf.open()
        ranges = []
        for spec, r in zip(specs, rngs):
            src = pymupdf.open(stream=render(spec, r), filetype="pdf")
            start = merged.page_count + 1
            merged.insert_pdf(src)
            ranges.append(list(range(start, merged.page_count + 1)))
        data = merged.tobytes(garbage=3, deflate=True, no_new_id=True)
        return data, ranges

    def scan_pdf(self, pdf: bytes, level: str, rng: Rng) -> tuple[bytes, dict]:
        p = sample_degradation(level, rng)
        doc = pymupdf.open(stream=pdf, filetype="pdf")
        images = []
        for i, page in enumerate(doc):
            pp = dict(p)
            pp["rotation_deg"] = round(p["rotation_deg"] + rng.uniform(-0.6, 0.6), 2) if level != "clean" else 0.0
            pix = page.get_pixmap(dpi=p["dpi"], colorspace=pymupdf.csGRAY, alpha=False)
            img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
            from .scan import degrade
            images.append(degrade(img, pp, rng.child("p", i)))
        return images_to_pdf(images, p), p

    def multi_doc(self, category: str, n: int, templates: list[str], *, scanned_level: str | None = None,
                  internal_duplicate: bool = False, long_prob: float = 0.25, name_hint: str | None = None,
                  split: str | None = None) -> dict:
        tag = "mixed"
        doc_id = name_hint or self.next_id(category, tag)
        rng = self.rng(doc_id)
        specs, rngs = [], []
        for i in range(n):
            t = rng.choice(templates)
            long = TEMPLATE_INFO[t]["multipage"] and rng.chance(long_prob)
            r = rng.child("inv", i)
            allowed = [a for a in DOC_ANOMALIES if a != "duplicate_invoice"]
            spec = self.new_spec(t, r, category, allowed=allowed, n_items=r.randint(24, 34) if long else None)
            specs.append(spec)
            rngs.append(r)
        if internal_duplicate and len(specs) > 3:
            j = rng.randint(0, len(specs) // 2)
            src = next((s for s in specs[j:] if s.invoice_number and not s.anomalies), None)
            if src is not None:
                dup = self.factory.duplicate_of(src)
                pos = rng.randint(specs.index(src) + 2, len(specs))
                specs.insert(pos, dup)
                rngs.insert(pos, rngs[specs.index(src)])
        pdf, ranges = self.compose(specs, rngs)
        degradation = None
        if scanned_level:
            pdf, degradation = self.scan_pdf(pdf, scanned_level, rng)
        rel = self.write(f"{doc_id}.pdf", pdf)
        invoices = [invoice_label(s, pages=r) for s, r in zip(specs, ranges)]
        sp = split or ("heldout" if all(split_of(t) == "heldout" for t in templates) else "dev")
        label = doc_label(doc_id=doc_id, file=rel, file_type="pdf", category=category, template=tag, split=sp,
                          degradation=degradation, invoices=invoices)
        self.add(label, {"scanned": bool(scanned_level), "invoices": [self.spec_meta(s) for s in specs]})
        for s in specs:
            if "duplicate_invoice" not in s.anomalies:
                self.remember(s, doc_id)
        return label

    # ------------------------------------------------------------------ spreadsheets
    def register_specs(self, category: str, n: int, rng: Rng, templates: list[str], *, line_items: bool = False,
                       locale_code: str | None = None, name_style: str | None = None) -> list[InvoiceSpec]:
        allowed = REGISTER_ANOMALIES + (["line_sum_mismatch"] if line_items else [])
        specs = []
        for i in range(n):
            r = rng.child("row", i)
            t = rng.choice(templates)
            anomaly = self.pick_anomaly(category, allowed, None)
            if anomaly == "duplicate_invoice":
                dup = self.take_from_pool(None, r, plain_only=True)
                if dup is not None:
                    specs.append(dup)
                    continue
                anomaly = None
            if anomaly == "negative_amount":
                spec = self.factory.make(t, r, extras=False, locale_code=locale_code,
                                         n_items=r.randint(1, 3))
                spec = sheets.credit_note(spec)
            else:
                spec = self.factory.make(t, r, extras=False, anomaly=anomaly, locale_code=locale_code,
                                         n_items=r.randint(1, 6))
            if name_style == "comma":
                f = self.factory.content.faker("en_US", r)
                spec.supplier = replace(spec.supplier, name=f"{f.last_name()}, {f.last_name()} & {f.last_name()} LLC")
            specs.append(spec)
        return specs

    def sheet_labels(self, rows, *, line_items: bool) -> list[dict]:
        out = []
        for spec, sheet, row, printed in rows:
            out.append(invoice_label(spec, printed=printed, line_items=line_items, sheet=sheet, row=row))
        return out

    def xlsx_form_doc(self, variant: str, template: str, ftype: str = "xlsx") -> dict:
        category = ftype
        doc_id = self.next_id(category, f"form{variant}")
        rng = self.rng(doc_id)
        spec = self.new_spec(template, rng, category, allowed=[a for a in DOC_ANOMALIES if a != "duplicate_invoice"])
        if ftype == "xlsx":
            data, sheet = sheets.xlsx_form(spec, rng, variant)
        else:
            data, sheet = sheets.xls_form(spec, rng)
        rel = self.write(f"{doc_id}.{ftype}", data)
        inv = invoice_label(spec, sheet=sheet)
        label = doc_label(doc_id=doc_id, file=rel, file_type=ftype, category=category, template=f"form{variant}",
                          split="dev", invoices=[inv])
        self.add(label, {"invoices": [self.spec_meta(spec)], "layout": "form"})
        self.remember(spec, doc_id)
        return label

    def xlsx_register_doc(self, n: int, *, text_amounts=False, text_dates=False, with_customer=True,
                          with_due=False, locale_code=None, templates=None, ftype="xlsx", title=None) -> dict:
        category = ftype
        doc_id = self.next_id(category, "register")
        rng = self.rng(doc_id)
        intl = templates is None and locale_code is None
        templates = templates or ["T1", "T2", "T3", "T5", "T6"]
        specs = self.register_specs(category, n, rng, templates, locale_code=locale_code)
        date_fmt = rng.choice(["dmy_slash", "iso", "mdy_slash", "dmy_dot"])
        if title is None:
            base = "International Supplier Invoices" if intl else rng.choice(
                ["Accounts Payable Register", "Purchase Invoice Register", "Supplier Invoices", "Sales Invoice Register"])
            title = base + " - " + rng.choice(["March 2026", "Q2 2026", "FY 2025-26", "September 2026"])
        if ftype == "xlsx":
            wb, rows = sheets.xlsx_register(specs, rng, title=title, with_customer=with_customer, with_due=with_due,
                                            text_amounts=text_amounts, text_dates=text_dates, date_fmt=date_fmt,
                                            sheet_name=rng.choice(["Invoices", "Register", "AP", "Sheet1"]))
            data = sheets.workbook_bytes(wb)
        else:
            data, rows = sheets.xls_register(specs, rng, title=title, with_customer=with_customer, with_due=with_due,
                                             date_fmt=date_fmt, sheet_name=rng.choice(["Register", "Invoices"]))
        rel = self.write(f"{doc_id}.{ftype}", data)
        label = doc_label(doc_id=doc_id, file=rel, file_type=ftype, category=category, template="register",
                          split="dev", invoices=self.sheet_labels(rows, line_items=False))
        self.add(label, {"invoices": [self.spec_meta(s) for s in specs], "layout": "register",
                         "text_amounts": text_amounts, "text_dates": text_dates, "date_format": date_fmt})
        for s in specs:
            if "duplicate_invoice" not in s.anomalies:
                self.remember(s, doc_id)
        return label

    def xlsx_workbook_doc(self, n: int) -> dict:
        category = "xlsx"
        doc_id = self.next_id(category, "workbook")
        rng = self.rng(doc_id)
        loc = rng.choice(["UK", "US", "BD", "DE"])
        tmap = {"UK": ["T2"], "US": ["T1", "T3"], "BD": ["T6"], "DE": ["T5"]}
        specs = self.register_specs(category, n, rng, tmap[loc], line_items=True, locale_code=loc)
        wb = openpyxl.Workbook()
        sheets.xlsx_summary_sheet(wb, specs)
        wb, rows = sheets.xlsx_register(specs, rng, title="Invoices - " + rng.choice(["April 2026", "May 2026"]),
                                        wb=wb, sheet_name="Invoices", with_customer=True, with_due=rng.chance(0.5))
        sheets.xlsx_line_items_sheet(wb, specs)
        data = sheets.workbook_bytes(wb)
        rel = self.write(f"{doc_id}.xlsx", data)
        label = doc_label(doc_id=doc_id, file=rel, file_type="xlsx", category=category, template="workbook",
                          split="dev", invoices=self.sheet_labels(rows, line_items=True))
        self.add(label, {"invoices": [self.spec_meta(s) for s in specs], "layout": "workbook"})
        for s in specs:
            if "duplicate_invoice" not in s.anomalies:
                self.remember(s, doc_id)
        return label

    def csv_doc(self, variant: str, n: int) -> dict:
        category = "csv"
        doc_id = self.next_id(category, variant)
        rng = self.rng(doc_id)
        loc_map = {"comma_us": ("US", ["T1", "T3"]), "semicolon_eu": ("DE", ["T5"]), "tab_us": ("CA", ["T1", "T3"]),
                   "bom_uk": ("UK", ["T2"]), "cp1252_eu": ("FR", ["T5"]), "quoted_us": ("US", ["T1"]),
                   "line_level": ("AU", ["T1", "T3"]), "symbols_us": ("US", ["T1", "T3"])}
        loc, templates = loc_map[variant]
        line_items = variant == "line_level"
        specs = self.register_specs(category, n, rng, templates, line_items=line_items, locale_code=loc,
                                    name_style="comma" if variant == "quoted_us" else None)
        if variant == "cp1252_eu":
            specs[0].supplier = replace(specs[0].supplier, name="Café Délices SARL")
            if len(specs) > 2:
                specs[2].customer = replace(specs[2].customer, name="Müller & Söhne GmbH") if specs[2].customer else None
        data, rows, info = sheets.csv_register(specs, rng, variant)
        rel = self.write(f"{doc_id}.csv", data)
        label = doc_label(doc_id=doc_id, file=rel, file_type="csv", category=category, template=f"csv_{variant}",
                          split="dev", invoices=self.sheet_labels(rows, line_items=line_items))
        self.add(label, {"invoices": [self.spec_meta(s) for s in specs], "layout": "csv", **info})
        for s in specs:
            if "duplicate_invoice" not in s.anomalies:
                self.remember(s, doc_id)
        return label

    # ------------------------------------------------------------------ corrupted inputs
    def corrupted_docs(self, which: list[str]) -> None:
        rng = self.rng("corrupted")
        base_spec = self.factory.make("T1", rng.child("base"), n_items=3)
        base_pdf = render(base_spec, rng.child("render"))
        cases = {
            "truncated_pdf": ("pdf", "pdf", lambda: corrupt.truncated_pdf(base_pdf), "corrupted_file", "T1"),
            "random_pdf": ("pdf", "pdf", lambda: corrupt.random_bytes(rng.child("rb")), "corrupted_file", None),
            "empty_pdf": ("pdf", "pdf", lambda: b"", "empty_file", None),
            "truncated_png": ("png", "image", lambda: corrupt.truncated_png(self._png_of(base_pdf, rng)), "corrupted_file", "T1"),
            "broken_zip_xlsx": ("xlsx", "xlsx", lambda: corrupt.broken_zip(self._xlsx_of(rng)), "corrupted_file", None),
            "garbage_xlsx": ("xlsx", "xlsx", lambda: corrupt.garbage_text_xlsx(rng.child("gx")), "corrupted_file", None),
            "encrypted_pdf": ("pdf", "pdf", lambda: corrupt.encrypted_pdf(base_pdf), "encrypted_pdf", "T1"),
            "html_as_pdf": ("pdf", "pdf", lambda: corrupt.html_document(f"Invoice {base_spec.invoice_number}", [
                f"Supplier: {base_spec.supplier.name}", f"Amount due: {base_spec.total} {base_spec.currency}"]),
                "unsupported_format", None),
            "binary_csv": ("csv", "csv", lambda: corrupt.binary_garbage_csv(rng.child("bc")), "corrupted_file", None),
        }
        for key in which:
            if key == "png_as_jpg":
                self._png_as_jpg()
                continue
            ext, ftype, make, err, tpl = cases[key]
            doc_id = self.next_id("corrupted", key)
            rel = self.write(f"{doc_id}.{ext}", make())
            label = doc_label(doc_id=doc_id, file=rel, file_type=ftype, category="corrupted", template=tpl, split="dev",
                              expect_failure=True, expected_error=err)
            self.add(label, {"case": key})

    def _png_of(self, pdf: bytes, rng: Rng) -> bytes:
        p = sample_degradation("clean", rng)
        p["dpi"] = 120
        return save_image(scanned_pages(pdf, p, rng), "png", p)

    def _xlsx_of(self, rng: Rng) -> bytes:
        specs = [self.factory.make("T1", rng.child("x", i), extras=False) for i in range(4)]
        wb, _ = sheets.xlsx_register(specs, rng, title="Accounts Payable Register - March 2026")
        return sheets.workbook_bytes(wb)

    def _png_as_jpg(self) -> None:
        doc_id = self.next_id("corrupted", "png_as_jpg")
        rng = self.rng(doc_id)
        spec = self.factory.make("T3", rng)
        pdf = render(spec, rng)
        p = sample_degradation("light", rng)
        data = save_image(scanned_pages(pdf, p, rng), "png", p)
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        rel = self.write(f"{doc_id}.jpg", data)
        label = doc_label(doc_id=doc_id, file=rel, file_type="image", category="corrupted", template="T3", split="dev",
                          degradation=p, invoices=[invoice_label(spec, pages=[1])])
        self.add(label, {"case": "png_as_jpg", "scanned": True, "invoices": [self.spec_meta(spec)]})

    # ------------------------------------------------------------------ reconciliation
    def recon_pdf_vs_register(self, n: int, pair_id: str) -> None:
        rng = self.rng(pair_id)
        templates = ["T1", "T2", "T3", "T5", "T6"]
        specs, rngs = [], []
        for i in range(n):
            r = rng.child("inv", i)
            s = self.factory.make(rng.choice(templates), r, extras=False)
            specs.append(s)
            rngs.append(r)
        pdf, ranges = self.compose(specs, rngs)
        left_name = f"{pair_id}-left.pdf"
        right_name = f"{pair_id}-right.xlsx"
        (self.out / "reconciliation").mkdir(exist_ok=True)
        (self.out / "reconciliation" / left_name).write_bytes(pdf)

        reg = [copy.deepcopy(s) for s in specs]
        missing_idx = rng.randint(0, n - 1)
        missing = reg.pop(missing_idx)
        mism = rng.sample(range(len(reg)), 2)
        discrepancies = {}
        a = reg[mism[0]]
        old_total = a.total
        a.total = q2(a.total + D(rng.choice(["9.00", "90.00", "100.00", "0.90"])))
        discrepancies[a.invoice_number] = [{"field": "total", "left": f"{old_total:.2f}", "right": f"{a.total:.2f}"}]
        b = reg[mism[1]]
        old_tax, old_tot = b.tax, b.total
        b.tax = q2(b.subtotal * (b.tax_rate + D("0.02")))
        b.total = q2(b.subtotal + b.tax)
        discrepancies[b.invoice_number] = [{"field": "tax", "left": f"{old_tax:.2f}", "right": f"{b.tax:.2f}"},
                                           {"field": "total", "left": f"{old_tot:.2f}", "right": f"{b.total:.2f}"}]
        extra = self.factory.make(rng.choice(templates), rng.child("extra"), extras=False)
        reg.insert(rng.randint(0, len(reg)), extra)
        wb, rows = sheets.xlsx_register(reg, rng, title="Purchase Ledger - October 2026", with_customer=True)
        (self.out / "reconciliation" / right_name).write_bytes(sheets.workbook_bytes(wb))

        left_doc = doc_label(doc_id=f"{pair_id}-left", file=f"reconciliation/{left_name}", file_type="pdf",
                             category="reconciliation", template="mixed", split="dev",
                             invoices=[invoice_label(s, pages=r) for s, r in zip(specs, ranges)])
        right_doc = doc_label(doc_id=f"{pair_id}-right", file=f"reconciliation/{right_name}", file_type="xlsx",
                              category="reconciliation", template="register", split="dev",
                              invoices=self.sheet_labels(rows, line_items=False))
        matched = []
        for s in specs:
            if s.invoice_number == missing.invoice_number:
                continue
            d = discrepancies.get(s.invoice_number, [])
            matched.append({"invoice_number": s.invoice_number, "supplier_name": s.supplier.name,
                            "status": "mismatch" if d else "match", "discrepancies": d})
        self.recon.append({
            "pair_id": pair_id, "kind": "pdf_vs_excel", "left": left_doc, "right": right_doc,
            "expected": {"matched": matched, "unmatched_left": [missing.invoice_number],
                         "unmatched_right": [extra.invoice_number]},
        })
        self.meta.append({"doc_id": f"{pair_id}-left", "invoices": [self.spec_meta(s) for s in specs]})
        self.meta.append({"doc_id": f"{pair_id}-right", "invoices": [self.spec_meta(s) for s in reg], "layout": "register"})

    def recon_pdf_vs_pdf(self, n: int, pair_id: str) -> None:
        rng = self.rng(pair_id)
        templates = ["T1", "T2", "T5", "T6", "T3"]
        specs, rngs = [], []
        for i in range(n):
            r = rng.child("inv", i)
            specs.append(self.factory.make(rng.choice(templates), r))
            rngs.append(r)
        left_pdf, left_ranges = self.compose(specs, rngs)
        right = [copy.deepcopy(s) for s in specs]
        i1, i2 = rng.sample(range(n), 2)
        changes = {}
        x = right[i1]
        old_date = x.invoice_date
        x.invoice_date = x.invoice_date + timedelta(days=rng.choice([3, 7, 10]))
        if x.due_date:
            x.due_date = x.due_date + (x.invoice_date - old_date)
        changes[x.invoice_number] = [{"field": "invoice_date", "left": old_date.isoformat(), "right": x.invoice_date.isoformat()}]
        y = right[i2]
        old = (y.subtotal, y.tax, y.total)
        it = y.items[0]
        it.quantity = it.quantity + 1
        it.amount = q2(it.quantity * it.unit_price)
        apply_totals(y)
        changes[y.invoice_number] = [
            {"field": "subtotal", "left": f"{old[0]:.2f}", "right": f"{y.subtotal:.2f}"},
            {"field": "tax", "left": f"{old[1]:.2f}", "right": f"{y.tax:.2f}"},
            {"field": "total", "left": f"{old[2]:.2f}", "right": f"{y.total:.2f}"},
            {"field": "line_items", "left": f"{it.description}: qty {it.quantity - 1}", "right": f"{it.description}: qty {it.quantity}"},
        ]
        right_pdf, right_ranges = self.compose(right, [r.child("reissue") for r in rngs])
        (self.out / "reconciliation").mkdir(exist_ok=True)
        (self.out / "reconciliation" / f"{pair_id}-left.pdf").write_bytes(left_pdf)
        (self.out / "reconciliation" / f"{pair_id}-right.pdf").write_bytes(right_pdf)
        left_doc = doc_label(doc_id=f"{pair_id}-left", file=f"reconciliation/{pair_id}-left.pdf", file_type="pdf",
                             category="reconciliation", template="mixed", split="dev",
                             invoices=[invoice_label(s, pages=r) for s, r in zip(specs, left_ranges)])
        right_doc = doc_label(doc_id=f"{pair_id}-right", file=f"reconciliation/{pair_id}-right.pdf", file_type="pdf",
                              category="reconciliation", template="mixed", split="dev",
                              invoices=[invoice_label(s, pages=r) for s, r in zip(right, right_ranges)])
        matched = [{"invoice_number": s.invoice_number, "supplier_name": s.supplier.name,
                    "status": "mismatch" if s.invoice_number in changes else "match",
                    "discrepancies": changes.get(s.invoice_number, [])} for s in specs]
        self.recon.append({"pair_id": pair_id, "kind": "pdf_vs_pdf", "left": left_doc, "right": right_doc,
                           "expected": {"matched": matched, "unmatched_left": [], "unmatched_right": []}})
        self.meta.append({"doc_id": f"{pair_id}-left", "invoices": [self.spec_meta(s) for s in specs]})
        self.meta.append({"doc_id": f"{pair_id}-right", "invoices": [self.spec_meta(s) for s in right]})

    # ------------------------------------------------------------------ perf
    def perf_multi(self, target_pages: int, *, scanned_level: str | None, doc_name: str) -> None:
        rng = self.rng(doc_name)
        specs, rngs, total = [], [], 0
        page_weights = [(1, 0.22), (2, 0.22), (3, 0.2), (4, 0.18), (5, 0.18)]
        items_for_pages = {1: (1, 10), 2: (26, 38), 3: (58, 66), 4: (88, 96), 5: (118, 126)}
        templates = ["T1", "T2", "T5", "T6", "T7", "T8", "T3"]
        i = 0
        while total < target_pages:
            remaining = target_pages - total
            want = rng.choices([p for p, _ in page_weights], [w for _, w in page_weights])
            want = min(want, remaining)
            t = rng.choice(templates)
            r = rng.child("inv", i)
            lo, hi = items_for_pages[want]
            n_items = r.randint(lo, hi)
            for _attempt in range(8):
                spec = self.new_spec(t, r, "perf", allowed=[a for a in DOC_ANOMALIES if a != "duplicate_invoice"],
                                     n_items=n_items)
                pages = page_count(render(spec, r.child("probe")))
                if pages <= remaining:
                    break
                n_items = max(1, n_items // 2)
            else:
                spec = self.factory.make(t, r, n_items=2)
                pages = 1
            specs.append(spec)
            rngs.append(r.child("probe"))
            total += pages
            i += 1
        pdf, ranges = self.compose(specs, rngs)
        assert ranges[-1][-1] == target_pages, (ranges[-1][-1], target_pages)
        degradation = None
        if scanned_level:
            pdf, degradation = self.scan_pdf(pdf, scanned_level, rng)
        rel = self.write(f"{doc_name}.pdf", pdf)
        label = doc_label(doc_id=doc_name, file=rel, file_type="pdf", category="perf", template="mixed",
                          split="dev", degradation=degradation,
                          invoices=[invoice_label(s, pages=r) for s, r in zip(specs, ranges)])
        self.add(label, {"scanned": bool(scanned_level), "invoices": [self.spec_meta(s) for s in specs]})

    # ------------------------------------------------------------------ profiles
    def build(self) -> None:
        getattr(self, f"profile_{self.profile}")()

    def profile_standard(self) -> None:
        for t in ALL_T:
            for k in range(5):
                long = k == 0 and TEMPLATE_INFO[t]["multipage"]
                self.single_doc("pdf_digital", t, n_items=self.rng("len", t, k).randint(26, 38) if long else None)
        for t in ALL_T:
            for k, level in enumerate(["light", "medium", "heavy"]):
                long = k == 1 and t in ("T1", "T5", "T6", "T8")
                self.single_doc("pdf_scanned", t, level=level,
                                n_items=self.rng("slen", t).randint(26, 34) if long else None)
        fmts = ["jpg", "png", "tiff"]
        for ti, t in enumerate(ALL_T):
            used_tiff_long = False
            for k, level in enumerate(LEVELS):
                fmt = fmts[(ti + k) % 3]
                long = fmt == "tiff" and not used_tiff_long and TEMPLATE_INFO[t]["multipage"]
                used_tiff_long = used_tiff_long or long
                self.single_doc("image", t, level=level, fmt=fmt,
                                n_items=self.rng("ilen", t).randint(26, 32) if long else None,
                                allow_rotate90=(level == "heavy" and t in ("T1", "T3", "T5", "T7")))
        self.multi_doc("multi_invoice_pdf", 12, DEV, internal_duplicate=True)
        self.multi_doc("multi_invoice_pdf", 10, ["T1", "T2", "T5", "T6", "T3"], long_prob=0.4)
        self.multi_doc("multi_invoice_pdf", 9, HELDOUT, long_prob=0.3)
        self.multi_doc("multi_invoice_pdf", 8, ["T1", "T2", "T3", "T5", "T6"], scanned_level="medium", long_prob=0.2)
        for variant, t in [("A", "T1"), ("B", "T2"), ("A", "T6"), ("B", "T5")]:
            self.xlsx_form_doc(variant, t)
        self.xlsx_register_doc(24, with_customer=True, with_due=True)
        self.xlsx_register_doc(18, with_customer=False, locale_code="UK", templates=["T2"])
        self.xlsx_register_doc(12, text_amounts=True, text_dates=True, locale_code="US", templates=["T1", "T3"])
        self.xlsx_register_doc(30, with_customer=True, locale_code="BD", templates=["T6"])
        self.xlsx_workbook_doc(10)
        self.xlsx_workbook_doc(8)
        self.xlsx_form_doc("X", "T1", ftype="xls")
        self.xlsx_form_doc("X", "T6", ftype="xls")
        self.xlsx_register_doc(14, ftype="xls", locale_code="UK", templates=["T2"])
        self.xlsx_register_doc(11, ftype="xls", with_due=True, locale_code="US", templates=["T1", "T3"])
        self.xlsx_register_doc(16, ftype="xls", with_customer=False, locale_code="BD", templates=["T6"])
        for variant, n in [("comma_us", 12), ("semicolon_eu", 10), ("tab_us", 9), ("bom_uk", 11), ("cp1252_eu", 8),
                           ("quoted_us", 10), ("line_level", 7), ("symbols_us", 9)]:
            self.csv_doc(variant, n)
        self.corrupted_docs(["truncated_pdf", "random_pdf", "empty_pdf", "truncated_png", "broken_zip_xlsx",
                             "garbage_xlsx", "encrypted_pdf", "html_as_pdf", "binary_csv", "png_as_jpg"])
        self.recon_pdf_vs_register(15, "recon-a")
        self.recon_pdf_vs_pdf(8, "recon-b")

    def profile_small(self) -> None:
        self.single_doc("pdf_digital", "T1", n_items=30)
        for t in ("T3", "T5", "T7"):
            self.single_doc("pdf_digital", t)
        self.single_doc("pdf_scanned", "T2", level="medium")
        self.single_doc("pdf_scanned", "T6", level="light")
        self.single_doc("image", "T4", level="light", fmt="jpg")
        self.single_doc("image", "T8", level="medium", fmt="png")
        self.single_doc("image", "T1", level="heavy", fmt="tiff", allow_rotate90=True)
        self.multi_doc("multi_invoice_pdf", 5, DEV, internal_duplicate=True)
        self.xlsx_form_doc("A", "T1")
        self.xlsx_register_doc(8, with_customer=True)
        self.xlsx_register_doc(6, ftype="xls", locale_code="UK", templates=["T2"])
        self.csv_doc("comma_us", 6)
        self.csv_doc("semicolon_eu", 5)
        self.corrupted_docs(["truncated_pdf", "encrypted_pdf", "empty_pdf"])
        self.recon_pdf_vs_register(6, "recon-a")

    def profile_fixtures(self) -> None:
        self.anomaly_rate = 0.0
        self.single_doc("pdf_digital", "T1", name_hint="invoice_digital", n_items=4)
        doc_id = "invoice_scanned"
        rng = self.rng(doc_id)
        spec = self.factory.make("T2", rng, n_items=3)
        pdf = render(spec, rng)
        p = sample_degradation("light", rng)
        p.update(dpi=150, noise_sigma=0.0, salt_pepper=0.0002, rotation_deg=0.7, blur=0.5, contrast=0.92)
        img = scanned_pages(pdf, p, rng)[0].point(lambda v: min(255, (v // 16) * 16 + 15))  # 16 grey levels
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True, dpi=(150, 150))
        rel = self.write(f"{doc_id}.png", buf.getvalue())
        self.add(doc_label(doc_id=doc_id, file=rel, file_type="image", category="image", template="T2", split="dev",
                           degradation=p, invoices=[invoice_label(spec, pages=[1])]),
                 {"scanned": True, "invoices": [self.spec_meta(spec)]})
        rng = self.rng("invoice_multi")
        specs = [self.factory.make("T1", rng.child(0), n_items=3),
                 self.factory.make("T5", rng.child(1), n_items=30),
                 self.factory.make("T6", rng.child(2), n_items=4)]
        rngs = [rng.child("r", i) for i in range(3)]
        pdf, ranges = self.compose(specs, rngs)
        assert ranges[-1][-1] == 4, ranges
        rel = self.write("invoice_multi.pdf", pdf)
        self.add(doc_label(doc_id="invoice_multi", file=rel, file_type="pdf", category="multi_invoice_pdf", template="mixed",
                           split="dev", invoices=[invoice_label(s, pages=r) for s, r in zip(specs, ranges)]),
                 {"scanned": False, "invoices": [self.spec_meta(s) for s in specs]})
        rng = self.rng("register_xlsx")
        specs = [self.factory.make(rng.choice(["T1", "T2", "T3"]), rng.child(i), extras=False, n_items=2) for i in range(5)]
        wb, rows = sheets.xlsx_register(specs, rng, title="Accounts Payable Register - March 2026", with_customer=True)
        rel = self.write("register.xlsx", sheets.workbook_bytes(wb))
        self.add(doc_label(doc_id="register_xlsx", file=rel, file_type="xlsx", category="xlsx", template="register", split="dev",
                           invoices=self.sheet_labels(rows, line_items=False)),
                 {"invoices": [self.spec_meta(s) for s in specs], "layout": "register"})
        rng = self.rng("register_xls")
        specs = [self.factory.make("T2", rng.child(i), extras=False, n_items=2) for i in range(3)]
        data, rows = sheets.xls_register(specs, rng, title="Purchase Invoice Register - Q2 2026", with_customer=True)
        rel = self.write("register.xls", data)
        self.add(doc_label(doc_id="register_xls", file=rel, file_type="xls", category="xls", template="register", split="dev",
                           invoices=self.sheet_labels(rows, line_items=False)),
                 {"invoices": [self.spec_meta(s) for s in specs], "layout": "register"})
        rng = self.rng("register_csv")
        specs = [self.factory.make(rng.choice(["T1", "T3"]), rng.child(i), extras=False, locale_code="US", n_items=2) for i in range(5)]
        data, rows, info = sheets.csv_register(specs, rng, "comma_us")
        rel = self.write("register.csv", data)
        self.add(doc_label(doc_id="register_csv", file=rel, file_type="csv", category="csv", template="csv_comma_us", split="dev",
                           invoices=self.sheet_labels(rows, line_items=False)),
                 {"invoices": [self.spec_meta(s) for s in specs], "layout": "csv", **info})
        base = render(self.factory.make("T1", self.rng("corrupt-base")), self.rng("corrupt-render"))
        rel = self.write("corrupted.pdf", corrupt.truncated_pdf(base))
        self.add(doc_label(doc_id="corrupted", file=rel, file_type="pdf", category="corrupted", template="T1", split="dev",
                           expect_failure=True, expected_error="corrupted_file"), {"case": "truncated_pdf"})

    def profile_perf(self) -> None:
        self.anomaly_rate = 0.08
        self.perf_multi(self.perf_pages, scanned_level=None, doc_name=f"perf-digital-{self.perf_pages}p")
        self.perf_multi(self.perf_scanned_pages, scanned_level="light", doc_name=f"perf-scanned-{self.perf_scanned_pages}p")

    # ------------------------------------------------------------------ output
    def finalize(self, started: float) -> dict:
        if self.flat:
            (self.out / "labels.json").write_text(json.dumps(self.labels, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        else:
            with (self.out / "labels.jsonl").open("w", encoding="utf-8") as f:
                for lab in self.labels:
                    f.write(json.dumps(lab, ensure_ascii=False) + "\n")
        with (self.out / ("_generation_meta.jsonl" if self.flat else "generation_meta.jsonl")).open("w", encoding="utf-8") as f:
            for m in self.meta:
                f.write(json.dumps(m, ensure_ascii=False, default=str) + "\n")
        if self.recon:
            (self.out / "reconciliation").mkdir(exist_ok=True)
            (self.out / "reconciliation" / "reconciliation_labels.json").write_text(
                json.dumps(self.recon, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        cats, splits, tmpls, ftypes, anoms, levels = Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
        inv_by_cat = Counter()
        for lab in self.labels:
            cats[lab["category"]] += 1
            splits[lab["split"]] += 1
            tmpls[lab["template"] or "none"] += 1
            ftypes[lab["file_type"]] += 1
            inv_by_cat[lab["category"]] += len(lab["invoices"])
            if lab["degradation"]:
                levels[lab["degradation"]["level"]] += 1
            for inv in lab["invoices"]:
                for a in inv["anomalies"]:
                    anoms[a] += 1
        n_inv = sum(inv_by_cat.values())
        size = sum(p.stat().st_size for p in self.out.rglob("*") if p.is_file())
        manifest = {
            "profile": self.profile, "seed": self.seed, "generator": "docintel-eval datagen 1.0",
            "documents": len(self.labels), "invoices": n_inv,
            "invoices_with_anomalies": sum(1 for lab in self.labels for inv in lab["invoices"] if inv["anomalies"]),
            "by_category": dict(cats), "invoices_by_category": dict(inv_by_cat), "by_split": dict(splits),
            "by_template": dict(tmpls), "by_file_type": dict(ftypes), "anomalies": dict(anoms),
            "degradation_levels": dict(levels),
            "reconciliation_pairs": [r["pair_id"] for r in self.recon],
            "total_bytes": size, "generation_seconds": round(time.time() - started, 1),
        }
        if not self.flat:
            (self.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return manifest
