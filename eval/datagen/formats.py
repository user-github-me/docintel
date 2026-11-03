"""Locale-aware number, date and currency formatting used when *printing* invoices.

Labels are always normalized (ISO dates, plain 2-decimal amounts); these helpers
produce the human-facing strings that appear on the documents.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from reportlab.lib.pagesizes import A4, LETTER

from .util import D, q2

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


# ---------------------------------------------------------------- numbers
def _group(int_part: str, sep: str, style: str) -> str:
    if style == "none" or len(int_part) <= 3:
        return int_part
    if style == "indian":
        head, tail = int_part[:-3], int_part[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        return sep.join(groups + [tail])
    groups = []
    while len(int_part) > 3:
        groups.insert(0, int_part[-3:])
        int_part = int_part[:-3]
    groups.insert(0, int_part)
    return sep.join(groups)


NUMBER_FORMATS = {
    # name: (thousands_sep, decimal_sep, grouping)
    "us": (",", ".", "western"),
    "eu": (".", ",", "western"),
    "plain": ("", ".", "none"),
    "eu_plain": ("", ",", "none"),
    "indian": (",", ".", "indian"),
}


def fmt_amount(value, number_format: str = "us", decimals: int = 2) -> str:
    """Format a Decimal per locale. Negative numbers get a leading minus."""
    tsep, dsep, grouping = NUMBER_FORMATS[number_format]
    v = D(value)
    neg = v < 0
    v = abs(v)
    s = f"{v:.{decimals}f}"
    int_part, _, frac = s.partition(".")
    int_part = _group(int_part, tsep, "none" if not tsep else grouping)
    out = int_part + (dsep + frac if decimals else "")
    return ("-" if neg else "") + out


def fmt_quantity(value, number_format: str = "us") -> str:
    v = D(value)
    if v == v.to_integral_value():
        return str(int(v))
    s = format(v.normalize(), "f")
    _, dsep, _ = NUMBER_FORMATS[number_format]
    return s.replace(".", dsep)


def fmt_percent(rate: Decimal, number_format: str = "us") -> str:
    pct = D(rate) * 100
    if pct == pct.to_integral_value():
        return f"{int(pct)}%"
    s = format(pct.normalize(), "f")
    _, dsep, _ = NUMBER_FORMATS[number_format]
    return s.replace(".", dsep) + "%"


# ---------------------------------------------------------------- dates
DATE_FORMATS = {
    "mdy_slash": lambda d: f"{d.month:02d}/{d.day:02d}/{d.year}",
    "dmy_slash": lambda d: f"{d.day:02d}/{d.month:02d}/{d.year}",
    "dmy_dot": lambda d: f"{d.day:02d}.{d.month:02d}.{d.year}",
    "iso": lambda d: d.isoformat(),
    "d_mon_y": lambda d: f"{d.day:02d} {MONTHS[d.month-1][:3]} {d.year}",
    "month_d_y": lambda d: f"{MONTHS[d.month-1]} {d.day}, {d.year}",
    "d_mon_y_dash": lambda d: f"{d.day:02d}-{MONTHS[d.month-1][:3]}-{d.year}",
    "dmy_dash": lambda d: f"{d.day:02d}-{d.month:02d}-{d.year}",
}


def fmt_date(d: date | None, date_format: str) -> str:
    if d is None:
        return ""
    return DATE_FORMATS[date_format](d)


# ---------------------------------------------------------------- locales
@dataclass(frozen=True)
class Locale:
    code: str
    currency: str
    number_format: str
    date_format: str
    tax_name: str                    # "VAT", "GST", "Sales Tax", "HST", ...
    tax_rates: tuple                 # candidate rates as strings
    faker_locale: str
    pagesize: tuple = field(default=A4)
    price_factor: Decimal = Decimal("1")
    symbol: str | None = None        # printable currency symbol (None -> use code)
    symbol_after: bool = False       # "1.234,56 €" style


LOCALES = {
    "US": Locale("US", "USD", "us", "mdy_slash", "Sales Tax", ("0.0625", "0.07", "0.0825", "0.08875", "0.06"), "en_US", LETTER, Decimal("1"), "$"),
    "CA": Locale("CA", "CAD", "us", "iso", "HST", ("0.13", "0.15"), "en_CA", LETTER, Decimal("1.35"), "$"),
    "CA_AB": Locale("CA_AB", "CAD", "us", "iso", "GST", ("0.05",), "en_CA", LETTER, Decimal("1.35"), "$"),
    "AU": Locale("AU", "AUD", "us", "dmy_slash", "GST", ("0.10",), "en_AU", A4, Decimal("1.5"), "$"),
    "UK": Locale("UK", "GBP", "us", "dmy_slash", "VAT", ("0.20",), "en_GB", A4, Decimal("0.8"), "£"),
    "DE": Locale("DE", "EUR", "eu", "dmy_dot", "VAT", ("0.19", "0.07"), "de_DE", A4, Decimal("0.92"), "€", True),
    "FR": Locale("FR", "EUR", "eu", "dmy_slash", "VAT", ("0.20", "0.10"), "fr_FR", A4, Decimal("0.92"), "€", True),
    "NL": Locale("NL", "EUR", "eu", "dmy_dash", "VAT", ("0.21", "0.09"), "nl_NL", A4, Decimal("0.92"), "€", True),
    "BD": Locale("BD", "BDT", "indian", "dmy_slash", "VAT", ("0.15", "0.075", "0.05"), "en_US", A4, Decimal("118"), None),
    "IN": Locale("IN", "INR", "indian", "d_mon_y_dash", "GST", ("0.18", "0.12", "0.05"), "en_IN", A4, Decimal("83"), None),
}


def money(value, loc: Locale, *, with_currency: str = "none", number_format: str | None = None) -> str:
    """Render an amount. with_currency: none | symbol | code | code_after."""
    nf = number_format or loc.number_format
    s = fmt_amount(value, nf)
    if with_currency == "none":
        return s
    if with_currency == "symbol" and loc.symbol:
        neg = s.startswith("-")
        body = s[1:] if neg else s
        if loc.symbol_after:
            return ("-" if neg else "") + f"{body} {loc.symbol}"
        return ("-" if neg else "") + f"{loc.symbol}{body}"
    if with_currency == "code_after":
        return f"{s} {loc.currency}"
    # code (also the fallback when no symbol exists)
    if loc.currency == "BDT" and with_currency == "symbol":
        return f"Tk {s}"
    if loc.currency == "INR" and with_currency == "symbol":
        return f"Rs. {s}"
    return f"{loc.currency} {s}"


# ---------------------------------------------------------------- words
_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
         "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
         "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _below_hundred(n: int) -> str:
    if n < 20:
        return _ONES[n]
    return (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else "")).strip()


def _below_thousand(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append(_ONES[h] + " Hundred")
    if r:
        parts.append(_below_hundred(r))
    return " ".join(parts)


def words_indian(amount: Decimal, major: str, minor: str) -> str:
    """'Taka One Lakh Twenty Three Thousand ... and Fifty Paisa Only'."""
    amount = q2(abs(amount))
    rupees = int(amount)
    paise = int((amount - rupees) * 100)
    parts = []
    crore, rest = divmod(rupees, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    if crore:
        parts.append(_below_thousand(crore) + " Crore")
    if lakh:
        parts.append(_below_hundred(lakh) + " Lakh")
    if thousand:
        parts.append(_below_hundred(thousand) + " Thousand")
    if rest:
        parts.append(_below_thousand(rest))
    text = " ".join(parts) or "Zero"
    out = f"{major} {text}"
    if paise:
        out += f" and {_below_hundred(paise)} {minor}"
    return out + " Only"
