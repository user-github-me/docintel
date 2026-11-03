"""Spreadsheet (xlsx / xls) and CSV writers: single-invoice forms and multi-invoice registers."""
from __future__ import annotations

import csv
import io
from datetime import date, datetime
from decimal import Decimal

import openpyxl
import xlwt
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .content import InvoiceSpec
from .formats import fmt_amount, fmt_date, fmt_percent, fmt_quantity
from .util import Rng

FIELD_HEADERS = {
    "invoice_number": ["Invoice No", "Inv #", "Bill No.", "Document No", "Invoice Number", "Invoice Ref"],
    "invoice_date": ["Invoice Date", "Date", "Bill Date", "Issue Date", "Inv. Date"],
    "supplier_name": ["Supplier", "Vendor", "Supplier Name", "Seller", "Vendor Name"],
    "customer_name": ["Customer", "Client", "Bill To", "Buyer", "Customer Name"],
    "currency": ["Currency", "Curr", "CCY", "Cur."],
    "subtotal": ["Subtotal", "Net Amount", "Net", "Amount excl. tax", "Taxable Value"],
    "tax": ["Tax", "VAT", "Tax Amount", "GST", "Sales Tax"],
    "total": ["Total", "Gross Amount", "Gross", "Amount incl. tax", "Invoice Total", "Total Payable"],
    "due_date": ["Due Date", "Payment Due", "Due"],
}
DISTRACTOR_COLS = ["Status", "PO Number", "Payment Ref", "Cost Centre", "Approved By", "Paid Amount", "GL Code"]
EXCEL_DATE_FORMATS = {"mdy_slash": "mm/dd/yyyy", "dmy_slash": "dd/mm/yyyy", "iso": "yyyy-mm-dd", "dmy_dot": "dd.mm.yyyy"}


def _distractor_value(col: str, spec: InvoiceSpec, rng: Rng):
    if col == "Status":
        return rng.choice(["Paid", "Open", "Overdue", "Approved", "On Hold"])
    if col == "PO Number":
        return spec.distractors.get("po_number", f"PO-{rng.digits(5)}")
    if col == "Payment Ref":
        return f"PAY-{rng.digits(7)}"
    if col == "Cost Centre":
        return rng.choice(["CC-100 Admin", "CC-210 Nursing", "CC-310 IT", "CC-420 Logistics"])
    if col == "Approved By":
        return rng.choice(["A. Rahman", "J. Smith", "M. Garcia", "K. Weber"])
    if col == "GL Code":
        return rng.choice(["5100", "5210", "6120", "6400"])
    if col == "Paid Amount":
        total = spec.total
        return float(rng.choice([total, Decimal("0"), (total / 2).quantize(Decimal("0.01"))]))
    return ""


def register_columns(rng: Rng, *, with_customer: bool, with_due: bool, n_distractors: int = 2):
    cols = ["invoice_number", "invoice_date", "supplier_name"]
    if with_customer:
        cols.append("customer_name")
    cols += ["currency", "subtotal", "tax", "total"]
    if with_due:
        cols.append("due_date")
    headers = {c: rng.choice(FIELD_HEADERS[c]) for c in cols}
    distractors = rng.sample(DISTRACTOR_COLS, n_distractors)
    order = cols + distractors
    return order, headers


def printed_fields(order) -> set[str]:
    return {c for c in order if c in FIELD_HEADERS}


def credit_note(spec: InvoiceSpec) -> InvoiceSpec:
    """Turn an invoice into a credit note (all amounts negative)."""
    for it in spec.items:
        it.quantity = -it.quantity
        it.amount = -it.amount
    spec.subtotal = -spec.subtotal
    spec.tax = -spec.tax if spec.tax is not None else None
    spec.total = -spec.total
    spec.discount = None
    spec.shipping = None
    spec.anomalies = ["negative_amount"]
    return spec


# =================================================================== XLSX
THIN = Side(style="thin", color="9CA3AF")
HEAD_FILL = PatternFill("solid", fgColor="1F4E79")


def xlsx_register(specs: list[InvoiceSpec], rng: Rng, *, title: str, sheet_name: str = "Invoices",
                  with_customer: bool = True, with_due: bool = False, text_amounts: bool = False,
                  text_dates: bool = False, date_fmt: str = "dmy_slash", wb=None):
    """Returns (workbook, rows) where rows = [(spec, sheet, excel_row)]."""
    own = wb is None
    wb = wb or openpyxl.Workbook()
    ws = wb.active if own else wb.create_sheet(sheet_name)
    ws.title = sheet_name
    order, headers = register_columns(rng, with_customer=with_customer, with_due=with_due)
    ws.cell(1, 1, title).font = Font(bold=True, size=14)
    ws.cell(2, 1, f"Period: {title.split(' - ')[-1]}" if " - " in title else "Period: see filters")
    ws.cell(3, 1, f"Generated: {datetime(2026, 4, 2, 9, 15).strftime('%Y-%m-%d %H:%M')} by finance-system")
    hr = 5
    for ci, col in enumerate(order, 1):
        c = ws.cell(hr, ci, headers.get(col, col))
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = HEAD_FILL
        c.alignment = Alignment(horizontal="center")
    rows = []
    r = hr + 1
    for spec in specs:
        loc = spec.locale
        for ci, col in enumerate(order, 1):
            v = _register_value(spec, col, rng)
            cell = ws.cell(r, ci)
            if col in ("subtotal", "tax", "total"):
                if v is None:
                    cell.value = None
                elif text_amounts:
                    sym = loc.symbol or loc.currency + " "
                    s = fmt_amount(v, loc.number_format)
                    cell.value = (f"-{sym}{s[1:]}" if s.startswith("-") else f"{sym}{s}")
                else:
                    cell.value = float(v)
                    cell.number_format = "#,##0.00"
            elif col in ("invoice_date", "due_date"):
                if v is None:
                    cell.value = None
                elif text_dates:
                    cell.value = fmt_date(v, date_fmt)
                else:
                    cell.value = v
                    cell.number_format = EXCEL_DATE_FORMATS.get(date_fmt, "dd/mm/yyyy")
            else:
                cell.value = v
            cell.border = Border(bottom=THIN)
        rows.append((spec, ws.title, r, printed_fields(order)))
        r += 1
    # TOTAL row (not an invoice)
    ws.cell(r + 1, 1, "TOTAL").font = Font(bold=True)
    for ci, col in enumerate(order, 1):
        if col in ("subtotal", "tax", "total") and not text_amounts:
            vals = [float(_register_value(s, col, rng) or 0) for s in specs]
            c = ws.cell(r + 1, ci, round(sum(vals), 2))
            c.number_format = "#,##0.00"
            c.font = Font(bold=True)
    ws.cell(r + 2, 1, f"Count: {len(specs)} invoices")
    for ci in range(1, len(order) + 1):
        ws.column_dimensions[get_column_letter(ci)].width = 18
    ws.column_dimensions["C"].width = 34
    return wb, rows


def _register_value(spec: InvoiceSpec, col: str, rng: Rng):
    if col == "invoice_number":
        return spec.invoice_number
    if col == "invoice_date":
        return spec.invoice_date
    if col == "due_date":
        return spec.due_date
    if col == "supplier_name":
        return spec.supplier.name
    if col == "customer_name":
        return spec.customer.name if spec.customer else None
    if col == "currency":
        return spec.currency
    if col in ("subtotal", "tax", "total"):
        return getattr(spec, col)
    return _distractor_value(col, spec, rng)


def xlsx_line_items_sheet(wb, specs: list[InvoiceSpec], sheet_name: str = "Line Items"):
    ws = wb.create_sheet(sheet_name)
    head = ["Invoice No", "Line", "Description", "Qty", "Unit Price", "Amount"]
    for ci, h in enumerate(head, 1):
        c = ws.cell(1, ci, h)
        c.font = Font(bold=True)
    r = 2
    for spec in specs:
        for i, it in enumerate(spec.items, 1):
            ws.cell(r, 1, spec.invoice_number)
            ws.cell(r, 2, i)
            ws.cell(r, 3, it.description)
            ws.cell(r, 4, float(it.quantity))
            c = ws.cell(r, 5, float(it.unit_price)); c.number_format = "#,##0.00"
            c = ws.cell(r, 6, float(it.amount)); c.number_format = "#,##0.00"
            r += 1
    ws.column_dimensions["C"].width = 46
    return ws


def xlsx_summary_sheet(wb, specs: list[InvoiceSpec]):
    ws = wb.active
    ws.title = "Summary"
    ws.cell(1, 1, "Monthly Billing Summary").font = Font(bold=True, size=14)
    cur = specs[0].currency
    ws.cell(3, 1, "Number of invoices"); ws.cell(3, 2, len(specs))
    ws.cell(4, 1, f"Total invoiced ({cur})"); c = ws.cell(4, 2, float(sum(s.total for s in specs))); c.number_format = "#,##0.00"
    ws.cell(5, 1, f"Average invoice ({cur})"); c = ws.cell(5, 2, float(sum(s.total for s in specs) / len(specs))); c.number_format = "#,##0.00"
    ws.cell(6, 1, "Largest invoice"); c = ws.cell(6, 2, float(max(s.total for s in specs))); c.number_format = "#,##0.00"
    ws.cell(8, 1, "Prepared by: Finance team. Figures are unaudited.")
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 18
    return ws


def xlsx_form(spec: InvoiceSpec, rng: Rng, variant: str = "A") -> tuple[bytes, str]:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = rng.choice(["Invoice", "Sheet1", "INV"])
    loc = spec.locale
    df = EXCEL_DATE_FORMATS.get(loc.date_format, "dd/mm/yyyy")
    if variant == "A":
        ws.merge_cells("A1:E1")
        ws["A1"] = "INVOICE"
        ws["A1"].font = Font(bold=True, size=18, color="1F4E79")
        ws["A3"] = spec.supplier.name
        ws["A3"].font = Font(bold=True, size=12)
        for i, line in enumerate(spec.supplier.address[:2] + [f"Tel: {spec.supplier.phone}"], 4):
            ws.cell(i, 1, line)
        meta = []
        if spec.invoice_number:
            meta.append(("Invoice No:", spec.invoice_number))
        if spec.invoice_date:
            meta.append(("Date:", spec.invoice_date))
        if spec.due_date:
            meta.append(("Due Date:", spec.due_date))
        meta.append(("PO Number:", spec.distractors["po_number"]))
        for i, (k, v) in enumerate(meta, 3):
            ws.cell(i, 4, k).font = Font(bold=True)
            c = ws.cell(i, 5, v)
            if isinstance(v, date):
                c.number_format = df
        r = 9
        if spec.customer:
            ws.cell(r, 1, "Bill To:").font = Font(bold=True)
            ws.cell(r + 1, 1, spec.customer.name)
            for i, line in enumerate(spec.customer.address[:2]):
                ws.cell(r + 2 + i, 1, line)
        hr = 14
        heads = ["#", "Description", "Qty", "Unit Price", "Amount"]
        for ci, h in enumerate(heads, 1):
            c = ws.cell(hr, ci, h)
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = HEAD_FILL
        r = hr + 1
        for i, it in enumerate(spec.items, 1):
            ws.cell(r, 1, i)
            ws.cell(r, 2, it.description)
            ws.cell(r, 3, float(it.quantity))
            c = ws.cell(r, 4, float(it.unit_price)); c.number_format = "#,##0.00"
            c = ws.cell(r, 5, float(it.amount)); c.number_format = "#,##0.00"
            r += 1
        r += 1
        tot = [("Subtotal", spec.subtotal)]
        if spec.discount:
            tot.append(("Discount", -spec.discount))
        if spec.shipping:
            tot.append(("Shipping", spec.shipping))
        if spec.tax is not None:
            tot.append((f"{loc.tax_name} ({fmt_percent(spec.tax_rate)})", spec.tax))
        tot.append(("Total", spec.total))
        for k, v in tot:
            ws.cell(r, 4, k).font = Font(bold=(k == "Total"))
            c = ws.cell(r, 5, float(v)); c.number_format = "#,##0.00"
            r += 1
        ws.cell(r + 1, 1, f"Currency: {spec.currency}")
        ws.cell(r + 2, 1, f"Payment terms: Net {spec.extra['terms_days']} days")
        ws.column_dimensions["A"].width = 6
        ws.column_dimensions["B"].width = 44
        for col in "CDE":
            ws.column_dimensions[col].width = 16
        ws.column_dimensions["A"].width = 28
    else:
        ws["A1"] = "Tax Invoice"
        ws["A1"].font = Font(bold=True, size=16)
        kv = []
        if spec.invoice_number:
            kv.append(("Invoice Number", spec.invoice_number))
        if spec.invoice_date:
            kv.append(("Invoice Date", spec.invoice_date))
        kv.append(("Supplier", spec.supplier.name))
        if spec.customer:
            kv.append(("Customer", spec.customer.name))
        kv.append(("Currency", spec.currency))
        kv.append(("Order Ref", spec.distractors["order_no"]))
        if spec.due_date:
            kv.append(("Payment Due", spec.due_date))
        for i, (k, v) in enumerate(kv, 3):
            ws.cell(i, 1, k).font = Font(bold=True)
            c = ws.cell(i, 2, v)
            if isinstance(v, date):
                c.number_format = df
        hr = 3 + len(kv) + 1
        heads = ["Item", "Quantity", "Rate", "Line Total"]
        for ci, h in enumerate(heads, 1):
            ws.cell(hr, ci, h).font = Font(bold=True)
        r = hr + 1
        for it in spec.items:
            ws.cell(r, 1, it.description)
            ws.cell(r, 2, float(it.quantity))
            c = ws.cell(r, 3, float(it.unit_price)); c.number_format = "#,##0.00"
            c = ws.cell(r, 4, float(it.amount)); c.number_format = "#,##0.00"
            r += 1
        tot = [("Net Total", spec.subtotal)]
        if spec.discount:
            tot.append(("Less Discount", -spec.discount))
        if spec.shipping:
            tot.append(("Delivery", spec.shipping))
        if spec.tax is not None:
            tot.append(("VAT", spec.tax))
        tot.append(("Gross Total", spec.total))
        for k, v in tot:
            ws.cell(r, 3, k).font = Font(bold=True)
            c = ws.cell(r, 4, float(v)); c.number_format = "#,##0.00"
            r += 1
        ws.column_dimensions["A"].width = 46
        for col in "BCD":
            ws.column_dimensions[col].width = 16
    return workbook_bytes(wb), ws.title


FIXED_TS = datetime(2026, 4, 2, 9, 15, 0)


def deterministic_zip(data: bytes) -> bytes:
    """Re-pack an OOXML zip with fixed entry timestamps so output bytes are reproducible."""
    import zipfile
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            zi = zipfile.ZipInfo(info.filename, date_time=(2026, 4, 2, 9, 15, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            payload = src.read(info.filename)
            if info.filename == "docProps/core.xml":  # openpyxl stamps 'modified' with the wall clock
                import re
                payload = re.sub(rb"(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)",
                                 rb"\g<1>2026-04-02T09:15:00Z\g<2>", payload)
            dst.writestr(zi, payload)
    return out.getvalue()


def workbook_bytes(wb) -> bytes:
    wb.properties.created = FIXED_TS
    wb.properties.modified = FIXED_TS
    wb.properties.creator = "finance-system"
    buf = io.BytesIO()
    wb.save(buf)
    return deterministic_zip(buf.getvalue())


# =================================================================== XLS (BIFF8)
def _xls_styles(date_fmt: str):
    return {
        "bold": xlwt.easyxf("font: bold on"),
        "title": xlwt.easyxf("font: bold on, height 280"),
        "head": xlwt.easyxf("font: bold on, colour white; pattern: pattern solid, fore_colour dark_blue"),
        "money": xlwt.easyxf(num_format_str="#,##0.00"),
        "date": xlwt.easyxf(num_format_str=EXCEL_DATE_FORMATS.get(date_fmt, "DD/MM/YYYY").upper().replace("YYYY", "YYYY")),
        "plain": xlwt.easyxf(""),
    }


def xls_register(specs: list[InvoiceSpec], rng: Rng, *, title: str, sheet_name: str = "Register",
                 with_customer: bool = True, with_due: bool = False, date_fmt: str = "dmy_slash"):
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet(sheet_name)
    stl = _xls_styles(date_fmt)
    order, headers = register_columns(rng, with_customer=with_customer, with_due=with_due)
    ws.write(0, 0, title, stl["title"])
    ws.write(1, 0, "Exported from accounting system", stl["plain"])
    hr = 3
    for ci, col in enumerate(order):
        ws.write(hr, ci, headers.get(col, col), stl["head"])
        ws.col(ci).width = 256 * (34 if col == "supplier_name" else 18)
    rows = []
    r = hr + 1
    for spec in specs:
        for ci, col in enumerate(order):
            v = _register_value(spec, col, rng)
            if v is None:
                continue
            if col in ("subtotal", "tax", "total"):
                ws.write(r, ci, float(v), stl["money"])
            elif col in ("invoice_date", "due_date"):
                ws.write(r, ci, datetime(v.year, v.month, v.day), stl["date"])
            else:
                ws.write(r, ci, v if not isinstance(v, Decimal) else float(v), stl["plain"])
        rows.append((spec, sheet_name, r + 1, printed_fields(order)))  # 1-based Excel row
        r += 1
    ws.write(r + 1, 0, "TOTAL", stl["bold"])
    for ci, col in enumerate(order):
        if col == "total":
            ws.write(r + 1, ci, float(sum(s.total for s in specs)), stl["money"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), rows


def xls_form(spec: InvoiceSpec, rng: Rng) -> tuple[bytes, str]:
    wb = xlwt.Workbook(encoding="utf-8")
    name = rng.choice(["Invoice", "Bill"])
    ws = wb.add_sheet(name)
    stl = _xls_styles(spec.locale.date_format)
    ws.write_merge(0, 0, 0, 4, "INVOICE", stl["title"])
    ws.write(2, 0, spec.supplier.name, stl["bold"])
    for i, line in enumerate(spec.supplier.address[:2]):
        ws.write(3 + i, 0, line)
    meta = []
    if spec.invoice_number:
        meta.append(("Invoice No:", spec.invoice_number))
    if spec.invoice_date:
        meta.append(("Invoice Date:", spec.invoice_date))
    if spec.due_date:
        meta.append(("Due Date:", spec.due_date))
    meta.append(("Customer ID:", spec.distractors["customer_id"]))
    for i, (k, v) in enumerate(meta):
        ws.write(2 + i, 3, k, stl["bold"])
        if isinstance(v, date):
            ws.write(2 + i, 4, datetime(v.year, v.month, v.day), stl["date"])
        else:
            ws.write(2 + i, 4, v)
    r = 8
    if spec.customer:
        ws.write(r, 0, "Bill To:", stl["bold"])
        ws.write(r + 1, 0, spec.customer.name)
    hr = 12
    for ci, h in enumerate(["#", "Description", "Qty", "Unit Price", "Amount"]):
        ws.write(hr, ci, h, stl["head"])
    r = hr + 1
    for i, it in enumerate(spec.items, 1):
        ws.write(r, 0, i)
        ws.write(r, 1, it.description)
        ws.write(r, 2, float(it.quantity))
        ws.write(r, 3, float(it.unit_price), stl["money"])
        ws.write(r, 4, float(it.amount), stl["money"])
        r += 1
    r += 1
    tot = [("Subtotal", spec.subtotal)]
    if spec.discount:
        tot.append(("Discount", -spec.discount))
    if spec.shipping:
        tot.append(("Shipping", spec.shipping))
    if spec.tax is not None:
        tot.append((f"{spec.locale.tax_name} {fmt_percent(spec.tax_rate)}", spec.tax))
    tot.append(("Total", spec.total))
    for k, v in tot:
        ws.write(r, 3, k, stl["bold"])
        ws.write(r, 4, float(v), stl["money"])
        r += 1
    ws.write(r + 1, 0, f"All amounts in {spec.currency}")
    ws.col(0).width = 256 * 30
    ws.col(1).width = 256 * 44
    for c in (2, 3, 4):
        ws.col(c).width = 256 * 16
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), name


# =================================================================== CSV
CSV_VARIANTS = {
    # name: delimiter, encoding, number_format, date_format, quoting
    "comma_us": (",", "utf-8", "plain", "iso", csv.QUOTE_MINIMAL),
    "semicolon_eu": (";", "utf-8", "eu", "dmy_dot", csv.QUOTE_MINIMAL),
    "tab_us": ("\t", "utf-8", "plain", "mdy_slash", csv.QUOTE_MINIMAL),
    "bom_uk": (",", "utf-8-sig", "plain", "dmy_slash", csv.QUOTE_MINIMAL),
    "cp1252_eu": (";", "cp1252", "eu", "dmy_dot", csv.QUOTE_MINIMAL),
    "quoted_us": (",", "utf-8", "us", "mdy_slash", csv.QUOTE_ALL),
    "line_level": (",", "utf-8", "plain", "iso", csv.QUOTE_MINIMAL),
    "symbols_us": (",", "utf-8", "us_symbol", "month_d_y", csv.QUOTE_MINIMAL),
}


def _csv_amount(v, nf: str, spec: InvoiceSpec) -> str:
    if v is None:
        return ""
    if nf == "us_symbol":
        s = fmt_amount(v, "us")
        sym = spec.locale.symbol or ""
        return f"-{sym}{s[1:]}" if s.startswith("-") else f"{sym}{s}"
    return fmt_amount(v, nf)


def csv_register(specs: list[InvoiceSpec], rng: Rng, variant: str) -> tuple[bytes, list, dict]:
    delim, enc, nf, df, quoting = CSV_VARIANTS[variant]
    buf = io.StringIO(newline="")
    w = csv.writer(buf, delimiter=delim, quoting=quoting, lineterminator="\r\n" if variant in ("bom_uk", "cp1252_eu") else "\n")
    rows = []
    if variant == "line_level":
        head = ["invoice_no", "invoice_date", "supplier", "customer", "currency", "line_no", "description",
                "quantity", "unit_price", "line_amount", "invoice_subtotal", "invoice_tax", "invoice_total"]
        w.writerow(head)
        line_no = 2
        for spec in specs:
            rows.append((spec, None, line_no, {"invoice_number", "invoice_date", "supplier_name", "customer_name",
                                               "currency", "subtotal", "tax", "total"}))
            for i, it in enumerate(spec.items, 1):
                w.writerow([spec.invoice_number or "", fmt_date(spec.invoice_date, df), spec.supplier.name,
                            spec.customer.name if spec.customer else "", spec.currency, i, it.description,
                            fmt_quantity(it.quantity), _csv_amount(it.unit_price, nf, spec), _csv_amount(it.amount, nf, spec),
                            _csv_amount(spec.subtotal, nf, spec), _csv_amount(spec.tax, nf, spec), _csv_amount(spec.total, nf, spec)])
                line_no += 1
        text = buf.getvalue()
        return text.encode(enc), rows, {"delimiter": delim, "encoding": enc, "number_format": nf, "date_format": df}
    with_customer = variant != "tab_us"
    order, headers = register_columns(rng, with_customer=with_customer, with_due=rng.chance(0.4), n_distractors=1)
    w.writerow([headers.get(c, c) for c in order])
    line_no = 2
    for spec in specs:
        out = []
        for col in order:
            v = _register_value(spec, col, rng)
            if col in ("subtotal", "tax", "total"):
                out.append(_csv_amount(v, nf, spec))
            elif col in ("invoice_date", "due_date"):
                out.append(fmt_date(v, df) if v else "")
            elif isinstance(v, float):
                out.append(_csv_amount(Decimal(str(v)), nf, spec))
            else:
                out.append("" if v is None else str(v))
        w.writerow(out)
        rows.append((spec, None, line_no, printed_fields(order)))
        line_no += 1
    if variant in ("quoted_us", "symbols_us"):
        total_row = [""] * len(order)
        total_row[0] = "TOTAL"
        total_row[order.index("total")] = _csv_amount(sum(s.total for s in specs), nf, specs[0])
        w.writerow(total_row)
    text = buf.getvalue()
    return text.encode(enc), rows, {"delimiter": delim, "encoding": enc, "number_format": nf, "date_format": df}
