# Development prompts

These are the prompts that directed the AI-assisted development (Claude Code with Claude Opus 5.5). Secrets are omitted.

## 1. Author → agent (main session)

> *[attached: the assessment brief "Ai Engineer Task 1.3.pdf", the recruitment e-mail and the author's CV]*
> make this, this is a interview task. [...] make complete the task, and also ready the email reply for me to copy paste

Follow-up during the session:

> *[attached: Azure OpenAI setup script; the key was moved into a git-ignored `.env` and is not in this repository]*
> check this, use this azure credentials

The agent turned the brief into the plan below and asked no further questions:

1. **Perception service (Python).** PDF text plus OCR plus spreadsheets, with layout-preserving lines. Accuracy measured on scans of increasing degradation.
2. **Core API (NestJS).** BullMQ flows that fan out page chunks (for 1,000-page PDFs); PostgreSQL with pgvector for storage and search.
3. **Extraction.** Deterministic rules plus an LLM cascade with strict structured outputs and evidence grounding, so values are never invented.
4. **Validation.** Arithmetic, duplicates and review routing; corrections with an audit trail; cross-verification for PDF vs PDF and PDF vs Excel.
5. **Labelled synthetic dataset.** Dev and held-out templates, degradation levels, injected anomalies.
6. **Evaluation.** End-to-end through the REST API, reporting measured metrics only.
7. **Delivery.** Next.js review UI, tests, Docker Compose, documentation, and a walkthrough recording.

## 2. Sub-agent: labelled dataset generator

Delegated to a parallel agent. The prompt below is verbatim (paths shortened):

```text
You are the fork responsible ONLY for the synthetic labeled evaluation dataset for the DocIntel project.
Write files ONLY under docintel/eval/ and docintel/fixtures/.

Deliverables
1. eval/pyproject.toml - uv project, Python 3.12. Deps: reportlab, faker, pillow, numpy, openpyxl, xlwt, pymupdf.
2. eval/generate_dataset.py - CLI: --profile {fixtures,small,standard,perf} --out <dir> --seed 42. Deterministic.
3. eval/check_labels.py - QA: for every digital PDF and spreadsheet, assert each non-null GT string field and each
   GT amount (as printed in that doc's number format) actually appears in the document. Must be 100%.
4. eval/README.md - how to generate, label schema, category counts, degradation levels, dev/held-out split.
5. Generate fixtures (tiny, committed), small and standard profiles.

Label schema: one JSON object per document (doc_id, file, file_type, category, template, split dev|heldout,
degradation {level, dpi, rotation_deg, rotate90, noise_sigma, blur, contrast, jpeg_quality, salt_pepper},
expect_failure, expected_error, invoices[{invoice_number, invoice_date, due_date, supplier_name, customer_name,
currency, subtotal, tax, discount, shipping, total, line_items[{description, quantity, unit_price, amount}],
pages, sheet, row, anomalies[]}]).
Rules: GT must equal what is PRINTED (normalised); not printed => null (this measures hallucination); injected
anomalies keep the printed (wrong) value and list the code: total_mismatch, line_sum_mismatch,
missing_invoice_number, missing_date, missing_tax, duplicate_invoice, negative_amount, future_date (~15%).

Content & variety: 8 templates (T1-T6 dev, T7-T8 held-out: describe held-out ones in one line only - the main
agent will deliberately not tune on them); varied label vocabularies; distractor numbers and dates near the real
ones (PO Number, Order No, Customer ID, VAT Reg/BIN/GSTIN, Order/Delivery/Due dates); US/EU/no-separator number
formats; locale date formats; USD, EUR, GBP, BDT, INR, CAD, AUD (unambiguous currency only); IT, office,
logistics and home-care/healthcare catalogues; amount = round_half_up(qty x price); totals arithmetic incl.
discount/shipping; some invoices span 2-3 pages.

Categories (standard): pdf_digital 40, pdf_scanned 24 (light/medium/heavy), image 32 (jpg/png/tiff incl. multi-page
TIFF; clean/light/medium/heavy incl. 90/180/270 rotations, low DPI, low contrast), multi_invoice_pdf 4 (8-15
invoices each), xlsx 10 (forms, registers with title rows and a TOTAL row, multi-sheet workbooks with a Line Items
sheet), xls 5, csv 8 (delimiters, EU decimals, UTF-8 BOM, cp1252, quoted commas, line-level CSV), corrupted 10
(truncated/random/zero-byte/HTML-as-PDF/encrypted PDF, broken/garbage XLSX, binary CSV, truncated PNG, plus one
recoverable PNG-named-.jpg), reconciliation 2 pairs (PDF vs XLSX with amount mismatches, missing and extra rows;
PDF vs PDF with changed fields), perf profile (1,000-page digital batch PDF, 100-page scanned batch PDF).

Quality bar: look at rendered samples of every template and scan level and fix anything fake or broken; run
check_labels.py until 100%; keep data under ~500 MB; generation under ~5 minutes.
```

## 3. Sub-agent: web frontend

Delegated to a parallel agent. Condensed; the original also specified layout details:

```text
You are the fork responsible ONLY for the DocIntel web frontend (docintel/apps/web). Do not edit the API; report
API bugs/gaps precisely instead.

Stack: Next.js (App Router, TypeScript, output: standalone), Tailwind, TanStack Query, lucide-react; no external
fonts/CDNs. Calm, professional internal-tool look; must look polished in screenshots.

Security: browser never sees the API key - BFF proxy route app/api/proxy/[...path] forwards method, query, body
(streamed uploads up to 200 MB) and streams responses (JSON, JPEG, downloads, SSE) with X-API-Key from server env;
optional basic auth (WEB_BASIC_AUTH) forwarding the user as x-actor; never use alert/confirm/prompt.

Pages: dashboard (KPIs from /stats, multi-file upload with purpose toggle, live progress); documents list (filters,
retry all failed, reprocess, delete with inline confirm); document detail (timeline, invoices, page image + text
viewer, sheet grid, issues, download, reprocess with force confirm); invoice review & correct (page image with
evidence highlight from bbox, editable fields with confidence/source badges, evidence, alternatives, editable line
items with live sum check, validation issues, save with optimistic locking and 409 handling, approve with 422
override-with-note, reject, history); review queue (needs_review, filter by issue code); search (hybrid/keyword/
semantic + filters, snippets, matchedBy) and browse; cross-verification (pick two documents, summary, discrepancies,
history). Live updates via EventSource + polling fallback.

Delivery: npm run build passes; Dockerfile (standalone, non-root uid 1000); Playwright smoke tests and a narrated
walkthrough recording; screenshots of every page reviewed and iterated until they look good.
```

## 4. Runtime prompts

See [runtime-prompts.md](runtime-prompts.md).
