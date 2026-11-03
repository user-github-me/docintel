"""Realistic content: companies, people, catalogs and invoice specifications."""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from decimal import Decimal

from faker import Faker

from .formats import LOCALES, Locale
from .util import D, Rng, q2

# ------------------------------------------------------------------ catalogs
# (description, base USD unit price, unit)
CATALOG: dict[str, list[tuple[str, float, str]]] = {
    "it": [
        ("Cloud hosting - Standard plan (monthly)", 89.00, "month"),
        ("Managed backup service", 49.00, "month"),
        ("Office suite licence (annual, per user)", 99.00, "user"),
        ("On-site IT support", 85.00, "hour"),
        ("Remote helpdesk support", 60.00, "hour"),
        ("Website maintenance retainer", 250.00, "month"),
        ("SSL certificate renewal (1 year)", 79.00, "pcs"),
        ("Domain registration (1 year)", 18.00, "pcs"),
        ("Business laptop 14-inch", 1150.00, "pcs"),
        ("24-port network switch", 329.00, "pcs"),
        ("Data migration service", 640.00, "job"),
        ("Cybersecurity audit", 1800.00, "job"),
        ("Wireless access point", 189.00, "pcs"),
        ("Firewall subscription (annual)", 540.00, "pcs"),
        ("Database administration", 95.00, "hour"),
        ("Backup storage 1 TB", 25.00, "month"),
        ("Patient records system licence", 420.00, "month"),
        ("Tablet for field staff", 329.00, "pcs"),
    ],
    "office": [
        ("A4 copy paper 80gsm (box of 5 reams)", 32.50, "box"),
        ("Ballpoint pens, blue (pack of 50)", 12.90, "pack"),
        ("Heavy-duty stapler", 24.00, "pcs"),
        ("Toner cartridge, black", 68.00, "pcs"),
        ("Lever arch files (pack of 10)", 21.50, "pack"),
        ("Whiteboard markers (set of 4)", 6.75, "set"),
        ("Desk organiser", 15.20, "pcs"),
        ("Sticky notes 3x3 (12 pads)", 9.80, "pack"),
        ("Printer ink, colour", 44.00, "pcs"),
        ("Envelopes DL (box of 500)", 19.40, "box"),
        ("Ergonomic office chair", 289.00, "pcs"),
        ("Paper shredder", 139.00, "pcs"),
        ("Archive boxes (pack of 10)", 27.00, "pack"),
        ("Visitor sign-in book", 11.50, "pcs"),
    ],
    "logistics": [
        ("Courier delivery - same day", 35.00, "trip"),
        ("Freight charges - 20ft container", 1450.00, "container"),
        ("Warehousing (per pallet per week)", 12.50, "pallet"),
        ("Customs clearance fee", 120.00, "job"),
        ("Fuel surcharge", 42.00, "trip"),
        ("Last-mile delivery", 8.50, "parcel"),
        ("Packaging materials", 3.20, "pcs"),
        ("Pallet wrapping", 4.00, "pallet"),
        ("Express air freight (per kg)", 6.40, "kg"),
        ("Loading and unloading labour", 28.00, "hour"),
        ("Medical supplies cold-chain transport", 95.00, "trip"),
    ],
    "homecare": [
        ("Home nursing visit", 75.00, "visit"),
        ("Physiotherapy session (60 min)", 90.00, "session"),
        ("Caregiver hours - daytime", 28.00, "hour"),
        ("Caregiver hours - overnight", 32.00, "hour"),
        ("Wound care dressing change", 55.00, "visit"),
        ("Medication administration visit", 45.00, "visit"),
        ("Elderly companionship", 24.00, "hour"),
        ("Post-operative care visit", 85.00, "visit"),
        ("Doctor home consultation", 120.00, "visit"),
        ("Lab sample collection at home", 30.00, "visit"),
        ("Personal care assistance (bathing and dressing)", 30.00, "hour"),
        ("Respite care", 26.50, "hour"),
        ("Care plan assessment", 150.00, "job"),
        ("Dementia care support", 34.00, "hour"),
    ],
    "medical": [
        ("Blood pressure monitor", 48.00, "pcs"),
        ("Disposable gloves (box of 100)", 9.50, "box"),
        ("Adult diapers (pack of 10)", 14.00, "pack"),
        ("Wheelchair rental (monthly)", 85.00, "month"),
        ("Oxygen concentrator rental (weekly)", 110.00, "week"),
        ("Glucometer test strips (50)", 22.00, "pack"),
        ("Sterile gauze pads (pack of 25)", 7.25, "pack"),
        ("Hospital bed rental (monthly)", 240.00, "month"),
        ("Pulse oximeter", 32.00, "pcs"),
        ("Hand sanitiser 500 ml", 5.90, "pcs"),
        ("Surgical face masks (box of 50)", 8.40, "box"),
        ("Walking frame with wheels", 96.00, "pcs"),
    ],
}

DOMAINS = list(CATALOG)

# small-basket retail catalogs used only by the POS receipt template (T4)
CATALOG["pharmacy"] = [
    ("Paracetamol 500mg (24 tablets)", 3.49, "pcs"), ("Ibuprofen 200mg (32 tablets)", 5.99, "pcs"),
    ("Vitamin D3 1000IU (90 caps)", 9.99, "pcs"), ("Cough syrup 200ml", 7.49, "pcs"),
    ("Antiseptic cream 30g", 4.25, "pcs"), ("Assorted bandages (40)", 4.99, "pack"),
    ("Hand sanitiser 500 ml", 5.90, "pcs"), ("Surgical face masks (box of 50)", 8.40, "box"),
    ("Disposable gloves (box of 100)", 9.50, "box"), ("Digital thermometer", 12.99, "pcs"),
    ("Saline nasal spray", 6.49, "pcs"), ("Glucometer test strips (50)", 22.00, "pack"),
    ("Adult diapers (pack of 10)", 14.00, "pack"), ("Cotton wool 100g", 2.99, "pcs"),
    ("Oral rehydration salts (10 sachets)", 4.50, "pack"), ("Blood pressure monitor", 48.00, "pcs"),
]
CATALOG["store"] = [
    ("A4 spiral notebook", 3.99, "pcs"), ("Ballpoint pens (pack of 10)", 4.49, "pack"),
    ("Highlighters (set of 4)", 5.25, "set"), ("Mini stapler", 9.99, "pcs"), ("Staples (box of 1000)", 2.49, "box"),
    ("Sticky notes 3x3", 3.75, "pack"), ("Envelopes C5 (pack of 25)", 4.99, "pack"),
    ("Printer paper A4 (500 sheets)", 6.99, "pack"), ("Correction tape", 2.79, "pcs"),
    ("Scissors 8-inch", 4.49, "pcs"), ("Glue stick 40g", 1.99, "pcs"), ("Clear folders (pack of 10)", 3.99, "pack"),
    ("USB flash drive 64GB", 11.99, "pcs"), ("Desk calendar", 7.50, "pcs"),
]

PREFIXES = ["Blue Harbor", "BrightPath", "Evergreen", "Nimbus", "Summit", "Crescent", "Pioneer",
            "Northstar", "Riverside", "Oakridge", "Maplewood", "Cedar", "Apex", "Vertex", "Lumen",
            "Atlas", "Keystone", "Silverline", "Bluewave", "Greenleaf", "Redwood", "Starlight",
            "Horizon", "Sunrise", "Clearview", "Brookside", "Highland", "Lakeside", "Westbridge",
            "Harborview", "Ironwood", "Kingsley", "Meadowbrook", "Orchard", "Willow Creek"]

CORES = {
    "pharmacy": ["Pharmacy", "Chemists", "Drug Store", "Health Pharmacy"],
    "store": ["Stationers", "Office Store", "Paper Shop", "Supplies Store"],
    "it": ["Cloud Solutions", "Data Systems", "IT Services", "Software", "Technologies", "Networks", "Digital"],
    "office": ["Office Supplies", "Stationers", "Office Products", "Paper Company", "Workplace Supplies"],
    "logistics": ["Freight", "Logistics", "Couriers", "Transport", "Shipping"],
    "homecare": ["Home Care", "Nursing Services", "Home Health", "Care Services", "Senior Care", "Community Care"],
    "medical": ["Medical Supplies", "Healthcare Supplies", "Pharma", "Surgical", "Medical Equipment"],
}

SUFFIXES = {
    "US": ["LLC", "Inc.", "Corp.", "Co.", "Group LLC"],
    "CA": ["Inc.", "Ltd.", "Corp."], "CA_AB": ["Inc.", "Ltd."],
    "AU": ["Pty Ltd", "Pty. Ltd."],
    "UK": ["Ltd", "Limited", "PLC", "LLP"],
    "DE": ["GmbH", "GmbH & Co. KG", "AG"],
    "FR": ["SARL", "SAS", "S.A."],
    "NL": ["B.V.", "N.V."],
    "BD": ["Ltd.", "Limited", "Enterprise", "Traders"],
    "IN": ["Pvt. Ltd.", "Private Limited", "LLP"],
}

EU_CORES = {
    "pharmacy": ["Pharmacy", "Chemists", "Drug Store", "Health Pharmacy"],
    "store": ["Stationers", "Office Store", "Paper Shop", "Supplies Store"],
    "DE": {"it": "IT-Service", "office": "Bürobedarf", "logistics": "Logistik", "homecare": "Pflegedienst", "medical": "Medizintechnik"},
    "FR": {"it": "Informatique", "office": "Fournitures de Bureau", "logistics": "Transports", "homecare": "Soins à Domicile", "medical": "Matériel Médical"},
    "NL": {"it": "IT Diensten", "office": "Kantoorartikelen", "logistics": "Logistiek", "homecare": "Thuiszorg", "medical": "Medische Hulpmiddelen"},
}

BD_SURNAMES = ["Rahman", "Karim", "Hossain", "Chowdhury", "Ahmed", "Islam", "Uddin", "Sarker", "Talukder",
               "Haque", "Siddiqui", "Bhuiyan", "Mollah", "Khan", "Alam"]
BD_GIVEN_M = ["Tanvir", "Rakib", "Imran", "Mahmud", "Arif", "Rafiq", "Jahid", "Sabbir", "Nazmul", "Habib"]
BD_GIVEN_F = ["Nusrat", "Farhana", "Sadia", "Shirin", "Nadia", "Taslima", "Rumana", "Sharmin", "Tahmina", "Lubna"]
BD_CORES = {
    "pharmacy": ["Pharmacy", "Chemists", "Drug Store", "Health Pharmacy"],
    "store": ["Stationers", "Office Store", "Paper Shop", "Supplies Store"],"it": "IT Solutions", "office": "Stationery Mart", "logistics": "Logistics", "homecare": "Home Care Services",
            "medical": "Medical Hall"}
BD_ADDRESSES = [("House 12, Road 5, Dhanmondi", "Dhaka 1205"), ("Plot 34, Gulshan Avenue, Gulshan-2", "Dhaka 1212"),
                ("House 7, Road 11, Banani", "Dhaka 1213"), ("House 22, Sector 7, Uttara", "Dhaka 1230"),
                ("128 Agrabad C/A", "Chattogram 4100"), ("45 Victoria Road", "Tangail 1900"),
                ("17 Zindabahar Lane, Old Dhaka", "Dhaka 1100"), ("Holding 9, Zindabazar", "Sylhet 3100"),
                ("Shop 14, Mirpur-10 Circle", "Dhaka 1216"), ("House 3, Road 2, Mohammadpur", "Dhaka 1207")]

TITLES = ["Mr.", "Mrs.", "Ms.", "Dr."]


@dataclass
class Company:
    name: str
    address: list[str]
    phone: str
    email: str
    website: str
    tax_ids: list[tuple[str, str]]
    is_person: bool = False


@dataclass
class Item:
    description: str
    quantity: Decimal
    unit: str
    unit_price: Decimal
    amount: Decimal
    service_date: date | None = None
    hsn: str | None = None


@dataclass
class InvoiceSpec:
    template: str
    locale: Locale
    domain: str
    invoice_number: str | None
    invoice_date: date | None
    due_date: date | None
    supplier: Company
    customer: Company | None
    currency: str
    tax_rate: Decimal
    items: list[Item]
    subtotal: Decimal
    discount: Decimal | None
    shipping: Decimal | None
    tax: Decimal | None
    total: Decimal
    anomalies: list[str] = field(default_factory=list)
    show_qty: bool = True
    show_unit_price: bool = True
    distractors: dict = field(default_factory=dict)
    extra: dict = field(default_factory=dict)

    def copy(self, **changes) -> "InvoiceSpec":
        return replace(self, **changes)


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "", text.lower().replace("&", "and"))
    return s[:18] or "company"


class ContentFactory:
    """Generates companies / people / addresses deterministically."""

    def __init__(self, seed: int):
        self.seed = seed
        self._fakers: dict[str, Faker] = {}

    def faker(self, loc: str, rng: Rng) -> Faker:
        f = self._fakers.get(loc)
        if f is None:
            f = Faker(loc)
            self._fakers[loc] = f
        f.seed_instance(rng.randint(0, 2**31 - 1))
        return f

    # ---------------------------------------------------------- addresses
    def address(self, loc: Locale, rng: Rng) -> list[str]:
        if loc.code == "BD":
            street, city = rng.choice(BD_ADDRESSES)
            return [street, city, "Bangladesh"]
        f = self.faker(loc.faker_locale, rng)
        if loc.code in ("US",):
            return [f.street_address(), f"{f.city()}, {f.state_abbr()} {f.postcode()}"]
        if loc.code in ("CA", "CA_AB"):
            prov = "ON" if loc.code == "CA" else "AB"
            city = rng.choice(["Toronto", "Ottawa", "Mississauga", "Hamilton", "London"]) if prov == "ON" else rng.choice(["Calgary", "Edmonton", "Red Deer"])
            return [f.street_address(), f"{city}, {prov} {f.postalcode() if hasattr(f, 'postalcode') else f.postcode()}"]
        if loc.code == "AU":
            return [f.street_address(), f"{f.city()} {f.state_abbr()} {f.postcode()}"]
        if loc.code == "UK":
            return [f.street_address().replace("\n", ", "), f"{f.city()} {f.postcode()}"]
        if loc.code == "IN":
            city, state = rng.choice([("Bengaluru", "Karnataka"), ("Mumbai", "Maharashtra"), ("Chennai", "Tamil Nadu"),
                                      ("Hyderabad", "Telangana"), ("Pune", "Maharashtra"), ("New Delhi", "Delhi")])
            return [f.street_address().replace("\n", ", "), f"{city} {rng.digits(6)}", state]
        # DE / FR / NL
        street = f.street_address().replace("\n", ", ")
        return [street, f"{f.postcode()} {f.city()}"]

    def phone(self, loc: Locale, rng: Rng) -> str:
        if loc.code == "BD":
            return f"+880 17{rng.digits(2)}-{rng.digits(6)}"
        if loc.code == "IN":
            return f"+91 {rng.digits(5)} {rng.digits(5)}"
        if loc.code in ("US", "CA", "CA_AB"):
            return f"({rng.randint(201, 989)}) {rng.randint(200, 989)}-{rng.digits(4)}"
        if loc.code == "UK":
            return f"+44 20 {rng.digits(4)} {rng.digits(4)}"
        if loc.code == "AU":
            return f"+61 2 {rng.digits(4)} {rng.digits(4)}"
        if loc.code == "DE":
            return f"+49 30 {rng.digits(7)}"
        if loc.code == "FR":
            return f"+33 1 {rng.digits(2)} {rng.digits(2)} {rng.digits(2)} {rng.digits(2)}"
        return f"+31 20 {rng.digits(3)} {rng.digits(4)}"

    def tax_ids(self, loc: Locale, rng: Rng) -> list[tuple[str, str]]:
        c = loc.code
        if c == "US":
            return [("EIN", f"{rng.digits(2)}-{rng.digits(7)}")]
        if c in ("CA", "CA_AB"):
            return [("GST/HST No.", f"{rng.digits(9)} RT0001")]
        if c == "AU":
            return [("ABN", f"{rng.digits(2)} {rng.digits(3)} {rng.digits(3)} {rng.digits(3)}")]
        if c == "UK":
            return [("VAT Reg No", f"GB {rng.digits(3)} {rng.digits(4)} {rng.digits(2)}"), ("Company No", rng.digits(8))]
        if c == "DE":
            return [("VAT ID", f"DE{rng.digits(9)}"), ("Tax No.", f"{rng.digits(2)}/{rng.digits(3)}/{rng.digits(5)}")]
        if c == "FR":
            return [("VAT ID", f"FR{rng.digits(11)}"), ("SIRET", f"{rng.digits(3)} {rng.digits(3)} {rng.digits(3)} {rng.digits(5)}")]
        if c == "NL":
            return [("VAT ID", f"NL{rng.digits(9)}B01"), ("KvK", rng.digits(8))]
        if c == "BD":
            return [("BIN", f"{rng.digits(9)}-{rng.digits(4)}"), ("TIN", rng.digits(12))]
        # IN: GSTIN = 2-digit state + PAN(10) + entity + Z + check
        pan = rng.letters(5) + rng.digits(4) + rng.letters(1)
        return [("GSTIN", f"{rng.randint(10, 36)}{pan}1Z{rng.letters(1, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}"), ("PAN", pan)]

    # ---------------------------------------------------------- names
    def company_name(self, loc: Locale, domain: str, rng: Rng) -> str:
        c = loc.code
        suffixes = SUFFIXES.get(c, ["Ltd"])
        if c == "BD":
            core = BD_CORES[domain]
            style = rng.randint(0, 2)
            if style == 0:
                name = f"{rng.choice(BD_SURNAMES)} {core}"
            elif style == 1:
                name = f"{rng.choice(['Dhaka', 'Bengal', 'Padma', 'Meghna', 'Jamuna', 'Sonar Bangla', 'Tangail', 'Green Delta'])} {core}"
            else:
                name = f"{rng.choice(PREFIXES)} {core}"
            suffix = rng.choice(suffixes + [""])
            return f"{name} {suffix}".strip()
        if c in EU_CORES:
            f = self.faker(loc.faker_locale, rng)
            core = EU_CORES[c][domain]
            style = rng.randint(0, 2)
            if style == 0:
                name = f"{f.last_name()} {core}"
            elif style == 1 and c == "DE":
                name = f"{f.last_name()} & Söhne"
            elif style == 1 and c == "FR":
                name = rng.choice(["Café Délices", "Lefèvre & Fils", "Atelier Bérénice", "Clinique Sainte-Hélène"])
            else:
                name = f"{rng.choice(PREFIXES)} {core}"
            return f"{name} {rng.choice(suffixes)}"
        if c == "IN":
            f = self.faker("en_IN", rng)
            core = CORES[domain][rng.randint(0, len(CORES[domain]) - 1)]
            name = f"{f.last_name()} {core}" if rng.chance(0.6) else f"{rng.choice(PREFIXES)} {core}"
            return f"{name} {rng.choice(suffixes)}"
        f = self.faker(loc.faker_locale, rng)
        core = rng.choice(CORES[domain])
        style = rng.randint(0, 3)
        if style == 0:
            name = f"{rng.choice(PREFIXES)} {core}"
        elif style == 1:
            name = f"{f.last_name()} {core}"
        elif style == 2:
            name = f"{f.last_name()} & {f.last_name()} {core}"
        else:
            name = f"{rng.choice(PREFIXES)} {core}"
        return f"{name} {rng.choice(suffixes)}"

    def person_name(self, loc: Locale, rng: Rng) -> str:
        male = rng.chance(0.5)
        title = rng.choice(["Mr.", "Mr.", "Dr."] if male else ["Mrs.", "Ms.", "Dr."])
        if loc.code == "BD":
            return f"{title} {rng.choice(BD_GIVEN_M if male else BD_GIVEN_F)} {rng.choice(BD_SURNAMES)}"
        f = self.faker(loc.faker_locale, rng)
        first = f.first_name_male() if male else f.first_name_female()
        return f"{title} {first} {f.last_name()}"

    def company(self, loc: Locale, domain: str, rng: Rng, person: bool = False) -> Company:
        name = self.person_name(loc, rng) if person else self.company_name(loc, domain, rng)
        dom = slug(name.split(" ", 1)[1] if person else name)
        tld = {"US": "com", "CA": "ca", "CA_AB": "ca", "AU": "com.au", "UK": "co.uk", "DE": "de", "FR": "fr",
               "NL": "nl", "BD": "com.bd", "IN": "in"}[loc.code]
        email = (f"{dom[:12]}@mail.{tld}" if person else f"{rng.choice(['accounts', 'billing', 'info', 'finance'])}@{dom}.{tld}")
        return Company(
            name=name,
            address=self.address(loc, rng),
            phone=self.phone(loc, rng),
            email=email,
            website="" if person else f"www.{dom}.{tld}",
            tax_ids=[] if person else self.tax_ids(loc, rng),
            is_person=person,
        )


# ---------------------------------------------------------------- items
HOUR_QTYS = ["2", "3", "4", "6", "7.5", "8", "10", "12", "12.5", "16", "20", "24", "40"]


def make_items(loc: Locale, domain: str, n: int, rng: Rng) -> list[Item]:
    cat = CATALOG[domain]
    picks = [rng.choice(cat) for _ in range(n)] if n > len(cat) else rng.sample(cat, n)
    items: list[Item] = []
    for desc, base, unit in picks:
        price = D(base) * loc.price_factor * D(round(rng.uniform(0.85, 1.2), 3))
        if loc.currency in ("BDT", "INR"):
            price = (price / 5).quantize(Decimal("1")) * 5
            price = max(price, Decimal("5"))
        else:
            price = q2(price)
            if rng.chance(0.35):
                price = price.quantize(Decimal("1")) + rng.choice([Decimal("0.00"), Decimal("0.50"), Decimal("0.99"), Decimal("0.95")])
        if unit == "hour":
            qty = D(rng.choice(HOUR_QTYS))
        elif base >= 600:
            qty = D(rng.randint(1, 2))
        elif base >= 100:
            qty = D(rng.randint(1, 6))
        else:
            qty = D(rng.randint(1, 24))
        items.append(Item(desc, qty, unit, q2(price), q2(qty * price)))
    return items


# ---------------------------------------------------------------- numbering
class Numbering:
    """Guarantees globally unique invoice numbers (except deliberate duplicates)."""

    def __init__(self):
        self.used: set[str] = set()

    def make(self, template: str, loc: Locale, inv_date: date, supplier: Company, rng: Rng) -> str:
        for _ in range(200):
            y = inv_date.year
            seq = rng.randint(1, 9999)
            initials = "".join(w[0] for w in re.findall(r"[A-Za-z]+", supplier.name)[:2]).upper() or "IN"
            style = rng.randint(0, 2)
            if template == "T1":
                num = [f"INV-{y}-{seq:04d}", f"INV{rng.randint(10000, 99999)}", f"{initials}-INV-{seq:05d}"][style]
            elif template == "T2":
                num = [f"{initials}-{seq:05d}", f"SI-{y % 100:02d}-{seq:05d}", f"{initials}{y % 100:02d}{seq:04d}"][style]
            elif template == "T3":
                num = [str(rng.randint(10000, 99999)), f"A-{rng.randint(1000, 99999)}", f"{rng.randint(100, 999)}-{seq:04d}"][style]
            elif template == "T4":
                num = [f"{rng.randint(1, 999999):06d}", f"R{rng.randint(10000, 99999)}", f"{rng.randint(1, 99):02d}-{rng.randint(1, 99999):05d}"][style]
            elif template == "T5":
                if loc.code == "DE":
                    num = [f"RE-{y}-{seq:04d}", f"{y}{rng.randint(1, 99999):05d}", f"R{y % 100:02d}-{seq:04d}"][style]
                elif loc.code == "FR":
                    num = [f"F{y}-{seq:04d}", f"FA{y % 100:02d}{seq:05d}", f"{y}-FAC-{seq:04d}"][style]
                else:
                    num = [f"{y}-{seq:04d}", f"NL{y}{seq:04d}", f"F-{y}-{seq:05d}"][style]
            elif template == "T6":
                city = rng.choice(["DHK", "CTG", "TGL", "SYL"])
                num = [f"{city}/{y}/{seq:04d}", f"BILL-{rng.randint(1, 99999):05d}", f"{initials}/{y % 100:02d}/{seq:05d}"][style]
            elif template == "T7":
                num = [f"HC-{rng.randint(1, 999999):06d}", f"ST-{y}{inv_date.month:02d}-{seq:04d}", f"{initials}{rng.randint(100000, 999999)}"][style]
            else:  # T8
                fy = f"{y}-{(y + 1) % 100:02d}" if inv_date.month >= 4 else f"{y - 1}-{y % 100:02d}"
                num = [f"TI/{fy}/{seq:04d}", f"GST/{rng.randint(1, 99999):05d}", f"{initials}/{fy}/{seq:03d}"][style]
            if num not in self.used:
                self.used.add(num)
                return num
        raise RuntimeError("could not find a unique invoice number")


def random_date(rng: Rng, start: date = date(2025, 1, 6), end: date = date(2026, 10, 30)) -> date:
    span = (end - start).days
    return start + timedelta(days=rng.randint(0, span))


def apply_totals(spec: InvoiceSpec) -> InvoiceSpec:
    """Recompute subtotal/tax/total from the (printed) line amounts."""
    subtotal = q2(sum((it.amount for it in spec.items), Decimal("0")))
    spec.subtotal = subtotal
    if spec.tax is not None or "missing_tax" not in spec.anomalies:
        if spec.extra.get("tax_split") == "cgst_sgst":
            half = spec.tax_rate / 2
            cgst = q2(subtotal * half)
            sgst = q2(subtotal * half)
            spec.extra["cgst"] = cgst
            spec.extra["sgst"] = sgst
            spec.tax = cgst + sgst
        else:
            spec.tax = q2(subtotal * spec.tax_rate)
    disc = spec.discount or Decimal("0")
    ship = spec.shipping or Decimal("0")
    spec.total = q2(subtotal - disc + ship + (spec.tax or Decimal("0")))
    return spec
