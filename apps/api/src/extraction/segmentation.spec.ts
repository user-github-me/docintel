import { page } from '../../test/helpers/pages';
import { segmentPages } from './segmentation';

const inv = (no: string, extra = '') => `ACME LTD\nINVOICE\nInvoice No: ${no}\nDate: 01/02/2026\n${extra}`;

describe('segmentPages', () => {
  it('splits a batch on invoice-number changes and "Page 1 of N" markers', () => {
    const pages = [
      page(inv('A-1', 'Page 1 of 2'), 1),
      page('Description  Amount\nItem  10.00\nTotal  10.00\nPage 2 of 2', 2),
      page(inv('A-2', 'Total 5.00\nPage 1 of 1'), 3),
      page(inv('A-3', 'Total 7.00'), 4),
      page(inv('A-3', 'continued\nTotal 7.00'), 5),
    ];
    const segs = segmentPages(pages);
    expect(segs.map((s) => [s.page_start, s.page_end])).toEqual([[1, 2], [3, 3], [4, 5]]);
  });

  it('closes an invoice after "Page N of N" even without a new invoice number', () => {
    const segs = segmentPages([page('INVOICE\nTotal 9.00\nPage 1 of 1', 1), page('RECEIPT\nTotal 3.00', 2)]);
    expect(segs).toHaveLength(2);
  });

  it('keeps unlabelled continuation pages with the current invoice', () => {
    const segs = segmentPages([page(inv('B-9'), 1), page('more items\n  x  1.00', 2), page('Subtotal 1.00\nTotal 1.00', 3)]);
    expect(segs).toHaveLength(1);
    expect(segs[0].page_end).toBe(3);
  });
});
