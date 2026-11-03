# Database schema

PostgreSQL 17 with the `vector` (pgvector) and `pg_trgm` extensions. The schema is defined in [`db/migrations/001_init.sql`](../db/migrations/001_init.sql). Migrations run automatically on start, under an advisory lock.

```mermaid
erDiagram
  documents ||--o{ document_pages : "has"
  documents ||--o{ invoices : "contains"
  documents ||--o{ validation_issues : "document-level issues"
  documents ||--o{ processing_events : "history"
  documents ||--o{ document_chunks : "search chunks"
  documents ||--o{ corrections : "audit"
  documents |o--o| documents : "duplicate_of"
  invoices ||--o{ invoice_line_items : "has"
  invoices ||--o{ validation_issues : "has"
  invoices ||--o{ corrections : "audited by"
  reconciliations ||--o{ reconciliation_items : "has"
  documents ||--o{ reconciliations : "left / right"
  invoices |o--o{ reconciliation_items : "left / right"

  documents {
    uuid id PK
    text original_filename
    text storage_key "random UUID path in object storage"
    text file_type "pdf | image | xlsx | xls | csv"
    char sha256 "byte-level duplicate detection"
    text purpose "invoices | reference (ledger for cross-verification)"
    text status "queued | processing | analyzing | completed | failed | duplicate"
    text stage
    smallint progress
    boolean needs_review
    int page_count
    int pages_processed
    int ocr_pages
    real avg_ocr_confidence
    int invoice_count
    text error_code "stable code: corrupted_file, encrypted_pdf, ..."
    int run_id "increments on reprocess"
    int processing_ms
    int llm_calls
    int llm_input_tokens
    int llm_output_tokens
  }
  document_pages {
    uuid document_id PK,FK
    int page_number PK
    text kind "text | ocr | empty | error | sheet"
    text text "layout-preserving text"
    real ocr_confidence
    jsonb lines "text + normalised bbox per line (evidence highlight)"
    jsonb table_data "spreadsheet grid"
    tsvector tsv "generated, GIN"
  }
  invoices {
    uuid id PK
    uuid document_id FK
    int sequence
    int page_start
    int page_end
    text sheet_name
    text invoice_number
    text invoice_number_norm "dedupe key"
    date invoice_date
    date due_date
    text supplier_name
    text supplier_norm "trigram-indexed"
    text customer_name
    char currency
    numeric subtotal
    numeric tax
    numeric discount
    numeric shipping
    numeric total
    jsonb fields "per field: value, confidence, source, evidence, alternatives"
    text extraction_method "rules | llm | hybrid | spreadsheet | manual"
    real confidence
    text status "needs_review | validated | approved | rejected"
    int version "optimistic locking"
    tsvector tsv "generated, GIN"
    vector embedding "384-d, HNSW"
  }
  invoice_line_items {
    bigint id PK
    uuid invoice_id FK
    int position
    text description
    numeric quantity
    numeric unit_price
    numeric amount
    real confidence
    text source
  }
  validation_issues {
    bigint id PK
    uuid document_id FK
    uuid invoice_id FK
    text code "TOTAL_MISMATCH, DUPLICATE_INVOICE, ..."
    text severity "error | warning | info"
    text field
    text message
    jsonb details
  }
  corrections {
    bigint id PK
    uuid invoice_id FK
    uuid document_id FK
    text field
    jsonb old_value
    jsonb new_value
    text reason
    text actor
  }
  processing_events {
    bigint id PK
    uuid document_id FK
    int run_id
    text stage "upload | inspect | extract-text | analyze | index | correction | approval"
    text status "started | completed | failed | retrying | info"
    int duration_ms
    jsonb details
    text actor
  }
  document_chunks {
    bigint id PK
    uuid document_id FK
    int page_number
    text content
    vector embedding "384-d, HNSW"
    tsvector tsv
  }
  reconciliations {
    uuid id PK
    uuid left_document_id FK
    uuid right_document_id FK
    jsonb options
    jsonb summary
  }
  reconciliation_items {
    bigint id PK
    uuid reconciliation_id FK
    uuid left_invoice_id FK
    uuid right_invoice_id FK
    text status "matched | mismatch | missing_in_right | missing_in_left"
    jsonb discrepancies
  }
```

## Design notes

- **Money is exact.** All amounts are `numeric(18,4)`. The API and extractors use `decimal.js`, and floats are never used for money. `NUMERIC` values are returned to Node as strings.
- **Structured columns and provenance together.** Canonical values live in typed, indexed columns, used for filtering, sorting, duplicate detection and reconciliation. `invoices.fields` (JSONB) keeps each field's confidence, source, verbatim evidence (with page and bounding box) and the alternatives that were rejected. This is what the review UI shows, and what corrections update.
- **Processing history** goes into `processing_events`, append-only. It records every stage with its duration, retries with the attempt number, failures with a stable code, and corrections and approvals with the actor. `corrections` keeps old and new values; its `invoice_id` uses `ON DELETE SET NULL`, so the audit trail outlives re-extraction.
- **Idempotency.** Pages are keyed `(document_id, page_number)` and upserted, because chunk jobs can be retried. Invoices for a document are replaced inside one transaction per run. `run_id` lets workers ignore stale jobs.
- **Search indexes.**
  - Generated `tsvector` columns, with GIN indexes on invoices, pages and chunks, use the `simple` configuration, so identifiers and names are not stemmed.
  - Trigram indexes on `supplier_norm` and `invoice_number_norm` support fuzzy supplier matching for duplicates and partial invoice-number search.
  - HNSW indexes (`vector_cosine_ops`) on invoice and chunk embeddings drive semantic search; `embedding_model` prevents comparing vectors from different models.
- **Duplicate detection** uses `(invoice_number_norm, supplier_norm)` and is restricted to documents with `purpose = 'invoices'`. Ledgers uploaded for cross-verification are `reference` documents, so they do not raise false duplicates.
- **Retention.** Deleting a document cascades to everything derived from it, which supports privacy and erasure requests.
