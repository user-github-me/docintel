# DocIntel evaluation dataset (synthetic, labeled)

A reproducible generator for **labeled invoice documents**: digital PDFs, scanned PDFs, photos/scans
(JPG/PNG/TIFF), Excel (XLSX/XLS), CSV, multi-invoice batches, corrupted files and
cross-verification pairs. Every value in the ground truth is guaranteed to be *printed* on the
document. The QA script below checks this for every text-based file.

> The documents are synthetic. Company names, people, addresses and tax IDs come from Faker and
> curated word lists, and any resemblance to real entities is coincidental. The dataset is meant to
> measure the pipeline. It does not stand in for a real-world benchmark: see *Caveats*.

## Quick start

```bash
cd eval
uv sync                                                                   # Python 3.12 venv
uv run python generate_dataset.py --profile standard --out data --clean   # ~133 docs, ~8 s, ~77 MB
uv run python generate_dataset.py --profile small    --out data-small --clean
uv run python generate_dataset.py --profile fixtures --out ../fixtures    # tiny files committed to git
uv run python generate_dataset.py --profile perf     --out data-perf --clean   # 1000-page + 100-page PDFs
uv run python check_labels.py data                                        # ground-truth QA (must be 100%)
```

All profiles are deterministic for a given `--seed` (default 42): two runs produce byte-identical
files, apart from the AES-encrypted PDF, whose IV is random. `--perf-pages` and
`--perf-scanned-pages` override the perf sizes, for example `--perf-pages 40 --perf-scanned-pages 6` for a quick check.

## Output layout

```
<out>/
  files/                         documents (fixtures profile: files sit directly in <out>/)
  labels.jsonl                   one document label per line (fixtures: labels.json = JSON array)
  manifest.json                  counts per category / split / template / anomaly, size, timing
  generation_meta.jsonl          generator-side facts per doc (locale, number/date format, csv encoding
                                 and delimiter, scanned yes/no). Do NOT feed this to the system under test.
  reconciliation/                cross-verification pairs + reconciliation_labels.json
```

## Label schema

```jsonc
{
  "doc_id": "pdf_digital-T1-0001",
  "file": "files/pdf_digital-T1-0001.pdf",          // relative to <out>
  "file_type": "pdf|image|xlsx|xls|csv",
  "category": "pdf_digital|pdf_scanned|image|multi_invoice_pdf|xlsx|xls|csv|corrupted|reconciliation|perf",
  "template": "T1",                                  // T1..T8, "mixed", "register", "formA", "csv_<variant>", ...
  "split": "dev|heldout",
  "degradation": null | {"level": "clean|light|medium|heavy", "dpi": 200, "rotation_deg": 1.2, "rotate90": 0,
                         "noise_sigma": 8, "blur": 0.6, "contrast": 0.9, "jpeg_quality": 75, "salt_pepper": 0.002},
  "expect_failure": false,
  "expected_error": null | "corrupted_file|encrypted_pdf|empty_file|unsupported_format",
  "invoices": [{
    "invoice_number": "INV-2026-0042" | null,
    "invoice_date": "2026-03-14" | null,
    "due_date": "2026-04-13" | null,
    "supplier_name": "Acme Supplies Ltd" | null,
    "customer_name": "Beta Corp" | null,
    "currency": "USD" | null,
    "subtotal": "1234.50" | null, "tax": "123.45" | null,
    "discount": "0.00" | null,   "shipping": "15.00" | null,
    "total": "1373.95" | null,
    "line_items": [{"description": "...", "quantity": "2" | null, "unit_price": "10.00" | null, "amount": "20.00"}],
    "pages": [1, 2] | null,      // 1-based pages of this invoice inside the file (PDF/TIFF)
    "sheet": "Invoices" | null,  // spreadsheet sheet name
    "row": 5 | null,             // 1-based Excel row / CSV line (header = line 1); null for single-invoice forms
    "anomalies": []
  }]
}
```

### Ground-truth rules

* **GT = what is printed.** Dates are normalised to ISO `YYYY-MM-DD`. Amounts are plain decimals
  with 2 places (`"1234.50"`). Quantities use their minimal form (`"2"`, `"7.5"`, `"-1"`). Currency is
  an ISO-4217 code. Names are exact strings: receipts (T4) print the store name in upper case, so its
  GT is upper case.
* **Not printed means `null`.** Examples: receipts have no customer, many invoices have no due date,
  some registers have no customer column, and some templates have no unit-price column (`unit_price: null`).
  These nulls are how you measure hallucination: a non-null prediction for a null field is an invented value.
* `discount` is the positive discount amount, even though documents print it as `-50.00` or `(50.00)`.
  `total = subtotal - discount + shipping + tax`.
* Registers (one row per invoice) carry no line items. Their `line_items` is `[]`, except for the
  multi-sheet workbooks (`Line Items` sheet) and the line-level CSV.
* Currency is always derivable from the document: an ISO code, `€`/`£`, or a `$` next to an explicit code.
* **Anomalies keep the printed (wrong) value.** If a printed total is wrong, GT `total` is the printed
  number and `anomalies: ["total_mismatch"]`.

### Anomaly codes (~15% of invoices in `standard`, at most one per invoice)

| code | what was done |
|---|---|
| `total_mismatch` | printed total is off by a typo-sized delta (±0.90 … ±100) |
| `line_sum_mismatch` | one printed line amount is off, so Σ lines ≠ subtotal (and qty×price ≠ amount) |
| `missing_invoice_number` | number (and its label) not printed. Register cell left blank |
| `missing_date` | invoice date not printed. A due date may still be present (trap) |
| `missing_tax` | no tax line. Total = subtotal − discount + shipping |
| `negative_amount` | documents: a "Return credit" line with qty −1. Registers/CSV: a credit note (all amounts negative) |
| `future_date` | invoice dated 2027 |
| `duplicate_invoice` | same supplier + invoice number + date + amounts as an earlier invoice elsewhere in the dataset. It is often a different format: a register row duplicating a PDF, or a scan of an earlier digital PDF. One case is the same invoice printed twice inside a multi-invoice PDF. Only the **later copy** carries the label. Find the pair via `(supplier_name, invoice_number)`, and count a duplicate flag on either member as a detection. |

`standard` profile: 60 / 362 invoices carry an anomaly. Every category has some.

## Categories (`standard`, seed 42)

| category | docs | invoices | notes |
|---|---:|---:|---|
| pdf_digital | 40 | 40 | 8 templates × 5. One 2–3-page invoice per multi-page template |
| pdf_scanned | 24 | 24 | image-only PDFs (JPEG pages, no text layer), light / medium / heavy per template |
| image | 32 | 32 | jpg / png / tiff × clean / light / medium / heavy. Multi-page TIFFs. Heavy TIFF = bilevel G4 fax. 4 heavy docs rotated 90/180/270° |
| multi_invoice_pdf | 4 | 40 | 8–15 invoices each (3 digital, 1 scanned). Includes an in-batch duplicate. `pages` per invoice |
| xlsx | 10 | 106 | 4 single-invoice forms, 4 registers (title rows, TOTAL row, text amounts/dates variant, mixed-currency variant), 2 workbooks (Summary + Invoices + Line Items) |
| xls | 5 | 43 | genuine BIFF8 (xlwt): 2 forms, 3 registers |
| csv | 8 | 76 | comma/US, semicolon/EU decimals, tab, UTF-8 BOM, cp1252 accents, fully quoted with commas in names, line-level (one row per line item), `$1,234.56`-style amounts |
| corrupted | 10 | 1 | see below |
| **total** | **133** | **362** | 108 dev + 25 held-out documents, ~77 MB |

Plus `reconciliation/` (not in `labels.jsonl`) and the `perf` profile.

### Templates

| id | split | description |
|---|---|---|
| T1 | dev | Classic corporate: logo + INVOICE title, meta box, Bill To, gridded table, totals box (US/CA/AU) |
| T2 | dev | Two-column modern: colour band, From/Billed To columns, labels-above-values meta row, zebra table (UK, GBP, VAT) |
| T3 | dev | Minimal serif label:value layout, qty-first borderless table, no page numbers (US/AU/CA) |
| T4 | dev | Narrow POS receipt in Courier, upper-case store name, cash/change distractors, no customer |
| T5 | dev | EU business letter: address window, info block, Pos. table, `1.234,56 €`, IBAN footer (DE/FR/NL) |
| T6 | dev | Bangladeshi bill: Mushak-6.3, Bill No./BIN/TIN, "Total" = subtotal then VAT, amount in words, lakh grouping (BDT) |
| T7 | heldout | Canadian home-care services invoice with sidebar letterhead and per-line service dates (CAD) |
| T8 | heldout | Indian GST tax invoice with receiver/consignee boxes, HSN/SAC, CGST/SGST or IGST (INR) |

The held-out templates T7 and T8 use label wording and layouts that never appear in T1–T6. Tune
extractors on the `dev` split only, and report `heldout` separately: it estimates performance on unseen
layouts. Every template carries distractors: PO / order / customer / account numbers, tax registration
IDs, phone numbers, bank details, order / delivery / service dates, and cash/change on receipts.

### Degradation levels (scan simulation)

PyMuPDF rasterization at the target DPI, then grayscale, rotation, Gaussian blur, faded ink on grey
paper, Gaussian and salt-and-pepper noise, and JPEG artefacts. Heavy adds uneven illumination.

| level | dpi | rotation | noise σ | blur | contrast | JPEG q |
|---|---|---|---|---|---|---|
| clean | 300 | 0° | 0 | 0 | 1.0 | 92 |
| light | 200–250 | ±1° | 3–7 | 0.3–0.6 | 0.90–1.0 | 80–90 |
| medium | 150–200 | ±1.5–3° | 9–14 | 0.6–0.9 | 0.75–0.88 | 60–75 |
| heavy | 120–150 | ±2.5–4.5° | 14–19 | 0.8–1.1 | 0.62–0.72 | 40–52 |

Heavy TIFFs are denoised, Otsu-binarised and stored as CCITT G4, like a bad fax. The exact parameters
of every file are in its `degradation` label.

### Corrupted / unreadable inputs

| case | file | `expected_error` | also acceptable |
|---|---|---|---|
| truncated PDF (cut at ~25%) | .pdf | corrupted_file | |
| random bytes | .pdf | corrupted_file | unsupported_format |
| zero bytes | .pdf | empty_file | |
| truncated PNG (signature + partial IHDR) | .png | corrupted_file | |
| xlsx with central directory cut off | .xlsx | corrupted_file | |
| plain text saved as .xlsx | .xlsx | corrupted_file | unsupported_format |
| AES-256 password-protected PDF | .pdf | encrypted_pdf | |
| HTML page saved as .pdf | .pdf | unsupported_format | corrupted_file |
| binary garbage with NULs | .csv | corrupted_file | unsupported_format |
| valid PNG saved as `.jpg` | .jpg | *(none: expect_failure=false, 1 invoice)* | |

Graceful handling means a clear, typed error and no crash or hang. Report exact-code agreement separately.

### Reconciliation pairs (`reconciliation/reconciliation_labels.json`)

* `recon-a` (pdf_vs_excel): a 15-invoice PDF and an XLSX purchase ledger. The ledger is missing 1
  invoice, has 1 extra row, and 2 rows disagree: one on `total` only, one on `tax` and `total`.
* `recon-b` (pdf_vs_pdf): an 8-invoice batch and its re-issued copies. One copy has a changed
  `invoice_date`. One copy has a changed line quantity, so `subtotal`, `tax`, `total` and `line_items`
  differ.

Each entry has `left` / `right`, which are full document labels in the schema above, plus
`expected = {matched: [{invoice_number, supplier_name, status: match|mismatch, discrepancies: [{field, left, right}]}],
unmatched_left: [...], unmatched_right: [...]}`.

### Perf profile

`perf-digital-1000p.pdf` is a 1000-page digital batch of mixed templates, with 1–5 pages per invoice and
~8% anomalies. `perf-scanned-100p.pdf` is a 100-page scanned batch at the light level. Both are labeled
with per-invoice `pages`, so you can measure invoice segmentation as well as throughput.

## Ground-truth QA

`check_labels.py` checks every digital PDF, spreadsheet and CSV, including both sides of the
reconciliation pairs. Every non-null invoice number, supplier and customer name, amount (in that
document's number format, or as a numeric cell), line description and invoice date must be present in
the file's own content. Scanned and image files are skipped because they have no text layer. Their
labels come from the same specs as the digital renderings.

Result for `standard`, seed 42: **4282 / 4282 values found (100.00%)**. The fixtures pass 202 / 202.

## Caveats

* The data is synthetic. Layout diversity is 8 templates plus spreadsheet layouts, and the scans are
  simulated, so there are no real camera photos, handwriting, stamps or folds. Expect real-world
  accuracy to be lower than on this set. The held-out templates are the honest proxy for unseen layouts.
* Everything is in English and Latin script. reportlab's standard fonts cannot render Bengali or the
  ₹/৳ glyphs, so BDT and INR appear as `Tk`/`BDT` and `Rs.`/`INR`.
* XLSX cells hold literal values, not formulas. openpyxl cannot write cached formula results, so a
  formula-only workbook would read back as empty cells.
* Line items in registers exist only in the workbook `Line Items` sheet and the line-level CSV.
