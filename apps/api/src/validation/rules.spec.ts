import { emptyFields, FieldName, InvoiceDraft, LineItem } from '../extraction/types';
import { reviewDecision, validateDraft } from './rules';

function draft(values: Partial<Record<FieldName, string | null>>, items: Array<Partial<LineItem>> = [], extra: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const fields = emptyFields();
  const base: Partial<Record<FieldName, string>> = {
    invoice_number: 'INV-1', invoice_date: '2026-03-01', supplier_name: 'Acme Ltd', customer_name: 'Beta Ltd', currency: 'USD',
    subtotal: '100.00', tax: '10.00', total: '110.00',
  };
  for (const [k, v] of Object.entries({ ...base, ...values })) fields[k as FieldName] = { value: v ?? null, confidence: 0.95, source: 'rules' };
  return {
    fields,
    line_items: items.map((i) => ({ description: 'x', quantity: null, unit_price: null, amount: null, confidence: 0.9, source: 'rules', ...i })),
    location: {}, method: 'rules', llm: null, notes: [], issues: [], is_invoice: true, document_type: 'invoice', ocr_confidence: null, ...extra,
  };
}
const opts = { tolerance: 0.05, reviewConfidence: 0.75, today: new Date('2026-11-03T00:00:00Z') };
const codes = (d: InvoiceDraft) => validateDraft(d, opts).map((i) => i.code);

describe('validation rules', () => {
  it('passes a consistent invoice', () => {
    const issues = validateDraft(draft({}, [{ amount: '60.00' }, { amount: '40.00' }]), opts);
    expect(issues).toEqual([]);
    expect(reviewDecision(issues).status).toBe('validated');
  });

  it('flags missing fields with severity by importance', () => {
    const issues = validateDraft(draft({ invoice_number: null, tax: null }), opts);
    expect(issues.find((i) => i.field === 'invoice_number')).toMatchObject({ code: 'MISSING_FIELD', severity: 'error' });
    expect(issues.find((i) => i.field === 'tax')).toMatchObject({ code: 'MISSING_FIELD', severity: 'warning' });
  });

  it('detects subtotal + tax != total (with discount and shipping)', () => {
    expect(codes(draft({ total: '120.00' }))).toContain('TOTAL_MISMATCH');
    expect(codes(draft({ discount: '5.00', shipping: '15.00', total: '120.00' }))).not.toContain('TOTAL_MISMATCH');
  });

  it('detects line items that do not add up to the subtotal and bad line math', () => {
    const c = codes(draft({}, [{ amount: '60.00' }, { amount: '30.00', quantity: '2', unit_price: '20.00' }]));
    expect(c).toContain('LINE_ITEMS_MISMATCH');
    expect(c).toContain('LINE_ITEM_MATH');
  });

  it('flags invalid and negative numbers, unusual tax rates and tax above total', () => {
    expect(codes(draft({ total: 'abc' }))).toContain('INVALID_AMOUNT');
    expect(codes(draft({ subtotal: '-100.00', tax: '-10.00', total: '-110.00' }))).toContain('NEGATIVE_AMOUNT');
    expect(codes(draft({ subtotal: '-100.00', tax: '-10.00', total: '-110.00' }, [], { document_type: 'credit_note' }))).not.toContain('NEGATIVE_AMOUNT');
    expect(codes(draft({ subtotal: '100.00', tax: '50.00', total: '150.00' }))).toContain('TAX_RATE_UNUSUAL');
  });

  it('checks dates: future, due before issue, ambiguous order', () => {
    expect(codes(draft({ invoice_date: '2027-06-04' }))).toContain('DATE_IN_FUTURE');
    expect(codes(draft({ due_date: '2026-02-01' }))).toContain('DUE_BEFORE_INVOICE');
    const d = draft({});
    d.fields.invoice_date.note = 'ambiguous day/month order in "03/04/2026"';
    expect(codes(d)).toContain('DATE_AMBIGUOUS');
  });

  it('routes low-confidence and poor-OCR invoices to manual review', () => {
    const d = draft({}, [], { ocr_confidence: 0.45 });
    d.fields.total.confidence = 0.5;
    const issues = validateDraft(d, opts);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['LOW_CONFIDENCE', 'LOW_OCR_QUALITY']));
    expect(reviewDecision(issues).status).toBe('needs_review');
  });

  it('treats a missing customer on receipts as informational', () => {
    const issues = validateDraft(draft({ customer_name: null }, [], { document_type: 'receipt' }), opts);
    expect(issues.find((i) => i.field === 'customer_name')?.severity).toBe('info');
    expect(reviewDecision(issues).status).toBe('validated');
  });
});
