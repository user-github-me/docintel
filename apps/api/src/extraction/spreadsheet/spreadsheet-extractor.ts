import Decimal from 'decimal.js';
import { normaliseInvoiceNumber } from '../../common/text';
import { detectNumberLocale, formatAmount, NumberLocale, parseAmount } from '../normalize/amount';
import { normaliseCurrency } from '../normalize/currency';
import { DateOrder, detectDateOrder, parseDate } from '../normalize/date';
import { extractWithRules } from '../rules/rule-extractor';
import { emptyFields, FieldName, FieldValue, InvoiceDraft, LineItem, PageText } from '../types';

type CellValue = string | number | null;
type ColRole = FieldName | 'description' | 'quantity' | 'unit_price' | 'line_amount';

const P = '(?:invoice\\s+|inv\\s+|bill\\s+)?'; // optional "invoice_" prefix (invoice_total, inv_date)
const COLUMN_SYNONYMS: Array<{ role: ColRole; re: RegExp }> = [
  { role: 'invoice_number', re: /^(?:(?:tax\s+)?invoice|inv|bill|document|doc|voucher|receipt|rechnung|facture)\s*(?:no|number|num|nr|#|id|ref|reference|code)?$|^(?:ref|reference)(?:\s*no)?$/ },
  { role: 'invoice_date', re: new RegExp(`^(?:(?:invoice|inv|bill|document|doc|issue|posting|tax\\s+point)\\s*)?date$|^date\\s+of\\s+issue$|^dated$|^datum$|^rechnungsdatum$|^issue\\s+date$|^issued(?:\\s+on)?$`) },
  { role: 'due_date', re: new RegExp(`^${P}(?:due\\s*date|payment\\s*due|due|date\\s+due|pay\\s+by|due\\s+on)$`) },
  { role: 'supplier_name', re: /^(?:vendor|supplier|seller|from|payee|company|vendor\s+name|supplier\s+name|creditor|lieferant|issuer|biller)$/ },
  { role: 'customer_name', re: /^(?:customer|client|buyer|bill\s*to|customer\s+name|client\s+name|account\s+name|sold\s+to|debtor|kunde|billed\s+to|invoiced\s+to)$/ },
  { role: 'currency', re: new RegExp(`^${P}(?:currency|ccy|cur|curr|w[äa]hrung|devise)$`) },
  { role: 'subtotal', re: new RegExp(`^${P}(?:sub\\s*total|net|net\\s+amount|net\\s+total|amount\\s+excl(?:uding)?(?:\\s+(?:tax|vat|gst))?|taxable(?:\\s+(?:value|amount))?|pre\\s*tax(?:\\s+amount)?|nettobetrag|netto|total\\s+excl(?:uding)?(?:\\s+(?:vat|tax|gst))?|amount\\s+before\\s+tax)$`) },
  { role: 'tax', re: new RegExp(`^${P}(?:tax|vat|gst|hst|tax\\s+amount|vat\\s+amount|gst\\s+amount|sales\\s+tax|mwst|ust|total\\s+tax|total\\s+vat|tax\\s+total)$`) },
  { role: 'discount', re: new RegExp(`^${P}(?:discount|rebate)$`) },
  { role: 'shipping', re: new RegExp(`^${P}(?:shipping|freight|delivery|postage)$`) },
  { role: 'total', re: new RegExp(`^${P}(?:total|gross|total\\s+amount|grand\\s+total|amount\\s+due|gross\\s+amount|total\\s+incl(?:uding)?(?:\\s+(?:vat|tax|gst))?|amount\\s+incl(?:uding)?(?:\\s+(?:vat|tax|gst))?|bruttobetrag|brutto|gesamtbetrag|amount|total\\s+payable|total\\s+due|net\\s+payable|amount\\s+payable)$`) },
  { role: 'description', re: /^(?:description|item|item\s+description|product|service|particulars|details|line\s+item|article)$/ },
  { role: 'quantity', re: /^(?:qty|quantity|units|hours|hrs|pcs)$/ },
  { role: 'unit_price', re: /^(?:unit\s*price|price|rate|unit\s*cost|price\s+per\s+unit)$/ },
  { role: 'line_amount', re: /^(?:line\s+total|line\s+amount|item\s+total|amount\s+line|ext(?:ended)?\s*price)$/ },
];

interface HeaderInfo {
  row: number; // 0-based
  roles: Map<ColRole, number>;
  currencyHint: string | null;
}

function headerKey(cell: CellValue): { key: string; currency: string | null } | null {
  if (typeof cell !== 'string') return null;
  let currency: string | null = null;
  const key = cell
    .toLowerCase()
    .replace(/\(([^)]*)\)/g, (_, inner: string) => {
      currency = currency ?? normaliseCurrency(inner);
      return ' ';
    })
    .replace(/[._\-/]+/g, ' ')
    .replace(/[:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return key ? { key, currency } : null;
}

function findHeader(rows: CellValue[][]): HeaderInfo | null {
  let best: HeaderInfo | null = null;
  let bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const roles = new Map<ColRole, number>();
    let currencyHint: string | null = null;
    rows[r].forEach((cell, c) => {
      const hk = headerKey(cell);
      if (!hk) return;
      for (const { role, re } of COLUMN_SYNONYMS) {
        if (re.test(hk.key) && !roles.has(role)) {
          roles.set(role, c);
          currencyHint = currencyHint ?? hk.currency;
          break;
        }
      }
    });
    // "Amount" next to a dedicated invoice total is a line amount
    if (roles.has('total') && roles.has('description') && !roles.has('line_amount')) {
      const totalCol = roles.get('total')!;
      const header = String(rows[r][totalCol] ?? '').toLowerCase();
      if (/^amount/.test(header)) {
        roles.delete('total');
        roles.set('line_amount', totalCol);
      }
    }
    const score = roles.size + (roles.has('invoice_number') ? 1 : 0);
    if (roles.size >= 2 && score > bestScore) {
      best = { row: r, roles, currencyHint };
      bestScore = score;
    }
  }
  return best;
}

function colLetter(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const TOTAL_ROW = /^(?:grand\s+)?totals?:?$|^sum(?:me)?$|^gesamt$|^subtotal$/i;
const SUMMARY_WORDS = /\b(?:grand\s+total|totals?|sub-?total|count|sum|average|avg|gesamt|summe)\b/i;

interface SheetCtx {
  sheet: string;
  page: number;
  locale: NumberLocale;
  order: DateOrder;
  currencyHint: string | null;
}

function cellField(ctx: SheetCtx, row: number, col: number, raw: CellValue, value: string | null, confidence = 0.97): FieldValue {
  if (value === null) return { value: null, confidence: 0, source: 'none', evidence: null };
  const ref = `${ctx.sheet}!${colLetter(col)}${row + 1}`;
  return {
    value,
    raw: raw === null ? null : String(raw),
    confidence,
    source: 'spreadsheet',
    evidence: { text: `${ref}: ${raw}`, cell: ref, page: ctx.page },
  };
}

function amountOf(raw: CellValue, locale: NumberLocale): Decimal | null {
  if (raw === null || raw === '') return null;
  return typeof raw === 'number' ? new Decimal(raw.toString()) : parseAmount(String(raw), locale);
}

function rowFields(ctx: SheetCtx, header: HeaderInfo, row: CellValue[], r: number): Record<FieldName, FieldValue> {
  const fields = emptyFields();
  for (const [role, c] of header.roles) {
    const raw = row[c] ?? null;
    if (raw === null || raw === '') continue;
    switch (role) {
      case 'invoice_number':
        fields.invoice_number = cellField(ctx, r, c, raw, String(raw).trim());
        break;
      case 'invoice_date':
      case 'due_date': {
        const d = parseDate(String(raw), ctx.order);
        if (d) fields[role] = cellField(ctx, r, c, raw, d.iso, d.ambiguous ? 0.75 : 0.97);
        break;
      }
      case 'supplier_name':
      case 'customer_name':
        fields[role] = cellField(ctx, r, c, raw, String(raw).replace(/\s+/g, ' ').trim());
        break;
      case 'currency': {
        const code = normaliseCurrency(String(raw));
        if (code) fields.currency = cellField(ctx, r, c, raw, code);
        break;
      }
      case 'subtotal':
      case 'tax':
      case 'discount':
      case 'shipping':
      case 'total': {
        const amount = amountOf(raw, ctx.locale);
        if (amount) fields[role] = cellField(ctx, r, c, raw, formatAmount(role === 'discount' ? amount.abs() : amount), typeof raw === 'number' ? 0.97 : 0.93);
        break;
      }
      default:
        break;
    }
  }
  if (!fields.currency.value && ctx.currencyHint) {
    fields.currency = { value: ctx.currencyHint, raw: ctx.currencyHint, confidence: 0.85, source: 'spreadsheet', evidence: { text: `${ctx.sheet}: column header (${ctx.currencyHint})`, page: ctx.page } };
  }
  return fields;
}

function rowItem(ctx: SheetCtx, header: HeaderInfo, row: CellValue[], r: number): LineItem | null {
  const get = (role: ColRole) => (header.roles.has(role) ? row[header.roles.get(role)!] ?? null : null);
  const desc = get('description');
  const amount = amountOf(get('line_amount') ?? (header.roles.has('total') ? null : get('total')), ctx.locale);
  if (!desc && !amount) return null;
  const qty = amountOf(get('quantity'), ctx.locale);
  const price = amountOf(get('unit_price'), ctx.locale);
  return {
    description: desc === null ? null : String(desc).trim(),
    quantity: qty ? qty.toString() : null,
    unit_price: price ? formatAmount(price) : null,
    amount: amount ? formatAmount(amount) : null,
    confidence: 0.95,
    source: 'spreadsheet',
    page: ctx.page,
    evidence: `${ctx.sheet}!R${r + 1}`,
  };
}

function isEmptyRow(row: CellValue[]): boolean {
  return row.every((c) => c === null || c === '');
}

function draftFrom(fields: Record<FieldName, FieldValue>, items: LineItem[], sheet: string, rowStart: number, rowEnd: number): InvoiceDraft {
  return {
    fields,
    line_items: items,
    location: { sheet_name: sheet, row_start: rowStart + 1, row_end: rowEnd + 1 },
    method: 'spreadsheet',
    llm: null,
    notes: [],
    issues: [],
    is_invoice: true,
    document_type: 'invoice',
    ocr_confidence: null,
  };
}

/** Render a sheet as column-aligned text so the layout rule engine can read invoice "forms". */
export function sheetToLayoutText(rows: CellValue[][]): string {
  const widths: number[] = [];
  const str = (c: CellValue) => (c === null ? '' : typeof c === 'number' ? String(c) : c.replace(/\s+/g, ' '));
  for (const row of rows) row.forEach((c, i) => (widths[i] = Math.min(42, Math.max(widths[i] ?? 0, str(c).length))));
  return rows
    .map((row) => row.map((c, i) => str(c).padEnd((widths[i] ?? 0) + 4)).join('').trimEnd())
    .join('\n');
}

/** Extract invoices from spreadsheet pages (one page per sheet). */
export function extractFromSheets(pages: PageText[]): { drafts: InvoiceDraft[]; notes: string[] } {
  const drafts: InvoiceDraft[] = [];
  const notes: string[] = [];
  const itemSheets: Array<{ ctx: SheetCtx; header: HeaderInfo; rows: CellValue[][] }> = [];

  for (const page of pages) {
    const rows = (page.table_data ?? []) as CellValue[][];
    const sheet = page.sheet_name ?? `Sheet${page.page_number}`;
    if (!rows.length) continue;
    const header = findHeader(rows);
    const columnText = (role: ColRole) =>
      header && header.roles.has(role) ? rows.slice(header.row + 1).map((r) => String(r[header.roles.get(role)!] ?? '')).join('\n') : '';
    const amountText = ['subtotal', 'tax', 'total', 'line_amount', 'unit_price'].map((r) => columnText(r as ColRole)).join('\n');
    const ctx: SheetCtx = {
      sheet,
      page: page.page_number,
      locale: detectNumberLocale(amountText || page.text),
      order: detectDateOrder(columnText('invoice_date') + '\n' + columnText('due_date') || page.text, header?.currencyHint ?? null),
      currencyHint: header?.currencyHint ?? null,
    };

    const isRegister = header && header.roles.has('invoice_number') && (header.roles.has('total') || header.roles.has('subtotal') || header.roles.has('line_amount'));
    if (header && isRegister) {
      const lineLevel = header.roles.has('description') && (header.roles.has('line_amount') || header.roles.has('quantity'));
      const invoiceLevelAmounts = header.roles.has('total') || header.roles.has('subtotal');
      if (lineLevel && !invoiceLevelAmounts) {
        itemSheets.push({ ctx, header, rows }); // pure line-items sheet: join to invoices later
        continue;
      }
      const numCol = header.roles.get('invoice_number')!;
      const groups = new Map<string, { first: number; last: number; rows: number[] }>();
      for (let r = header.row + 1; r < rows.length; r++) {
        const row = rows[r];
        if (isEmptyRow(row)) continue;
        const firstText = row.find((c) => typeof c === 'string' && c.trim()) as string | undefined;
        const num = row[numCol];
        if (firstText && TOTAL_ROW.test(firstText.trim())) continue; // totals row
        if (num === null || num === '') {
          // A data row with no invoice number is still an invoice (validation flags the gap),
          // provided it carries invoice-level data rather than being a note or spacer.
          const hasAmount = ['total', 'subtotal'].some((role) => header.roles.has(role as ColRole) && row[header.roles.get(role as ColRole)!] !== null && row[header.roles.get(role as ColRole)!] !== '');
          const hasParty = ['supplier_name', 'invoice_date'].some((role) => header.roles.has(role as ColRole) && row[header.roles.get(role as ColRole)!]);
          if (!hasAmount || !hasParty || lineLevel) continue;
          groups.set(`__row${r}`, { first: r, last: r, rows: [r] });
          continue;
        }
        // footer rows that put their label in the number column: "TOTAL", "Count: 5 invoices"
        if (typeof num === 'string' && (SUMMARY_WORDS.test(num) || !/\d/.test(num))) continue;
        const key = normaliseInvoiceNumber(String(num)) ?? String(num);
        const g = groups.get(key) ?? { first: r, last: r, rows: [] };
        g.rows.push(r);
        g.last = r;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const fields = rowFields(ctx, header, rows[g.first], g.first);
        const items = lineLevel ? g.rows.map((r) => rowItem(ctx, header, rows[r], r)).filter((x): x is LineItem => !!x) : [];
        drafts.push(draftFrom(fields, items, sheet, g.first, g.last));
      }
      continue;
    }

    // Not a register: treat the sheet like a document page and let the layout rules read it.
    const text = sheetToLayoutText(rows);
    if (!/[A-Za-z]/.test(text)) continue;
    const draft = extractWithRules({ pages: [{ page_number: page.page_number, kind: 'text', text, ocr_confidence: null }] });
    const found = draft.fields.total.value || draft.fields.invoice_number.value;
    if (!found) {
      notes.push(`sheet "${sheet}" does not contain invoice data`);
      continue;
    }
    for (const f of Object.values(draft.fields)) {
      if (f.value && f.evidence) f.evidence.text = `${sheet}: ${f.evidence.text}`;
    }
    draft.method = 'spreadsheet';
    draft.location = { sheet_name: sheet, row_start: 1, row_end: rows.length };
    drafts.push(draft);
  }

  // Attach line items from item-only sheets to invoices with the same number (cross-sheet join).
  for (const { ctx, header, rows } of itemSheets) {
    const numCol = header.roles.get('invoice_number')!;
    const byNumber = new Map<string, InvoiceDraft>();
    for (const d of drafts) {
      const key = normaliseInvoiceNumber(d.fields.invoice_number.value);
      if (key) byNumber.set(key, d);
    }
    let attached = 0;
    for (let r = header.row + 1; r < rows.length; r++) {
      const row = rows[r];
      if (isEmptyRow(row)) continue;
      const key = normaliseInvoiceNumber(String(row[numCol] ?? ''));
      const item = rowItem(ctx, header, row, r);
      if (!key || !item) continue;
      let target = byNumber.get(key);
      if (!target) {
        target = draftFrom(rowFields(ctx, header, row, r), [], ctx.sheet, r, r);
        byNumber.set(key, target);
        drafts.push(target);
      }
      target.line_items.push(item);
      attached++;
    }
    notes.push(`joined ${attached} line items from sheet "${ctx.sheet}" by invoice number`);
  }
  return { drafts, notes };
}
