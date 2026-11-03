# Walkthrough

- **Automated recording:** [`docs/media/walkthrough.mp4`](media/walkthrough.mp4) (1 min 44 s, 1440×900). A captioned, silent screen recording of the working application in hybrid mode (Azure OpenAI cascade). It was recorded with Playwright against the running stack (`apps/web/e2e/walkthrough.spec.ts`) and shows upload with live progress, batch splitting, a corrupted file failing cleanly, review and correction with evidence highlighting, approval, keyword and semantic search, and PDF vs Excel cross-verification.
- **Screenshots:** [`docs/media/screenshots/`](media/screenshots/).

## Script for a narrated walkthrough (about 8 minutes)

Use this outline to record a voice-over version, for example with Loom or QuickTime screen recording.

1. **Problem and approach (30 s).** Thousands of mixed documents arrive every day: PDFs, scans, photos, Excel and CSV files. The goal is to extract invoice data without inventing values, validate it, flag only the uncertain cases for people, and make everything searchable and cross-checkable.
2. **Architecture (60 s).** Show `docs/ARCHITECTURE.md`. Cover:
   - The NestJS API and BullMQ workers.
   - The Python processor, which handles OCR and spreadsheets.
   - PostgreSQL with pgvector.
   - The LLM cascade (Azure OpenAI), with grounding.
   - That every tier scales independently, and that a 1,000-page PDF fans out into page-range jobs.
3. **Upload (60 s).** On the dashboard, drag in a mixed batch: a digital PDF, a scanned image, a multi-invoice PDF, an Excel register and a corrupted PDF. Show live progress (SSE). Point out that the corrupted file fails with a clear `corrupted_file` code and no retries.
4. **Results (90 s).**
   - Open the multi-invoice PDF: the batch was split into separate invoices.
   - Open the Excel register: one invoice per row, and the TOTAL footer was ignored.
   - Open a scanned invoice: the page image is shown next to the OCR text, with OCR confidence and the preprocessing steps applied.
5. **Review and correct (90 s).** Open the review queue and pick an invoice with a `TOTAL_MISMATCH` or a low-confidence field.
   - Click a field to highlight its evidence on the page image. Show the confidence and source badges (rules, llm, rules+llm).
   - Correct a value and save: validation re-runs, and the audit history records who changed what.
   - Try to approve an invoice with errors (it is blocked), fix it, then approve.
6. **Search (45 s).** Keyword search by invoice number; semantic search with a natural-language query ("physiotherapy home visits from …"); hybrid search combining both.
7. **Cross-verification (45 s).** Compare the invoice PDF batch with the Excel register. Show the amount mismatches, the invoice missing from the register, and the extra row.
8. **Quality evidence (60 s).** Show `docs/EVALUATION.md`:
   - success and failure rates, and the field accuracy for rules-only vs hybrid;
   - the held-out templates and the 0.6% hallucination rate;
   - that every invoice with a wrong value was routed to review;
   - latency and throughput.

   Mention the honest caveats: the data is synthetic, and heavy scans are the hardest case.
9. **Close (15 s).** Tests (unit, end-to-end, UI), Docker one-command start, security measures, and the AI-assistance disclosure.
