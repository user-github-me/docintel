import { page, snapshotPages, fixtureLabels } from '../../../test/helpers/pages';
import { segmentPages } from '../segmentation';
import { extractWithRules } from './rule-extractor';

const CLASSIC = `
            ACME HOME CARE LTD                                        TAX INVOICE
            12 High Street, Leeds LS1 4AB
            VAT Reg No: GB 123 4567 89

            Invoice No.:   INV-2026-0042                       PO Number:  PO-7788
            Invoice Date:  14/03/2026                           Due Date:   13/04/2026

            Bill To:
            Northwind Care Services Ltd
            1 Market Square, York

             Description                         Qty        Unit Price        Amount
             Home nursing visit                    2            115.00        230.00
             Physiotherapy session (60 min)        3             80.00        240.00
                                                              Subtotal        470.00
                                                              VAT (20%)        94.00
                                                              Total (GBP)     564.00
`;

describe('rule extractor', () => {
  it('reads labelled fields, the bill-to block, line items and totals', () => {
    const d = extractWithRules({ pages: [page(CLASSIC)] });
    const v = Object.fromEntries(Object.entries(d.fields).map(([k, f]) => [k, f.value]));
    expect(v).toMatchObject({
      invoice_number: 'INV-2026-0042', invoice_date: '2026-03-14', due_date: '2026-04-13', supplier_name: 'ACME HOME CARE LTD',
      customer_name: 'Northwind Care Services Ltd', currency: 'GBP', subtotal: '470.00', tax: '94.00', total: '564.00',
    });
    expect(d.line_items).toHaveLength(2);
    expect(d.line_items[1]).toMatchObject({ description: 'Physiotherapy session (60 min)', quantity: '3', unit_price: '80.00', amount: '240.00' });
    expect(d.fields.invoice_number.evidence?.text).toContain('INV-2026-0042'); // every value has evidence
    expect(d.fields.total.confidence).toBeGreaterThan(0.8); // 'Total (GBP)' is a weaker label than 'Amount Due'
  });

  it('re-joins a letterhead name that wraps onto two lines', () => {
    const text = `            Shaw & Ramos Healthcare                              INVOICE
            Supplies Pty. Ltd.
            12 George St, Sydney NSW 2000
            Invoice No.:  INV-2025-3470
            Total (AUD)   100.00`;
    const d = extractWithRules({ pages: [page(text)] });
    expect(d.fields.supplier_name.value).toBe('Shaw & Ramos Healthcare Supplies Pty. Ltd.');
  });

  it('does not invent values that are not printed', () => {
    const d = extractWithRules({ pages: [page('ACME LTD\nThank you for your business\nTotal  120.00')] });
    expect(d.fields.invoice_number.value).toBeNull();
    expect(d.fields.invoice_date.value).toBeNull();
    expect(d.fields.customer_name.value).toBeNull();
    expect(d.fields.tax.value).toBeNull();
    expect(d.fields.currency.value).toBeNull();
  });

  it('maps "Total" to subtotal when a payable total and tax follow (South-Asian bills)', () => {
    const text = `Bill No.: CTG/2025/2166                Bill Date: 04/11/2025
  SL   Description              Qty      Rate (Tk)      Amount (Tk)
   1   Toner cartridge           10       7,075.00        70,750.00
                                              Total        70,750.00
                                            VAT 15%        10,612.50
                                Total Payable (BDT)        81,362.50`;
    const d = extractWithRules({ pages: [page(text)] });
    expect([d.fields.subtotal.value, d.fields.tax.value, d.fields.total.value]).toEqual(['70750.00', '10612.50', '81362.50']);
    expect(d.fields.currency.value).toBe('BDT');
  });

  it('sums split taxes (CGST + SGST)', () => {
    const text = `Invoice No: GST/26/0091    Date: 02/05/2026
   Description          Qty    Rate      Amount
   Laptop stand           2    1,500.00   3,000.00
                         Taxable Value     3,000.00
                             CGST 9%         270.00
                             SGST 9%         270.00
                         Total Invoice     3,540.00`;
    const d = extractWithRules({ pages: [page(text)] });
    expect(d.fields.tax.value).toBe('540.00');
    expect(d.fields.total.value).toBe('3540.00');
  });

  it('reads receipt-style items and ignores cash/change lines', () => {
    const text = `   SUNRISE PHARMACY LTD
   Invoice No: R95617
   Date: 28/01/2025  15:40
   ITEM                              AMOUNT
   Digital thermometer
     2 x 21.95                        43.90
   Cotton wool 100g
     1 x 4.83                          4.83
   SUBTOTAL                           48.73
   GST 10%                             4.87
   TOTAL                          AUD 53.60
   CASH                              60.00
   CHANGE                             6.40`;
    const d = extractWithRules({ pages: [page(text)] });
    expect(d.line_items.map((i) => [i.description, i.quantity, i.amount])).toEqual([
      ['Digital thermometer', '2', '43.90'],
      ['Cotton wool 100g', '1', '4.83'],
    ]);
    expect(d.fields.total.value).toBe('53.60');
  });

  it('reads European number and date formats', () => {
    const text = `Müller Pflegedienst GmbH
Invoice No.      RE-2025-6496
Invoice Date     27.03.2025
 Pos.  Description              Qty   Unit Price      Amount
 1     Care visit                24        90,00    2.160,00
                          Total excl. VAT          2.160,00 €
                          VAT 19%                    410,40 €
                          Total incl. VAT          2.570,40 €`;
    const d = extractWithRules({ pages: [page(text)] });
    expect(d.fields.invoice_date.value).toBe('2025-03-27');
    expect([d.fields.subtotal.value, d.fields.tax.value, d.fields.total.value]).toEqual(['2160.00', '410.40', '2570.40']);
    expect(d.fields.currency.value).toBe('EUR');
    expect(d.line_items[0]).toMatchObject({ quantity: '24', unit_price: '90.00', amount: '2160.00' });
  });

  it('matches the labelled fixtures (golden test on real processor output)', () => {
    const labels = fixtureLabels();
    for (const file of ['invoice_digital.pdf', 'invoice_multi.pdf']) {
      const gt = labels.find((l) => l.file === file).invoices;
      const drafts = segmentPages(snapshotPages(file)).map((s) => extractWithRules(s));
      expect(drafts).toHaveLength(gt.length);
      drafts.forEach((d, i) => {
        expect(d.fields.invoice_number.value).toBe(gt[i].invoice_number);
        expect(d.fields.total.value).toBe(gt[i].total);
      });
    }
  });

  it('reads an OCR scan and returns null (not garbage) where OCR mangled the text', () => {
    const gt = fixtureLabels().find((l) => l.file === 'invoice_scanned.png').invoices[0];
    const d = extractWithRules({ pages: snapshotPages('invoice_scanned.png') });
    // OCR read the label as "Invorce" and the value as "S!-26-01807": the rules abstain instead of guessing
    expect([null, gt.invoice_number]).toContain(d.fields.invoice_number.value);
    expect(d.fields.customer_name.value).toBe(gt.customer_name);
    expect(d.fields.total.value).toBe(gt.total);
    expect(d.ocr_confidence).not.toBeNull();
    expect(d.fields.total.confidence).toBeLessThan(0.98); // OCR factor applied
  });
});
