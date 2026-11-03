/** Date parsing for invoice formats. Never guesses silently: ambiguous day/month order is reported. */

export type DateOrder = 'dmy' | 'mdy';

export interface ParsedDate {
  iso: string;
  raw: string;
  ambiguous: boolean;
  index: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
  // common non-English month names seen on EU invoices
  januar: 1, februar: 2, märz: 3, maerz: 3, mai: 5, juni: 6, juli: 7, okt: 10, oktober: 10, dez: 12, dezember: 12,
};

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const PATTERNS: Array<{ re: RegExp; kind: 'ymd' | 'num' | 'dMy' | 'Mdy' }> = [
  { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, kind: 'ymd' },
  { re: /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/g, kind: 'num' },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-./,]*(${MONTH_RE})\\.?[\\s\\-./,]*(\\d{4}|\\d{2})\\b`, 'gi'), kind: 'dMy' },
  { re: new RegExp(`\\b(${MONTH_RE})\\.?[\\s\\-./]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s\\-./]*(\\d{4})\\b`, 'gi'), kind: 'Mdy' },
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isValidDate(y: number, m: number, d: number): boolean {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

function year4(y: string): number {
  const n = Number(y);
  return y.length === 2 ? (n >= 70 ? 1900 + n : 2000 + n) : n;
}

/** Extract every date in a line. `order` resolves numeric dates where both parts are <= 12. */
export function findDates(text: string, order: DateOrder = 'dmy'): ParsedDate[] {
  const found: ParsedDate[] = [];
  const taken: Array<[number, number]> = [];
  for (const { re, kind } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      let y: number, mo: number, d: number;
      let ambiguous = false;
      if (kind === 'ymd') {
        [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      } else if (kind === 'num') {
        const a = Number(m[1]);
        const b = Number(m[2]);
        y = year4(m[3]);
        if (a > 12 && b <= 12) [d, mo] = [a, b];
        else if (b > 12 && a <= 12) [mo, d] = [a, b];
        else if (a <= 12 && b <= 12) {
          ambiguous = a !== b;
          [d, mo] = order === 'dmy' ? [a, b] : [b, a];
        } else continue;
      } else if (kind === 'dMy') {
        d = Number(m[1]);
        mo = MONTHS[m[2].toLowerCase()];
        y = year4(m[3]);
      } else {
        mo = MONTHS[m[1].toLowerCase()];
        d = Number(m[2]);
        y = Number(m[3]);
      }
      if (!mo || !isValidDate(y, mo, d)) continue;
      taken.push([start, end]);
      found.push({ iso: `${y}-${pad(mo)}-${pad(d)}`, raw: m[0], ambiguous, index: start });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export function parseDate(raw: string | null | undefined, order: DateOrder = 'dmy'): ParsedDate | null {
  if (!raw) return null;
  const all = findDates(String(raw), order);
  return all[0] ?? null;
}

/**
 * Infer the numeric date order from unambiguous dates in the document (e.g. 23/02/2025 => dmy),
 * falling back to a currency hint (USD invoices are usually US-style), then dmy.
 */
export function detectDateOrder(text: string, currencyHint?: string | null): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const m of text.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy !== mdy) return dmy > mdy ? 'dmy' : 'mdy';
  if (/\b\d{1,2}\.\d{1,2}\.\d{4}\b/.test(text)) return 'dmy'; // dotted dates are European
  if (currencyHint === 'USD') return 'mdy';
  return 'dmy';
}
