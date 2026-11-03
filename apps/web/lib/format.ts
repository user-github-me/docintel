const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Money with two decimals and thousands separators; the currency code is shown separately. */
export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  let f = moneyFormatters.get("x");
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    moneyFormatters.set("x", f);
  }
  return f.format(n);
}

/** Plain decimal for form inputs ("399.2000" -> "399.20"). */
export function decimalInput(value: string | null | undefined, places = 2): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toFixed(places);
}

/** Quantities keep their own precision but drop trailing zeros ("12.5000" -> "12.5"). */
export function quantity(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : value;
}

export function date(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: value.length === 10 ? "UTC" : undefined });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relative(value: string | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return dateTime(value);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function bytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function percent(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export const FIELD_LABELS: Record<string, string> = {
  invoice_number: "Invoice number",
  invoice_date: "Invoice date",
  due_date: "Due date",
  supplier_name: "Supplier",
  customer_name: "Customer",
  currency: "Currency",
  subtotal: "Subtotal",
  discount: "Discount",
  shipping: "Shipping",
  tax: "Tax",
  total: "Total",
  line_items: "Line items",
};

export const ISSUE_LABELS: Record<string, string> = {
  MISSING_FIELD: "Missing field",
  TOTAL_MISMATCH: "Total mismatch",
  LINE_ITEMS_MISMATCH: "Line items mismatch",
  LINE_ITEM_MATH: "Line item maths",
  DUPLICATE_INVOICE: "Duplicate invoice",
  POSSIBLE_DUPLICATE: "Possible duplicate",
  LOW_CONFIDENCE: "Low confidence",
  LOW_OCR_QUALITY: "Poor scan quality",
  EXTRACTION_CONFLICT: "Rules and AI disagree",
  UNGROUNDED_VALUE: "AI value not in document",
  VISION_ONLY_VALUE: "Read from image only",
  DATE_AMBIGUOUS: "Ambiguous date",
  DATE_IN_FUTURE: "Date in the future",
  DATE_TOO_OLD: "Date too old",
  DUE_BEFORE_INVOICE: "Due before issue date",
  NEGATIVE_AMOUNT: "Negative amount",
  INVALID_AMOUNT: "Invalid amount",
  TAX_RATE_UNUSUAL: "Unusual tax rate",
  TAX_EXCEEDS_TOTAL: "Tax exceeds total",
  ZERO_TOTAL: "Zero total",
  CURRENCY_UNKNOWN: "Unknown currency",
  NOT_AN_INVOICE: "Not an invoice",
  AI_EXTRACTION_FAILED: "AI step unavailable",
  NO_INVOICE_FOUND: "No invoice found",
};

export const STAGE_LABELS: Record<string, string> = {
  queued: "Waiting in queue",
  inspect: "Inspecting file",
  "extract-text": "Reading text & OCR",
  parse: "Parsing spreadsheet",
  "extract-fields": "Extracting fields",
  analyze: "Extracting fields",
  index: "Indexing for search",
  done: "Done",
  upload: "Uploaded",
};

export const FILE_TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  image: "Image",
  xlsx: "Excel",
  xls: "Excel 97",
  csv: "CSV",
};

const MIME_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "Image",
  "image/png": "Image",
  "image/tiff": "Image",
  "text/csv": "CSV",
  "application/vnd.ms-excel": "Excel 97",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
};

/** Detected type when known, otherwise the type claimed by the upload (e.g. an unreadable "PDF"). */
export function typeLabel(fileType: string | null | undefined, mimeType: string | null | undefined): string {
  if (fileType) return FILE_TYPE_LABELS[fileType] ?? fileType;
  return mimeType && MIME_LABELS[mimeType] ? `${MIME_LABELS[mimeType]} (unreadable)` : "Unknown type";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
