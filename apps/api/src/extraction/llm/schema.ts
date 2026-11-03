import { z } from 'zod';

/** Every extracted field carries a verbatim evidence quote so it can be verified against the source. */
const Field = z.object({
  value: z.string().nullable().describe('Normalised value, or null when the document does not state it.'),
  evidence: z.string().nullable().describe('Exact text copied from the document that supports the value (<=120 chars), or null.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const LlmInvoiceSchema = z.object({
  is_invoice: z.boolean().describe('false when the text is not an invoice, bill or receipt'),
  document_type: z.enum(['invoice', 'receipt', 'credit_note', 'other']),
  invoice_number: Field,
  invoice_date: Field,
  due_date: Field,
  supplier_name: Field,
  customer_name: Field,
  currency: Field,
  subtotal: Field,
  tax: Field,
  discount: Field,
  shipping: Field,
  total: Field,
  line_items: z.array(
    z.object({
      description: z.string().nullable(),
      quantity: z.string().nullable(),
      unit_price: z.string().nullable(),
      amount: z.string().nullable(),
      evidence: z.string().nullable(),
    }),
  ),
  notes: z.array(z.string()).describe('Short notes about missing, unreadable or ambiguous information.'),
});

export type LlmInvoice = z.infer<typeof LlmInvoiceSchema>;
export type LlmField = z.infer<typeof Field>;
