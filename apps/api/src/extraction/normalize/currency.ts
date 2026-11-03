/** Currency detection. Only unambiguous evidence produces a code; a bare "$" alone is not enough. */

export const ISO_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'BDT', 'INR', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN',
  'CZK', 'HUF', 'SGD', 'HKD', 'MYR', 'THB', 'IDR', 'PHP', 'PKR', 'LKR', 'NPR', 'AED', 'SAR', 'QAR', 'KWD',
  'BHD', 'OMR', 'ZAR', 'NGN', 'KES', 'EGP', 'TRY', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'KRW', 'RUB', 'UAH',
]);

const SYMBOLS: Array<[RegExp, string]> = [
  [/US\$|USD/i, 'USD'],
  [/C\$|CA\$|CAD/i, 'CAD'],
  [/A\$|AU\$|AUD/i, 'AUD'],
  [/NZ\$|NZD/i, 'NZD'],
  [/€|\bEUR\b|\beuros?\b/i, 'EUR'],
  [/£|\bGBP\b|\bpounds? sterling\b/i, 'GBP'],
  [/৳|\bBDT\b|\bTk\.?(?=\s?\d)|\bTaka\b/i, 'BDT'],
  [/₹|\bINR\b|\bRs\.?(?=\s?\d)|\bRupees?\b/i, 'INR'],
  [/¥|\bJPY\b/i, 'JPY'],
];

export interface CurrencyHit {
  code: string;
  raw: string;
  index: number;
  strength: number; // 3 = explicit ISO code / label, 2 = unambiguous symbol, 1 = weak
}

/** All currency mentions in a line. */
export function findCurrencies(line: string): CurrencyHit[] {
  const hits: CurrencyHit[] = [];
  for (const m of line.matchAll(/\b([A-Z]{3})\b/g)) {
    if (ISO_CURRENCIES.has(m[1])) hits.push({ code: m[1], raw: m[1], index: m.index ?? 0, strength: 3 });
  }
  for (const [re, code] of SYMBOLS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of line.matchAll(g)) {
      if (/^[A-Z]{3}$/.test(m[0])) continue; // counted above
      hits.push({ code, raw: m[0], index: m.index ?? 0, strength: /[€£৳₹¥]/.test(m[0]) || m[0].length > 2 ? 2 : 1 });
    }
  }
  return hits;
}

/** Best currency for a document text; totals lines and "Currency:" labels weigh more. */
export function detectCurrency(lines: string[]): { code: string; evidence: string; confidence: number } | null {
  const score = new Map<string, { s: number; evidence: string }>();
  for (const line of lines) {
    const hits = findCurrencies(line);
    if (!hits.length) continue;
    const boost = /currency|total|amount due|payable|balance/i.test(line) ? 2 : 1;
    for (const h of hits) {
      const prev = score.get(h.code) ?? { s: 0, evidence: line.trim() };
      prev.s += h.strength * boost;
      if (boost > 1 && h.strength >= 2) prev.evidence = line.trim();
      score.set(h.code, prev);
    }
  }
  if (!score.size) return null;
  const ranked = [...score.entries()].sort((a, b) => b[1].s - a[1].s);
  const [code, best] = ranked[0];
  const runnerUp = ranked[1]?.[1].s ?? 0;
  const confidence = best.s >= 3 && best.s > runnerUp * 2 ? 0.92 : best.s > runnerUp ? 0.75 : 0.5;
  return { code, evidence: best.evidence.slice(0, 160), confidence };
}

export function normaliseCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (ISO_CURRENCIES.has(up)) return up;
  const hits = findCurrencies(raw);
  const strong = hits.filter((h) => h.strength >= 2);
  return strong.length ? strong[0].code : null;
}
