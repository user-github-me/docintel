import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService, Queryable } from '../database/database.service';
import { InvoiceDraft } from '../extraction/types';
import { ValidationIssue, validateDraft } from './rules';

export interface DuplicateProbe {
  id: string;
  invoice_number_norm: string | null;
  supplier_norm: string | null;
  total: string | null;
  invoice_date: string | null;
}

@Injectable()
export class ValidationService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly db: DatabaseService) {}

  validate(draft: InvoiceDraft): ValidationIssue[] {
    return validateDraft(draft, { tolerance: this.config.VALIDATION_TOLERANCE, reviewConfidence: this.config.REVIEW_CONFIDENCE, today: new Date() });
  }

  /**
   * Duplicates among invoices to be booked (documents with purpose "invoices"; reference
   * documents used for cross-verification are excluded). Exact = same normalised invoice number
   * and same/similar supplier. Possible = same supplier, date and total under a different number.
   */
  async duplicates(inv: DuplicateProbe, client: Queryable): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (inv.invoice_number_norm) {
      const rows = await this.db.query<{ id: string; document_id: string; invoice_number: string; supplier_name: string | null; original_filename: string }>(
        `SELECT i.id, i.document_id, i.invoice_number, i.supplier_name, d.original_filename
           FROM invoices i JOIN documents d ON d.id = i.document_id
          WHERE i.id <> $1 AND d.purpose = 'invoices' AND i.invoice_number_norm = $2
            AND ($3::text IS NULL OR i.supplier_norm IS NULL OR i.supplier_norm = $3 OR similarity(i.supplier_norm, $3) >= 0.55)
          ORDER BY i.created_at ASC LIMIT 5`,
        [inv.id, inv.invoice_number_norm, inv.supplier_norm],
        client,
      );
      if (rows.length) {
        issues.push({
          code: 'DUPLICATE_INVOICE',
          severity: 'error',
          field: 'invoice_number',
          message: `Duplicate: invoice ${rows[0].invoice_number} from ${rows[0].supplier_name ?? 'the same supplier'} was already processed (${rows[0].original_filename}).`,
          details: { duplicates: rows.map((r) => ({ invoice_id: r.id, document_id: r.document_id, file: r.original_filename })) },
        });
        return issues;
      }
    }
    if (inv.supplier_norm && inv.total && inv.invoice_date) {
      const rows = await this.db.query<{ id: string; document_id: string; invoice_number: string | null; original_filename: string }>(
        `SELECT i.id, i.document_id, i.invoice_number, d.original_filename
           FROM invoices i JOIN documents d ON d.id = i.document_id
          WHERE i.id <> $1 AND d.purpose = 'invoices' AND i.supplier_norm = $2 AND i.total = $3 AND i.invoice_date = $4
            AND coalesce(i.invoice_number_norm, '') <> coalesce($5, '')
          LIMIT 5`,
        [inv.id, inv.supplier_norm, inv.total, inv.invoice_date, inv.invoice_number_norm],
        client,
      );
      if (rows.length) {
        issues.push({
          code: 'POSSIBLE_DUPLICATE',
          severity: 'warning',
          message: `Possible duplicate: same supplier, date and total as invoice ${rows[0].invoice_number ?? '(no number)'} in ${rows[0].original_filename}.`,
          details: { candidates: rows.map((r) => ({ invoice_id: r.id, document_id: r.document_id, file: r.original_filename })) },
        });
      }
    }
    return issues;
  }
}
