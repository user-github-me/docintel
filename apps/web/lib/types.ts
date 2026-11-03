/** Shapes returned by the DocIntel REST API (see /docs on the API). */

export type DocumentStatus = "queued" | "processing" | "analyzing" | "completed" | "failed" | "duplicate";
export type FileType = "pdf" | "image" | "xlsx" | "xls" | "csv";
export type InvoiceStatus = "needs_review" | "validated" | "approved" | "rejected";
export type Severity = "error" | "warning" | "info";
export type FieldSource = "rules" | "llm" | "rules+llm" | "spreadsheet" | "manual" | "none";

export interface DocumentSummary {
  id: string;
  filename: string;
  fileType: FileType | null;
  mimeType: string | null;
  sizeBytes: number;
  purpose: "invoices" | "reference";
  status: DocumentStatus;
  stage: string | null;
  progress: number;
  needsReview: boolean;
  duplicateOf: string | null;
  pageCount: number | null;
  pagesProcessed: number;
  ocrPages: number;
  avgOcrConfidence: number | null;
  invoiceCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  warnings: string[];
  runId: number;
  uploadedBy: string | null;
  processingMs: number | null;
  indexedAt: string | null;
  llm: { calls: number; inputTokens: number; outputTokens: number };
  createdAt: string;
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DocumentInvoiceRow {
  id: string;
  sequence: number;
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  currency: string | null;
  total: string | null;
  status: InvoiceStatus;
  confidence: number;
  extraction_method: string;
  page_start: number | null;
  page_end: number | null;
  sheet_name: string | null;
  row_start: number | null;
  is_corrected: boolean;
  errors: number;
  warnings: number;
}

export interface DocumentDetail extends DocumentSummary {
  invoices: DocumentInvoiceRow[];
  documentIssues: Array<{ code: string; severity: Severity; message: string; details: Record<string, unknown> }>;
  correctionCount: number;
}

export interface PageLine {
  text: string;
  bbox: number[];
  conf: number | null;
}

export interface DocumentPage {
  page_number: number;
  kind: "text" | "ocr" | "empty" | "error" | "sheet";
  sheet_name: string | null;
  text: string;
  ocr_confidence: number | null;
  lines: PageLine[] | null;
  /** Spreadsheet cell grid (sheets only). */
  table_data?: Array<Array<string | number | null>> | null;
  width: number | null;
  height: number | null;
  warnings: string[];
  ocr_steps: string[];
  duration_ms: number | null;
}

export interface ProcessingEvent {
  id: number;
  stage: string;
  status: "started" | "completed" | "failed" | "retrying" | "info";
  message: string | null;
  duration_ms: number | null;
  details: Record<string, unknown>;
  actor: string | null;
  run_id: number | null;
  created_at: string;
}

export interface Evidence {
  text: string;
  page?: number | null;
  bbox?: number[] | null;
  cell?: string | null;
}

export interface FieldValue {
  value: string | null;
  confidence: number;
  source: FieldSource;
  evidence?: Evidence | null;
  raw?: string | null;
  alternatives?: Array<{ value: string; source: FieldSource; confidence: number }>;
  note?: string | null;
}

export const FIELD_ORDER = [
  "invoice_number",
  "invoice_date",
  "due_date",
  "supplier_name",
  "customer_name",
  "currency",
  "subtotal",
  "discount",
  "shipping",
  "tax",
  "total",
] as const;
export type FieldName = (typeof FIELD_ORDER)[number];

export interface LineItem {
  position: number;
  description: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string | null;
  confidence: number | null;
  source: string | null;
  page: number | null;
  evidence: string | null;
}

export interface ValidationIssue {
  id: number;
  code: string;
  severity: Severity;
  field: string | null;
  message: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Correction {
  field: string;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  actor: string;
  created_at: string;
}

export interface InvoiceListRow {
  id: string;
  document_id: string;
  filename: string;
  file_type: FileType | null;
  sequence: number;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  status: InvoiceStatus;
  confidence: number;
  extraction_method: string;
  is_corrected: boolean;
  page_start: number | null;
  page_end: number | null;
  sheet_name: string | null;
  created_at: string;
  errors: number;
  warnings: number;
}

export interface InvoiceDetail {
  id: string;
  document_id: string;
  sequence: number;
  page_start: number | null;
  page_end: number | null;
  sheet_name: string | null;
  row_start: number | null;
  row_end: number | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  discount: string | null;
  shipping: string | null;
  total: string | null;
  fields: Record<FieldName, FieldValue>;
  extraction_method: string;
  llm_model: string | null;
  document_type: string;
  confidence: number;
  status: InvoiceStatus;
  review_reasons: string[];
  notes: string[];
  is_corrected: boolean;
  approved_by: string | null;
  approved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  filename: string;
  file_type: FileType | null;
  page_count: number | null;
  document: { id: string; filename: string; fileType: FileType | null; pageCount: number | null };
  lineItems: LineItem[];
  issues: ValidationIssue[];
  corrections: Correction[];
  semanticIndexed: boolean;
}

export interface InvoiceHistory {
  corrections: Correction[];
  events: Array<{ stage: string; status: string; message: string | null; actor: string | null; duration_ms: number | null; created_at: string }>;
}

export interface SearchResult {
  invoice: Pick<
    InvoiceListRow,
    "id" | "document_id" | "filename" | "file_type" | "invoice_number" | "invoice_date" | "supplier_name" | "customer_name" | "currency" | "total" | "status" | "confidence" | "page_start" | "page_end" | "sheet_name"
  >;
  score: number;
  matchedBy: Array<"keyword" | "semantic">;
  snippet: string | null;
  page: number | null;
  keywordScore?: number;
  semanticScore?: number;
}

export interface SearchResponse {
  query: string;
  mode: "hybrid" | "keyword" | "semantic";
  embeddingModel: string | null;
  tookMs: number;
  results: SearchResult[];
}

export interface Stats {
  documents: { byStatus: Partial<Record<DocumentStatus, number>>; byType: Record<string, number>; total: number };
  successRate: number | null;
  failureRate: number | null;
  invoices: { total: number; needs_review: number; validated: number; approved: number; rejected: number; corrected: number };
  processing: { avg_ms: number | null; p50_ms: number | null; p95_ms: number | null; pages: number };
  topIssues: Array<{ code: string; severity: Severity; n: number }>;
  llm: { calls: number; input_tokens: number; output_tokens: number };
}

export interface Health {
  status: "ok" | "degraded";
  database: boolean;
  queue: boolean;
  processor: { ok: boolean; tesseract?: string | null; embedding?: { model: string; loaded: boolean; degraded: boolean } };
  llm: { enabled: boolean; provider: string | null; model: string | null; strategy: string };
  version: string;
}

export interface ReconInvoice {
  id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  line_count?: number;
}

export interface Discrepancy {
  field: string;
  left: string | number | null;
  right: string | number | null;
  difference?: string;
}

export interface ReconSummary {
  leftCount: number;
  rightCount: number;
  matched: number;
  mismatched: number;
  missingInRight: number;
  missingInLeft: number;
  leftTotal: string;
  rightTotal: string;
  difference: string;
}

export interface ReconItem {
  status: "matched" | "mismatch" | "missing_in_right" | "missing_in_left";
  match_method: "invoice_number" | "fuzzy" | null;
  match_score: number | null;
  discrepancies: Discrepancy[];
  left: ReconInvoice | null;
  right: ReconInvoice | null;
}

export interface Reconciliation {
  id: string;
  left_document_id: string;
  right_document_id: string;
  left_filename: string;
  right_filename: string;
  options: { amountTolerance: number; dateToleranceDays: number };
  summary: ReconSummary;
  created_by: string | null;
  created_at: string;
  items: ReconItem[];
}

export interface ReconciliationListRow {
  id: string;
  summary: ReconSummary;
  created_at: string;
  created_by: string | null;
  left_filename: string;
  right_filename: string;
  left_document_id: string;
  right_document_id: string;
}

export interface UploadResponse {
  documents: DocumentSummary[];
  rejected: Array<{ filename: string; code: string; reason: string }>;
}

export interface LiveEvent {
  type: "document.updated" | "invoice.updated" | "heartbeat";
  documentId?: string;
  invoiceId?: string;
  status?: string;
  stage?: string | null;
  progress?: number;
  needsReview?: boolean;
  at: string;
}
