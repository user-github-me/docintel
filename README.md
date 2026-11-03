# DocIntel: AI-powered document intelligence

DocIntel turns invoices and receipts into validated, searchable data. It reads digital PDFs, scanned PDFs, phone photos and scans (JPG/PNG/TIFF), Excel (XLSX/XLS) and CSV files, including 1,000-page batch PDFs. Reviewers only look at what the system flags.

**What happens to a document:**

1. Text is extracted. OCR handles scans, with measured preprocessing for poor image quality.
2. Batch PDFs are split into individual invoices.
3. Fields and line items are extracted by deterministic rules plus an LLM cascade with strict JSON output.
4. Every AI value is grounded in the source, so nothing is invented.
5. Totals, line items, dates and duplicates are validated, and uncertain records are routed to manual review.
6. Results are stored in PostgreSQL with full-text and semantic search, cross-verified PDF vs PDF and PDF vs Excel, and exposed through a REST API and a Next.js review UI.

> Built as the AI Engineer assessment for Care Guide (Task 1.3). Measured results: [docs/EVALUATION.md](docs/EVALUATION.md).

| | |
|---|---|
| **Architecture** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diagram, pipeline, scalability, reliability, security, design decisions |
| **Database schema** | [docs/DATABASE.md](docs/DATABASE.md): ER diagram and notes; SQL in [db/migrations](db/migrations/001_init.sql) |
| **Evaluation report** | [docs/EVALUATION.md](docs/EVALUATION.md): measured accuracy, success/failure rates, latency, throughput |
| **AI disclosure and prompts** | [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md), [docs/prompts/](docs/prompts/) |
| **Walkthrough** | [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) (recording link and script) |
| **API reference** | OpenAPI/Swagger at `http://localhost:4000/docs` once running |

## Quick start (Docker)

Requirements: Docker Desktop (about 6 GB free disk) and nothing else.

```bash
cp .env.example .env          # optional: add an Azure OpenAI or Anthropic key for the AI pass
docker compose up --build -d  # postgres+pgvector, redis, processor, api, worker, web
open http://localhost:3000    # web UI
open http://localhost:4000/docs  # Swagger (API key: dev-admin-key-change-me)
```

Scale OCR and AI workers horizontally with `docker compose up -d --scale worker=4`.

Without any LLM key the system runs in **rules-only mode**. It still processes every format; the [evaluation](docs/EVALUATION.md) reports both modes. To enable the AI pass, set `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_DEPLOYMENT`, or `ANTHROPIC_API_KEY`, in `.env`.

### Try it from the command line

```bash
KEY=dev-admin-key-change-me
# upload several files at once (processing runs in the background)
curl -s -H "X-API-Key: $KEY" -F files=@fixtures/invoice_digital.pdf -F files=@fixtures/invoice_scanned.png \
     -F files=@fixtures/register.xlsx -F files=@fixtures/corrupted.pdf http://localhost:4000/api/v1/documents
curl -s -H "X-API-Key: $KEY" "http://localhost:4000/api/v1/documents?pageSize=10"         # status & progress
curl -s -H "X-API-Key: $KEY" "http://localhost:4000/api/v1/invoices?status=needs_review"  # review queue
curl -s -H "X-API-Key: $KEY" "http://localhost:4000/api/v1/search?q=physiotherapy%20home%20visits&mode=hybrid"
```

## Local development

```bash
make dev    # postgres, redis and the Python processor in Docker (hot reload)
make api    # NestJS API + workers on :4000 (APP_ROLE=all)
make web    # Next.js on :3000
```

| Command | What it runs |
|---|---|
| `make test-api` | API unit and integration tests (Jest): extraction, OCR-output golden tests, spreadsheets, segmentation, grounding/merge, validation, reconciliation, LLM adapters with mocked SDKs, upload screening |
| `make test-processor` | Processor tests in the Docker image (pytest, including OCR on rotated and noisy scans) |
| `make test-e2e` | Black-box HTTP tests against a running stack: auth, upload rejection, pipeline, OCR, corrupted files, duplicates, corrections, approval rules, search, reprocess, cross-verification, SSE |
| `make test-web` | Playwright smoke test of the UI |
| `make dataset` | Regenerate the labelled evaluation dataset (deterministic, seed 42) |
| `make eval` | End-to-end evaluation; see [docs/EVALUATION.md](docs/EVALUATION.md) |

Test results from the last run are in [docs/test-results/](docs/test-results/).

## How the assignment maps to the code

| Task | Implementation |
|---|---|
| **1. Document processing** | [`services/processor`](services/processor/app). Detects file type from content (not the extension). Uses the PDF text layer when usable and OCR otherwise. OCR for poor scans: despeckle, robust grain estimate, scaling, NL-means denoising, contrast, speck removal, deskew, table-rule removal, rotation probe, multi-pass. Multi-page PDFs are split into page-range jobs, so a 1,000-page PDF fans out across workers. Spreadsheets: multiple sheets, XLS dates, CSV delimiter and encoding sniffing. Corrupted, encrypted and empty files fail with stable error codes, without retries. |
| **2. AI information extraction** | [`apps/api/src/extraction`](apps/api/src/extraction): segmentation of batch PDFs, a rules engine, an LLM provider layer (Azure OpenAI Responses API with strict JSON schema, and Anthropic Claude), a cascade strategy, a vision fallback for poor OCR, **grounding** (no invented values) and a confidence-aware merge. Output is structured JSON with value, confidence, source and verbatim evidence per field, plus line items. |
| **3. Data validation** | [`apps/api/src/validation`](apps/api/src/validation): missing fields; invalid or negative numbers; subtotal + tax (− discount + shipping) vs total; line items vs subtotal; qty × price; unusual tax rates; date sanity and ambiguity; currency; low confidence or poor OCR; duplicates (exact and possible) checked against the database. Uncertain records go to `needs_review`. |
| **4. Backend API** | NestJS: [documents](apps/api/src/documents/documents.controller.ts) (multi-file upload, status, pages, page images, download, history, reprocess, delete), [invoices](apps/api/src/invoices/invoices.controller.ts) (results, audited corrections, approve, reject), [search](apps/api/src/search), [reconciliations](apps/api/src/reconciliation), [jobs](apps/api/src/stats/stats.controller.ts) (queue stats, retry failed), SSE events. OCR and AI run in the background on BullMQ. |
| **5. Database and search** | PostgreSQL 17 with [schema](db/migrations/001_init.sql) for metadata, page text, structured results, validation issues, corrections and processing history. Keyword search (FTS, trigram) plus semantic search (pgvector HNSW, local embeddings) plus hybrid (RRF), with structured filters. |
| **6. Frontend** | [`apps/web`](apps/web): Next.js with multi-file upload, live progress (SSE), document and page viewer, invoice review with evidence highlighting and corrections, validation issues, review queue, search, cross-verification. |
| **7. Testing and evaluation** | Unit, integration, black-box e2e and UI tests, plus a labelled dataset (133 docs / 362 invoices, held-out templates) evaluated end to end. [Measured report](docs/EVALUATION.md). |
| **Scenario: PDF–PDF and PDF–Excel cross-verification** | `POST /reconciliations` matches invoices by number, or fuzzily by supplier, amount and date, and reports field discrepancies and invoices missing on each side. |

## Configuration

All settings are environment variables, documented in [`.env.example`](.env.example). The most important:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `auto` | `azure-openai`, `anthropic` or `none`. `auto` picks whichever is configured. |
| `LLM_STRATEGY` | `fallback` | `fallback`: cascade, call the LLM only when rules are incomplete or uncertain. `always`: every invoice. `never`: no LLM calls. |
| `LLM_VISION_FALLBACK` | `true` | Attach page images when OCR confidence is below 0.9. |
| `API_KEYS` | `admin:dev-admin-key-change-me` | `name:key` pairs. Change for any non-local use. |
| `PAGE_CHUNK_SIZE` | `16` | Pages per extraction job (halved for scanned PDFs). |
| `WORKER_CONCURRENCY_PAGES` / `_ANALYZE` | `4` / `6` | Jobs per worker process. OCR is CPU-bound and analysis is I/O-bound, waiting on the LLM. |

## Project structure

```
apps/api            NestJS REST API + BullMQ workers (TypeScript)
apps/web            Next.js review UI with server-side API proxy
services/processor  Python FastAPI: PDF/OCR/spreadsheets/rendering/embeddings
db/migrations       PostgreSQL schema
eval/               labelled dataset generator, end-to-end evaluation runner, results
fixtures/           small labelled sample files used by tests
docs/               architecture, database, evaluation, AI disclosure, prompts, walkthrough
```

## Security notes

- API-key authentication, compared in constant time, with the key name recorded as the audit actor. The web UI uses a server-side proxy, so the browser never holds a key.
- Uploads are screened (allowlist, size limits, executables). Files are stored under random names; downloads are forced to attachment with `nosniff`.
- The processor guards against path traversal, decompression bombs and zip bombs.
- Parameterised SQL, strict DTO validation, Helmet headers, CORS, rate limiting.
- LLM input is treated as untrusted data: no tools, schema-constrained output, grounding, `store: false`.
- Containers run as non-root. Secrets live only in the git-ignored `.env`.

Full details: [docs/ARCHITECTURE.md#security](docs/ARCHITECTURE.md#security).
