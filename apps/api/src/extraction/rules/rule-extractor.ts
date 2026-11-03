import Decimal from 'decimal.js';
import { detectNumberLocale, formatAmount } from '../normalize/amount';
import { detectCurrency } from '../normalize/currency';
import { detectDateOrder } from '../normalize/date';
import { emptyFields, FieldValue, InvoiceDraft, PageText, Segment } from '../types';
import {
  Candidate,
  customerFromSenderLine,
  evidenceOf,
  extractCustomer,
  extractDueDate,
  extractInvoiceDate,
  extractInvoiceNumber,
  extractSupplier,
  toField,
} from './fields';
import { extractLineItems, looseItems, sumItems } from './line-items';
import { toDocLines } from './lines';
import { collectAmountLines, solveTotals } from './totals';

/**
 * Deterministic extractor: labels, layout columns and arithmetic. Fast, free, explainable, and it
 * never fabricates - every value is a substring of the document with a line-level evidence pointer.
 */
export function extractWithRules(segment: Segment | { pages: PageText[]; page_start?: number; page_end?: number }): InvoiceDraft {
  const lines = toDocLines(segment);
  const allText = lines.map((l) => l.text).join('\n');
  const locale = detectNumberLocale(allText);
  const currency = detectCurrency(lines.map((l) => l.text));
  const order = detectDateOrder(allText, currency?.code ?? null);
  const fields = emptyFields();
  const notes: string[] = [];

  const invoiceNumber = extractInvoiceNumber(lines);
  fields.invoice_number = toField(invoiceNumber);
  const invoiceDate = extractInvoiceDate(lines, order);
  fields.invoice_date = toField(invoiceDate);
  fields.due_date = toField(extractDueDate(lines, order));

  let customer: Candidate | null = extractCustomer(lines);
  const supplier = extractSupplier(lines, customer?.value ?? null);
  if (!customer) customer = customerFromSenderLine(lines, supplier?.value ?? null);
  fields.customer_name = toField(customer);
  fields.supplier_name = toField(supplier);

  if (currency) {
    const line = lines.find((l) => l.text.includes(currency.evidence.slice(0, 40))) ?? lines[0];
    fields.currency = {
      value: currency.code,
      raw: currency.code,
      confidence: currency.confidence,
      source: 'rules',
      evidence: line ? { ...evidenceOf(line), text: currency.evidence } : { text: currency.evidence },
    };
  }

  const items = extractLineItems(lines, locale);
  const amountLines = collectAmountLines(lines, locale, items.consumed);
  let lineItems = items.items;
  if (!items.headerFound) {
    const firstTotals = amountLines[0]?.line.idx ?? lines.length;
    lineItems = looseItems(lines, locale, firstTotals);
    if (lineItems.length) notes.push('line items read without a table header (lower confidence)');
  }
  const itemsSum = sumItems(lineItems);
  const totals = solveTotals(amountLines, itemsSum);
  Object.assign(fields, totals.fields);
  notes.push(...totals.notes);

  // Arithmetic agreement between items and subtotal is strong corroboration for both.
  const subtotal = fields.subtotal.value ? new Decimal(fields.subtotal.value) : null;
  if (subtotal && itemsSum && subtotal.minus(itemsSum).abs().lte(0.05)) {
    fields.subtotal.confidence = Math.min(0.99, fields.subtotal.confidence + 0.03);
    for (const item of lineItems) item.confidence = Math.min(0.97, item.confidence + 0.04);
  }
  if (order === 'mdy') notes.push('numeric dates read as MM/DD/YYYY');
  for (const f of [fields.invoice_date, fields.due_date]) if (f.note) notes.push(f.note);

  const pages = 'pages' in segment ? segment.pages : [];
  const ocrPages = pages.filter((p) => p.kind === 'ocr' && p.ocr_confidence !== null);
  const ocrConfidence = ocrPages.length ? Math.min(...ocrPages.map((p) => p.ocr_confidence as number)) : null;

  return {
    fields,
    line_items: lineItems,
    location: {
      page_start: (segment as Segment).page_start ?? pages[0]?.page_number ?? null,
      page_end: (segment as Segment).page_end ?? pages[pages.length - 1]?.page_number ?? null,
    },
    method: 'rules',
    llm: null,
    notes,
    issues: [],
    is_invoice: looksLikeInvoice(allText, fields),
    document_type: /\bcredit\s+note\b/i.test(allText) ? 'credit_note' : /\breceipt\b/i.test(allText) ? 'receipt' : 'invoice',
    ocr_confidence: ocrConfidence,
  };
}

function looksLikeInvoice(text: string, fields: Record<string, FieldValue>): boolean {
  if (/\b(?:invoice|bill|receipt|rechnung|facture|mushak)\b/i.test(text)) return true;
  return !!(fields.total.value || fields.invoice_number.value);
}

/** Overall confidence: mean of the confidences of required fields that were found, penalising gaps. */
export function overallConfidence(draft: InvoiceDraft): number {
  const keys = ['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'subtotal', 'tax', 'total', 'currency'] as const;
  const vals = keys.map((k) => (draft.fields[k].value ? draft.fields[k].confidence : 0));
  return Math.round((vals.reduce((a, b) => a + b, 0) / keys.length) * 1000) / 1000;
}

export { formatAmount };
