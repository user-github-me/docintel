import { InvoiceDraft } from '../extraction/types';

/** Keyword index text (FTS): identifiers, names, amounts, item descriptions. */
export function invoiceSearchText(d: InvoiceDraft, filename: string): string {
  const f = d.fields;
  const amounts = ['subtotal', 'tax', 'total'].map((k) => f[k as 'total'].value).filter(Boolean);
  return [
    f.invoice_number.value,
    f.invoice_number.value?.replace(/[^A-Za-z0-9]/g, ''),
    f.supplier_name.value,
    f.customer_name.value,
    f.invoice_date.value,
    f.currency.value,
    ...amounts,
    ...d.line_items.map((i) => i.description),
    filename,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Natural-language summary used for the semantic (embedding) index. */
export function invoiceSemanticText(r: {
  invoice_number: string | null; supplier_name: string | null; customer_name: string | null; invoice_date: string | null;
  currency: string | null; total: string | null; subtotal: string | null; tax: string | null; items: string[];
}): string {
  const parts = [
    `Invoice ${r.invoice_number ?? '(no number)'} from ${r.supplier_name ?? 'unknown supplier'} to ${r.customer_name ?? 'unknown customer'}`,
    r.invoice_date ? `dated ${r.invoice_date}` : '',
    r.total ? `total ${r.currency ?? ''} ${r.total}`.trim() : '',
    r.subtotal || r.tax ? `(subtotal ${r.subtotal ?? '-'}, tax ${r.tax ?? '-'})` : '',
  ].filter(Boolean);
  const items = r.items.filter(Boolean).slice(0, 40);
  return `${parts.join(' ')}.${items.length ? ` Items: ${items.join('; ')}.` : ''}`.slice(0, 2000);
}
