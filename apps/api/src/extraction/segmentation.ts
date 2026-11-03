import { PageText, Segment } from './types';
import { quickInvoiceNumber } from './rules/fields';
import { toDocLines } from './rules/lines';
import { normaliseInvoiceNumber } from '../common/text';
import { TOTAL_STRONG } from './rules/labels';

interface PageSignals {
  page: PageText;
  pageOf: { x: number; y: number } | null;
  invoiceNo: string | null;
  header: boolean;
  totals: boolean;
  continued: boolean;
}

const PAGE_OF = /\bpage\s*(\d{1,4})\s*(?:of|\/)\s*(\d{1,4})\b/i;

function signals(page: PageText): PageSignals {
  const lines = toDocLines({ pages: [page] });
  const head = lines.slice(0, 18).map((l) => l.text).join('\n');
  const m = PAGE_OF.exec(page.text);
  return {
    page,
    pageOf: m ? { x: Number(m[1]), y: Number(m[2]) } : null,
    invoiceNo: normaliseInvoiceNumber(quickInvoiceNumber(lines)),
    header: /\b(?:tax\s+)?invoice\b|\bbill\b|\breceipt\b|\bmushak\b/i.test(head) && !/\bcontinued\b|\(cont/i.test(head),
    totals: TOTAL_STRONG.test(page.text) || /^\s*total\b/im.test(page.text),
    continued: /\bcontinued\b|\bcont'?d\b|\bcarried\s+forward\b/i.test(head),
  };
}

/**
 * Split a multi-page document (e.g. a 1,000-page scanned batch) into invoices.
 * Signals, strongest first: "Page 1 of N" markers, a change of invoice number, an invoice header
 * after a page that closed with totals. Pages without signals stay with the current invoice.
 */
export function segmentPages(pages: PageText[], maxPagesPerInvoice = 60): Segment[] {
  const usable = pages.filter((p) => p.kind !== 'sheet');
  const segments: Segment[] = [];
  let current: { pages: PageText[]; invoiceNo: string | null; closed: boolean; complete: boolean; reason: string } | null = null;

  const flush = () => {
    if (!current || !current.pages.length) return;
    segments.push({
      pages: current.pages,
      page_start: current.pages[0].page_number,
      page_end: current.pages[current.pages.length - 1].page_number,
      reason: current.reason,
    });
  };

  for (const page of usable) {
    const s = signals(page);
    let start = false;
    let reason = '';
    if (!current) {
      start = true;
      reason = 'first page';
    } else if (s.pageOf && s.pageOf.x === 1) {
      start = true;
      reason = `"Page 1 of ${s.pageOf.y}" marker`;
    } else if (s.pageOf && s.pageOf.x > 1) {
      start = false;
    } else if (current.complete) {
      start = true; // previous page said "Page N of N": that invoice is finished
      reason = 'previous invoice ended ("Page N of N")';
    } else if (s.invoiceNo && current.invoiceNo && s.invoiceNo !== current.invoiceNo) {
      start = !s.continued;
      reason = 'new invoice number';
    } else if (!s.invoiceNo && s.header && current.closed && !s.continued) {
      start = true;
      reason = 'invoice header after totals';
    } else if (current.pages.length >= maxPagesPerInvoice) {
      start = true;
      reason = 'page limit per invoice reached';
    }
    if (start) {
      flush();
      current = { pages: [page], invoiceNo: s.invoiceNo, closed: s.totals, complete: !!s.pageOf && s.pageOf.x === s.pageOf.y, reason };
    } else if (current) {
      current.pages.push(page);
      current.invoiceNo = current.invoiceNo ?? s.invoiceNo;
      current.closed = s.totals;
      current.complete = !!s.pageOf && s.pageOf.x === s.pageOf.y;
    }
  }
  flush();
  return segments;
}
