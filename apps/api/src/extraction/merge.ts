import Decimal from 'decimal.js';
import { companySimilarity, normaliseInvoiceNumber, similarity } from '../common/text';
import { formatAmount, parseAmount } from './normalize/amount';
import { normaliseCurrency } from './normalize/currency';
import { parseDate } from './normalize/date';
import { GroundingContext, groundValue } from './grounding';
import { LlmField, LlmInvoice } from './llm/schema';
import { sumItems } from './rules/line-items';
import {
  AMOUNT_FIELDS,
  emptyField,
  ExtractionIssue,
  FIELD_NAMES,
  FieldName,
  FieldValue,
  InvoiceDraft,
  LineItem,
  LlmUsage,
} from './types';

const SELF_CONFIDENCE = { high: 0.88, medium: 0.72, low: 0.5 } as const;

function normaliseLlmValue(field: FieldName, raw: string | null): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (!v || /^(?:null|n\/a|none|-)$/i.test(v)) return null;
  if ((AMOUNT_FIELDS as readonly string[]).includes(field)) {
    const d = parseAmount(v);
    return d ? formatAmount(field === 'discount' ? d.abs() : d) : null;
  }
  if (field === 'invoice_date' || field === 'due_date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return parseDate(v)?.iso ?? null;
    return parseDate(v)?.iso ?? null;
  }
  if (field === 'currency') return normaliseCurrency(v);
  return v.replace(/\s+/g, ' ');
}

export function sameValue(field: FieldName, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if ((AMOUNT_FIELDS as readonly string[]).includes(field)) return new Decimal(a).minus(new Decimal(b)).abs().lte(0.005);
  if (field === 'invoice_number') return normaliseInvoiceNumber(a) === normaliseInvoiceNumber(b);
  if (field === 'supplier_name' || field === 'customer_name') return companySimilarity(a, b) >= 0.92;
  return a.toLowerCase() === b.toLowerCase();
}

/** Turn one LLM field into a FieldValue, rejecting values that cannot be traced to the source. */
export function llmFieldValue(
  field: FieldName,
  f: LlmField,
  ctx: GroundingContext,
  issues: ExtractionIssue[],
  visionAssisted: boolean,
): FieldValue {
  const value = normaliseLlmValue(field, f.value);
  if (value === null) return emptyField();
  const g = groundValue(field, value, ctx);
  let confidence = SELF_CONFIDENCE[f.confidence] * (g.grounded ? g.score : 1);
  if (!g.grounded) {
    if (!visionAssisted) {
      issues.push({
        code: 'UNGROUNDED_VALUE',
        severity: 'warning',
        field,
        message: `AI proposed "${value}" for ${field.replace('_', ' ')}, but it does not appear in the document text; value discarded.`,
        details: { proposed: value, evidence: f.evidence, reason: g.reason },
      });
      return emptyField();
    }
    // Read from the page image (OCR too poor to verify): keep, but force human review.
    confidence = Math.min(confidence, 0.55);
    issues.push({
      code: 'VISION_ONLY_VALUE',
      severity: 'warning',
      field,
      message: `${field.replace('_', ' ')} "${value}" was read from the page image and could not be verified against OCR text.`,
      details: { proposed: value, evidence: f.evidence },
    });
  }
  return {
    value,
    raw: f.value,
    confidence: Math.round(confidence * 1000) / 1000,
    source: 'llm',
    evidence: f.evidence ? { text: f.evidence.slice(0, 240) } : null,
  };
}

function llmItems(items: LlmInvoice['line_items']): LineItem[] {
  return items
    .map((i) => {
      const amount = i.amount ? parseAmount(i.amount) : null;
      const qty = i.quantity ? parseAmount(i.quantity) : null;
      const price = i.unit_price ? parseAmount(i.unit_price) : null;
      const consistent = amount && qty && price ? qty.times(price).minus(amount).abs().lte(0.02) : null;
      return {
        description: i.description?.trim() || null,
        quantity: qty ? qty.toString() : null,
        unit_price: price ? formatAmount(price) : null,
        amount: amount ? formatAmount(amount) : null,
        confidence: consistent === false ? 0.6 : 0.82,
        source: 'llm' as const,
        evidence: i.evidence?.slice(0, 200) ?? null,
      };
    })
    .filter((i) => i.amount || i.description);
}

function consistentTotals(fields: Record<FieldName, FieldValue>): boolean | null {
  const v = (f: FieldName) => (fields[f].value ? new Decimal(fields[f].value!) : null);
  const total = v('total');
  const subtotal = v('subtotal');
  if (!total || !subtotal) return null;
  const computed = subtotal.minus(v('discount') ?? 0).plus(v('shipping') ?? 0).plus(v('tax') ?? 0);
  return computed.minus(total).abs().lte(0.05);
}

/**
 * Combine the deterministic draft with the LLM draft, field by field:
 * agreement raises confidence; disagreement keeps the better-supported value, records the
 * alternative and raises EXTRACTION_CONFLICT so a reviewer looks at it.
 */
export function mergeDrafts(rules: InvoiceDraft, llm: LlmInvoice, ctx: GroundingContext, usage: LlmUsage): InvoiceDraft {
  const issues: ExtractionIssue[] = [...rules.issues];
  const visionAssisted = usage.used_vision;
  const fields = { ...rules.fields };

  for (const field of FIELD_NAMES) {
    const r = rules.fields[field];
    const l = llmFieldValue(field, llm[field], ctx, issues, visionAssisted);
    if (!l.value) continue;
    if (!r.value) {
      fields[field] = l;
      continue;
    }
    if (sameValue(field, r.value, l.value)) {
      // Prefer the verbatim rules value, but take the LLM's when the rules one is a fragment.
      const longer = (field === 'supplier_name' || field === 'customer_name') && l.value.length > r.value.length + 3 && similarity(r.value, l.value) < 1;
      fields[field] = {
        ...(longer ? l : r),
        confidence: Math.min(0.99, Math.max(r.confidence, l.confidence) + 0.08),
        source: 'rules+llm',
        evidence: r.evidence ?? l.evidence,
      };
      continue;
    }
    // Disagreement.
    const rulesWins = r.confidence >= 0.9 && l.confidence < 0.88;
    const winner = rulesWins ? r : l;
    const loser = rulesWins ? l : r;
    fields[field] = {
      ...winner,
      confidence: Math.min(winner.confidence, 0.62),
      alternatives: [{ value: loser.value!, source: loser.source, confidence: loser.confidence }],
    };
    issues.push({
      code: 'EXTRACTION_CONFLICT',
      severity: 'warning',
      field,
      message: `Rules read "${r.value}" but the AI read "${l.value}" for ${field.replace('_', ' ')}; kept "${winner.value}".`,
      details: { rules: r.value, llm: l.value },
    });
  }

  // If merging broke arithmetic that one side had right, fall back to that side's amounts.
  if (consistentTotals(fields) === false) {
    for (const candidate of [rules.fields, Object.fromEntries(FIELD_NAMES.map((f) => [f, llmFieldValue(f, llm[f], ctx, [], visionAssisted)])) as Record<FieldName, FieldValue>]) {
      if (consistentTotals(candidate) === true) {
        for (const f of AMOUNT_FIELDS) fields[f] = candidate[f];
        break;
      }
    }
  }

  // Line items: the set whose sum matches the subtotal wins; prefer verbatim rules rows on ties.
  const fromLlm = llmItems(llm.line_items);
  const target = fields.subtotal.value ? new Decimal(fields.subtotal.value) : fields.total.value && !fields.tax.value ? new Decimal(fields.total.value) : null;
  const ok = (items: LineItem[]) => {
    const s = sumItems(items);
    return !!(s && target && s.minus(target).abs().lte(0.05));
  };
  let lineItems = rules.line_items;
  if (ok(fromLlm) && !ok(rules.line_items)) lineItems = fromLlm;
  else if (!ok(rules.line_items) && !ok(fromLlm) && fromLlm.length > rules.line_items.length) lineItems = fromLlm;

  return {
    ...rules,
    fields,
    line_items: lineItems,
    method: 'hybrid',
    llm: usage,
    notes: [...rules.notes, ...llm.notes.map((n) => `AI: ${n}`)],
    issues,
    is_invoice: rules.is_invoice || llm.is_invoice,
    document_type: llm.document_type !== 'other' ? llm.document_type : rules.document_type,
  };
}
