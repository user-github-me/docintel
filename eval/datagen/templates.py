"""Eight invoice templates rendered with reportlab.

T1-T6 are the development split, T7-T8 the held-out split. Every renderer prints
exactly the fields present on the InvoiceSpec (None => the field and its label
are not printed), so labels can be derived from the spec.
"""
from __future__ import annotations

import textwrap
from datetime import timedelta
from decimal import Decimal

from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import KeepTogether, Paragraph, Spacer, Table, TableStyle

from .content import InvoiceSpec
from .formats import fmt_amount, fmt_date, fmt_percent, fmt_quantity, money, words_indian
from .pdfkit import BRAND_COLORS, HEX, P, PT, build_pdf, esc, frame_width, initials, logo, styles
from .util import Rng

import io

TEMPLATE_INFO = {
    "T1": {"split": "dev", "multipage": True, "desc": "Classic corporate: logo + INVOICE title, meta box, Bill To, gridded table, totals box (US/CA/AU)"},
    "T2": {"split": "dev", "multipage": True, "desc": "Two-column modern: colour band, From/Billed To columns, labels-above-values meta row, zebra table (UK, GBP, VAT)"},
    "T3": {"split": "dev", "multipage": True, "desc": "Minimal serif label:value layout, qty-first borderless table, no page numbers (US/AU/CA)"},
    "T4": {"split": "dev", "multipage": False, "desc": "Narrow POS receipt in Courier, upper-case store name, cash/change distractors, no customer"},
    "T5": {"split": "dev", "multipage": True, "desc": "EU business letter: address window, info block, Pos. table, 1.234,56 EUR, IBAN footer"},
    "T6": {"split": "dev", "multipage": True, "desc": "Bangladeshi bill: Mushak-6.3, Bill No./BIN/TIN, 'Total' = subtotal then VAT 15%, amount in words (BDT)"},
    "T7": {"split": "heldout", "multipage": True, "desc": "Canadian home-care services invoice with sidebar letterhead and per-line service dates (CAD)"},
    "T8": {"split": "heldout", "multipage": True, "desc": "Indian GST tax invoice with receiver/consignee boxes, HSN/SAC and CGST/SGST or IGST (INR)"},
}

GRID = HEX("#9ca3af")
LIGHT = HEX("#f3f4f6")


def _num(spec: InvoiceSpec, v) -> str:
    return fmt_amount(v, spec.locale.number_format)


def _qty(spec: InvoiceSpec, v) -> str:
    return fmt_quantity(v, spec.locale.number_format)


def _rate(spec: InvoiceSpec) -> str:
    return fmt_percent(spec.tax_rate, spec.locale.number_format)


def _date(spec: InvoiceSpec, d, fmt: str | None = None) -> str:
    return fmt_date(d, fmt or spec.extra.get("date_format") or spec.locale.date_format)


def _kv_table(rows, widths, font, bold, size=8.5, label_color="#374151", align_values="LEFT", pad=1.6):
    t = Table(rows, colWidths=widths)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), bold),
        ("FONTNAME", (1, 0), (1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), size),
        ("TEXTCOLOR", (0, 0), (0, -1), HEX(label_color)),
        ("ALIGN", (1, 0), (1, -1), align_values),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
    ]))
    return t


def _totals_table(rows, widths, font, bold, size=9, bold_last=True, line_color="#111827", box=False, bg_last=None):
    t = Table(rows, colWidths=widths)
    cmds = [
        ("FONTNAME", (0, 0), (-1, -1), font),
        ("FONTSIZE", (0, 0), (-1, -1), size),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    if bold_last:
        cmds += [("FONTNAME", (0, -1), (-1, -1), bold), ("LINEABOVE", (0, -1), (-1, -1), 1, HEX(line_color))]
    if box:
        cmds += [("BOX", (0, 0), (-1, -1), 0.6, GRID)]
    if bg_last:
        cmds += [("BACKGROUND", (0, -1), (-1, -1), HEX(bg_last))]
    t.setStyle(TableStyle(cmds))
    return t


def _item_rows(spec: InvoiceSpec, cell_style, *, with_qty=True, with_price=True, desc_first=True,
               sl=False, extra_cols=None):
    rows = []
    for i, it in enumerate(spec.items, 1):
        desc = PT(it.description, cell_style)
        cols = []
        if sl:
            cols.append(str(i))
        if not desc_first and with_qty:
            cols.append(_qty(spec, it.quantity))
        cols.append(desc)
        if extra_cols:
            cols.extend(extra_cols(it))
        if desc_first and with_qty:
            cols.append(_qty(spec, it.quantity))
        if with_price:
            cols.append(_num(spec, it.unit_price))
        cols.append(_num(spec, it.amount))
        rows.append(cols)
    return rows


# =========================================================================== T1
def render_t1(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    margins = (18 * mm, 18 * mm, 16 * mm, 24 * mm)
    width = frame_width(loc.pagesize, margins)
    W, H = loc.pagesize
    brand = rng.choice(BRAND_COLORS)
    st = styles("Helvetica", "Helvetica-Bold", 9)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors

    sup_block = [PT(sup.name, st["h2"])] + [PT(l, st["small"]) for l in sup.address]
    sup_block += [PT(f"Phone: {sup.phone}", st["small"]), PT(f"{sup.email}  |  {sup.website}", st["small"])]
    left = Table([[logo(initials(sup.name), brand, rng.choice(["square", "circle", "diamond"])), sup_block]],
                 colWidths=[19 * mm, width * 0.56 - 19 * mm])
    left.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    meta = []
    if spec.invoice_number:
        meta.append(["Invoice No.:", spec.invoice_number])
    if spec.invoice_date:
        meta.append(["Invoice Date:", _date(spec, spec.invoice_date)])
    if spec.due_date:
        meta.append(["Due Date:", _date(spec, spec.due_date)])
    meta.append(["PO Number:", d["po_number"]])
    meta.append(["Terms:", f"Net {spec.extra['terms_days']}"])
    title = Paragraph(f'<font color="{brand}">INVOICE</font>', st["h1"])
    right = [title, Spacer(1, 3 * mm), _kv_table(meta, [27 * mm, width * 0.44 - 27 * mm], "Helvetica", "Helvetica-Bold", 8.6)]
    header = Table([[left, right]], colWidths=[width * 0.56, width * 0.44])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    story = [header, Spacer(1, 7 * mm)]
    if cus:
        bill = [Paragraph(f'<font color="{brand}"><b>Bill To:</b></font>', st["normal"]), PT(cus.name, st["bold"])]
        bill += [PT(l, st["normal"]) for l in cus.address]
        bill += [PT(f"Customer ID: {d['customer_id']}", st["small"])]
        ship = [Paragraph(f'<font color="{brand}"><b>Order Details:</b></font>', st["normal"]),
                PT(f"Order Date: {_date(spec, d['order_date'])}", st["normal"]),
                PT(f"Sales Rep: {d['sales_rep']}", st["normal"])]
        blk = Table([[bill, ship]], colWidths=[width * 0.56, width * 0.44])
        blk.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        story += [blk, Spacer(1, 6 * mm)]

    data = [["Description", "Qty", "Unit Price", "Amount"]] + _item_rows(spec, st["cell"])
    t = Table(data, colWidths=[width * 0.52, width * 0.1, width * 0.19, width * 0.19], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEX(brand)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]))
    story += [t, Spacer(1, 4 * mm)]

    rows = [["Subtotal", _num(spec, spec.subtotal)]]
    if spec.discount:
        rows.append(["Discount", "-" + _num(spec, spec.discount)])
    if spec.shipping:
        rows.append(["Shipping & Handling", _num(spec, spec.shipping)])
    if spec.tax is not None:
        tname = "Tax" if loc.code == "US" else loc.tax_name
        rows.append([f"{tname} ({_rate(spec)})", _num(spec, spec.tax)])
    rows.append([f"Total ({spec.currency})", money(spec.total, loc, with_currency="symbol")])
    totals = _totals_table(rows, [38 * mm, 34 * mm], "Helvetica", "Helvetica-Bold", 9, line_color=brand, box=True, bg_last="#eef2f7")
    wrap = Table([["", totals]], colWidths=[width - 72 * mm, 72 * mm])
    wrap.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    notes = [Spacer(1, 6 * mm), PT("Payment details", st["label"]),
             PT(f"Bank: {d['bank_name']}  |  Account No: {d['account_no']}  |  Routing: {d['routing']}", st["small"]),
             PT("Please include the invoice number with your payment. Thank you for your business!", st["small"])]
    story += [KeepTogether([wrap] + notes)]

    num = spec.invoice_number

    def on_later(c, doc):
        c.setFont("Helvetica", 8)
        c.setFillColor(HEX("#4b5563"))
        txt = f"{sup.name} - Invoice {num} (continued)" if num else f"{sup.name} - Invoice (continued)"
        c.drawString(margins[0], H - 12 * mm, txt)

    def footer(c, page, total):
        c.setFont("Helvetica", 7.5)
        c.setFillColor(HEX("#6b7280"))
        c.drawString(margins[0], 12 * mm, f"{sup.name}  -  {sup.phone}  -  {sup.email}")
        c.drawRightString(W - margins[1], 12 * mm, f"Page {page} of {total}")
        if page < total:
            c.drawRightString(W - margins[1], 16 * mm, "Continued on next page...")

    return build_pdf(loc.pagesize, margins, story, on_later=on_later, footer=footer)


# =========================================================================== T2
def render_t2(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    W, H = loc.pagesize
    band = 26 * mm
    margins = (17 * mm, 17 * mm, band + 9 * mm, 24 * mm)
    width = frame_width(loc.pagesize, margins)
    brand = rng.choice(BRAND_COLORS)
    st = styles("Helvetica", "Helvetica-Bold", 9)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors

    def on_first(c, doc):
        c.setFillColor(HEX(brand))
        c.rect(0, H - band, W, band, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(margins[0], H - band / 2 - 2, sup.name)
        c.setFont("Helvetica-Bold", 20)
        c.drawRightString(W - margins[1], H - band / 2 - 4, "TAX INVOICE")

    def on_later(c, doc):
        c.setFillColor(HEX(brand))
        c.rect(0, H - 10 * mm, W, 10 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(margins[0], H - 6.5 * mm, sup.name)
        c.drawRightString(W - margins[1], H - 6.5 * mm, "TAX INVOICE (continued)")

    frm = [PT("FROM", st["label"]), PT(sup.name, st["bold"])] + [PT(l, st["normal"]) for l in sup.address]
    for lbl, val in sup.tax_ids[:1]:
        frm.append(PT(f"{lbl}: {val}", st["small"]))
    frm.append(PT(f"Tel: {sup.phone}", st["small"]))
    to = [PT("BILLED TO", st["label"])]
    if cus:
        to += [PT(cus.name, st["bold"])] + [PT(l, st["normal"]) for l in cus.address]
        to.append(PT(f"Customer Ref: {d['customer_id']}", st["small"]))
    cols = Table([[frm, to]], colWidths=[width / 2, width / 2])
    cols.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    labels, values = [], []
    if spec.invoice_number:
        labels.append("Invoice #"); values.append(spec.invoice_number)
    if spec.invoice_date:
        labels.append("Date of Issue"); values.append(_date(spec, spec.invoice_date))
    labels.append("Order No"); values.append(d["order_no"])
    if spec.due_date:
        labels.append("Due Date"); values.append(_date(spec, spec.due_date))
    labels.append("Delivery Date"); values.append(_date(spec, d["delivery_date"]))
    mw = width / len(labels)
    meta = Table([labels, values], colWidths=[mw] * len(labels))
    meta.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica"), ("FONTSIZE", (0, 0), (-1, 0), 7.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), HEX("#6b7280")),
        ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"), ("FONTSIZE", (0, 1), (-1, 1), 9.5),
        ("LINEABOVE", (0, 0), (-1, 0), 0.8, HEX(brand)), ("LINEBELOW", (0, 1), (-1, 1), 0.8, HEX(brand)),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))

    story = [cols, Spacer(1, 6 * mm), meta, Spacer(1, 6 * mm)]
    qty_head = "Hours" if spec.domain in ("homecare",) and all(it.unit == "hour" for it in spec.items) else "Qty"
    if spec.show_unit_price:
        data = [["Item", qty_head, "Rate", "Line Total"]] + _item_rows(spec, st["cell"])
        widths = [width * 0.55, width * 0.11, width * 0.16, width * 0.18]
    else:
        data = [["Item", "Line Total"]] + _item_rows(spec, st["cell"], with_qty=False, with_price=False)
        widths = [width * 0.78, width * 0.22]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 8.6),
        ("TEXTCOLOR", (0, 0), (-1, 0), HEX(brand)), ("LINEBELOW", (0, 0), (-1, 0), 1.2, HEX(brand)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, HEX("#f1f5f9")]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [t, Spacer(1, 5 * mm)]

    rows = [["Net Amount", "£" + _num(spec, spec.subtotal) if loc.currency == "GBP" else _num(spec, spec.subtotal)]]
    if spec.discount:
        rows.append(["Discount", "-" + _num(spec, spec.discount)])
    if spec.shipping:
        rows.append(["Delivery", _num(spec, spec.shipping)])
    if spec.tax is not None:
        rows.append([f"VAT ({_rate(spec)})", _num(spec, spec.tax)])
    rows.append(["Amount Due", money(spec.total, loc, with_currency="symbol")])
    totals = _totals_table(rows, [36 * mm, 32 * mm], "Helvetica", "Helvetica-Bold", 9.2, line_color=brand, bg_last="#e2e8f0")
    pay = [PT("Payment", st["label"]),
           PT(f"Bank: {d['bank_name']}", st["small"]),
           PT(f"Sort code: {d['sort_code']}   Account: {d['account_no_short']}", st["small"]),
           PT("Please use the invoice number as your payment reference.", st["small"]),
           PT(f"All amounts in {spec.currency}.", st["small"])]
    wrap = Table([[pay, totals]], colWidths=[width - 70 * mm, 70 * mm])
    wrap.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [KeepTogether([wrap])]

    def footer(c, page, total):
        c.setFont("Helvetica", 7.5)
        c.setFillColor(HEX("#6b7280"))
        reg = " | ".join(f"{a}: {b}" for a, b in sup.tax_ids)
        c.drawString(margins[0], 12 * mm, f"{sup.name}  |  {reg}")
        c.drawRightString(W - margins[1], 12 * mm, f"Page {page} of {total}")
        if page < total:
            c.drawRightString(W - margins[1], 16 * mm, "Continued on next page")

    return build_pdf(loc.pagesize, margins, story, on_first=on_first, on_later=on_later, footer=footer,
                     later_top_extra=-(band + 9 * mm) + 18 * mm)


# =========================================================================== T3
def render_t3(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    margins = (20 * mm, 20 * mm, 18 * mm, 20 * mm)
    width = frame_width(loc.pagesize, margins)
    st = styles("Times-Roman", "Times-Bold", 10)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors
    df = spec.extra.get("date_format", "month_d_y")

    story = [Paragraph(esc(sup.name), st["h1"].clone("t3h", alignment=1, fontName="Times-Bold", fontSize=20, leading=24)),
             PT(", ".join(sup.address), st["center_small"]),
             PT(f"Telephone {sup.phone}  -  {sup.email}", st["center_small"]),
             Spacer(1, 3 * mm)]
    rule = Table([[""]], colWidths=[width], rowHeights=[1])
    rule.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 0.8, colors.black)]))
    story += [rule, Spacer(1, 4 * mm)]

    lines = []
    if spec.invoice_number:
        lines.append(f"<b>Invoice Number:</b> {esc(spec.invoice_number)}")
    if spec.invoice_date:
        lines.append(f"<b>Dated:</b> {_date(spec, spec.invoice_date, df)}")
    if cus:
        lines.append(f"<b>Customer:</b> {esc(cus.name)}")
        lines += [esc(l) for l in cus.address]
    left = [Paragraph(x, st["normal"]) for x in lines]
    rlines = [f"<b>Customer Account:</b> {esc(d['account_ref'])}",
              f"<b>Order Date:</b> {_date(spec, d['order_date'], df)}"]
    if spec.due_date:
        rlines.append(f"<b>Payment Due:</b> {_date(spec, spec.due_date, df)}")
    rlines.append(f"<b>Ship Via:</b> {esc(d['carrier'])}")
    right = [Paragraph(x, st["normal"]) for x in rlines]
    blk = Table([[left, right]], colWidths=[width * 0.55, width * 0.45])
    blk.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [blk, Spacer(1, 7 * mm)]

    if spec.show_unit_price:
        data = [["Qty", "Description", "Price", "Total"]] + _item_rows(spec, st["cell"], desc_first=False)
        widths = [width * 0.1, width * 0.54, width * 0.17, width * 0.19]
    else:
        data = [["Qty", "Description", "Total"]] + _item_rows(spec, st["cell"], desc_first=False, with_price=False)
        widths = [width * 0.1, width * 0.7, width * 0.2]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Times-Bold"), ("FONTNAME", (0, 1), (-1, -1), "Times-Roman"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("LINEBELOW", (0, 0), (-1, 0), 1, colors.black), ("LINEBELOW", (0, 1), (-1, -1), 0.25, HEX("#d1d5db")),
        ("ALIGN", (0, 0), (0, -1), "CENTER"), ("ALIGN", (2, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story += [t, Spacer(1, 5 * mm)]

    cur = spec.currency
    rows = [["Sub Total", _num(spec, spec.subtotal)]]
    if spec.discount:
        rows.append(["Less Discount", "(" + _num(spec, spec.discount) + ")"])
    if spec.tax is not None:
        tname = "Sales Tax" if loc.code == "US" else loc.tax_name
        rows.append([f"{tname} ({_rate(spec)})", _num(spec, spec.tax)])
    if spec.shipping:
        rows.append(["Shipping", _num(spec, spec.shipping)])
    rows.append(["Grand Total", f"{cur} {_num(spec, spec.total)}"])
    totals = _totals_table(rows, [40 * mm, 36 * mm], "Times-Roman", "Times-Bold", 10)
    wrap = Table([[PT("Thank you for your order. Goods remain our property until paid in full.", st["small"]), totals]],
                 colWidths=[width - 76 * mm, 76 * mm])
    wrap.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "BOTTOM"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [KeepTogether([wrap])]
    return build_pdf(loc.pagesize, margins, story, later_top_extra=0)


# =========================================================================== T4
def render_t4(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    d = spec.distractors
    W = 80 * mm
    cols = 40
    font_size = 7.6
    lead = 10.2
    lines: list[tuple[str, str]] = []  # (text, mode)

    def center(text, mode="center"):
        for chunk in textwrap.wrap(text, cols, break_long_words=False) or [""]:
            lines.append((chunk, mode))

    def lr(left, right, mode="left"):
        space = max(1, cols - len(left) - len(right))
        lines.append((left + " " * space + right, mode))

    def sep(ch="-"):
        lines.append((ch * cols, "left"))

    sup = spec.supplier
    center(sup.name, "center_bold")
    for l in sup.address:
        center(l)
    center(f"Tel: {sup.phone}")
    if sup.tax_ids:
        center(f"{sup.tax_ids[0][0]}: {sup.tax_ids[0][1]}")
    sep("=")
    center("TAX INVOICE", "center_bold")
    if spec.invoice_number:
        lines.append((f"Invoice No: {spec.invoice_number}", "left"))
    if spec.invoice_date:
        lines.append((f"Date: {_date(spec, spec.invoice_date)}  {d['time']}", "left"))
    lr(f"Cashier: {d['cashier']}", f"Till: {d['till']}")
    lines.append((f"Order #: {d['order_no_short']}", "left"))
    sep()
    lr("ITEM", "AMOUNT", "bold")
    for it in spec.items:
        for chunk in textwrap.wrap(it.description, cols, break_long_words=False):
            lines.append((chunk, "left"))
        lr(f"  {_qty(spec, it.quantity)} x {_num(spec, it.unit_price)}", _num(spec, it.amount))
    sep()
    lr("SUBTOTAL", _num(spec, spec.subtotal))
    if spec.discount:
        lr("DISCOUNT", "-" + _num(spec, spec.discount))
    if spec.tax is not None:
        lr(f"{loc.tax_name.upper()} {_rate(spec)}", _num(spec, spec.tax))
    lr("TOTAL", f"{spec.currency} {_num(spec, spec.total)}", "bold")
    sep()
    lr("CASH", _num(spec, d["cash"]))
    lr("CHANGE", _num(spec, d["change"]))
    sep()
    center(f"All amounts in {spec.currency}")
    center("Thank you for shopping with us!")
    center("Goods sold are not returnable after 7 days.")

    top, bottom = 9 * mm, 9 * mm
    H = top + bottom + lead * len(lines)
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(W, H), invariant=1)
    c.setTitle("Invoice")
    y = H - top
    x0 = 5.5 * mm
    for text, mode in lines:
        bold = mode in ("center_bold", "bold")
        c.setFont("Courier-Bold" if bold else "Courier", font_size + (0.6 if mode == "center_bold" else 0))
        if mode.startswith("center"):
            c.drawCentredString(W / 2, y, text)
        else:
            c.drawString(x0, y, text)
        y -= lead
    c.showPage()
    c.save()
    return buf.getvalue()


# =========================================================================== T5
def render_t5(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    W, H = loc.pagesize
    margins = (22 * mm, 18 * mm, 14 * mm, 30 * mm)
    width = frame_width(loc.pagesize, margins)
    brand = rng.choice(BRAND_COLORS)
    st = styles("Helvetica", "Helvetica-Bold", 9)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors
    eur = lambda v: money(v, loc, with_currency="symbol")

    head = Table([["", [Paragraph(f'<font color="{brand}">{esc(sup.name)}</font>', st["h2"].clone("t5h", alignment=2)),
                        PT(" - ".join(sup.address), st["small"].clone("t5a", alignment=2)),
                        PT(f"Phone {sup.phone}  -  {sup.email}", st["small"].clone("t5b", alignment=2))]]],
                 colWidths=[width * 0.3, width * 0.7])
    head.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))

    sender = Paragraph(f'<u>{esc(sup.name)} - {esc(sup.address[0])} - {esc(sup.address[-1])}</u>', st["tiny"])
    addr = [sender, Spacer(1, 2 * mm)]
    if cus:
        addr += [PT(cus.name, st["bold"])] + [PT(l, st["normal"]) for l in cus.address]
    info = []
    if spec.invoice_number:
        info.append(["Invoice No.", spec.invoice_number])
    if spec.invoice_date:
        info.append(["Invoice Date", _date(spec, spec.invoice_date)])
    info.append(["Delivery Date", _date(spec, d["delivery_date"])])
    info.append(["Customer No.", d["customer_no"]])
    if spec.due_date:
        info.append(["Due Date", _date(spec, spec.due_date)])
    info.append(["Contact", d["contact"]])
    info_t = _kv_table(info, [28 * mm, 42 * mm], "Helvetica", "Helvetica-Bold", 8.5)
    blk = Table([[addr, info_t]], colWidths=[width - 72 * mm, 72 * mm])
    blk.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))

    period = d["period_label"]
    story = [head, Spacer(1, 12 * mm), blk, Spacer(1, 12 * mm),
             PT("Invoice", st["h2"]), PT(f"Services and deliveries for {period}", st["normal"]), Spacer(1, 3 * mm),
             PT("Dear Sir or Madam, we hereby invoice you for the following items:", st["normal"]), Spacer(1, 4 * mm)]

    data = [["Pos.", "Description", "Qty", "Unit", "Unit Price", "Amount"]]
    for i, it in enumerate(spec.items, 1):
        data.append([str(i), PT(it.description, st["cell"]), _qty(spec, it.quantity), it.unit,
                     _num(spec, it.unit_price), _num(spec, it.amount)])
    t = Table(data, colWidths=[width * 0.07, width * 0.45, width * 0.09, width * 0.09, width * 0.14, width * 0.16], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("BACKGROUND", (0, 0), (-1, 0), HEX("#e5e7eb")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.black), ("LINEBELOW", (0, -1), (-1, -1), 0.8, colors.black),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"), ("ALIGN", (4, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story += [t, Spacer(1, 3 * mm)]
    rows = [["Total excl. VAT", eur(spec.subtotal)]]
    if spec.discount:
        rows.insert(0, ["Discount", "-" + eur(spec.discount)])
    if spec.shipping:
        rows.append(["Freight", eur(spec.shipping)])
    if spec.tax is not None:
        rows.append([f"VAT {_rate(spec)}", eur(spec.tax)])
    rows.append(["Total incl. VAT" if spec.tax is not None else "Invoice Total", eur(spec.total)])
    totals = _totals_table(rows, [40 * mm, 34 * mm], "Helvetica", "Helvetica-Bold", 9)
    wrap = Table([["", totals]], colWidths=[width - 74 * mm, 74 * mm])
    wrap.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    terms = (f"Please transfer the invoice amount within {spec.extra['terms_days']} days to the account below, "
             f"quoting the invoice number.")
    story += [KeepTogether([wrap, Spacer(1, 6 * mm), PT(terms, st["normal"]), Spacer(1, 3 * mm),
                            PT("Kind regards", st["normal"]), PT(sup.name, st["normal"])])]

    num = spec.invoice_number

    def on_later(c, doc):
        c.setFont("Helvetica", 8)
        c.setFillColor(HEX("#4b5563"))
        c.drawString(margins[0], H - 11 * mm, f"Invoice {num} - continued" if num else "Invoice - continued")

    def footer(c, page, total):
        c.setStrokeColor(HEX("#9ca3af"))
        c.line(margins[0], 24 * mm, W - margins[1], 24 * mm)
        c.setFont("Helvetica", 6.8)
        c.setFillColor(HEX("#4b5563"))
        x1, x2, x3 = margins[0], margins[0] + width * 0.36, margins[0] + width * 0.7
        c.drawString(x1, 20 * mm, sup.name)
        c.drawString(x1, 17 * mm, sup.address[0])
        c.drawString(x1, 14 * mm, sup.address[-1])
        c.drawString(x2, 20 * mm, f"Bank: {d['bank_name']}")
        c.drawString(x2, 17 * mm, f"IBAN: {d['iban']}")
        c.drawString(x2, 14 * mm, f"BIC: {d['bic']}")
        for k, (lbl, val) in enumerate(sup.tax_ids[:2]):
            c.drawString(x3, (20 - 3 * k) * mm, f"{lbl}: {val}")
        c.drawString(x3, 14 * mm, f"Managing Director: {d['director']}")
        c.setFont("Helvetica", 7.5)
        c.drawRightString(W - margins[1], 8 * mm, f"Page {page} of {total}")

    return build_pdf(loc.pagesize, margins, story, on_later=on_later, footer=footer)


# =========================================================================== T6
def render_t6(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    W, H = loc.pagesize
    margins = (16 * mm, 16 * mm, 14 * mm, 22 * mm)
    width = frame_width(loc.pagesize, margins)
    font, bold = rng.choice([("Helvetica", "Helvetica-Bold"), ("Times-Roman", "Times-Bold")])
    st = styles(font, bold, 9.5)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors
    tk = lambda v: _num(spec, v)

    mushak = Table([["Mushak-6.3"]], colWidths=[24 * mm])
    mushak.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.6, colors.black), ("FONTNAME", (0, 0), (-1, -1), bold),
                                ("FONTSIZE", (0, 0), (-1, -1), 7.5), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    head = [Paragraph(esc(sup.name), st["h2"].clone("t6h", alignment=1, fontSize=15, leading=18)),
            PT(", ".join(sup.address), st["center"]),
            PT(f"Phone: {sup.phone}  |  Email: {sup.email}", st["center_small"]),
            PT("  |  ".join(f"{a}: {b}" for a, b in sup.tax_ids), st["center_small"])]
    top = Table([[ "", head, mushak]], colWidths=[24 * mm, width - 48 * mm, 24 * mm])
    top.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    title = spec.extra.get("bd_title", "INVOICE")
    story = [top, Spacer(1, 4 * mm), Paragraph(f"<u>{title}</u>", st["h2"].clone("t6t", alignment=1, fontSize=13)), Spacer(1, 4 * mm)]

    left = []
    if spec.invoice_number:
        left.append(Paragraph(f"<b>Bill No.:</b> {esc(spec.invoice_number)}", st["normal"]))
    if cus:
        left.append(Paragraph("<b>Customer:</b>", st["normal"]))
        left += [PT(cus.name, st["bold"])] + [PT(l, st["normal"]) for l in cus.address]
    right = []
    if spec.invoice_date:
        right.append(Paragraph(f"<b>Bill Date:</b> {_date(spec, spec.invoice_date)}", st["normal"]))
    right.append(Paragraph(f"<b>Work Order No.:</b> {esc(d['work_order'])}", st["normal"]))
    right.append(Paragraph(f"<b>Challan No.:</b> {esc(d['challan_no'])}", st["normal"]))
    right.append(Paragraph(f"<b>Delivery Date:</b> {_date(spec, d['delivery_date'])}", st["normal"]))
    if spec.due_date:
        right.append(Paragraph(f"<b>Payment Due:</b> {_date(spec, spec.due_date)}", st["normal"]))
    blk = Table([[left, right]], colWidths=[width * 0.58, width * 0.42])
    blk.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [blk, Spacer(1, 5 * mm)]

    data = [["SL", "Description", "Qty", "Rate (Tk)", "Amount (Tk)"]] + _item_rows(spec, st["cell"], sl=True)
    t = Table(data, colWidths=[width * 0.07, width * 0.49, width * 0.1, width * 0.16, width * 0.18], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), bold), ("FONTNAME", (0, 1), (-1, -1), font), ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("BACKGROUND", (0, 0), (-1, 0), HEX("#e5e7eb")),
        ("ALIGN", (0, 0), (0, -1), "CENTER"), ("ALIGN", (2, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story += [t]
    rows = [["Total", tk(spec.subtotal)]]
    if spec.discount:
        rows.append(["Less: Discount", "-" + tk(spec.discount)])
    if spec.shipping:
        rows.append(["Carrying Charge", tk(spec.shipping)])
    if spec.tax is not None:
        rows.append([f"VAT {_rate(spec)}", tk(spec.tax)])
    final_label = spec.extra.get("bd_final", "Grand Total (BDT)")
    rows.append([final_label, tk(spec.total)])
    totals = Table(rows, colWidths=[width * 0.26, width * 0.18])
    totals.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), font), ("FONTNAME", (0, -1), (-1, -1), bold), ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    wrap = Table([["", totals]], colWidths=[width * 0.56, width * 0.44])
    wrap.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 0)]))
    words = words_indian(spec.total, "Taka", "Paisa")
    sig = Table([["____________________", "____________________"],
                 ["Received by", f"For {sup.name}"],
                 ["", "Authorized Signature"]], colWidths=[width / 2, width / 2])
    sig.setStyle(TableStyle([("FONTNAME", (0, 0), (-1, -1), font), ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                             ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [KeepTogether([wrap, Spacer(1, 3 * mm), Paragraph(f"<b>In words:</b> {esc(words)}", st["normal"]),
                            Spacer(1, 2 * mm), PT("Payment by cheque/pay order in favour of the company or bKash/bank transfer.", st["small"]),
                            Spacer(1, 14 * mm), sig])]

    def footer(c, page, total):
        c.setFont(font, 7.5)
        c.setFillColor(HEX("#374151"))
        c.drawCentredString(W / 2, 10 * mm, f"Page {page}/{total}")

    return build_pdf(loc.pagesize, margins, story, footer=footer, later_top_extra=0)


# =========================================================================== T7 (held-out)
def render_t7(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    W, H = loc.pagesize
    side = 54 * mm
    margins = (10 * mm, 14 * mm, 16 * mm, 20 * mm)
    width = frame_width(loc.pagesize, margins, left_extra=side)
    brand = rng.choice(["#0f766e", "#1d4ed8", "#6d28d9", "#9f1239", "#155e75"])
    st = styles("Helvetica", "Helvetica-Bold", 9)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors

    def sidebar(c, doc):
        c.setFillColor(HEX(brand))
        c.rect(0, 0, side, H, stroke=0, fill=1)
        c.setFillColor(colors.white)
        y = H - 22 * mm
        c.setFont("Helvetica-Bold", 12)
        for chunk in textwrap.wrap(sup.name, 22):
            c.drawString(8 * mm, y, chunk)
            y -= 14
        y -= 6
        c.setFont("Helvetica", 8)
        for line in sup.address + [sup.phone, sup.email, sup.website]:
            for chunk in textwrap.wrap(line, 36):
                c.drawString(8 * mm, y, chunk)
                y -= 11
        y -= 8
        for lbl, val in sup.tax_ids:
            c.drawString(8 * mm, y, f"{lbl}")
            y -= 10
            c.drawString(8 * mm, y, val)
            y -= 12
        c.setFont("Helvetica-Oblique", 7.5)
        c.drawString(8 * mm, 18 * mm, "Caring for you at home.")

    story = [Paragraph(f'<font color="{brand}">Home Care Services Invoice</font>', st["h2"].clone("t7h", fontSize=17, leading=21)),
             Spacer(1, 5 * mm)]
    meta = []
    if spec.invoice_number:
        meta.append(["Document No.", spec.invoice_number])
    if spec.invoice_date:
        meta.append(["Issue Date", _date(spec, spec.invoice_date)])
    if spec.due_date:
        meta.append(["Payment Due", _date(spec, spec.due_date)])
    meta.append(["Service Period", f"{_date(spec, d['period_start'])} to {_date(spec, d['period_end'])}"])
    meta.append(["Care Plan ID", d["care_plan"]])
    meta_t = _kv_table(meta, [28 * mm, 52 * mm], "Helvetica", "Helvetica-Bold", 8.6)
    holder = [PT("Account Holder", st["label"])]
    if cus:
        holder += [PT(cus.name, st["bold"])] + [PT(l, st["normal"]) for l in cus.address]
    recip = [PT("Service Recipient", st["label"]), PT(d["patient"], st["normal"]), PT(f"Client ID: {d['client_id']}", st["small"])]
    blk = Table([[holder, [meta_t, Spacer(1, 3 * mm)] + recip]], colWidths=[width * 0.46, width * 0.54])
    blk.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [blk, Spacer(1, 7 * mm)]

    data = [["Service Date", "Service", "Units", "Rate", "Charge"]]
    for it in spec.items:
        data.append([_date(spec, it.service_date), PT(it.description, st["cell"]), _qty(spec, it.quantity),
                     _num(spec, it.unit_price), _num(spec, it.amount)])
    t = Table(data, colWidths=[width * 0.17, width * 0.43, width * 0.1, width * 0.14, width * 0.16], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 8.4),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white), ("BACKGROUND", (0, 0), (-1, 0), HEX(brand)),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, HEX("#cbd5e1")),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.2),
    ]))
    story += [t, Spacer(1, 5 * mm)]
    rows = [["Charges before tax", _num(spec, spec.subtotal)]]
    if spec.discount:
        rows.append(["Courtesy discount", "-" + _num(spec, spec.discount)])
    if spec.tax is not None:
        rows.append([f"{loc.tax_name} {_rate(spec)}", _num(spec, spec.tax)])
    rows.append([f"Balance Owing ({spec.currency})", money(spec.total, loc, with_currency="symbol")])
    totals = _totals_table(rows, [42 * mm, 30 * mm], "Helvetica", "Helvetica-Bold", 9, line_color=brand, bg_last="#ecfeff")
    wrap = Table([[PT("Questions about this invoice? Contact our billing office. Payments by cheque or e-transfer.", st["small"]), totals]],
                 colWidths=[width - 74 * mm, 74 * mm])
    wrap.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [KeepTogether([wrap])]

    def footer(c, page, total):
        c.setFont("Helvetica", 7.5)
        c.setFillColor(HEX("#475569"))
        c.drawRightString(W - margins[1], 10 * mm, f"Page {page} of {total}")

    return build_pdf(loc.pagesize, margins, story, on_first=sidebar, on_later=sidebar, footer=footer,
                     later_top_extra=0, left_extra=side)


# =========================================================================== T8 (held-out)
def render_t8(spec: InvoiceSpec, rng: Rng) -> bytes:
    loc = spec.locale
    W, H = loc.pagesize
    margins = (14 * mm, 14 * mm, 12 * mm, 20 * mm)
    width = frame_width(loc.pagesize, margins)
    st = styles("Helvetica", "Helvetica-Bold", 8.6)
    sup, cus, d = spec.supplier, spec.customer, spec.distractors
    inr = lambda v: _num(spec, v)
    box = [("BOX", (0, 0), (-1, -1), 0.7, colors.black), ("VALIGN", (0, 0), (-1, -1), "TOP"),
           ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]

    title = Table([[PT("TAX INVOICE", st["center_bold"].clone("t8t", fontSize=13, leading=16))],
                   [PT("(Original for Recipient)", st["center_small"])]], colWidths=[width])
    sup_cell = [PT(sup.name, st["h3"])] + [PT(l, st["normal"]) for l in sup.address]
    sup_cell += [PT(f"{a}: {b}", st["normal"]) for a, b in sup.tax_ids]
    sup_cell += [PT(f"Phone: {sup.phone}  Email: {sup.email}", st["small"])]
    det = []
    if spec.invoice_number:
        det.append(["Invoice Serial No.", spec.invoice_number])
    if spec.invoice_date:
        det.append(["Date of Invoice", _date(spec, spec.invoice_date)])
    det += [["Place of Supply", d["place_of_supply"]], ["Currency", spec.currency], ["Reverse Charge", "No"],
            ["E-Way Bill No.", d["eway"]], ["Buyer's Order No.", d["po_number"]]]
    if spec.due_date:
        det.append(["Payment Due By", _date(spec, spec.due_date)])
    det_t = _kv_table(det, [32 * mm, width * 0.42 - 34 * mm], "Helvetica", "Helvetica-Bold", 8.2, pad=1.4)
    top = Table([[sup_cell, det_t]], colWidths=[width * 0.58, width * 0.42])
    top.setStyle(TableStyle(box + [("LINEAFTER", (0, 0), (0, -1), 0.7, colors.black)]))

    recv = [PT("Details of Receiver (Billed to)", st["label"])]
    if cus:
        recv += [PT(cus.name, st["bold"])] + [PT(l, st["normal"]) for l in cus.address]
        if d.get("receiver_gstin"):
            recv.append(PT(f"GSTIN: {d['receiver_gstin']}", st["normal"]))
    cons = [PT("Details of Consignee (Shipped to)", st["label"]), PT(d["consignee"], st["bold"])]
    cons += [PT(l, st["normal"]) for l in d["consignee_address"]]
    parties = Table([[recv, cons]], colWidths=[width / 2, width / 2])
    parties.setStyle(TableStyle(box + [("LINEAFTER", (0, 0), (0, -1), 0.7, colors.black)]))

    data = [["S.No", "Description of Goods/Services", "HSN/SAC", "Qty", "Rate", "Taxable Value"]]
    for i, it in enumerate(spec.items, 1):
        data.append([str(i), PT(it.description, st["cell"]), it.hsn, _qty(spec, it.quantity), inr(it.unit_price), inr(it.amount)])
    t = Table(data, colWidths=[width * 0.07, width * 0.41, width * 0.11, width * 0.08, width * 0.15, width * 0.18], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTSIZE", (0, 0), (-1, -1), 8.2),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black), ("BACKGROUND", (0, 0), (-1, 0), HEX("#f3f4f6")),
        ("ALIGN", (0, 0), (0, -1), "CENTER"), ("ALIGN", (3, 0), (-1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    rows = [["Taxable Value", inr(spec.subtotal)]]
    if spec.discount:
        rows.insert(0, ["Trade Discount", "-" + inr(spec.discount)])
    if spec.shipping:
        rows.append(["Freight & Insurance", inr(spec.shipping)])
    if spec.tax is not None:
        if spec.extra.get("tax_split") == "cgst_sgst":
            half = fmt_percent(spec.tax_rate / 2)
            rows.append([f"CGST @ {half}", inr(spec.extra["cgst"])])
            rows.append([f"SGST @ {half}", inr(spec.extra["sgst"])])
        else:
            rows.append([f"IGST @ {_rate(spec)}", inr(spec.tax)])
        rows.append(["Total Tax", inr(spec.tax)])
    rows.append(["Total Invoice Value (Rs.)", inr(spec.total)])
    summ = Table(rows, colWidths=[46 * mm, 32 * mm])
    summ.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"), ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.4), ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    bank = [PT("Bank Details", st["label"]), PT(f"Bank: {d['bank_name']}", st["small"]),
            PT(f"A/c No.: {d['account_no']}", st["small"]), PT(f"IFSC: {d['ifsc']}", st["small"]),
            Spacer(1, 2 * mm), PT("Declaration: We declare that this invoice shows the actual price of the goods/services described.", st["tiny"])]
    lower = Table([[bank, summ]], colWidths=[width - 80 * mm, 80 * mm])
    lower.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    words = words_indian(spec.total, "Rupees", "Paise")
    sign = Table([["", PT(f"For {sup.name}", st["right_bold"])], ["", ""], ["", PT("Authorised Signatory", st["right"])]],
                 colWidths=[width / 2, width / 2], rowHeights=[None, 10 * mm, None])
    story = [title, Spacer(1, 2 * mm), top, parties, Spacer(1, 3 * mm), t, Spacer(1, 3 * mm),
             KeepTogether([lower, Spacer(1, 2 * mm), Paragraph(f"<b>Amount in words:</b> {esc(words)}", st["normal"]),
                           Spacer(1, 4 * mm), sign])]

    def footer(c, page, total):
        c.setFont("Helvetica", 7)
        c.setFillColor(HEX("#374151"))
        c.drawString(margins[0], 10 * mm, "This is a computer generated invoice.")
        c.drawRightString(W - margins[1], 10 * mm, f"Page {page} of {total}")

    return build_pdf(loc.pagesize, margins, story, footer=footer, later_top_extra=0)


RENDERERS = {"T1": render_t1, "T2": render_t2, "T3": render_t3, "T4": render_t4, "T5": render_t5,
             "T6": render_t6, "T7": render_t7, "T8": render_t8}


def render(spec: InvoiceSpec, rng: Rng) -> bytes:
    return RENDERERS[spec.template](spec, rng)
