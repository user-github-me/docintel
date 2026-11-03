import Decimal from 'decimal.js';
import { findAmounts, formatAmount, NumberLocale } from '../normalize/amount';
import { AmountField, FieldValue } from '../types';
import { evidenceOf, ocrFactor } from './fields';
import { DocLine, maskNonAmounts } from './lines';
import { DISCOUNT, NOT_TAX, NOT_TOTALS, SHIPPING, SUBTOTAL, TAX, TOTAL_STRONG, TOTAL_WEAK } from './labels';

type Role = 'total_strong' | 'total_weak' | 'subtotal' | 'tax' | 'discount' | 'shipping';

export interface AmountLine {
  line: DocLine;
  label: string;
  role: Role;
  value: Decimal;
  raw: string;
}

const ROLE_STRENGTH: Record<Role, number> = {
  total_strong: 0.93,
  subtotal: 0.92,
  tax: 0.9,
  discount: 0.88,
  shipping: 0.88,
  total_weak: 0.8,
};

function classify(label: string): Role | null {
  const l = label.replace(/\s+/g, ' ').trim();
  if (!l || NOT_TOTALS.test(l)) return null;
  if (TOTAL_STRONG.test(l)) return 'total_strong';
  if (SUBTOTAL.test(l)) return 'subtotal';
  if (DISCOUNT.test(l)) return 'discount';
  if (SHIPPING.test(l)) return 'shipping';
  if (TAX.test(l) && !NOT_TAX.test(l.replace(TAX, ''))) return 'tax';
  if (TAX.test(l) && /^\s*(?:total\s+)?(?:vat|gst|tax)\b/i.test(l)) return 'tax';
  if (TOTAL_WEAK.test(l.replace(/[:.]$/, '')) || /^total\b/i.test(l)) return 'total_weak';
  return null;
}

/** Collect "label ... amount" lines that look like part of a totals block. */
export function collectAmountLines(lines: DocLine[], locale: NumberLocale, skip: Set<number>): AmountLine[] {
  const out: AmountLine[] = [];
  for (const line of lines) {
    if (skip.has(line.idx)) continue;
    const masked = maskNonAmounts(line.text);
    const amounts = findAmounts(masked, locale);
    if (!amounts.length) continue;
    const last = amounts[amounts.length - 1];
    // label = text cells to the left of the amount, nearest first
    const labelCells = line.cells.filter((c) => c.end <= last.index + 1 && /[A-Za-z]/.test(c.text));
    if (!labelCells.length) continue;
    const nearest = labelCells[labelCells.length - 1].text.replace(/[\d.,]+\s*$/, '').trim();
    let role = classify(nearest);
    let label = nearest;
    if (!role && labelCells.length > 1) {
      label = labelCells.map((c) => c.text).join(' ');
      role = classify(labelCells[labelCells.length - 2].text);
    }
    if (!role) continue;
    let value = last.value;
    if (role === 'discount' && value.isPositive()) value = value; // discounts are printed either way; sign handled in solve()
    out.push({ line, label, role, value, raw: last.raw });
  }
  return out;
}

export interface TotalsResult {
  fields: Partial<Record<AmountField, FieldValue>>;
  consistent: boolean;
  notes: string[];
}

function field(a: AmountLine | null, confidence: number, value?: Decimal): FieldValue {
  if (!a) return { value: null, confidence: 0, source: 'none', evidence: null };
  const v = value ?? a.value;
  return {
    value: formatAmount(v),
    raw: a.raw,
    confidence: Math.round(confidence * ocrFactor(a.line) * 1000) / 1000,
    source: 'rules',
    evidence: evidenceOf(a.line),
  };
}

const TOL = new Decimal('0.05');

/**
 * Choose subtotal / tax / discount / shipping / total so that
 *   subtotal - discount + shipping + tax == total
 * holds, preferring stronger labels. When the printed numbers cannot be reconciled we keep the
 * best-labelled values and say so (validation will flag the mismatch); we never invent a number.
 */
export function solveTotals(amountLines: AmountLine[], itemsSum: Decimal | null): TotalsResult {
  const notes: string[] = [];
  const by = (role: Role) => amountLines.filter((a) => a.role === role);
  const strong = by('total_strong');
  const weak = by('total_weak');
  const subs = by('subtotal');
  const taxes = by('tax');
  const discounts = by('discount');
  const shippings = by('shipping');

  const totalCands = [...strong.slice().reverse(), ...weak.slice().reverse()];
  const subtotalCands = [...subs, ...(strong.length ? weak : [])];
  const discount = discounts[0] ?? null;
  const shipping = shippings[0] ?? null;
  const dAbs = discount ? discount.value.abs() : new Decimal(0);
  const sVal = shipping ? shipping.value : new Decimal(0);

  // Tax options: each tax line, or the sum of distinct tax lines (CGST + SGST).
  const taxOptions: Array<{ lines: AmountLine[]; value: Decimal }> = taxes.map((t) => ({ lines: [t], value: t.value }));
  if (taxes.length > 1) {
    const distinct = taxes.filter((t, i) => taxes.findIndex((u) => u.value.eq(t.value) && u.label === t.label) === i);
    const sum = distinct.reduce((acc, t) => acc.plus(t.value), new Decimal(0));
    taxOptions.push({ lines: distinct, value: sum });
  }

  type Combo = { total: AmountLine; sub: AmountLine | null; tax: { lines: AmountLine[]; value: Decimal } | null; score: number };
  let best: Combo | null = null;
  for (const total of totalCands) {
    for (const sub of [...subtotalCands, null]) {
      if (sub === total) continue;
      for (const tax of [...taxOptions, null]) {
        const s = sub?.value ?? null;
        const t = tax?.value ?? new Decimal(0);
        let ok = false;
        if (s) ok = s.minus(dAbs).plus(sVal).plus(t).minus(total.value).abs().lte(TOL);
        else if (tax && itemsSum) ok = itemsSum.minus(dAbs).plus(sVal).plus(t).minus(total.value).abs().lte(TOL);
        if (!ok) continue;
        const score =
          ROLE_STRENGTH[total.role] + (sub ? ROLE_STRENGTH[sub.role] : 0) + (tax ? 0.9 : 0) +
          (sub?.role === 'subtotal' ? 0.2 : 0) + (total.role === 'total_strong' ? 0.2 : 0);
        if (!best || score > best.score) best = { total, sub, tax, score };
      }
    }
  }

  const fields: Partial<Record<AmountField, FieldValue>> = {};
  if (best) {
    // full arithmetic agreement (subtotal and tax both present) corroborates even a weakly labelled total
    fields.total = field(best.total, Math.min(0.98, ROLE_STRENGTH[best.total.role] + (best.sub && best.tax ? 0.12 : 0.05)));
    if (best.sub) {
      fields.subtotal = field(best.sub, 0.96);
      if (best.sub.role === 'total_weak') notes.push(`"${best.sub.label}" is the pre-tax subtotal on this document`);
    }
    if (best.tax) {
      const first = best.tax.lines[0];
      fields.tax = field(first, 0.95, best.tax.value);
      if (best.tax.lines.length > 1) {
        fields.tax.raw = best.tax.lines.map((l) => l.raw).join(' + ');
        notes.push(`tax is the sum of ${best.tax.lines.map((l) => l.label).join(' + ')}`);
      }
    }
  } else {
    // No consistent combination: take the best-labelled value per role, reduced confidence.
    const total = strong[strong.length - 1] ?? weak[weak.length - 1] ?? null;
    if (total) fields.total = field(total, ROLE_STRENGTH[total.role] - 0.15);
    const sub = subs[0] ?? null;
    if (sub) fields.subtotal = field(sub, 0.75);
    if (taxes.length) {
      const opt = taxOptions[taxOptions.length - 1];
      fields.tax = field(opt.lines[0], 0.72, opt.value);
    }
    if (amountLines.length) notes.push('printed totals do not reconcile (subtotal - discount + shipping + tax != total)');
  }
  if (discount) fields.discount = field(discount, ROLE_STRENGTH.discount, dAbs);
  if (shipping) fields.shipping = field(shipping, ROLE_STRENGTH.shipping);
  return { fields, consistent: !!best, notes };
}
