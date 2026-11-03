"""Builds complete InvoiceSpecs (with distractors and optional anomalies) per template."""
from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
from decimal import Decimal

from .content import (DOMAINS, ContentFactory, InvoiceSpec, Item, Numbering, apply_totals, make_items,
                      random_date)
from .formats import LOCALES, MONTHS
from .util import D, Rng, q2

TEMPLATE_LOCALES = {
    "T1": ["US", "US", "CA", "AU"],
    "T2": ["UK"],
    "T3": ["US", "AU", "CA_AB"],
    "T4": ["US", "UK", "AU", "CA"],
    "T5": ["DE", "FR", "NL", "DE"],
    "T6": ["BD"],
    "T7": ["CA", "CA_AB"],
    "T8": ["IN"],
}
TEMPLATE_DOMAINS = {
    "T1": ["it", "office", "logistics", "homecare", "medical"],
    "T2": ["it", "homecare", "logistics", "office"],
    "T3": ["office", "medical", "homecare", "it"],
    "T4": ["pharmacy", "store"],
    "T5": ["it", "logistics", "office", "medical", "homecare"],
    "T6": ["medical", "homecare", "it", "office", "logistics"],
    "T7": ["homecare"],
    "T8": ["it", "medical", "logistics", "office", "homecare"],
}
SUPPORTS_DISCOUNT = {"T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"}
SUPPORTS_SHIPPING = {"T1", "T2", "T3", "T5", "T6", "T8"}

ANOMALIES = ["total_mismatch", "line_sum_mismatch", "missing_invoice_number", "missing_date",
             "missing_tax", "negative_amount", "future_date"]

BANKS = {"US": ["Chase Bank", "Wells Fargo", "Bank of America", "First Republic"],
         "CA": ["RBC Royal Bank", "TD Canada Trust", "Scotiabank"], "CA_AB": ["ATB Financial", "RBC Royal Bank"],
         "AU": ["Commonwealth Bank", "Westpac", "ANZ"], "UK": ["Barclays", "HSBC UK", "Lloyds Bank", "NatWest"],
         "DE": ["Deutsche Bank", "Commerzbank", "Sparkasse Berlin"], "FR": ["BNP Paribas", "Crédit Agricole", "Société Générale"],
         "NL": ["ING Bank", "ABN AMRO", "Rabobank"], "BD": ["Dutch-Bangla Bank", "BRAC Bank", "City Bank"],
         "IN": ["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank"]}
CASHIERS = ["Maria", "John", "Aisha", "Tom", "Priya", "Lucas", "Fatima", "Ben"]
CARRIERS = ["UPS Ground", "FedEx Express", "USPS Priority", "DHL", "Customer pickup"]
HSN = {"it": ["998313", "998316", "847130", "851762"], "medical": ["901819", "300490", "401519", "630790"],
       "logistics": ["996511", "996791", "996812"], "office": ["482020", "960810", "847290"],
       "homecare": ["999311", "999319", "998533"]}


class InvoiceFactory:
    def __init__(self, seed: int):
        self.content = ContentFactory(seed)
        self.numbering = Numbering()

    # ------------------------------------------------------------------ public
    def make(self, template: str, rng: Rng, *, n_items: int | None = None, anomaly: str | None = None,
             locale_code: str | None = None, domain: str | None = None, extras: bool = True) -> InvoiceSpec:
        loc = LOCALES[locale_code or rng.choice(TEMPLATE_LOCALES[template])]
        domain = domain or rng.choice(TEMPLATE_DOMAINS[template])
        supplier = self.content.company(loc, domain, rng)
        if template == "T4":
            supplier = replace(supplier, name=supplier.name.upper())
        person = template == "T7" or (domain == "homecare" and rng.chance(0.45))
        cust_domain = rng.choice([x for x in DOMAINS if x != domain])
        customer = None if template == "T4" else self.content.company(loc, cust_domain, rng, person=person)

        inv_date = random_date(rng)
        terms = rng.choice([7, 14, 15, 30, 30, 30, 45, 60])
        if n_items is None:
            n_items = rng.choice([1, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8])
        items = make_items(loc, domain, n_items, rng)
        if template == "T4":  # shop receipts: small baskets
            for it in items:
                it.quantity = D(rng.choice([1, 1, 1, 2, 2, 3, 4]))
                it.amount = q2(it.quantity * it.unit_price)
        if anomaly == "negative_amount":
            src = rng.choice(items)
            items.append(Item(f"Return credit - {src.description}", Decimal("-1"), src.unit, src.unit_price, -src.unit_price))

        rate = D(rng.choice(loc.tax_rates))
        spec = InvoiceSpec(
            template=template, locale=loc, domain=domain,
            invoice_number=None, invoice_date=inv_date, due_date=None,
            supplier=supplier, customer=customer, currency=loc.currency, tax_rate=rate,
            items=items, subtotal=Decimal("0"), discount=None, shipping=None, tax=Decimal("0"), total=Decimal("0"),
        )
        spec.extra["terms_days"] = terms
        spec.invoice_number = self.numbering.make(template, loc, inv_date, supplier, rng)
        self._template_options(spec, rng)

        # discount / shipping
        est = sum((it.amount for it in items), Decimal("0"))
        if extras and template in SUPPORTS_DISCOUNT and rng.chance(0.18) and est > 0:
            spec.discount = q2(est * D(rng.choice(["0.05", "0.1", "0.02"])))
        if extras and template in SUPPORTS_SHIPPING and rng.chance(0.22):
            spec.shipping = q2(D(rng.choice(["9.95", "15", "25", "49.50", "12.40"])) * loc.price_factor)
            if loc.currency in ("BDT", "INR"):
                spec.shipping = spec.shipping.quantize(Decimal("1"))
        apply_totals(spec)
        if anomaly and anomaly != "negative_amount":
            self.apply_anomaly(spec, anomaly, rng)
        elif anomaly:
            spec.anomalies.append(anomaly)
        self._distractors(spec, rng)
        self._due_date(spec, rng)
        return spec

    def duplicate_of(self, original: InvoiceSpec) -> InvoiceSpec:
        """Same supplier + invoice number + amounts/date: the invoice was sent twice."""
        return replace(original, items=[replace(it) for it in original.items], extra=dict(original.extra),
                       distractors=dict(original.distractors), anomalies=["duplicate_invoice"])

    # ------------------------------------------------------------------ anomalies
    def apply_anomaly(self, spec: InvoiceSpec, anomaly: str, rng: Rng) -> None:
        if anomaly == "total_mismatch":
            delta = D(rng.choice(["10.00", "100.00", "1.00", "9.00", "90.00", "0.90", "45.00"]))
            if spec.total - delta > 0 and rng.chance(0.5):
                delta = -delta
            spec.total = q2(spec.total + delta)
        elif anomaly == "line_sum_mismatch":
            it = rng.choice(spec.items)
            delta = D(rng.choice(["10.00", "1.00", "100.00", "5.50", "20.00"]))
            if it.amount - delta > 0 and rng.chance(0.5):
                delta = -delta
            it.amount = q2(it.amount + delta)
        elif anomaly == "missing_invoice_number":
            self.numbering.used.discard(spec.invoice_number)
            spec.invoice_number = None
        elif anomaly == "missing_date":
            spec.extra["keep_due"] = True
            spec.invoice_date = None
        elif anomaly == "missing_tax":
            spec.tax = None
            spec.extra.pop("cgst", None)
            spec.extra.pop("sgst", None)
            spec.total = q2(spec.subtotal - (spec.discount or 0) + (spec.shipping or 0))
        elif anomaly == "future_date":
            spec.invoice_date = random_date(rng, date(2027, 1, 11), date(2027, 9, 28))
        spec.anomalies.append(anomaly)

    # ------------------------------------------------------------------ helpers
    def _due_date(self, spec: InvoiceSpec, rng: Rng) -> None:
        base = spec.invoice_date or spec.distractors["order_date"] + timedelta(days=rng.randint(1, 6))
        print_due = {"T1": 0.85, "T2": 0.75, "T3": 0.5, "T4": 0.0, "T5": 0.4, "T6": 0.35, "T7": 0.8, "T8": 0.4}[spec.template]
        if spec.extra.get("keep_due") or rng.chance(print_due):
            spec.due_date = base + timedelta(days=spec.extra["terms_days"])
        else:
            spec.due_date = None

    def _template_options(self, spec: InvoiceSpec, rng: Rng) -> None:
        t = spec.template
        spec.show_qty = True
        spec.show_unit_price = True
        if t == "T2" and rng.chance(0.3):
            spec.show_qty = False
            spec.show_unit_price = False
        if t == "T3":
            spec.extra["date_format"] = rng.choice(["month_d_y", "month_d_y", "iso"])
            if rng.chance(0.3):
                spec.show_unit_price = False
        if t == "T2":
            spec.extra["date_format"] = rng.choice(["d_mon_y", "dmy_slash"])
        if t == "T5":
            spec.extra["date_format"] = spec.locale.date_format
        if t == "T6":
            spec.extra["bd_title"] = rng.choice(["INVOICE", "BILL", "INVOICE / BILL"])
            spec.extra["bd_final"] = rng.choice(["Grand Total (BDT)", "Total Payable (BDT)", "Net Payable (BDT)"])
        if t == "T8":
            spec.extra["tax_split"] = "cgst_sgst" if rng.chance(0.65) else "igst"
            for it in spec.items:
                it.hsn = rng.choice(HSN[spec.domain])
        if t == "T7":
            start = (spec.invoice_date or date(2026, 1, 1)) - timedelta(days=rng.randint(14, 30))
            for it in spec.items:
                it.service_date = start + timedelta(days=rng.randint(0, 13))
            spec.items.sort(key=lambda it: it.service_date)
            spec.extra["period_start"] = start
            spec.extra["period_end"] = start + timedelta(days=13)

    def _distractors(self, spec: InvoiceSpec, rng: Rng) -> None:
        loc = spec.locale
        ref = spec.invoice_date or date(2026, 5, 1)
        cc = loc.code
        d = {
            "po_number": rng.choice([f"PO-{rng.randint(10000, 99999)}", f"45000{rng.digits(5)}", f"PO{rng.digits(6)}"]),
            "order_no": f"SO-{rng.digits(6)}",
            "order_no_short": rng.digits(4),
            "customer_id": f"CUST-{rng.digits(5)}",
            "customer_no": rng.digits(5),
            "account_ref": f"{rng.digits(4)}-{rng.digits(2)}",
            "account_no": f"{rng.digits(4)}-{rng.digits(4)}-{rng.digits(4)}" if cc != "IN" else rng.digits(14),
            "account_no_short": rng.digits(8),
            "routing": rng.digits(9),
            "sort_code": f"{rng.digits(2)}-{rng.digits(2)}-{rng.digits(2)}",
            "bank_name": rng.choice(BANKS.get(cc, BANKS["US"])),
            "order_date": ref - timedelta(days=rng.randint(2, 12)),
            "delivery_date": ref - timedelta(days=rng.randint(0, 5)),
            "sales_rep": rng.choice(["J. Carter", "M. Lopez", "S. Patel", "A. Nguyen", "R. Brooks"]),
            "carrier": rng.choice(CARRIERS),
            "time": f"{rng.randint(8, 21):02d}:{rng.randint(0, 59):02d}",
            "cashier": rng.choice(CASHIERS),
            "till": f"{rng.randint(1, 12):02d}",
            "work_order": f"WO-{ref.year}-{rng.randint(100, 999)}",
            "challan_no": rng.digits(4),
            "contact": rng.choice(["Mr. Becker", "Ms. Laurent", "Mr. de Vries", "Ms. Hoffmann", "Mr. Martin"]),
            "director": rng.choice(["Dr. Klaus Weber", "Anne Dubois", "Pieter Jansen", "Sabine Krüger"]),
            "period_label": f"{MONTHS[(ref.month - 2) % 12]} {ref.year if ref.month > 1 else ref.year - 1}",
            "care_plan": f"CP-{rng.digits(6)}",
            "client_id": f"CL-{rng.digits(5)}",
            "place_of_supply": rng.choice(["Karnataka (29)", "Maharashtra (27)", "Tamil Nadu (33)", "Telangana (36)", "Delhi (07)"]),
            "eway": rng.digits(12),
            "ifsc": f"{rng.choice(['HDFC', 'ICIC', 'SBIN', 'UTIB'])}0{rng.digits(6)}",
        }
        iban_cc = {"DE": "DE", "FR": "FR", "NL": "NL"}.get(cc, "DE")
        d["iban"] = f"{iban_cc}{rng.digits(2)} {rng.digits(4)} {rng.digits(4)} {rng.digits(4)} {rng.digits(4)} {rng.digits(2)}"
        d["bic"] = rng.letters(4) + iban_cc + rng.letters(2) + "XXX"
        if spec.template == "T7":
            d["patient"] = self.content.person_name(loc, rng)
            d["period_start"] = spec.extra.get("period_start", ref - timedelta(days=20))
            d["period_end"] = spec.extra.get("period_end", ref - timedelta(days=7))
        if spec.template == "T8":
            same = rng.chance(0.5) and spec.customer is not None
            if spec.customer and not spec.customer.is_person:
                d["receiver_gstin"] = self.content.tax_ids(loc, rng)[0][1]
            d["consignee"] = (spec.customer.name if same else
                              self.content.company(loc, rng.choice(DOMAINS), rng).name + " - Warehouse")
            d["consignee_address"] = self.content.address(loc, rng)
        if spec.template == "T4":
            total = spec.total or Decimal("0")
            step = Decimal("10") if total < 50 else Decimal("50") if total < 300 else Decimal("100")
            cash = ((total // step) + 1) * step
            d["cash"] = q2(cash)
            d["change"] = q2(cash - total)
        spec.distractors = d

    def refresh_cash(self, spec: InvoiceSpec) -> None:
        """Receipts: cash/change depend on the final (possibly anomalous) total."""
        if spec.template != "T4":
            return
        total = spec.total
        step = Decimal("10") if total < 50 else Decimal("50") if total < 300 else Decimal("100")
        cash = ((abs(total) // step) + 1) * step
        spec.distractors["cash"] = q2(cash)
        spec.distractors["change"] = q2(cash - total)
