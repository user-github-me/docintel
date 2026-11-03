import { ReconInvoice, reconcile } from './matcher';

const inv = (id: string, no: string | null, total: string, extra: Partial<ReconInvoice> = {}): ReconInvoice => ({
  id, invoice_number: no, supplier_name: 'Acme Supplies Ltd', customer_name: 'Beta Corp', invoice_date: '2026-03-01', currency: 'USD',
  subtotal: null, tax: null, total, ...extra,
});
const opts = { amountTolerance: 0.05, dateToleranceDays: 3 };

describe('reconcile (cross-verification)', () => {
  it('matches by invoice number and reports field discrepancies', () => {
    const { items, summary } = reconcile(
      [inv('l1', 'INV-001', '100.00'), inv('l2', 'INV-002', '50.00')],
      [inv('r1', 'inv 001', '100.00'), inv('r2', 'INV-002', '55.00', { invoice_date: '2026-03-05' })],
      opts,
    );
    expect(summary).toMatchObject({ matched: 1, mismatched: 1, missingInLeft: 0, missingInRight: 0 });
    const mismatch = items.find((i) => i.status === 'mismatch')!;
    expect(mismatch.discrepancies).toEqual(expect.arrayContaining([
      { field: 'total', left: '50.00', right: '55.00', difference: '5.00' },
      { field: 'invoice_date', left: '2026-03-01', right: '2026-03-05' },
    ]));
  });

  it('pairs invoices without a matching number by supplier + amount + date', () => {
    const { items } = reconcile([inv('l1', 'A-17', '99.90')], [inv('r1', 'B-0017', '99.90', { supplier_name: 'ACME Supplies Limited' })], opts);
    expect(items[0]).toMatchObject({ status: 'mismatch', method: 'fuzzy' });
    expect(items[0].discrepancies.map((d) => d.field)).toEqual(['invoice_number']);
  });

  it('reports invoices missing on either side and the total difference', () => {
    const { summary } = reconcile([inv('l1', 'X-1', '10.00'), inv('l2', 'X-2', '20.00', { supplier_name: 'Other Co' })], [inv('r1', 'X-1', '10.00'), inv('r3', 'Y-9', '75.00', { supplier_name: 'Third Party', invoice_date: '2025-01-01' })], opts);
    expect(summary).toMatchObject({ matched: 1, missingInRight: 1, missingInLeft: 1, leftTotal: '30.00', rightTotal: '85.00', difference: '55.00' });
  });
});
