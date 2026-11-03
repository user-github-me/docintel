import Decimal from 'decimal.js';
import { companySimilarity, normaliseInvoiceNumber } from '../common/text';

export interface ReconInvoice {
  id: string;
  invoice_number: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  line_count?: number;
  line_sum?: string | null;
}

export interface Discrepancy {
  field: string;
  left: string | number | null;
  right: string | number | null;
  difference?: string;
}

export interface ReconItem {
  left: ReconInvoice | null;
  right: ReconInvoice | null;
  status: 'matched' | 'mismatch' | 'missing_in_right' | 'missing_in_left';
  method: 'invoice_number' | 'fuzzy' | null;
  score: number | null;
  discrepancies: Discrepancy[];
}

export interface ReconOptions {
  amountTolerance: number;
  dateToleranceDays: number;
}

const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
const amt = (v: string | null) => (v === null || v === undefined ? null : new Decimal(v));

function compare(l: ReconInvoice, r: ReconInvoice, opts: ReconOptions, method: ReconItem['method']): Discrepancy[] {
  const out: Discrepancy[] = [];
  const tol = new Decimal(opts.amountTolerance);
  for (const f of ['subtotal', 'tax', 'total'] as const) {
    const a = amt(l[f]);
    const b = amt(r[f]);
    if (a && b && a.minus(b).abs().gt(tol)) out.push({ field: f, left: a.toFixed(2), right: b.toFixed(2), difference: b.minus(a).toFixed(2) });
    else if ((a && !b) || (!a && b)) out.push({ field: f, left: a?.toFixed(2) ?? null, right: b?.toFixed(2) ?? null });
  }
  if (l.invoice_date && r.invoice_date && l.invoice_date !== r.invoice_date) out.push({ field: 'invoice_date', left: l.invoice_date, right: r.invoice_date });
  if (l.currency && r.currency && l.currency !== r.currency) out.push({ field: 'currency', left: l.currency, right: r.currency });
  if (l.supplier_name && r.supplier_name && companySimilarity(l.supplier_name, r.supplier_name) < 0.85) out.push({ field: 'supplier_name', left: l.supplier_name, right: r.supplier_name });
  if (l.customer_name && r.customer_name && companySimilarity(l.customer_name, r.customer_name) < 0.85) out.push({ field: 'customer_name', left: l.customer_name, right: r.customer_name });
  if (method === 'fuzzy' && normaliseInvoiceNumber(l.invoice_number) !== normaliseInvoiceNumber(r.invoice_number)) {
    out.push({ field: 'invoice_number', left: l.invoice_number, right: r.invoice_number });
  }
  if (l.line_count && r.line_count && l.line_count !== r.line_count) out.push({ field: 'line_items', left: l.line_count, right: r.line_count });
  return out;
}

function fuzzyScore(l: ReconInvoice, r: ReconInvoice, opts: ReconOptions): number {
  const supplier = companySimilarity(l.supplier_name, r.supplier_name);
  const a = amt(l.total);
  const b = amt(r.total);
  const amountScore = a && b ? (a.minus(b).abs().lte(opts.amountTolerance) ? 1 : a.minus(b).abs().div(Decimal.max(a.abs(), 1)).lte(0.02) ? 0.5 : 0) : 0;
  const dateScore = l.invoice_date && r.invoice_date ? (days(l.invoice_date, r.invoice_date) <= opts.dateToleranceDays ? 1 : 0) : 0;
  return 0.4 * supplier + 0.4 * amountScore + 0.2 * dateScore;
}

/**
 * Cross-verify two sets of invoices (PDF vs PDF, PDF vs Excel/CSV register).
 * Pass 1 matches on normalised invoice number (supplier similarity breaks ties);
 * pass 2 pairs the rest by supplier + amount + date similarity (score >= 0.75).
 */
export function reconcile(left: ReconInvoice[], right: ReconInvoice[], opts: ReconOptions) {
  const items: ReconItem[] = [];
  const usedRight = new Set<string>();
  const byNumber = new Map<string, ReconInvoice[]>();
  for (const r of right) {
    const k = normaliseInvoiceNumber(r.invoice_number);
    if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), r]);
  }
  const unmatchedLeft: ReconInvoice[] = [];
  for (const l of left) {
    const k = normaliseInvoiceNumber(l.invoice_number);
    const candidates = (k ? byNumber.get(k) ?? [] : []).filter((r) => !usedRight.has(r.id));
    if (!candidates.length) {
      unmatchedLeft.push(l);
      continue;
    }
    const best = candidates.sort((a, b) => companySimilarity(l.supplier_name, b.supplier_name) - companySimilarity(l.supplier_name, a.supplier_name))[0];
    usedRight.add(best.id);
    const discrepancies = compare(l, best, opts, 'invoice_number');
    items.push({ left: l, right: best, status: discrepancies.length ? 'mismatch' : 'matched', method: 'invoice_number', score: 1, discrepancies });
  }
  for (const l of unmatchedLeft) {
    let best: ReconInvoice | null = null;
    let bestScore = 0;
    for (const r of right) {
      if (usedRight.has(r.id)) continue;
      const s = fuzzyScore(l, r, opts);
      if (s > bestScore) {
        best = r;
        bestScore = s;
      }
    }
    if (best && bestScore >= 0.75) {
      usedRight.add(best.id);
      const discrepancies = compare(l, best, opts, 'fuzzy');
      items.push({ left: l, right: best, status: discrepancies.length ? 'mismatch' : 'matched', method: 'fuzzy', score: Number(bestScore.toFixed(3)), discrepancies });
    } else {
      items.push({ left: l, right: null, status: 'missing_in_right', method: null, score: null, discrepancies: [] });
    }
  }
  for (const r of right) if (!usedRight.has(r.id)) items.push({ left: null, right: r, status: 'missing_in_left', method: null, score: null, discrepancies: [] });

  const sum = (xs: ReconInvoice[]) => xs.reduce((acc, x) => acc.plus(x.total ? new Decimal(x.total) : 0), new Decimal(0));
  const leftSum = sum(left);
  const rightSum = sum(right);
  const count = (s: ReconItem['status']) => items.filter((i) => i.status === s).length;
  return {
    items,
    summary: {
      leftCount: left.length,
      rightCount: right.length,
      matched: count('matched'),
      mismatched: count('mismatch'),
      missingInRight: count('missing_in_right'),
      missingInLeft: count('missing_in_left'),
      leftTotal: leftSum.toFixed(2),
      rightTotal: rightSum.toFixed(2),
      difference: rightSum.minus(leftSum).toFixed(2),
    },
  };
}
