import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { DocumentsRepository } from '../documents/documents.repository';
import { ReconInvoice, reconcile, ReconOptions } from './matcher';

@Injectable()
export class ReconciliationService {
  constructor(private readonly db: DatabaseService, private readonly documents: DocumentsRepository) {}

  private invoicesOf(documentId: string): Promise<ReconInvoice[]> {
    return this.db.query<ReconInvoice>(
      `SELECT i.id, i.invoice_number, i.supplier_name, i.customer_name, i.invoice_date::text, i.currency, i.subtotal, i.tax, i.total,
              (SELECT count(*) FROM invoice_line_items li WHERE li.invoice_id = i.id)::int AS line_count
         FROM invoices i WHERE i.document_id = $1 AND i.status <> 'rejected' ORDER BY i.sequence`,
      [documentId],
    );
  }

  async create(leftId: string, rightId: string, options: Partial<ReconOptions>, actor: string) {
    if (leftId === rightId) throw new BadRequestException('Choose two different documents');
    for (const id of [leftId, rightId]) {
      const d = await this.documents.get(id);
      if (!d) throw new NotFoundException(`Document ${id} not found`);
      if (d.status !== 'completed') throw new BadRequestException(`Document ${d.original_filename} has not finished processing (status ${d.status})`);
    }
    const opts: ReconOptions = { amountTolerance: options.amountTolerance ?? 0.05, dateToleranceDays: options.dateToleranceDays ?? 3 };
    const [left, right] = await Promise.all([this.invoicesOf(leftId), this.invoicesOf(rightId)]);
    const result = reconcile(left, right, opts);
    const id = await this.db.transaction(async (client) => {
      const rec = await client.query<{ id: string }>(
        `INSERT INTO reconciliations (left_document_id, right_document_id, options, summary, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [leftId, rightId, JSON.stringify(opts), JSON.stringify(result.summary), actor],
      );
      const recId = rec.rows[0].id;
      if (result.items.length) {
        await client.query(
          `INSERT INTO reconciliation_items (reconciliation_id, left_invoice_id, right_invoice_id, status, match_method, match_score, discrepancies, left_summary, right_summary)
           SELECT $1, x.left_id, x.right_id, x.status, x.method, x.score, x.discrepancies, x.left_summary, x.right_summary
             FROM jsonb_to_recordset($2::jsonb) AS x(left_id uuid, right_id uuid, status text, method text, score real, discrepancies jsonb, left_summary jsonb, right_summary jsonb)`,
          [recId, JSON.stringify(result.items.map((i) => ({ left_id: i.left?.id ?? null, right_id: i.right?.id ?? null, status: i.status, method: i.method, score: i.score, discrepancies: i.discrepancies, left_summary: i.left, right_summary: i.right })))],
        );
      }
      return recId;
    });
    return this.get(id);
  }

  async get(id: string) {
    const rec = await this.db.one<Record<string, unknown>>(
      `SELECT r.*, l.original_filename AS left_filename, rt.original_filename AS right_filename
         FROM reconciliations r JOIN documents l ON l.id = r.left_document_id JOIN documents rt ON rt.id = r.right_document_id WHERE r.id = $1`,
      [id],
    );
    if (!rec) throw new NotFoundException(`Reconciliation ${id} not found`);
    const items = await this.db.query(
      `SELECT status, match_method, match_score, discrepancies, left_summary AS left, right_summary AS right FROM reconciliation_items WHERE reconciliation_id = $1
        ORDER BY CASE status WHEN 'mismatch' THEN 0 WHEN 'missing_in_right' THEN 1 WHEN 'missing_in_left' THEN 2 ELSE 3 END, id`,
      [id],
    );
    return { ...rec, items };
  }

  list() {
    return this.db.query(
      `SELECT r.id, r.summary, r.created_at, r.created_by, l.original_filename AS left_filename, rt.original_filename AS right_filename, r.left_document_id, r.right_document_id
         FROM reconciliations r JOIN documents l ON l.id = r.left_document_id JOIN documents rt ON rt.id = r.right_document_id ORDER BY r.created_at DESC LIMIT 100`,
    );
  }
}
