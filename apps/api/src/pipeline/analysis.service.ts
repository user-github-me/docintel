import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { normaliseCompany, normaliseInvoiceNumber } from '../common/text';
import { DatabaseService } from '../database/database.service';
import { DocumentRow, DocumentsRepository } from '../documents/documents.repository';
import { EventsService } from '../events/events.service';
import { ExtractionService } from '../extraction/extraction.service';
import { overallConfidence } from '../extraction/rules/rule-extractor';
import { InvoiceDraft } from '../extraction/types';
import { invoiceSearchText } from '../invoices/invoice-text';
import { reviewDecision, ValidationIssue } from '../validation/rules';
import { ValidationService } from '../validation/validation.service';

export interface AnalysisSummary {
  invoices: number;
  needsReview: number;
  llmCalls: number;
  durationMs: number;
}

/** Extraction -> validation -> transactional persistence for one document run. */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentsRepository,
    private readonly extraction: ExtractionService,
    private readonly validation: ValidationService,
    private readonly events: EventsService,
  ) {}

  async analyze(doc: DocumentRow): Promise<AnalysisSummary> {
    const started = Date.now();
    const pages = await this.documents.loadPages(doc.id);
    const outcome = await this.extraction.extractDocument(doc, pages);
    const drafts = outcome.drafts.filter((d) => d.is_invoice || d.fields.total.value || d.fields.invoice_number.value);
    const skipped = outcome.drafts.length - drafts.length;

    let needsReview = 0;
    await this.db.transaction(async (client) => {
      // Serialise insert + duplicate check across workers so concurrent uploads of the same
      // invoice cannot both miss each other.
      await client.query('SELECT pg_advisory_xact_lock(4242)');
      await client.query('DELETE FROM invoices WHERE document_id = $1', [doc.id]);
      await client.query('DELETE FROM validation_issues WHERE document_id = $1', [doc.id]);
      let sequence = 0;
      for (const draft of drafts) {
        sequence++;
        const status = await this.persistInvoice(client, doc, draft, sequence);
        if (status === 'needs_review') needsReview++;
      }
      if (!drafts.length) {
        await client.query(
          `INSERT INTO validation_issues (document_id, code, severity, message, details) VALUES ($1, 'NO_INVOICE_FOUND', 'warning', $2, $3)`,
          [doc.id, 'No invoice could be identified in this document.', JSON.stringify({ notes: outcome.notes })],
        );
      }
      const pageStats = await this.documents.pageStats(doc.id);
      const finished = new Date();
      await this.documents.update(
        doc.id,
        {
          status: 'completed',
          stage: 'done',
          progress: 100,
          invoice_count: drafts.length,
          needs_review: doc.purpose === 'invoices' && (needsReview > 0 || drafts.length === 0),
          page_count: doc.page_count ?? pageStats.processed,
          pages_processed: pageStats.processed,
          ocr_pages: pageStats.ocr,
          avg_ocr_confidence: pageStats.avg_conf,
          processing_finished_at: finished,
          processing_ms: doc.processing_started_at ? finished.getTime() - new Date(doc.processing_started_at).getTime() : Date.now() - started,
          llm_calls: outcome.llm.calls,
          llm_input_tokens: outcome.llm.inputTokens,
          llm_output_tokens: outcome.llm.outputTokens,
          error_code: null,
          error_message: null,
        },
        client,
      );
      await this.documents.addEvent(
        {
          documentId: doc.id,
          runId: doc.run_id,
          stage: 'analyze',
          status: 'completed',
          durationMs: Date.now() - started,
          message: `${drafts.length} invoice(s) extracted, ${needsReview} need review${skipped ? `, ${skipped} non-invoice section(s) skipped` : ''}`,
          details: { notes: outcome.notes.slice(0, 20), llm: outcome.llm },
        },
        client,
      );
    });
    await this.events.publish({ type: 'document.updated', documentId: doc.id, status: 'completed', stage: 'done', progress: 100, needsReview: doc.purpose === 'invoices' && (needsReview > 0 || drafts.length === 0) });
    return { invoices: drafts.length, needsReview, llmCalls: outcome.llm.calls, durationMs: Date.now() - started };
  }

  private async persistInvoice(client: PoolClient, doc: DocumentRow, draft: InvoiceDraft, sequence: number): Promise<string> {
    const f = draft.fields;
    const issues: ValidationIssue[] = this.validation.validate(draft);
    const numberNorm = normaliseInvoiceNumber(f.invoice_number.value);
    const supplierNorm = normaliseCompany(f.supplier_name.value);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO invoices (document_id, sequence, page_start, page_end, sheet_name, row_start, row_end,
         invoice_number, invoice_number_norm, invoice_date, due_date, supplier_name, supplier_norm, customer_name, currency,
         subtotal, tax, discount, shipping, total, fields, extraction_method, llm_model, document_type, confidence, notes, search_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
      [
        doc.id, sequence, draft.location.page_start ?? null, draft.location.page_end ?? null, draft.location.sheet_name ?? null,
        draft.location.row_start ?? null, draft.location.row_end ?? null,
        f.invoice_number.value, numberNorm, f.invoice_date.value, f.due_date.value, f.supplier_name.value, supplierNorm,
        f.customer_name.value, f.currency.value, f.subtotal.value, f.tax.value, f.discount.value, f.shipping.value, f.total.value,
        JSON.stringify(f), draft.method, draft.llm?.model ?? null, draft.document_type ?? 'invoice', overallConfidence(draft),
        JSON.stringify(draft.notes.slice(0, 30)), invoiceSearchText(draft, doc.original_filename),
      ],
    );
    const id = inserted.rows[0].id;
    if (draft.line_items.length) {
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, position, description, quantity, unit_price, amount, confidence, source, page, evidence)
         SELECT $1, li.position, li.description, li.quantity, li.unit_price, li.amount, li.confidence, li.source, li.page, li.evidence
           FROM jsonb_to_recordset($2::jsonb) AS li(position int, description text, quantity numeric, unit_price numeric, amount numeric, confidence real, source text, page int, evidence text)`,
        [id, JSON.stringify(draft.line_items.map((li, i) => ({ ...li, position: i + 1 })))],
      );
    }
    if (doc.purpose === 'invoices') {
      issues.push(...(await this.validation.duplicates({ id, invoice_number_norm: numberNorm, supplier_norm: supplierNorm, total: f.total.value, invoice_date: f.invoice_date.value }, client)));
    }
    await this.insertIssues(client, doc.id, id, issues);
    const decision = reviewDecision(issues);
    // Reference ledgers exist only for cross-verification: issues are recorded, not queued for review.
    const status = doc.purpose === 'reference' ? 'validated' : decision.status;
    await client.query(`UPDATE invoices SET status = $2, review_reasons = $3 WHERE id = $1`, [id, status, JSON.stringify(decision.reasons)]);
    return status;
  }

  async insertIssues(client: PoolClient, documentId: string, invoiceId: string, issues: ValidationIssue[]): Promise<void> {
    if (!issues.length) return;
    await client.query(
      `INSERT INTO validation_issues (document_id, invoice_id, code, severity, field, message, details)
       SELECT $1, $2, x.code, x.severity, x.field, x.message, coalesce(x.details, '{}'::jsonb)
         FROM jsonb_to_recordset($3::jsonb) AS x(code text, severity text, field text, message text, details jsonb)`,
      [documentId, invoiceId, JSON.stringify(issues)],
    );
  }
}
