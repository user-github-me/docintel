-- DocIntel schema. PostgreSQL 16+ with pgvector (semantic search) and pg_trgm (fuzzy matching).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One row per uploaded file.
CREATE TABLE documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename      text        NOT NULL,
  storage_key            text        NOT NULL,
  mime_type              text,
  file_type              text CHECK (file_type IN ('pdf', 'image', 'xlsx', 'xls', 'csv')),
  size_bytes             bigint      NOT NULL,
  sha256                 char(64)    NOT NULL,
  purpose                text        NOT NULL DEFAULT 'invoices' CHECK (purpose IN ('invoices', 'reference')),
  status                 text        NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'processing', 'analyzing', 'completed', 'failed', 'duplicate')),
  stage                  text,
  progress               smallint    NOT NULL DEFAULT 0,
  needs_review           boolean     NOT NULL DEFAULT false,
  duplicate_of           uuid REFERENCES documents (id) ON DELETE SET NULL,
  page_count             int,
  pages_processed        int         NOT NULL DEFAULT 0,
  ocr_pages              int         NOT NULL DEFAULT 0,
  avg_ocr_confidence     real,
  invoice_count          int         NOT NULL DEFAULT 0,
  error_code             text,
  error_message          text,
  warnings               jsonb       NOT NULL DEFAULT '[]',
  run_id                 int         NOT NULL DEFAULT 1,
  attempts               int         NOT NULL DEFAULT 0,
  uploaded_by            text,
  processing_started_at  timestamptz,
  processing_finished_at timestamptz,
  processing_ms          int,
  indexed_at             timestamptz,
  llm_calls              int         NOT NULL DEFAULT 0,
  llm_input_tokens       int         NOT NULL DEFAULT 0,
  llm_output_tokens      int         NOT NULL DEFAULT 0,
  metadata               jsonb       NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_status_idx  ON documents (status, created_at DESC);
CREATE INDEX documents_created_idx ON documents (created_at DESC);
CREATE INDEX documents_sha256_idx  ON documents (sha256);
CREATE INDEX documents_review_idx  ON documents (needs_review) WHERE needs_review;
CREATE INDEX documents_name_trgm   ON documents USING gin (original_filename gin_trgm_ops);

-- Extracted text per PDF page / image frame / spreadsheet sheet.
CREATE TABLE document_pages (
  document_id    uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  page_number    int         NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('text', 'ocr', 'empty', 'error', 'sheet')),
  sheet_name     text,
  text           text        NOT NULL DEFAULT '',
  ocr_confidence real,
  lines          jsonb,      -- [{text, bbox:[x0,y0,x1,y1], conf}] (normalised) for evidence highlighting
  table_data     jsonb,      -- spreadsheet cell grid
  width          real,
  height         real,
  warnings       jsonb       NOT NULL DEFAULT '[]',
  ocr_steps      jsonb       NOT NULL DEFAULT '[]',
  duration_ms    int,
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(text, 200000))) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, page_number)
);
CREATE INDEX document_pages_tsv_idx ON document_pages USING gin (tsv);

-- Structured invoices (a document can hold many: batch PDFs, spreadsheet registers).
CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid          NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  sequence            int           NOT NULL,
  page_start          int,
  page_end            int,
  sheet_name          text,
  row_start           int,
  row_end             int,
  invoice_number      text,
  invoice_number_norm text,
  invoice_date        date,
  due_date            date,
  supplier_name       text,
  supplier_norm       text,
  customer_name       text,
  currency            char(3),
  subtotal            numeric(18, 4),
  tax                 numeric(18, 4),
  discount            numeric(18, 4),
  shipping            numeric(18, 4),
  total               numeric(18, 4),
  fields              jsonb         NOT NULL DEFAULT '{}', -- per field: value, confidence, source, evidence, alternatives
  extraction_method   text          NOT NULL CHECK (extraction_method IN ('rules', 'llm', 'hybrid', 'spreadsheet', 'manual')),
  llm_model           text,
  document_type       text          NOT NULL DEFAULT 'invoice',
  confidence          real          NOT NULL DEFAULT 0,
  status              text          NOT NULL DEFAULT 'needs_review'
                      CHECK (status IN ('needs_review', 'validated', 'approved', 'rejected')),
  review_reasons      jsonb         NOT NULL DEFAULT '[]',
  notes               jsonb         NOT NULL DEFAULT '[]',
  is_corrected        boolean       NOT NULL DEFAULT false,
  approved_by         text,
  approved_at         timestamptz,
  version             int           NOT NULL DEFAULT 1, -- optimistic locking for corrections
  search_text         text          NOT NULL DEFAULT '',
  tsv                 tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  embedding           vector(384),
  embedding_model     text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX invoices_document_idx      ON invoices (document_id, sequence);
CREATE INDEX invoices_dup_idx           ON invoices (invoice_number_norm, supplier_norm);
CREATE INDEX invoices_date_idx          ON invoices (invoice_date);
CREATE INDEX invoices_total_idx         ON invoices (total);
CREATE INDEX invoices_status_idx        ON invoices (status, created_at DESC);
CREATE INDEX invoices_tsv_idx           ON invoices USING gin (tsv);
CREATE INDEX invoices_supplier_trgm_idx ON invoices USING gin (supplier_norm gin_trgm_ops);
CREATE INDEX invoices_number_trgm_idx   ON invoices USING gin (invoice_number_norm gin_trgm_ops);
CREATE INDEX invoices_embedding_idx     ON invoices USING hnsw (embedding vector_cosine_ops);

CREATE TABLE invoice_line_items (
  id          bigserial PRIMARY KEY,
  invoice_id  uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  position    int  NOT NULL,
  description text,
  quantity    numeric(18, 4),
  unit_price  numeric(18, 4),
  amount      numeric(18, 4),
  confidence  real,
  source      text,
  page        int,
  evidence    text
);
CREATE INDEX line_items_invoice_idx ON invoice_line_items (invoice_id, position);

CREATE TABLE validation_issues (
  id          bigserial PRIMARY KEY,
  document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  invoice_id  uuid REFERENCES invoices (id) ON DELETE CASCADE,
  code        text        NOT NULL,
  severity    text        NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  field       text,
  message     text        NOT NULL,
  details     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validation_issues_invoice_idx  ON validation_issues (invoice_id);
CREATE INDEX validation_issues_document_idx ON validation_issues (document_id);
CREATE INDEX validation_issues_code_idx     ON validation_issues (code, severity);

-- Audit trail of human corrections (kept even if the invoice is re-extracted).
CREATE TABLE corrections (
  id          bigserial PRIMARY KEY,
  invoice_id  uuid REFERENCES invoices (id) ON DELETE SET NULL,
  document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  field       text        NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  actor       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corrections_invoice_idx  ON corrections (invoice_id, created_at);
CREATE INDEX corrections_document_idx ON corrections (document_id);

-- Processing history (every stage start/finish/failure/retry, corrections, approvals).
CREATE TABLE processing_events (
  id          bigserial PRIMARY KEY,
  document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  invoice_id  uuid,
  run_id      int,
  stage       text        NOT NULL,
  status      text        NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'retrying', 'info')),
  message     text,
  duration_ms int,
  details     jsonb       NOT NULL DEFAULT '{}',
  actor       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_events_document_idx ON processing_events (document_id, id);

-- Text chunks for document-level keyword + semantic search.
CREATE TABLE document_chunks (
  id              bigserial PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  page_number     int,
  chunk_index     int  NOT NULL,
  content         text NOT NULL,
  embedding       vector(384),
  embedding_model text,
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX document_chunks_document_idx  ON document_chunks (document_id);
CREATE INDEX document_chunks_tsv_idx       ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_embedding_idx ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- Cross-verification (PDF vs PDF, PDF vs Excel/CSV).
CREATE TABLE reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  left_document_id  uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  right_document_id uuid        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  options           jsonb       NOT NULL DEFAULT '{}',
  summary           jsonb       NOT NULL DEFAULT '{}',
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reconciliation_items (
  id                bigserial PRIMARY KEY,
  reconciliation_id uuid NOT NULL REFERENCES reconciliations (id) ON DELETE CASCADE,
  left_invoice_id   uuid REFERENCES invoices (id) ON DELETE SET NULL,
  right_invoice_id  uuid REFERENCES invoices (id) ON DELETE SET NULL,
  status            text NOT NULL CHECK (status IN ('matched', 'mismatch', 'missing_in_right', 'missing_in_left')),
  match_method      text,
  match_score       real,
  discrepancies     jsonb NOT NULL DEFAULT '[]',
  left_summary      jsonb,
  right_summary     jsonb
);
CREATE INDEX reconciliation_items_idx ON reconciliation_items (reconciliation_id);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER invoices_touch  BEFORE UPDATE ON invoices  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
