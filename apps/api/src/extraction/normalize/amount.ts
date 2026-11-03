import Decimal from 'decimal.js';

/** Decimal separator convention of a document: "dot" = 1,234.56 ; "comma" = 1.234,56 */
export type NumberLocale = 'dot' | 'comma';

const CURRENCY_NOISE = /[A-Za-z$€£¥₹৳₨₩₦₱฿]+\.?/g;

/** Matches a money-like token inside text (with optional sign / parentheses / currency). */
export const AMOUNT_TOKEN =
  /(?<![\w./-])(?:[-−(]\s*)?(?:[A-Z]{3}\s?|[$€£¥₹৳]\s?|Tk\.?\s?|Rs\.?\s?)?\d{1,3}(?:[,.'  ]\d{2,3})*(?:[.,]\d{1,3})?(?:\s?[$€£])?\)?(?![\w/])-?|(?<![\w./-])(?:[-−(]\s*)?\d+(?:[.,]\d{1,3})?\)?(?![\w/])/g;

export function toDecimal(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const d = new Decimal(typeof value === 'number' ? value.toString() : value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export function formatAmount(d: Decimal | null): string | null {
  if (!d) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Parse a printed amount ("$1,234.56", "1.234,56 €", "(45.00)", "1 234,50", "1,23,456.00", "12.50-").
 * Returns null when the text is not a clean number - we never guess.
 */
export function parseAmount(raw: string | number | null | undefined, locale: NumberLocale = 'dot'): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Decimal(raw.toString()) : null;
  let s = raw.trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/\b(?:CR|DR)\b\.?$/i, (m) => {
    if (/^CR/i.test(m)) negative = true;
    return '';
  });
  s = s.replace(CURRENCY_NOISE, '').replace(/ /g, ' ').trim();
  if (/^[-−]/.test(s)) {
    negative = true;
    s = s.replace(/^[-−]\s*/, '');
  }
  if (/-$/.test(s)) {
    negative = true;
    s = s.replace(/-$/, '');
  }
  s = s.replace(/^[:=\s]+/, '').trim();
  if (!/^\d[\d.,' ]*$/.test(s)) return null;

  // Spaces are only valid as thousands separators between groups of 3 digits.
  if (/ /.test(s)) {
    if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return null;
    s = s.replace(/ /g, '');
  }
  s = s.replace(/'/g, '');

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalised: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: whichever comes last is the decimal separator.
    normalised = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commas = (s.match(/,/g) || []).length;
    if (commas === 1 && decimals <= 2) normalised = s.replace(',', '.');
    else if (commas === 1 && decimals === 3 && locale === 'comma' && !/^\d{1,3},\d{3}$/.test(s)) normalised = s.replace(',', '.');
    else if (/^\d{1,3}(,\d{2,3})+$/.test(s)) normalised = s.replace(/,/g, ''); // 1,234 or Indian 1,23,456
    else return null;
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null;
      normalised = s.replace(/\./g, ''); // 1.234.567 (EU thousands)
    } else if (decimals === 3 && locale === 'comma' && /^\d{1,3}\.\d{3}$/.test(s)) {
      normalised = s.replace('.', ''); // 1.234 in an EU document = 1234
    } else {
      normalised = s;
    }
  } else {
    normalised = s;
  }
  if (!/^\d+(\.\d+)?$/.test(normalised)) return null;
  const d = new Decimal(normalised);
  return negative ? d.negated() : d;
}

/** Find every amount-like token in a line, in reading order, with its parsed value. */
export function findAmounts(line: string, locale: NumberLocale = 'dot'): Array<{ raw: string; value: Decimal; index: number }> {
  const out: Array<{ raw: string; value: Decimal; index: number }> = [];
  for (const m of line.matchAll(AMOUNT_TOKEN)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const value = parseAmount(raw, locale);
    if (value) out.push({ raw, value, index: m.index ?? 0 });
  }
  return out;
}

/** Infer the decimal-separator convention used by a document from its numbers. */
export function detectNumberLocale(text: string): NumberLocale {
  const comma =
    (text.match(/\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g) || []).length * 3 +
    (text.match(/(?<![\d.,])\d+,\d{2}(?![\d,.])/g) || []).length;
  const dot =
    (text.match(/\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g) || []).length * 3 +
    (text.match(/(?<![\d.,])\d+\.\d{2}(?![\d,.])/g) || []).length;
  return comma > dot ? 'comma' : 'dot';
}

/** True when |a - b| <= tolerance. */
export function amountsClose(a: Decimal | null, b: Decimal | null, tolerance: Decimal | number = 0.02): boolean {
  if (!a || !b) return false;
  return a.minus(b).abs().lte(tolerance);
}
