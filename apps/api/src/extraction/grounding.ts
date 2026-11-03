import { matchKey, partialSimilarity } from '../common/text';
import { findAmounts, formatAmount, parseAmount } from './normalize/amount';
import { findCurrencies, normaliseCurrency } from './normalize/currency';
import { findDates } from './normalize/date';
import { FieldName, PageText } from './types';

/**
 * Anti-hallucination check: a value proposed by the LLM is accepted only if it can be traced back
 * to the source text. Numbers and dates are compared numerically (any locale / day-month order);
 * names and identifiers tolerate small OCR errors via fuzzy matching on the most similar line.
 */
export interface GroundingContext {
  key: string;
  lineKeys: string[];
  amounts: Set<string>;
  digitRuns: Set<string>;
  dates: Set<string>;
  currencies: Set<string>;
}

export function buildGroundingContext(pages: PageText[]): GroundingContext {
  const text = pages.map((p) => p.text).join('\n');
  const lines = text.split('\n').filter((l) => l.trim());
  const amounts = new Set<string>();
  const digitRuns = new Set<string>();
  for (const line of lines) {
    for (const locale of ['dot', 'comma'] as const) {
      for (const a of findAmounts(line, locale)) {
        const f = formatAmount(a.value.abs());
        if (f) amounts.add(f);
      }
    }
    for (const m of line.matchAll(/\d[\d.,' ]*\d|\d/g)) digitRuns.add(m[0].replace(/\D/g, '').replace(/^0+/, ''));
  }
  const dates = new Set<string>();
  for (const order of ['dmy', 'mdy'] as const) for (const d of findDates(text, order)) dates.add(d.iso);
  const currencies = new Set<string>();
  for (const line of lines) for (const c of findCurrencies(line)) currencies.add(c.code);
  return { key: matchKey(text), lineKeys: lines.map(matchKey), amounts, digitRuns, dates, currencies };
}

export interface GroundingResult {
  grounded: boolean;
  score: number; // 1 = exact, lower = fuzzy
  reason?: string;
}

function fuzzyText(value: string, ctx: GroundingContext): number {
  const k = matchKey(value);
  if (!k) return 0;
  if (ctx.key.includes(k)) return 1;
  let best = 0;
  for (const line of ctx.lineKeys) {
    if (Math.abs(line.length - k.length) > k.length * 3 + 20 && !line.includes(k.slice(0, 4))) continue;
    const s = partialSimilarity(k, line);
    if (s > best) best = s;
    if (best >= 0.999) break;
  }
  return best;
}

export function groundValue(field: FieldName, value: string, ctx: GroundingContext): GroundingResult {
  switch (field) {
    case 'subtotal':
    case 'tax':
    case 'discount':
    case 'shipping':
    case 'total': {
      const d = parseAmount(value);
      if (!d) return { grounded: false, score: 0, reason: 'not a number' };
      const f = formatAmount(d.abs())!;
      if (ctx.amounts.has(f)) return { grounded: true, score: 1 };
      // OCR may drop separators ("1602 64"): compare digit strings
      const digits = f.replace(/\D/g, '').replace(/^0+/, '');
      const intDigits = d.abs().toFixed(0) === d.abs().toString() ? d.abs().toFixed(0) : null;
      if (ctx.digitRuns.has(digits) || (intDigits && ctx.digitRuns.has(intDigits))) return { grounded: true, score: 0.8, reason: 'digits match, separators differ' };
      if (d.isZero()) return { grounded: true, score: 0.7, reason: 'zero amount' };
      return { grounded: false, score: 0, reason: `amount ${f} does not appear in the document` };
    }
    case 'invoice_date':
    case 'due_date':
      return ctx.dates.has(value) ? { grounded: true, score: 1 } : { grounded: false, score: 0, reason: `date ${value} does not appear in the document` };
    case 'currency': {
      const code = normaliseCurrency(value);
      if (!code) return { grounded: false, score: 0, reason: 'not an ISO currency' };
      return ctx.currencies.has(code) ? { grounded: true, score: 1 } : { grounded: false, score: 0, reason: `no evidence of ${code} in the document` };
    }
    default: {
      const s = fuzzyText(value, ctx);
      if (s >= 0.999) return { grounded: true, score: 1 };
      if (s >= 0.85) return { grounded: true, score: s, reason: `fuzzy match ${(s * 100).toFixed(0)}% (OCR noise)` };
      return { grounded: false, score: s, reason: `"${value}" not found in the document text` };
    }
  }
}
