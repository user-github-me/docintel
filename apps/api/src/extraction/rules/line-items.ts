import Decimal from 'decimal.js';
import { findAmounts, formatAmount, NumberLocale, parseAmount } from '../normalize/amount';
import { LineItem } from '../types';
import { ocrFactor } from './fields';
import { Cell, DocLine, maskNonAmounts, PAGE_FOOTER } from './lines';
import { headerRole, isBareTotalsLabel, TOTALS_ANY } from './labels';

type Role = 'description' | 'quantity' | 'unit_price' | 'amount' | 'position' | 'unit' | 'other';

interface Column {
  role: Role;
  start: number;
  end: number;
  center: number;
}

export interface ItemsResult {
  items: LineItem[];
  /** line indexes consumed by the table (header + rows), excluded from totals detection */
  consumed: Set<number>;
  headerFound: boolean;
}

function headerColumns(line: DocLine): Column[] | null {
  const cols: Column[] = [];
  for (const cell of line.cells) {
    const role = headerRole(cell.text);
    if (!role) {
      // multi-word cells like "Unit Price (Tk)" or "Description of goods"
      const words = cell.text.split(' ');
      const joined = words.length > 1 ? headerRole(words.slice(0, 2).join(' ')) ?? headerRole(words[0]) : null;
      if (!joined) return null; // a non-header cell disqualifies the line
      cols.push({ role: joined, start: cell.start, end: cell.end, center: (cell.start + cell.end) / 2 });
      continue;
    }
    cols.push({ role, start: cell.start, end: cell.end, center: (cell.start + cell.end) / 2 });
  }
  const roles = new Set(cols.map((c) => c.role));
  if (!roles.has('description') || !(roles.has('amount') || roles.has('unit_price'))) return null;
  if (cols.length < 2) return null;
  return cols;
}

const RECEIPT_QTY = /^\s*(\d+(?:[.,]\d+)?)\s*[x×@*]\s*([A-Z$€£]{0,3}\s?\d[\d.,]*)\s*(?:@\s*)?(?:\s{2,}|\s)([-−]?[A-Z$€£]{0,3}\s?\d[\d.,]*)\s*$/i;

function isStopLine(line: DocLine, cols: Column[]): boolean {
  const textCells = line.cells.filter((c) => /[A-Za-z]{2,}/.test(c.text));
  if (!textCells.length) return false;
  if (/^(?:thank\s+you|terms|notes?\b|payment\s+(?:terms|details|information)|bank\s+details|amount\s+in\s+words|in\s+words|authori[sz]ed|signature)/i.test(textCells[0].text)) return true;
  // The totals block: a bare totals label anywhere, or a totals word outside the description
  // column. "Freight charges - 20ft container" in the description column is an item, not a total.
  const label = textCells[textCells.length - 1];
  if (!TOTALS_ANY.test(label.text)) return false;
  if (isBareTotalsLabel(label.text)) return true;
  const desc = cols.find((c) => c.role === 'description');
  return !!desc && label.start > desc.start + 15 && textCells.length === 1;
}

function numericCells(line: DocLine, locale: NumberLocale): Array<{ cell: Cell; value: Decimal }> {
  const masked = maskNonAmounts(line.text);
  const out: Array<{ cell: Cell; value: Decimal }> = [];
  for (const cell of line.cells) {
    const maskedCell = masked.slice(cell.start, cell.end).trim();
    if (!maskedCell || /[A-Za-z]{2,}/.test(maskedCell.replace(/^[A-Z]{3}\s|\s?[A-Z]{3}$/g, ''))) continue;
    const v = parseAmount(maskedCell, locale);
    if (v) out.push({ cell, value: v });
  }
  return out;
}

function nearestColumn(cols: Column[], cell: Cell, roles: Role[]): Column | null {
  let best: Column | null = null;
  let bestDist = Infinity;
  const center = (cell.start + cell.end) / 2;
  for (const col of cols) {
    if (!roles.includes(col.role)) continue;
    // right-aligned numbers line up with the column's right edge, left-aligned with its start
    const dist = Math.min(Math.abs(center - col.center), Math.abs(cell.end - col.end), Math.abs(cell.start - col.start));
    if (dist < bestDist) {
      best = col;
      bestDist = dist;
    }
  }
  return bestDist <= 18 ? best : null;
}

function itemConfidence(qty: Decimal | null, price: Decimal | null, amount: Decimal | null): number {
  if (amount && qty && price) return qty.times(price).minus(amount).abs().lte(0.02) ? 0.93 : 0.7;
  if (amount) return 0.82;
  return 0.5;
}

function makeItem(desc: string | null, qty: Decimal | null, price: Decimal | null, amount: Decimal | null, line: DocLine): LineItem {
  return {
    description: desc ? desc.replace(/\s+/g, ' ').trim() : null,
    quantity: qty ? qty.toString() : null,
    unit_price: price ? formatAmount(price) : null,
    amount: amount ? formatAmount(amount) : null,
    confidence: Math.round(itemConfidence(qty, price, amount) * ocrFactor(line) * 1000) / 1000,
    source: 'rules',
    page: line.page,
    evidence: line.text.trim().replace(/\s{3,}/g, '   ').slice(0, 200),
  };
}

/** Parse every line-item table in the segment (tables may continue across pages). */
export function extractLineItems(lines: DocLine[], locale: NumberLocale): ItemsResult {
  const items: LineItem[] = [];
  const consumed = new Set<number>();
  let cols: Column[] | null = null;
  let headerFound = false;
  let pendingDesc: { text: string; line: DocLine } | null = null; // receipt style: description above numbers
  let inTable = false;
  let receiptMode = false; // once "2 x 1.50   3.00" rows appear, text-only lines start the next item

  for (const line of lines) {
    const header = headerColumns(line);
    if (header) {
      cols = header;
      headerFound = true;
      inTable = true;
      pendingDesc = null;
      consumed.add(line.idx);
      continue;
    }
    if (!inTable || !cols) continue;
    if (PAGE_FOOTER.test(line.text) && line.cells.length <= 2) {
      consumed.add(line.idx);
      continue;
    }
    if (isStopLine(line, cols)) {
      inTable = false;
      pendingDesc = null;
      continue;
    }

    // Receipt pattern: "Glue stick 40g" followed by "  2 x 1.74     3.48"
    const receipt = RECEIPT_QTY.exec(maskNonAmounts(line.text));
    if (receipt) {
      receiptMode = true;
      const qty = parseAmount(receipt[1], locale);
      const price = parseAmount(receipt[2], locale);
      const amount = parseAmount(receipt[3], locale);
      const desc = pendingDesc?.text ?? null;
      items.push(makeItem(desc, qty, price, amount, line));
      if (pendingDesc) consumed.add(pendingDesc.line.idx);
      consumed.add(line.idx);
      pendingDesc = null;
      continue;
    }

    const nums = numericCells(line, locale);
    const texts = line.cells.filter((c) => !nums.some((n) => n.cell === c) && /[A-Za-z]/.test(c.text));

    if (!nums.length) {
      // text-only line: description continuation, or a receipt description awaiting its numbers
      const text = texts.map((t) => t.text).join(' ');
      if (!text) continue;
      const last = items[items.length - 1];
      const descCol = cols.find((c) => c.role === 'description');
      const alignedWithDesc = descCol && texts[0] && Math.abs(texts[0].start - descCol.start) <= 6;
      if (pendingDesc) {
        pendingDesc = { text: `${pendingDesc.text} ${text}`, line: pendingDesc.line };
      } else if (receiptMode) {
        pendingDesc = { text, line };
      } else if (last && alignedWithDesc && last.page === line.page && !cols.some((c) => c.role === 'quantity' && c.start < (descCol?.start ?? 0))) {
        // wrapped description of the previous row (only when rows are not receipt-style)
        if (items.length && !RECEIPT_QTY.test(line.text)) {
          last.description = `${last.description ?? ''} ${text}`.trim();
          consumed.add(line.idx);
          continue;
        }
      } else {
        pendingDesc = { text, line };
      }
      continue;
    }

    // Tabular row: map numbers to the nearest numeric column; leading small integer may be a position.
    let qty: Decimal | null = null;
    let price: Decimal | null = null;
    let amount: Decimal | null = null;
    const assigned = new Set<Cell>();
    for (const n of nums) {
      const col = nearestColumn(cols, n.cell, ['quantity', 'unit_price', 'amount', 'position']);
      if (!col) continue;
      if (col.role === 'position') {
        assigned.add(n.cell);
        continue;
      }
      if (col.role === 'quantity' && !qty) qty = n.value;
      else if (col.role === 'unit_price' && !price) price = n.value;
      else if (col.role === 'amount') amount = n.value; // right-most wins
      assigned.add(n.cell);
    }
    // Fallback when alignment is off (OCR): right-most number is the amount, then price, then qty.
    if (!amount) {
      const unassigned = nums.filter((n) => !assigned.has(n.cell));
      const pool = unassigned.length ? unassigned : nums;
      amount = pool[pool.length - 1]?.value ?? null;
      if (!price && pool.length >= 2 && cols.some((c) => c.role === 'unit_price')) price = pool[pool.length - 2].value;
      if (!qty && pool.length >= 3 && cols.some((c) => c.role === 'quantity')) qty = pool[pool.length - 3].value;
    }
    const unitCol = cols.find((c) => c.role === 'unit');
    const descTexts = texts.filter((t) => !(unitCol && Math.abs(t.start - unitCol.start) <= 4 && t.text.split(' ').length === 1));
    let desc = descTexts.map((t) => t.text).join(' ').trim() || null;
    if (pendingDesc && !desc) desc = pendingDesc.text;
    else if (pendingDesc && desc) desc = `${pendingDesc.text} ${desc}`;
    if (pendingDesc) consumed.add(pendingDesc.line.idx);
    pendingDesc = null;
    if (!amount && !desc) continue;
    items.push(makeItem(desc, qty, price, amount, line));
    consumed.add(line.idx);
  }
  return { items, consumed, headerFound };
}

export function sumItems(items: LineItem[]): Decimal | null {
  const amounts = items.map((i) => (i.amount ? new Decimal(i.amount) : null));
  if (!amounts.length || amounts.some((a) => a === null)) return null;
  return amounts.reduce((acc: Decimal, a) => acc.plus(a as Decimal), new Decimal(0));
}

/** Header-less fallback: rows of "description ... amount" between the document head and the totals. */
export function looseItems(lines: DocLine[], locale: NumberLocale, stopAt: number): LineItem[] {
  const out: LineItem[] = [];
  for (const line of lines) {
    if (line.idx >= stopAt) break;
    const masked = maskNonAmounts(line.text);
    const amounts = findAmounts(masked, locale);
    if (amounts.length < 2) continue;
    const text = line.cells.filter((c) => /[A-Za-z]{3,}/.test(c.text)).map((c) => c.text).join(' ');
    if (!text || TOTALS_ANY.test(text)) continue;
    out.push(makeItem(text, null, null, amounts[amounts.length - 1].value, line));
  }
  return out;
}
