/** Shared extraction types. All monetary values travel as decimal strings ("1234.50"), never floats. */

export const STRING_FIELDS = ['invoice_number', 'supplier_name', 'customer_name'] as const;
export const DATE_FIELDS = ['invoice_date', 'due_date'] as const;
export const AMOUNT_FIELDS = ['subtotal', 'tax', 'discount', 'shipping', 'total'] as const;
export const FIELD_NAMES = [
  'invoice_number',
  'invoice_date',
  'due_date',
  'supplier_name',
  'customer_name',
  'currency',
  'subtotal',
  'tax',
  'discount',
  'shipping',
  'total',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];
export type AmountField = (typeof AMOUNT_FIELDS)[number];

/** Fields the task requires; missing ones are validation issues. */
export const REQUIRED_FIELDS: FieldName[] = [
  'invoice_number',
  'invoice_date',
  'supplier_name',
  'customer_name',
  'subtotal',
  'tax',
  'total',
  'currency',
];
/** Fields without which an invoice cannot be booked at all (missing => error, otherwise warning). */
export const CRITICAL_FIELDS: FieldName[] = ['invoice_number', 'invoice_date', 'supplier_name', 'total'];

export type FieldSource = 'rules' | 'llm' | 'rules+llm' | 'spreadsheet' | 'manual' | 'none';

export interface Evidence {
  /** Verbatim text that supports the value (a line, or "Sheet!B5: value"). */
  text: string;
  page?: number | null;
  /** Normalised bounding box (0..1) of the supporting line on the page image, when known. */
  bbox?: number[] | null;
  cell?: string | null;
}

export interface Alternative {
  value: string;
  source: FieldSource;
  confidence: number;
}

export interface FieldValue {
  /** Normalised value: ISO date, decimal string, ISO-4217 code, or trimmed text. null = not found. */
  value: string | null;
  confidence: number;
  source: FieldSource;
  evidence?: Evidence | null;
  /** Raw text as printed, before normalisation. */
  raw?: string | null;
  alternatives?: Alternative[];
  /** Free-text note about uncertainty (e.g. "ambiguous day/month order"). */
  note?: string | null;
}

export type InvoiceFields = Record<FieldName, FieldValue>;

export interface LineItem {
  description: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string | null;
  confidence: number;
  source: FieldSource;
  page?: number | null;
  evidence?: string | null;
}

export interface LlmUsage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  used_vision: boolean;
}

export interface InvoiceLocation {
  page_start?: number | null;
  page_end?: number | null;
  sheet_name?: string | null;
  row_start?: number | null;
  row_end?: number | null;
}

export type ExtractionMethod = 'rules' | 'llm' | 'hybrid' | 'spreadsheet';

/** Issue raised while extracting (before business validation), e.g. an LLM value that failed grounding. */
export interface ExtractionIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  field?: FieldName | null;
  message: string;
  details?: Record<string, unknown>;
}

export interface InvoiceDraft {
  fields: InvoiceFields;
  line_items: LineItem[];
  location: InvoiceLocation;
  method: ExtractionMethod;
  llm: LlmUsage | null;
  notes: string[];
  issues: ExtractionIssue[];
  is_invoice: boolean;
  document_type?: 'invoice' | 'receipt' | 'credit_note' | 'other';
  /** Lowest OCR confidence among source pages (null for digital text/spreadsheets). */
  ocr_confidence: number | null;
}

/** A page as stored by the pipeline (PDF page, image frame, or spreadsheet sheet). */
export interface PageText {
  page_number: number;
  kind: 'text' | 'ocr' | 'empty' | 'error' | 'sheet';
  text: string;
  ocr_confidence: number | null;
  lines?: Array<{ text: string; bbox: number[]; conf: number | null }> | null;
  sheet_name?: string | null;
  table_data?: Array<Array<string | number | null>> | null;
}

export interface Segment {
  pages: PageText[];
  page_start: number;
  page_end: number;
  reason: string;
}

export function emptyField(): FieldValue {
  return { value: null, confidence: 0, source: 'none', evidence: null };
}

export function emptyFields(): InvoiceFields {
  return Object.fromEntries(FIELD_NAMES.map((f) => [f, emptyField()])) as InvoiceFields;
}
