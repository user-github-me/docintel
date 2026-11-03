# Evaluation report

All numbers come from running the full system end to end through its REST API:
upload, background pipeline (queue, OCR/parsing, extraction, validation), then reading back the results.
The runner is [`eval/run_eval.py`](../eval/run_eval.py); raw results are in [`eval/results/`](../eval/results/).
Regenerate this file with `cd eval && uv run python make_report.py`.

## Dataset

- **133 documents** containing **362 labelled invoices**, generated with seed 42 by [`eval/generate_dataset.py`](../eval/generate_dataset.py) ([README](../eval/README.md)).
- Formats: digital PDFs, scanned PDFs, JPG/PNG/TIFF photos and scans (4 quality levels: clean, light, medium and heavy, including 90°/180° rotations and 120–150 DPI scans), multi-invoice batch PDFs, XLSX, XLS and CSV files (registers, invoice forms, multi-sheet workbooks, line-level CSV, EU number formats, cp1252 encoding), and corrupted files.
- **8 invoice templates.** T1–T6 were used during development ("dev"). **T7–T8 are held out**: the extraction rules were never tuned on them, so they measure generalisation to unseen layouts.
- **Ground truth is what is printed.** Fields that are not printed are `null`, which is how the hallucination rate is measured. 60 invoices carry injected anomalies (wrong totals, line sums that don't match, missing fields, duplicates, negative amounts, future dates) to test validation.
- **The dataset is synthetic** (company names from Faker). It is varied, but not a substitute for real customer documents; see the caveats below.

## Key findings

- **Every valid document was processed** (100.0% success, 0.0% failures), and every corrupted file ended with a clear, typed error.
- **Hybrid extraction is 98.6% accurate at field level**, against 91.5% for rules only. The biggest gains are on layouts never seen in development (55.9% → 95.6%) and on heavily degraded scans (18.1% → 82.6%), where page images are sent to the model.
- **Values are grounded in the document.** Every AI value must be traceable to the document text; the hallucination rate (a value returned for a field that is not printed) is 0.3%.
- **Review routing is safe.** 96.2% of invoices with any wrong value were sent to manual review (rules-only: 100.0%). Of 187 auto-accepted invoices, 99.5% were fully correct. The one exception is listed below.
- **Cross-verification** found every injected mismatch and missing invoice, with no false mismatches, for both PDF vs Excel and PDF vs PDF.
- **Scale.** A 1,000-page digital batch PDF is split into 388/388 invoices in under 3 s of server time. A 100-page scanned batch takes about 75 s on 4 OCR processes.

## Headline results

| Metric | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| Document success rate (valid files processed) | 100.0% | 100.0% |
| Document failure rate (system failures) | 0.0% | 0.0% |
| Corrupted files handled gracefully (typed error, no crash) | 100.0% | 100.0% |
| Invoices detected (incl. splitting batch PDFs) | 97.5% | 100.0% |
| **Field accuracy, all fields** | 91.5% | 98.6% |
| Field accuracy, dev templates | 95.0% | 98.9% |
| Field accuracy, held-out templates | 55.9% | 95.6% |
| Hallucination rate (value returned where none is printed) | 0.6% | 0.3% |
| Line items F1 | 90.8% | 98.4% |
| Injected anomalies detected by validation | 85.0% | 86.7% |
| Invoices with a wrong field that were flagged for review | 100.0% | 96.2% |
| Auto-accepted invoices that were fully correct | 100.0% | 99.5% |
| Share of invoices routed to manual review | 52.4% | 48.3% |
| LLM calls (whole run, incl. cross-verification and latency samples) | 0 | 125 |
| LLM tokens in / out | 0 / 0 | 323,405 / 132,784 |
| Batch throughput (whole dataset uploaded at once) | 37.1 docs/min | 15.7 docs/min |

> **How to read this.** Accuracy is exact match after normalisation: amounts within half a cent, ISO dates, ISO currency codes, invoice numbers ignoring punctuation and case, names ignoring case and spacing. A field the system leaves empty because it is unsure counts as wrong. The review-routing rows measure safety: an invoice that still contains a wrong value should never be auto-accepted.

## Field accuracy by field

| Field | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| `invoice_number` | 90.3% | 97.5% |
| `invoice_date` | 94.8% | 98.3% |
| `due_date` | 95.6% | 99.4% |
| `supplier_name` | 91.7% | 97.2% |
| `customer_name` | 84.8% | 97.2% |
| `currency` | 96.1% | 99.7% |
| `subtotal` | 89.5% | 99.7% |
| `tax` | 92.8% | 99.2% |
| `total` | 87.6% | 98.9% |

## Accuracy by document type and scan quality

| Group | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| Digital PDF | 91.7% | 99.7% |
| Multi-invoice batch PDF | 86.9% | 99.4% |
| Scanned PDF | 56.0% | 94.0% |
| Image (JPG/PNG/TIFF) | 63.9% | 90.3% |
| Excel XLSX | 99.8% | 99.8% |
| Excel XLS | 100.0% | 100.0% |
| CSV | 100.0% | 100.0% |
| Scan quality: clean | 87.5% | 95.8% |
| Scan quality: light | 87.6% | 96.7% |
| Scan quality: medium | 67.1% | 95.8% |
| Scan quality: heavy | 18.1% | 82.6% |

Heavy scans are deliberately extreme: 120–150 DPI, strong blur and grain, JPEG quality around 45, and some rotated 90° or 180°.

## Validation: injected anomalies detected

| Anomaly | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| `duplicate_invoice` | 4/6 (66.7%) | 4/6 (66.7%) |
| `future_date` | 8/9 (88.9%) | 8/9 (88.9%) |
| `line_sum_mismatch` | 7/7 (100.0%) | 7/7 (100.0%) |
| `missing_date` | 5/6 (83.3%) | 5/6 (83.3%) |
| `missing_invoice_number` | 8/8 (100.0%) | 8/8 (100.0%) |
| `missing_tax` | 8/9 (88.9%) | 9/9 (100.0%) |
| `negative_amount` | 4/7 (57.1%) | 4/7 (57.1%) |
| `total_mismatch` | 7/8 (87.5%) | 7/8 (87.5%) |
| Error raised on an invoice with no injected anomaly (usually an extraction miss) | 17.3% | 4.0% |

A duplicate is detected when the later copy is flagged `DUPLICATE_INVOICE`. When extraction misses a field, the invoice is still routed to review (`MISSING_FIELD`, `LOW_CONFIDENCE`), even where the specific anomaly code is not raised.

## Review routing (human-in-the-loop safety)

| | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| Wrong field and flagged for review | 59 | 25 |
| **Wrong field but auto-accepted** | 0 | 1 |
| Correct but flagged (extra review work) | 126 | 150 |
| Correct and auto-accepted | 168 | 186 |

Every wrong value that was auto-accepted:

- Hybrid, cascade (default), `image-T5-0001`: `customer_name` read as "Crescent Burobedarf GmbH", printed as "Crescent Bürobedarf GmbH".

The umlaut was lost because the OCR engine runs with English language data only, and both the rules and the model read the same OCR text. Fix: add Tesseract language packs (`deu`, `fra`, `nld`) to the processor image, or send images for documents in EU currencies.

## Search quality (recall@5)

40 labelled invoices are sampled; each is queried by its invoice number, and by a natural-language description: "<first line item> billed by <supplier>".

| Mode | Query | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|---|
| keyword | invoice number | 75.0% | 92.5% |
| keyword | description + supplier | 0.0% | 2.5% |
| semantic | invoice number | 2.5% | 2.5% |
| semantic | description + supplier | 75.0% | 92.5% |
| hybrid | invoice number | 75.0% | 92.5% |
| hybrid | description + supplier | 75.0% | 92.5% |

Keyword search uses PostgreSQL full-text search, which requires every word to match, so it is precise for identifiers but cannot answer a paraphrase. Semantic search (local bge-small embeddings) handles paraphrases but not identifiers. Hybrid search (reciprocal-rank fusion) gets both. Recall is also capped by extraction: an invoice whose number was not read cannot be found by that number.

## Cross-verification (PDF vs Excel, PDF vs PDF)

| Pair | Mode | Mismatches found | False mismatches | Matches confirmed | Missing in register found | Extra in register found |
|---|---|---|---|---|---|---|
| recon-a (pdf_vs_excel) | Rules only (no LLM) | 2/2 | 0 | 12/12 | 1/1 | 1/1 |
| recon-b (pdf_vs_pdf) | Rules only (no LLM) | 2/2 | 0 | 6/6 | 0/0 | 0/0 |
| recon-a (pdf_vs_excel) | Hybrid, cascade (default) | 2/2 | 0 | 12/12 | 1/1 | 1/1 |
| recon-b (pdf_vs_pdf) | Hybrid, cascade (default) | 2/2 | 0 | 6/6 | 0/0 | 0/0 |

## Processing time

**Idle latency.** One document at a time on an idle system. Server-side time from upload to stored result (`processing_ms`), shown as mean and maximum over the sampled documents:

| Document type | Rules only (no LLM) | Hybrid, cascade (default) |
|---|---|---|
| pdf_digital | 46 ms (max 65 ms) | 18.2 s (max 35.0 s) |
| multi_invoice_pdf | 124 ms (max 147 ms) | 43.2 s (max 56.0 s) |
| pdf_scanned | 7.6 s (max 11.7 s) | 26.6 s (max 39.0 s) |
| image | 5.6 s (max 13.3 s) | 25.7 s (max 53.0 s) |
| xlsx | 60 ms (max 103 ms) | 50 ms (max 79 ms) |
| xls | 57 ms (max 75 ms) | 57 ms (max 70 ms) |
| csv | 65 ms (max 76 ms) | 68 ms (max 70 ms) |

**Throughput.** The whole dataset was uploaded in one burst:

- Rules only (no LLM): 213.3 s for the dataset, **37.1 documents/min**. Time from upload to result under the burst: p50 2.9 s, p95 160.9 s (includes queue wait).
- Hybrid, cascade (default): 503.1 s for the dataset, **15.7 documents/min**. Time from upload to result under the burst: p50 125.0 s, p95 441.2 s (includes queue wait).

### Large batch PDFs (1,000 pages)

- Dataset: `eval/generate_dataset.py --profile perf` produces a 1,000-page digital batch PDF and a 100-page scanned batch PDF (425 labelled invoices in total).
- Result: 2/2 processed, 99.8% of invoices detected by segmentation, field accuracy 89.5%.
- `perf-digital-1000p.pdf`: 1000 pages, server-side **2.8 s** (352 pages/s; 6.2 s as seen by the client), 388/388 invoices split out correctly.
- `perf-scanned-100p.pdf`: 100 pages, server-side **75.5 s** (1.3 pages/s; 76.4 s as seen by the client), 37/37 invoices split out correctly.
- Run in rules-only mode to measure the document pipeline itself. With the LLM on, add one model call per invoice that the cascade flags, run 4 at a time per worker process.

Environment: Apple M4, 16 GB RAM (macOS); Docker Desktop VM: 10 CPUs, 7.7 GB. Processor: 4 uvicorn workers (OCR concurrency 6). API and workers: one Node process (`APP_ROLE=all`, page concurrency 4, analyze concurrency 6). LLM: Azure OpenAI `gpt-6-astra` (reasoning effort low, concurrency 4).

## Methodology details

- **Matching.** Extracted invoices are paired with ground-truth invoices by normalised invoice number, or failing that by the best overlap of total, date, supplier and subtotal. A ground-truth invoice with no match scores every field as wrong.
- **Hallucination rate.** Among fields that are not printed on the document (ground truth `null`), the share where the system still returned a value.
- **Line items.** A predicted item matches a labelled item when the amounts are equal; each labelled item can be matched once. The report also gives the share of matched items whose description matches (90% or better similarity).
- **Corrupted files.** "Handled" means a clear, typed outcome: rejected at upload (empty or unsupported), or `failed` with a stable `error_code` and no retries. The one recoverable case (a PNG saved as `.jpg`) must succeed.
- **Isolation.** Each mode runs against a freshly truncated database on a separate API instance (its own queue prefix), so duplicate detection only sees that run's documents.
- **No tuning on held-out data.** Extraction rules and OCR parameters were tuned on the dev split only, and the held-out templates were never inspected during development.

## Caveats

- Synthetic documents cannot cover the full variety of real invoices: handwriting, stamps over text, folded paper, multi-currency invoices, non-Latin scripts. The held-out score is the best available estimate of performance on unseen layouts.
- With the LLM involved, results vary slightly from run to run. Rules-only results are deterministic for a given OCR output.
- Latencies depend on hardware and on LLM endpoint load. `gpt-6-astra` is a reasoning model, at roughly 15–35 s per call here.
