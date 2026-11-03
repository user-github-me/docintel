import { DateOrder, findDates } from '../normalize/date';
import { Evidence, FieldValue } from '../types';
import { Cell, DocLine } from './lines';
import {
  ADDRESS_HINT,
  COMPANY_SUFFIX,
  CONTACT_LINE,
  CUSTOMER_LABELS,
  DOC_TITLE,
  DUE_DATE_LABELS,
  ID_LINE,
  INVOICE_DATE_LABELS,
  INVOICE_NUMBER_LABELS,
  NOT_INVOICE_DATE,
  NOT_INVOICE_NUMBER,
  SUPPLIER_LABELS,
  SUPPLIER_WEAK_LABELS,
  TOTALS_ANY,
} from './labels';

export interface Candidate {
  value: string;
  raw: string;
  confidence: number;
  line: DocLine;
  how: 'same-line' | 'below' | 'block' | 'heuristic';
  note?: string;
}

/** Confidence penalty for OCR'd pages: a 0.95-confidence page keeps ~98% of the base score. */
export function ocrFactor(line: DocLine): number {
  if (line.pageConf === null || line.pageConf === undefined) return 1;
  const c = line.conf ?? line.pageConf;
  return 0.55 + 0.45 * Math.max(0, Math.min(1, c));
}

export function evidenceOf(line: DocLine): Evidence {
  return { text: line.text.trim().replace(/\s{3,}/g, '   ').slice(0, 240), page: line.page, bbox: line.bbox };
}

export function toField(c: Candidate | null, source: 'rules' = 'rules'): FieldValue {
  if (!c) return { value: null, confidence: 0, source: 'none', evidence: null };
  return {
    value: c.value,
    raw: c.raw,
    confidence: Math.round(c.confidence * ocrFactor(c.line) * 1000) / 1000,
    source,
    evidence: evidenceOf(c.line),
    note: c.note ?? null,
  };
}

interface LabelHit {
  line: DocLine;
  cellIndex: number;
  /** text after the label inside the same cell */
  rest: string;
  start: number;
  end: number;
}

/** Find label occurrences; returns the cell containing the label and the remainder of that cell. */
export function findLabels(lines: DocLine[], labels: RegExp[], exclude?: RegExp): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const line of lines) {
    line.cells.forEach((cell, cellIndex) => {
      for (const re of labels) {
        const m = re.exec(cell.text);
        if (!m) continue;
        const before = cell.text.slice(0, m.index);
        const labelText = before + m[0];
        if (exclude && exclude.test(labelText.replace(m[0], ' ') + ' ' + m[0]) && exclude.test(labelText)) continue;
        const rest = cell.text.slice(m.index + m[0].length).replace(/^[\s:#.\-–—]+/, '');
        hits.push({ line, cellIndex, rest, start: cell.start, end: cell.end });
        break;
      }
    });
  }
  return hits;
}

/** Value in the cell directly below a label (label-above-value layouts), matched by column overlap. */
export function valueBelow(lines: DocLine[], hit: LabelHit, maxDown = 2): { cell: Cell; line: DocLine } | null {
  const pos = lines.indexOf(hit.line);
  for (let k = 1; k <= maxDown && pos + k < lines.length; k++) {
    const next = lines[pos + k];
    if (next.page !== hit.line.page) break;
    let best: Cell | null = null;
    let bestOverlap = 0;
    for (const cell of next.cells) {
      const overlap = Math.min(cell.end, hit.end + 6) - Math.max(cell.start, hit.start - 3);
      if (overlap > bestOverlap) {
        best = cell;
        bestOverlap = overlap;
      }
    }
    if (best) return { cell: best, line: next };
  }
  return null;
}

/** Value immediately right of a label: rest of the label cell, else the next cell on the line. */
export function valueRight(hit: LabelHit): string | null {
  if (hit.rest.trim()) return hit.rest.trim();
  const next = hit.line.cells[hit.cellIndex + 1];
  if (next && next.start - hit.end < 40) return next.text.trim();
  return null;
}

// ---------------------------------------------------------------- invoice number

const INVOICE_NO_VALUE = /^[#:]?\s*([A-Z0-9][A-Z0-9\-\/_.]{1,29}[A-Z0-9])\b/i;

export function cleanInvoiceNumber(raw: string | null): string | null {
  if (!raw) return null;
  const m = INVOICE_NO_VALUE.exec(raw.trim());
  if (!m) return null;
  const v = m[1];
  if (!/\d/.test(v)) return null;
  if (findDates(v).some((d) => d.raw === v)) return null;
  if (/^\d{1,2}$/.test(v)) return null;
  if (/^(?:19|20)\d{2}$/.test(v)) return null; // a bare year
  return v;
}

export function extractInvoiceNumber(lines: DocLine[]): Candidate | null {
  const candidates: Candidate[] = [];
  for (const hit of findLabels(lines, INVOICE_NUMBER_LABELS)) {
    const labelCell = hit.line.cells[hit.cellIndex].text;
    if (NOT_INVOICE_NUMBER.test(labelCell.replace(hit.rest, ''))) continue;
    const right = cleanInvoiceNumber(valueRight(hit));
    if (right) {
      candidates.push({ value: right, raw: right, confidence: 0.93, line: hit.line, how: 'same-line' });
      continue;
    }
    const below = valueBelow(lines, hit);
    const v = below ? cleanInvoiceNumber(below.cell.text) : null;
    if (below && v) candidates.push({ value: v, raw: below.cell.text, confidence: 0.88, line: below.line, how: 'below' });
  }
  if (!candidates.length) {
    // OCR may split a label across columns ("Invoice  No:  91-91379"): retry on space-collapsed lines.
    for (const line of lines) {
      const flat = line.text.replace(/\s+/g, ' ');
      const m = /\b(?:tax\s+)?(?:invoice|inv|bill|receipt)\s*(?:no\.?|n[o0°]\.?|number|num\.?|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/_.]{1,29}[A-Z0-9])\b/i.exec(flat);
      const v = m ? cleanInvoiceNumber(m[1]) : null;
      if (v && !NOT_INVOICE_NUMBER.test(flat.slice(0, m!.index))) {
        candidates.push({ value: v, raw: m![0], confidence: 0.8, line, how: 'same-line' });
        break;
      }
    }
    if (!candidates.length) return null;
  }
  // earliest strong candidate wins (headers precede footers); identical values reinforce
  candidates.sort((a, b) => b.confidence - a.confidence || a.line.idx - b.line.idx);
  const best = candidates[0];
  const agreeing = candidates.filter((c) => c.value === best.value).length;
  if (agreeing > 1) best.confidence = Math.min(0.98, best.confidence + 0.03);
  return best;
}

// ---------------------------------------------------------------- dates

function dateFromHit(lines: DocLine[], hit: LabelHit, order: DateOrder): Candidate | null {
  const rightText = valueRight(hit);
  const right = rightText ? findDates(rightText, order)[0] : undefined;
  if (right) {
    return {
      value: right.iso, raw: right.raw, confidence: right.ambiguous ? 0.7 : 0.92, line: hit.line, how: 'same-line',
      note: right.ambiguous ? `ambiguous day/month order in "${right.raw}" (resolved as ${order.toUpperCase()})` : undefined,
    };
  }
  const below = valueBelow(lines, hit);
  const d = below ? findDates(below.cell.text, order)[0] : undefined;
  if (below && d) {
    return {
      value: d.iso, raw: d.raw, confidence: d.ambiguous ? 0.66 : 0.87, line: below.line, how: 'below',
      note: d.ambiguous ? `ambiguous day/month order in "${d.raw}" (resolved as ${order.toUpperCase()})` : undefined,
    };
  }
  return null;
}

export function extractInvoiceDate(lines: DocLine[], order: DateOrder): Candidate | null {
  const candidates: Candidate[] = [];
  for (const hit of findLabels(lines, INVOICE_DATE_LABELS)) {
    const labelCell = hit.line.cells[hit.cellIndex].text;
    const label = hit.rest ? labelCell.slice(0, labelCell.length - hit.rest.length) : labelCell;
    if (NOT_INVOICE_DATE.test(label) && !/\b(?:invoice|bill|issue)\b/i.test(label)) continue;
    const c = dateFromHit(lines, hit, order);
    if (!c) continue;
    if (/\b(?:invoice|bill|issue|dated)\b/i.test(label)) c.confidence = Math.min(0.97, c.confidence + 0.03);
    candidates.push(c);
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.confidence - a.confidence || a.line.idx - b.line.idx);
    return candidates[0];
  }
  // Fallback: first date on the first page that is not labelled as another kind of date.
  for (const line of lines.slice(0, 40)) {
    if (NOT_INVOICE_DATE.test(line.text)) continue;
    const d = findDates(line.text, order)[0];
    if (d) return { value: d.iso, raw: d.raw, confidence: 0.55, line, how: 'heuristic', note: 'unlabelled date' };
  }
  return null;
}

export function extractDueDate(lines: DocLine[], order: DateOrder): Candidate | null {
  for (const hit of findLabels(lines, DUE_DATE_LABELS)) {
    const c = dateFromHit(lines, hit, order);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------- party names

export function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw
    .replace(/^[^A-Za-z0-9(\u00C0-\u024F]+/, '') // OCR junk before the first letter ("+=Maplewood")
    .replace(/\s{2,}.*$/, '') // stop at the next column
    .replace(/[,;:|]+$/, '')
    .trim();
  s = s.replace(/^(?:m\/s\.?|messrs\.?)\s+/i, '');
  s = s.replace(/\s+(?:tax\s+)?(?:invoice|bill|receipt|statement)(?:\s*\/\s*bill)?$/i, '').trim(); // letterhead + title on one row
  if (s.length < 2 || s.length > 90) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  if (CONTACT_LINE.test(s) || /^\d[\d\s\-/]*$/.test(s)) return null;
  if (DOC_TITLE.test(s) && s.split(/\s+/).length <= 3) return null;
  if (TOTALS_ANY.test(s) && !COMPANY_SUFFIX.test(s)) return null;
  return s;
}

function looksLikeAddress(s: string): boolean {
  return ADDRESS_HINT.test(s) && !COMPANY_SUFFIX.test(s);
}

const ANY_LABEL = /^(?:invoice|bill|customer|client|supplier|vendor|from|to|date|due|currency|subtotal|sub total|tax|vat|gst|total|amount|terms|po|order|reference|ref|phone|email|address)\b[\s\w.#]*:?$/i;
function isLabelText(s: string): boolean {
  return ANY_LABEL.test(s.trim()) && s.trim().split(/\s+/).length <= 3;
}

function partyFromLabels(lines: DocLine[], labels: RegExp[], exclude?: RegExp): Candidate | null {
  for (const hit of findLabels(lines, labels)) {
    const labelCell = hit.line.cells[hit.cellIndex].text;
    if (exclude && exclude.test(labelCell)) continue;
    const sameLine = cleanName(hit.rest);
    if (sameLine && !looksLikeAddress(sameLine)) {
      return { value: sameLine, raw: hit.rest, confidence: 0.9, line: hit.line, how: 'same-line' };
    }
    // label cell followed by a value cell on the same row (forms, two-column key/value layouts)
    const right = !hit.rest.trim() ? valueRight(hit) : null;
    const rightName = right && !/:\s*$/.test(right) && !isLabelText(right) ? cleanName(right) : null;
    if (rightName && !looksLikeAddress(rightName)) {
      return { value: rightName, raw: right!, confidence: 0.88, line: hit.line, how: 'same-line' };
    }
    if (!hit.rest.trim()) {
      const below = valueBelow(lines, hit, 2);
      const name = below ? cleanName(below.cell.text) : null;
      if (below && name && !looksLikeAddress(name)) {
        return { value: name, raw: below.cell.text, confidence: 0.86, line: below.line, how: 'block' };
      }
    }
  }
  return null;
}

export function extractCustomer(lines: DocLine[]): Candidate | null {
  return partyFromLabels(lines, CUSTOMER_LABELS, /\b(?:ship(?:ped)?\s+to|deliver(?:y)?\s+to)\b/i);
}

const STOPWORDS = new Set(['and', 'for', 'the', 'of', 'und', 'de', 'des', 'du', 'la', 'le', 'van', 'von', 'der', 'den']);

/** Sentences ("Services and deliveries for July 2026") are not company names. */
function looksLikeSentence(s: string): boolean {
  if (/\b(?:19|20)\d{2}\b/.test(s)) return true;
  return s.split(/\s+/).some((w) => w.length >= 4 && /^[a-zäöüéèàç]+[.,]?$/.test(w) && !STOPWORDS.has(w.toLowerCase()));
}

function lineHeight(line: DocLine): number | null {
  return line.bbox ? line.bbox[3] - line.bbox[1] : null;
}

/** Letterhead names that wrap ("Rodriguez & Jones Medical" / "Equipment Pty. Ltd.") are re-joined. */
function joinWrappedName(lines: DocLine[], line: DocLine, cell: Cell, name: string): { name: string; line: DocLine } {
  const pos = lines.indexOf(line);
  const aligned = (other: DocLine | undefined) => {
    if (!other || other.page !== line.page) return null;
    const c = other.cells.find((x) => Math.abs(x.start - cell.start) <= 3);
    const t = c ? cleanName(c.text) : null;
    if (!t || CONTACT_LINE.test(t) || ID_LINE.test(t) || /\d/.test(t) || DOC_TITLE.test(t) || looksLikeSentence(t)) return null;
    if (looksLikeAddress(t)) return null;
    return t;
  };
  if (pos <= 3 && !COMPANY_SUFFIX.test(aligned(lines[pos - 1]) ?? 'x Ltd')) {
    const before = aligned(lines[pos - 1]);
    if (before && before.split(/\s+/).length <= 5) name = `${before} ${name}`;
  }
  const after = aligned(lines[pos + 1]);
  const SUFFIX_ONLY = /^(?:(?:pty|pvt|private|co|corp|ltd|limited|llc|inc|plc|gmbh|ag|kg|&|b\.?v|s\.?a|sarl)\.?\s*)+$/i;
  const ENDS_LEGAL = /\b(?:ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|co|plc|pvt|gmbh|ag|kg|sarl|s\.?a|b\.?v|n\.?v|pty|pte|llp|lp)\.?$/i;
  // "Shaw & Ramos Healthcare" / "Supplies Pty. Ltd.": the wrapped tail carries the legal suffix
  if (after && (SUFFIX_ONLY.test(after) || (!ENDS_LEGAL.test(name) && ENDS_LEGAL.test(after) && after.split(/\s+/).length <= 4))) {
    name = `${name} ${after}`;
  }
  return { name, line };
}

/** Supplier: explicit label first, then the letterhead (top lines of page 1), then payment instructions. */
export function extractSupplier(lines: DocLine[], customer: string | null): Candidate | null {
  const labelled = partyFromLabels(lines, SUPPLIER_LABELS);
  if (labelled && labelled.value !== customer) return labelled;

  const firstPage = lines.filter((l) => l.page === lines[0]?.page);
  const scored: Array<{ c: Candidate; cell: Cell; score: number }> = [];
  firstPage.slice(0, 14).forEach((line, i) => {
    for (const cell of line.cells) {
      const name = cleanName(cell.text);
      if (!name) continue;
      if (DOC_TITLE.test(name) || ID_LINE.test(name) || CONTACT_LINE.test(name) || /:/.test(name)) continue;
      if (looksLikeAddress(name) || findDates(name).length || looksLikeSentence(name)) continue;
      if (customer && name.toLowerCase() === customer.toLowerCase()) continue;
      if (name.split(/\s+/).length > 9) continue;
      let score = 1 - i * 0.05;
      if (COMPANY_SUFFIX.test(name)) score += 1.2;
      if (/^[A-Z0-9&.,' -]+$/.test(name) && /[A-Z]{3,}/.test(name)) score += 0.2; // ALL CAPS letterhead
      const h = lineHeight(line);
      if (h !== null && i < 6) score += Math.min(0.6, h * 20); // larger type near the top
      scored.push({ c: { value: name, raw: cell.text, confidence: 0, line, how: 'heuristic' }, cell, score });
    }
  });
  if (!scored.length) {
    const weak = partyFromLabels(lines, SUPPLIER_WEAK_LABELS);
    if (weak) weak.confidence = 0.6;
    return weak;
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const joined = joinWrappedName(firstPage, best.c.line, best.cell, best.c.value);
  best.c.value = joined.name;
  // A name repeated elsewhere (footer, "For X", sender line) is very likely the issuer.
  const key = best.c.value.toLowerCase();
  const repeats = lines.filter((l) => l !== best.c.line && l.text.toLowerCase().includes(key)).length;
  best.c.confidence = Math.min(0.9, (COMPANY_SUFFIX.test(best.c.value) ? 0.72 : 0.6) + Math.min(repeats, 2) * 0.07);
  best.c.note = 'inferred from letterhead';
  return best.c;
}

/**
 * DIN 5008-style letters print the sender in small type above the recipient address window:
 * "Supplier GmbH - Street 1 - 12345 City". The next line in that column is the customer.
 */
export function customerFromSenderLine(lines: DocLine[], supplier: string | null): Candidate | null {
  if (!supplier) return null;
  const key = supplier.toLowerCase().slice(0, 12);
  for (let i = 0; i < Math.min(lines.length - 1, 30); i++) {
    const cell = lines[i].cells[0];
    if (!cell || !cell.text.toLowerCase().startsWith(key) || !/\s[-–·|]\s/.test(cell.text)) continue;
    const next = lines[i + 1];
    const nextCell = next.cells.find((c) => Math.abs(c.start - cell.start) <= 4);
    const name = cleanName(nextCell?.text);
    if (name && !looksLikeAddress(name) && name.toLowerCase() !== supplier.toLowerCase()) {
      return { value: name, raw: nextCell!.text, confidence: 0.66, line: next, how: 'heuristic', note: 'recipient address block' };
    }
  }
  return null;
}

/** Cheap invoice-number probe used by segmentation (per page). */
export function quickInvoiceNumber(lines: DocLine[]): string | null {
  return extractInvoiceNumber(lines)?.value ?? null;
}
