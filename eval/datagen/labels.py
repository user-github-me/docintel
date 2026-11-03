"""Ground-truth label construction (schema documented in eval/README.md)."""
from __future__ import annotations

from datetime import date

from .content import InvoiceSpec
from .util import fmt2, fmt_qty

ALL_FIELDS = {"invoice_number", "invoice_date", "due_date", "supplier_name", "customer_name", "currency",
              "subtotal", "tax", "discount", "shipping", "total"}


def iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def invoice_label(spec: InvoiceSpec, *, printed: set[str] | None = None, line_items: bool = True,
                  pages: list[int] | None = None, sheet: str | None = None, row: int | None = None,
                  anomalies: list[str] | None = None) -> dict:
    printed = ALL_FIELDS if printed is None else printed

    def keep(field, value):
        return value if field in printed else None

    items = []
    if line_items:
        for it in spec.items:
            items.append({
                "description": it.description,
                "quantity": fmt_qty(it.quantity) if spec.show_qty else None,
                "unit_price": fmt2(it.unit_price) if spec.show_unit_price else None,
                "amount": fmt2(it.amount),
            })
    return {
        "invoice_number": keep("invoice_number", spec.invoice_number),
        "invoice_date": iso(keep("invoice_date", spec.invoice_date)),
        "due_date": iso(keep("due_date", spec.due_date)),
        "supplier_name": keep("supplier_name", spec.supplier.name),
        "customer_name": keep("customer_name", spec.customer.name if spec.customer else None),
        "currency": keep("currency", spec.currency),
        "subtotal": fmt2(keep("subtotal", spec.subtotal)),
        "tax": fmt2(keep("tax", spec.tax)),
        "discount": fmt2(keep("discount", spec.discount)),
        "shipping": fmt2(keep("shipping", spec.shipping)),
        "total": fmt2(keep("total", spec.total)),
        "line_items": items,
        "pages": pages,
        "sheet": sheet,
        "row": row,
        "anomalies": list(spec.anomalies if anomalies is None else anomalies),
    }


def doc_label(*, doc_id: str, file: str, file_type: str, category: str, template: str | None, split: str,
              degradation: dict | None = None, invoices: list[dict] | None = None, expect_failure: bool = False,
              expected_error: str | None = None) -> dict:
    deg = None
    if degradation:
        deg = {k: degradation[k] for k in ("level", "dpi", "rotation_deg", "rotate90", "noise_sigma", "blur",
                                           "contrast", "jpeg_quality", "salt_pepper")}
    return {
        "doc_id": doc_id,
        "file": file,
        "file_type": file_type,
        "category": category,
        "template": template,
        "split": split,
        "degradation": deg,
        "expect_failure": expect_failure,
        "expected_error": expected_error,
        "invoices": invoices or [],
    }
