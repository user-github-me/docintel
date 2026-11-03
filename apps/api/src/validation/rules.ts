import Decimal from 'decimal.js';
import { ISO_CURRENCIES } from '../extraction/normalize/currency';
import { CRITICAL_FIELDS, ExtractionIssue, FieldName, InvoiceDraft, REQUIRED_FIELDS } from '../extraction/types';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  severity: Severity;
  field?: string | null;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationOptions {
  /** Absolute money tolerance for arithmetic checks (rounding). */
  tolerance: number;
  /** Fields below this confidence need a human. */
  reviewConfidence: number;
  today: Date;
}

export const DEFAULT_VALIDATION: ValidationOptions = { tolerance: 0.05, reviewConfidence: 0.75, today: new Date() };

/** Warnings that are serious enough to route an invoice to manual review. */
export const REVIEW_WARNING_CODES = new Set([
  'MISSING_FIELD',
  'LOW_CONFIDENCE',
  'UNGROUNDED_VALUE',
  'VISION_ONLY_VALUE',
  'EXTRACTION_CONFLICT',
  'DATE_AMBIGUOUS',
  'DATE_IN_FUTURE',
  'NEGATIVE_AMOUNT',
  'TAX_RATE_UNUSUAL',
  'LOW_OCR_QUALITY',
  'POSSIBLE_DUPLICATE',
  'NOT_AN_INVOICE',
  'LINE_ITEM_MATH',
  'CURRENCY_UNKNOWN',
]);

const LABEL: Record<string, string> = {
  invoice_number: 'invoice number', invoice_date: 'invoice date', due_date: 'due date', supplier_name: 'supplier name',
  customer_name: 'customer name', currency: 'currency', subtotal: 'subtotal', tax: 'tax', discount: 'discount',
  shipping: 'shipping', total: 'total',
};

const dec = (v: string | null | undefined): Decimal | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
};

/** Field-level and arithmetic validation of one invoice (duplicates are checked against the DB separately). */
export function validateDraft(draft: InvoiceDraft, opts: ValidationOptions = DEFAULT_VALIDATION): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const f = draft.fields;
  const tol = new Decimal(opts.tolerance);
  const isReceipt = draft.document_type === 'receipt';
  const isCredit = draft.document_type === 'credit_note';

  if (!draft.is_invoice) {
    issues.push({ code: 'NOT_AN_INVOICE', severity: 'warning', message: 'This section does not look like an invoice, bill or receipt.' });
  }

  // 1. Missing fields
  for (const name of REQUIRED_FIELDS) {
    if (f[name].value) continue;
    const critical = CRITICAL_FIELDS.includes(name);
    const severity: Severity = critical ? 'error' : name === 'customer_name' && isReceipt ? 'info' : 'warning';
    issues.push({ code: 'MISSING_FIELD', severity, field: name, message: `${LABEL[name]} is missing or could not be read.` });
  }

  // 2. Numeric sanity
  for (const name of ['subtotal', 'tax', 'discount', 'shipping', 'total'] as FieldName[]) {
    const raw = f[name].value;
    if (raw === null) continue;
    const d = dec(raw);
    if (!d) {
      issues.push({ code: 'INVALID_AMOUNT', severity: 'error', field: name, message: `${LABEL[name]} "${raw}" is not a valid number.` });
      continue;
    }
    if (d.isNegative() && !isCredit && name !== 'discount') {
      issues.push({ code: 'NEGATIVE_AMOUNT', severity: 'warning', field: name, message: `${LABEL[name]} is negative (${d.toFixed(2)}) on a document that is not a credit note.` });
    }
  }
  const subtotal = dec(f.subtotal.value);
  const tax = dec(f.tax.value);
  const discount = dec(f.discount.value)?.abs() ?? new Decimal(0);
  const shipping = dec(f.shipping.value) ?? new Decimal(0);
  const total = dec(f.total.value);
  if (total && total.isZero()) issues.push({ code: 'ZERO_TOTAL', severity: 'warning', field: 'total', message: 'Total is zero.' });

  // 3. Arithmetic consistency
  if (subtotal && total) {
    const expected = subtotal.minus(discount).plus(shipping).plus(tax ?? 0);
    const diff = total.minus(expected);
    if (diff.abs().gt(tol)) {
      issues.push({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        field: 'total',
        message: `Total ${total.toFixed(2)} does not equal subtotal ${subtotal.toFixed(2)}${discount.isZero() ? '' : ` - discount ${discount.toFixed(2)}`}${shipping.isZero() ? '' : ` + shipping ${shipping.toFixed(2)}`} + tax ${(tax ?? new Decimal(0)).toFixed(2)} = ${expected.toFixed(2)} (difference ${diff.toFixed(2)}).`,
        details: { expected: expected.toFixed(2), actual: total.toFixed(2), difference: diff.toFixed(2) },
      });
    }
  }
  if (tax && subtotal && subtotal.gt(0)) {
    const rate = tax.div(subtotal);
    if (rate.gt(0.35)) {
      issues.push({ code: 'TAX_RATE_UNUSUAL', severity: 'warning', field: 'tax', message: `Tax is ${rate.times(100).toFixed(1)}% of the subtotal, which is unusually high.`, details: { rate: rate.toFixed(4) } });
    }
  }
  if (tax && total && tax.gt(total) && total.gt(0)) {
    issues.push({ code: 'TAX_EXCEEDS_TOTAL', severity: 'error', field: 'tax', message: `Tax ${tax.toFixed(2)} is larger than the total ${total.toFixed(2)}.` });
  }

  const items = draft.line_items;
  if (items.length) {
    const amounts = items.map((i) => dec(i.amount));
    if (amounts.every((a) => a)) {
      const sum = amounts.reduce((acc: Decimal, a) => acc.plus(a as Decimal), new Decimal(0));
      const target = subtotal ?? (total && !tax ? total.plus(discount).minus(shipping) : null);
      const targetName = subtotal ? 'subtotal' : 'total';
      // per-line rounding can accumulate: allow 1 cent per line on top of the base tolerance
      const itemTol = tol.plus(new Decimal(0.01).times(items.length));
      if (target && sum.minus(target).abs().gt(itemTol)) {
        issues.push({
          code: 'LINE_ITEMS_MISMATCH',
          severity: 'error',
          field: targetName,
          message: `Line items add up to ${sum.toFixed(2)} but the ${targetName} is ${target.toFixed(2)} (difference ${sum.minus(target).toFixed(2)}).`,
          details: { line_items_sum: sum.toFixed(2), [targetName]: target.toFixed(2), count: items.length },
        });
      }
    }
    const badMath = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const q = dec(item.quantity);
        const p = dec(item.unit_price);
        const a = dec(item.amount);
        return q && p && a && q.times(p).minus(a).abs().gt(new Decimal(0.02).plus(q.abs().times(0.005)));
      });
    if (badMath.length) {
      issues.push({
        code: 'LINE_ITEM_MATH',
        severity: 'warning',
        message: `${badMath.length} line item(s) where quantity x unit price != amount (rows ${badMath.map((b) => b.index + 1).join(', ')}).`,
        details: { rows: badMath.map((b) => b.index + 1) },
      });
    }
  }

  // 4. Dates
  const inv = f.invoice_date.value ? new Date(`${f.invoice_date.value}T00:00:00Z`) : null;
  const due = f.due_date.value ? new Date(`${f.due_date.value}T00:00:00Z`) : null;
  if (inv) {
    const tomorrow = new Date(opts.today.getTime() + 24 * 3600 * 1000);
    if (inv > tomorrow) issues.push({ code: 'DATE_IN_FUTURE', severity: 'warning', field: 'invoice_date', message: `Invoice date ${f.invoice_date.value} is in the future.` });
    if (inv.getUTCFullYear() < 2000) issues.push({ code: 'DATE_TOO_OLD', severity: 'warning', field: 'invoice_date', message: `Invoice date ${f.invoice_date.value} is implausibly old.` });
    if (due && due < inv) issues.push({ code: 'DUE_BEFORE_INVOICE', severity: 'warning', field: 'due_date', message: `Due date ${f.due_date.value} is before the invoice date ${f.invoice_date.value}.` });
  }
  if (f.invoice_date.note && /ambiguous/i.test(f.invoice_date.note)) {
    issues.push({ code: 'DATE_AMBIGUOUS', severity: 'warning', field: 'invoice_date', message: f.invoice_date.note });
  }

  // 5. Currency
  if (f.currency.value && !ISO_CURRENCIES.has(f.currency.value)) {
    issues.push({ code: 'CURRENCY_UNKNOWN', severity: 'warning', field: 'currency', message: `"${f.currency.value}" is not a recognised ISO-4217 currency.` });
  }

  // 6. Confidence
  const weak = CRITICAL_FIELDS.concat(['subtotal', 'tax'] as FieldName[]).filter((n) => f[n].value && f[n].confidence < opts.reviewConfidence);
  if (weak.length) {
    issues.push({
      code: 'LOW_CONFIDENCE',
      severity: 'warning',
      message: `Low extraction confidence for ${weak.map((n) => LABEL[n]).join(', ')}.`,
      details: Object.fromEntries(weak.map((n) => [n, f[n].confidence])),
    });
  }
  if (draft.ocr_confidence !== null && draft.ocr_confidence < 0.6) {
    issues.push({ code: 'LOW_OCR_QUALITY', severity: 'warning', message: `Scan quality is poor (OCR confidence ${(draft.ocr_confidence * 100).toFixed(0)}%).` });
  }

  // 7. Issues raised during extraction (grounding failures, rules/AI conflicts)
  for (const e of draft.issues as ExtractionIssue[]) issues.push({ ...e, field: e.field ?? null });
  return issues;
}

export function reviewDecision(issues: ValidationIssue[]): { status: 'needs_review' | 'validated'; reasons: string[] } {
  const reasons = issues
    .filter((i) => i.severity === 'error' || (i.severity === 'warning' && REVIEW_WARNING_CODES.has(i.code)))
    .map((i) => i.message);
  return { status: reasons.length ? 'needs_review' : 'validated', reasons };
}
