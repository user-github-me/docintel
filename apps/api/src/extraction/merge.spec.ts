import { page } from '../../test/helpers/pages';
import { buildGroundingContext, groundValue } from './grounding';
import { LlmInvoice } from './llm/schema';
import { mergeDrafts } from './merge';
import { extractWithRules } from './rules/rule-extractor';
import { LlmUsage } from './types';

const TEXT = `Orchard Care PLC
Invoice No: OC-1001
Date: 05/02/2026
Bill To: Beta Clinic Ltd
 Description        Qty   Unit Price   Amount
 Nursing visit        2       50.00    100.00
                         Subtotal      100.00
                         VAT 20%        20.00
                         Total (GBP)   120.00`;

const f = (value: string | null, evidence: string | null = value, confidence: 'high' | 'medium' | 'low' = 'high') => ({ value, evidence, confidence });
const usage: LlmUsage = { provider: 'test', model: 'm', input_tokens: 1, output_tokens: 1, latency_ms: 1, used_vision: false };

function llm(overrides: Partial<LlmInvoice> = {}): LlmInvoice {
  return {
    is_invoice: true, document_type: 'invoice',
    invoice_number: f('OC-1001'), invoice_date: f('2026-02-05', 'Date: 05/02/2026'), due_date: f(null), supplier_name: f('Orchard Care PLC'),
    customer_name: f('Beta Clinic Ltd'), currency: f('GBP', 'Total (GBP)'), subtotal: f('100.00'), tax: f('20.00'), discount: f(null),
    shipping: f(null), total: f('120.00'), line_items: [{ description: 'Nursing visit', quantity: '2', unit_price: '50.00', amount: '100.00', evidence: null }],
    notes: [], ...overrides,
  };
}

describe('grounding', () => {
  const ctx = buildGroundingContext([page(TEXT)]);
  it('accepts values present in the document (numerically / fuzzily)', () => {
    expect(groundValue('total', '120.00', ctx).grounded).toBe(true);
    expect(groundValue('invoice_date', '2026-02-05', ctx).grounded).toBe(true);
    expect(groundValue('supplier_name', 'Orchard Care PLC', ctx).score).toBe(1);
    expect(groundValue('supplier_name', 'Orchard Care PIC', ctx).grounded).toBe(true); // OCR-style typo
  });
  it('rejects values that do not appear anywhere', () => {
    expect(groundValue('total', '999.99', ctx).grounded).toBe(false);
    expect(groundValue('invoice_date', '2025-01-01', ctx).grounded).toBe(false);
    expect(groundValue('customer_name', 'Totally Made Up Inc', ctx).grounded).toBe(false);
    expect(groundValue('currency', 'USD', ctx).grounded).toBe(false);
  });
});

describe('mergeDrafts', () => {
  const pages = [page(TEXT)];
  const rules = () => extractWithRules({ pages });

  it('boosts confidence when rules and AI agree', () => {
    const merged = mergeDrafts(rules(), llm(), buildGroundingContext(pages), usage);
    expect(merged.method).toBe('hybrid');
    expect(merged.fields.total).toMatchObject({ value: '120.00', source: 'rules+llm' });
    expect(merged.fields.total.confidence).toBeGreaterThan(0.95);
    expect(merged.issues).toHaveLength(0);
  });

  it('discards hallucinated AI values and records why', () => {
    const r = rules();
    r.fields.due_date = { value: null, confidence: 0, source: 'none' };
    const merged = mergeDrafts(r, llm({ due_date: f('2026-03-07', 'Due: 07/03/2026') }), buildGroundingContext(pages), usage);
    expect(merged.fields.due_date.value).toBeNull();
    expect(merged.issues.map((i) => i.code)).toContain('UNGROUNDED_VALUE');
  });

  it('fills fields the rules missed when the AI value is grounded', () => {
    const r = rules();
    r.fields.customer_name = { value: null, confidence: 0, source: 'none' };
    const merged = mergeDrafts(r, llm(), buildGroundingContext(pages), usage);
    expect(merged.fields.customer_name).toMatchObject({ value: 'Beta Clinic Ltd', source: 'llm' });
  });

  it('flags disagreements for review and keeps the alternative', () => {
    const r = rules();
    r.fields.invoice_number.confidence = 0.7;
    const merged = mergeDrafts(r, llm({ invoice_number: f('OC 1001 X', 'Invoice No: OC-1001') }), buildGroundingContext([page(TEXT + '\nRef OC 1001 X')]), usage);
    expect(merged.issues.map((i) => i.code)).toContain('EXTRACTION_CONFLICT');
    expect(merged.fields.invoice_number.alternatives?.length).toBe(1);
    expect(merged.fields.invoice_number.confidence).toBeLessThanOrEqual(0.62);
  });

  it('keeps vision-only values but caps their confidence (forces review)', () => {
    const r = rules();
    r.fields.due_date = { value: null, confidence: 0, source: 'none' };
    const merged = mergeDrafts(r, llm({ due_date: f('2026-03-07') }), buildGroundingContext(pages), { ...usage, used_vision: true });
    expect(merged.fields.due_date.value).toBe('2026-03-07');
    expect(merged.fields.due_date.confidence).toBeLessThanOrEqual(0.55);
    expect(merged.issues.map((i) => i.code)).toContain('VISION_ONLY_VALUE');
  });
});
