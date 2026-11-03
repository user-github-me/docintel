# Test results

These are the results of the last runs, captured on 2026-11-03.

| Suite | Scope | Result | Output |
|---|---|---|---|
| API unit and integration (Jest) | Number, date and currency parsing; rules extraction including golden tests on real processor output (digital, OCR, batch, spreadsheets); segmentation; spreadsheet registers and joins; grounding and rules/LLM merge; validation rules; cross-verification matcher; LLM adapters (Azure OpenAI, Anthropic) with mocked SDKs, including refusal and truncation; extraction cascade and vision fallback; upload screening | **70 passed** (11 suites) | [api-unit-tests.txt](api-unit-tests.txt) |
| Processor (pytest, in the Docker image) | Type detection and rejection codes; layout reconstruction; PDF text, page ranges, encrypted, truncated and repaired files, rendering; OCR on clean, sideways and noisy scans; speck and ruling-line removal; deskew; XLSX/XLS/CSV including encodings and corrupted workbooks; HTTP API including path traversal and typed errors | **38 passed** | [processor-tests.txt](processor-tests.txt), [processor-junit.xml](processor-junit.xml) |
| API end-to-end, black box (local stack) | Real queue, workers, OCR and database. Auth, upload rejection, input validation, digital/OCR/spreadsheet extraction with evidence, corrupted files without retries, duplicate uploads, page images and downloads, reprocessing, corrections with optimistic locking and re-validation, approval rules, keyword and hybrid search, cross-verification, stats and queues, SSE | **15 passed** | [api-e2e-tests.txt](api-e2e-tests.txt) |
| API end-to-end, black box (`docker compose up --build`) | The same suite against the fully containerised deployment: separate API and worker containers, with the Azure OpenAI cascade enabled | **15 passed** | [api-e2e-tests-docker.txt](api-e2e-tests-docker.txt) |
| Web UI (Playwright, against the Docker web container) | Dashboard, upload through the UI, correcting a total re-runs validation, search, cross-verify page, API key never exposed to the browser | **6 passed** | [web-e2e-junit.xml](web-e2e-junit.xml) |
| Walkthrough (Playwright) | The full product tour recorded to video | **passed** | [../media/walkthrough.mp4](../media/walkthrough.mp4) |
| Evaluation (labelled dataset, end to end) | Accuracy, failure handling, validation, search, cross-verification, latency | see report | [../EVALUATION.md](../EVALUATION.md) |

Re-run with `make test-api`, `make test-processor`, `make test-e2e` (needs a running stack) and `make test-web`.
