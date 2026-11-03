import { fixtureLabels, snapshotPages } from '../../../test/helpers/pages';
import { PageText } from '../types';
import { extractFromSheets } from './spreadsheet-extractor';

const sheet = (name: string, rows: Array<Array<string | number | null>>, n = 1): PageText => ({
  page_number: n, kind: 'sheet', text: rows.map((r) => r.join(' | ')).join('\n'), ocr_confidence: null, sheet_name: name, table_data: rows,
});

describe('spreadsheet extractor', () => {
  it('reads a register: skips title rows and the TOTAL footer, keeps rows without a number', () => {
    const { drafts } = extractFromSheets([
      sheet('AP', [
        ['Accounts Payable Register - March 2026'],
        [],
        ['Inv #', 'Inv. Date', 'Vendor Name', 'Bill To', 'CCY', 'Subtotal', 'Tax', 'Gross'],
        ['INV-1', '2026-03-01', 'Acme Ltd', 'Beta Corp', 'USD', 100, 10, 110],
        [null, '2026-03-02', 'Gamma LLC', 'Beta Corp', 'USD', 50, 5, 55],
        ['TOTAL', null, null, null, null, 150, 15, 165],
      ]),
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].fields.total.value).toBe('110.00');
    expect(drafts[0].fields.total.evidence?.cell).toBe('AP!H4');
    expect(drafts[1].fields.invoice_number.value).toBeNull(); // flagged later by validation, not invented
  });

  it('groups a line-level CSV (one row per item) into invoices with items', () => {
    const { drafts } = extractFromSheets([
      sheet('CSV', [
        ['invoice_no', 'invoice_date', 'supplier', 'customer', 'currency', 'description', 'quantity', 'unit_price', 'line_amount', 'invoice_subtotal', 'invoice_tax', 'invoice_total'],
        ['A-1', '2026-01-05', 'Acme', 'Beta', 'AUD', 'Visit', 2, '10.00', '20.00', '30.00', '3.00', '33.00'],
        ['A-1', '2026-01-05', 'Acme', 'Beta', 'AUD', 'Kit', 1, '10.00', '10.00', '30.00', '3.00', '33.00'],
        ['A-2', '2026-01-06', 'Acme', 'Delta', 'AUD', 'Visit', 1, '10.00', '10.00', '10.00', '1.00', '11.00'],
      ]),
    ]);
    expect(drafts.map((d) => [d.fields.invoice_number.value, d.line_items.length, d.fields.total.value])).toEqual([['A-1', 2, '33.00'], ['A-2', 1, '11.00']]);
  });

  it('joins a Line Items sheet to the register by invoice number', () => {
    const { drafts, notes } = extractFromSheets([
      sheet('Invoices', [['Invoice Ref', 'Date', 'Supplier', 'Total'], ['R-7', '2026-05-01', 'Acme GmbH', 99.5]], 1),
      sheet('Line Items', [['Invoice No', 'Description', 'Qty', 'Amount'], ['R-7', 'Switch', 1, 99.5]], 2),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].line_items[0]).toMatchObject({ description: 'Switch', amount: '99.50' });
    expect(notes.join(' ')).toContain('joined 1 line items');
  });

  it('parses EU-formatted string amounts and dates in CSV registers', () => {
    const { drafts } = extractFromSheets([
      sheet('CSV', [['Rechnung', 'Datum', 'Lieferant', 'Netto', 'MwSt', 'Brutto'], ['R-1', '14.03.2026', 'Café Délices SARL', '1.000,00', '190,00', '1.190,00']]),
    ]);
    // German headers are only partly known: invoice number + amounts must still be read correctly
    expect(drafts[0].fields.invoice_number.value).toBe('R-1');
    expect(drafts[0].fields.invoice_date.value).toBe('2026-03-14');
  });

  it('matches the labelled spreadsheet fixtures', () => {
    const labels = fixtureLabels();
    for (const file of ['register.xlsx', 'register.xls', 'register.csv']) {
      const gt = labels.find((l) => l.file === file).invoices;
      const { drafts } = extractFromSheets(snapshotPages(file));
      const byNo = new Map(drafts.map((d) => [d.fields.invoice_number.value, d]));
      expect(drafts).toHaveLength(gt.length);
      for (const g of gt) expect(byNo.get(g.invoice_number)?.fields.total.value).toBe(g.total);
    }
  });
});
