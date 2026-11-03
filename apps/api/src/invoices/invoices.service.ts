import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PoolClient } from 'pg';
import { normaliseCompany, normaliseInvoiceNumber } from '../common/text';
import { DatabaseService } from '../database/database.service';
import { DocumentsRepository } from '../documents/documents.repository';
import { EventsService } from '../events/events.service';
import { formatAmount, parseAmount } from '../extraction/normalize/amount';
import { normaliseCurrency } from '../extraction/normalize/currency';
import { AMOUNT_FIELDS, FIELD_NAMES, FieldName, FieldValue, InvoiceDraft, InvoiceFields, LineItem } from '../extraction/types';
import { IndexingService } from '../pipeline/indexing.service';
import { reviewDecision, ValidationIssue } from '../validation/rules';
import { ValidationService } from '../validation/validation.service';
import { invoiceSearchText } from './invoice-text';
import { CorrectInvoiceBody, LineItemInput, ListInvoicesQuery } from './invoices.dto';

/** Issues created during extraction; they are kept on re-validation unless their field was corrected. */
const EXTRACTION_CODES = new Set(['UNGROUNDED_VALUE', 'EXTRACTION_CONFLICT', 'VISION_ONLY_VALUE', 'AI_EXTRACTION_FAILED']);

const SORT_COLUMNS: Record<string, string> = { created_at: 'i.created_at', invoice_date: 'i.invoice_date', total: 'i.total', confidence: 'i.confidence' };

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentsRepository,
    private readonly validation: ValidationService,
    private readonly indexing: IndexingService,
    private readonly events: EventsService,
  ) {}

  /** Shared WHERE builder for list + search (structured filters). */
  static filters(q: Partial<ListInvoicesQuery>, params: unknown[]): string[] {
    const where: string[] = [];
    if (q.status) where.push(`i.status = $${params.push(q.status)}`);
    if (q.supplier) where.push(`(i.supplier_name ILIKE $${params.push(`%${q.supplier}%`)} OR similarity(i.supplier_norm, $${params.push(normaliseCompany(q.supplier) ?? q.supplier)}) > 0.45)`);
    if (q.customer) where.push(`i.customer_name ILIKE $${params.push(`%${q.customer}%`)}`);
    if (q.currency) where.push(`i.currency = $${params.push(q.currency)}`);
    if (q.dateFrom) where.push(`i.invoice_date >= $${params.push(q.dateFrom)}`);
    if (q.dateTo) where.push(`i.invoice_date <= $${params.push(q.dateTo)}`);
    if (q.minTotal) where.push(`i.total >= $${params.push(q.minTotal)}`);
    if (q.maxTotal) where.push(`i.total <= $${params.push(q.maxTotal)}`);
    if (q.documentId) where.push(`i.document_id = $${params.push(q.documentId)}`);
    if (q.issue) where.push(`EXISTS (SELECT 1 FROM validation_issues v WHERE v.invoice_id = i.id AND v.code = $${params.push(q.issue)})`);
    return where;
  }

  async list(q: ListInvoicesQuery) {
    const params: unknown[] = [];
    const where = InvoicesService.filters(q, params);
    if (q.q) {
      const p = params.push(q.q);
      const n = params.push(`%${normaliseInvoiceNumber(q.q) ?? q.q}%`);
      where.push(`(i.tsv @@ websearch_to_tsquery('simple', $${p}) OR i.invoice_number_norm ILIKE $${n})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM invoices i ${clause}`, params);
    const rows = await this.db.query(
      `SELECT i.id, i.document_id, d.original_filename AS filename, d.file_type, i.sequence, i.invoice_number, i.invoice_date, i.due_date,
              i.supplier_name, i.customer_name, i.currency, i.subtotal, i.tax, i.total, i.status, i.confidence, i.extraction_method,
              i.is_corrected, i.page_start, i.page_end, i.sheet_name, i.created_at,
              (SELECT count(*) FROM validation_issues v WHERE v.invoice_id = i.id AND v.severity = 'error')::int AS errors,
              (SELECT count(*) FROM validation_issues v WHERE v.invoice_id = i.id AND v.severity = 'warning')::int AS warnings
         FROM invoices i JOIN documents d ON d.id = i.document_id ${clause}
        ORDER BY ${SORT_COLUMNS[q.sort] ?? 'i.created_at'} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, i.document_id, i.sequence
        LIMIT $${params.push(q.pageSize)} OFFSET $${params.push((q.page - 1) * q.pageSize)}`,
      params,
    );
    return { items: rows, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, client?: PoolClient) {
    const inv = await this.db.one<Record<string, any>>(
      `SELECT i.*, d.original_filename AS filename, d.file_type, d.page_count FROM invoices i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
      [id],
      client,
    );
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
    return inv;
  }

  async detail(id: string) {
    const inv = await this.get(id);
    const [items, issues, corrections] = await Promise.all([
      this.db.query(`SELECT position, description, quantity, unit_price, amount, confidence, source, page, evidence FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`, [id]),
      this.db.query(`SELECT id, code, severity, field, message, details, created_at FROM validation_issues WHERE invoice_id = $1 ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id`, [id]),
      this.db.query(`SELECT field, old_value, new_value, reason, actor, created_at FROM corrections WHERE invoice_id = $1 ORDER BY id DESC`, [id]),
    ]);
    const { tsv, embedding, search_text, ...rest } = inv;
    void tsv; void embedding; void search_text;
    return {
      ...rest,
      document: { id: inv.document_id, filename: inv.filename, fileType: inv.file_type, pageCount: inv.page_count },
      lineItems: items,
      issues,
      corrections,
      semanticIndexed: inv.embedding !== null,
    };
  }

  private normaliseCorrection(field: string, value: string | null): string | null {
    if (!(FIELD_NAMES as readonly string[]).includes(field)) throw new BadRequestException(`Unknown field "${field}"`);
    if (value === null || value === '') return null;
    const v = String(value).trim();
    if ((AMOUNT_FIELDS as readonly string[]).includes(field)) {
      const d = parseAmount(v);
      if (!d) throw new BadRequestException(`${field}: "${v}" is not a valid amount`);
      return formatAmount(d);
    }
    if (field === 'invoice_date' || field === 'due_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new BadRequestException(`${field}: use YYYY-MM-DD`);
      return v;
    }
    if (field === 'currency') {
      const c = normaliseCurrency(v);
      if (!c) throw new BadRequestException(`currency: "${v}" is not an ISO-4217 code`);
      return c;
    }
    if (v.length > 300) throw new BadRequestException(`${field} is too long`);
    return v;
  }

  private normaliseItems(items: LineItemInput[]): LineItem[] {
    return items.map((li, idx) => {
      const num = (s: string | null | undefined, name: string) => {
        if (s === null || s === undefined || s === '') return null;
        const d = parseAmount(String(s));
        if (!d) throw new BadRequestException(`line ${idx + 1} ${name}: "${s}" is not a number`);
        return d;
      };
      const qty = num(li.quantity, 'quantity');
      const price = num(li.unit_price, 'unit_price');
      const amount = num(li.amount, 'amount');
      return { description: li.description?.trim() || null, quantity: qty ? qty.toString() : null, unit_price: formatAmount(price), amount: formatAmount(amount), confidence: 1, source: 'manual', page: null, evidence: null };
    });
  }

  /** Apply manual corrections with an audit trail, then re-run validation. */
  async correct(id: string, body: CorrectInvoiceBody, actor: string) {
    const changes = Object.entries(body.fields ?? {});
    if (!changes.length && !body.lineItems) throw new BadRequestException('Nothing to change: provide "fields" and/or "lineItems"');
    const normalised = changes.map(([field, value]) => [field, this.normaliseCorrection(field, value)] as const);
    const newItems = body.lineItems ? this.normaliseItems(body.lineItems) : null;

    const result = await this.db.transaction(async (client) => {
      const inv = await this.db.one<Record<string, any>>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id], client);
      if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
      if (inv.version !== body.version) throw new ConflictException(`Invoice was modified by someone else (version ${inv.version}, you sent ${body.version}); reload and retry.`);
      const fields: InvoiceFields = inv.fields;
      const corrected: string[] = [];
      for (const [field, value] of normalised) {
        const old = fields[field as FieldName]?.value ?? null;
        if (old === value) continue;
        corrected.push(field);
        fields[field as FieldName] = {
          value,
          confidence: 1,
          source: 'manual',
          evidence: { text: `Corrected by ${actor}${body.reason ? `: ${body.reason}` : ''}` },
          raw: value,
          alternatives: old ? [{ value: old, source: fields[field as FieldName]?.source ?? 'none', confidence: fields[field as FieldName]?.confidence ?? 0 }] : [],
        } as FieldValue;
        await client.query(`INSERT INTO corrections (invoice_id, document_id, field, old_value, new_value, reason, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, inv.document_id, field, JSON.stringify(old), JSON.stringify(value), body.reason ?? null, actor]);
      }
      if (newItems) {
        const oldItems = await this.db.query('SELECT description, quantity, unit_price, amount FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position', [id], client);
        await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [id]);
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, position, description, quantity, unit_price, amount, confidence, source)
           SELECT $1, li.position, li.description, li.quantity, li.unit_price, li.amount, 1, 'manual'
             FROM jsonb_to_recordset($2::jsonb) AS li(position int, description text, quantity numeric, unit_price numeric, amount numeric)`,
          [id, JSON.stringify(newItems.map((li, i) => ({ ...li, position: i + 1 })))],
        );
        await client.query(`INSERT INTO corrections (invoice_id, document_id, field, old_value, new_value, reason, actor) VALUES ($1,$2,'line_items',$3,$4,$5,$6)`, [id, inv.document_id, JSON.stringify(oldItems), JSON.stringify(newItems), body.reason ?? null, actor]);
        corrected.push('line_items');
      }
      if (!corrected.length) return { changed: false };
      const v = (f: FieldName) => fields[f]?.value ?? null;
      await client.query(
        `UPDATE invoices SET fields = $2, invoice_number = $3, invoice_number_norm = $4, invoice_date = $5, due_date = $6, supplier_name = $7, supplier_norm = $8,
                customer_name = $9, currency = $10, subtotal = $11, tax = $12, discount = $13, shipping = $14, total = $15,
                is_corrected = true, version = version + 1 WHERE id = $1`,
        [id, JSON.stringify(fields), v('invoice_number'), normaliseInvoiceNumber(v('invoice_number')), v('invoice_date'), v('due_date'), v('supplier_name'), normaliseCompany(v('supplier_name')), v('customer_name'), v('currency'), v('subtotal'), v('tax'), v('discount'), v('shipping'), v('total')],
      );
      await this.revalidateInTx(client, id, new Set(corrected));
      await this.documents.addEvent({ documentId: inv.document_id, invoiceId: id, stage: 'correction', status: 'info', actor, message: `Corrected ${corrected.join(', ')}${body.reason ? ` (${body.reason})` : ''}` }, client);
      return { changed: true, documentId: inv.document_id as string };
    });
    if (result.changed && result.documentId) {
      await this.refreshDocumentReviewFlag(result.documentId);
      void this.indexing.indexInvoices(result.documentId, [id]).catch((e) => this.logger.warn(`re-embed failed: ${e.message}`));
      await this.events.publish({ type: 'invoice.updated', invoiceId: id, documentId: result.documentId });
    }
    return this.detail(id);
  }

  /** Rebuild the invoice as a draft from stored values and run all validation rules again. */
  private async revalidateInTx(client: PoolClient, id: string, correctedFields: Set<string>): Promise<ValidationIssue[]> {
    const inv = await this.db.one<Record<string, any>>('SELECT i.*, d.purpose, d.original_filename FROM invoices i JOIN documents d ON d.id = i.document_id WHERE i.id = $1', [id], client);
    if (!inv) throw new NotFoundException();
    const items = await this.db.query<LineItem>('SELECT description, quantity::text, unit_price::text, amount::text, confidence, source FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position', [id], client);
    const previous = await this.db.query<ValidationIssue>('SELECT code, severity, field, message, details FROM validation_issues WHERE invoice_id = $1', [id], client);
    const keep = previous.filter((p) => EXTRACTION_CODES.has(p.code) && !(p.field && correctedFields.has(p.field)) && !(correctedFields.size && p.code === 'AI_EXTRACTION_FAILED' && correctedFields.has('line_items')));
    const fields: InvoiceFields = inv.fields;
    const draft: InvoiceDraft = {
      fields,
      line_items: items.map((li) => ({ ...li, amount: li.amount ? new Decimal(li.amount).toFixed(2) : null })),
      location: {},
      method: inv.extraction_method,
      llm: null,
      notes: [],
      issues: keep.map((k) => ({ code: k.code, severity: k.severity, field: (k.field as FieldName) ?? null, message: k.message, details: k.details })),
      is_invoice: true,
      document_type: inv.document_type,
      ocr_confidence: null,
    };
    const issues = this.validation.validate(draft);
    if (inv.purpose === 'invoices') {
      issues.push(...(await this.validation.duplicates({ id, invoice_number_norm: inv.invoice_number_norm, supplier_norm: inv.supplier_norm, total: inv.total, invoice_date: inv.invoice_date }, client)));
    }
    await client.query('DELETE FROM validation_issues WHERE invoice_id = $1', [id]);
    if (issues.length) {
      await client.query(
        `INSERT INTO validation_issues (document_id, invoice_id, code, severity, field, message, details)
         SELECT $1, $2, x.code, x.severity, x.field, x.message, coalesce(x.details, '{}'::jsonb) FROM jsonb_to_recordset($3::jsonb) AS x(code text, severity text, field text, message text, details jsonb)`,
        [inv.document_id, id, JSON.stringify(issues)],
      );
    }
    const decision = reviewDecision(issues);
    const nextStatus = inv.status === 'approved' || inv.status === 'rejected' ? inv.status : decision.status;
    const search = invoiceSearchText({ ...draft, line_items: draft.line_items }, inv.original_filename);
    await client.query('UPDATE invoices SET status = $2, review_reasons = $3, search_text = $4 WHERE id = $1', [id, nextStatus, JSON.stringify(decision.reasons), search]);
    return issues;
  }

  async revalidate(id: string, actor: string) {
    const docId = await this.db.transaction(async (client) => {
      const inv = await this.get(id, client);
      await this.revalidateInTx(client, id, new Set());
      await this.documents.addEvent({ documentId: inv.document_id, invoiceId: id, stage: 'revalidate', status: 'info', actor, message: 'Validation re-run' }, client);
      return inv.document_id as string;
    });
    await this.refreshDocumentReviewFlag(docId);
    return this.detail(id);
  }

  async approve(id: string, actor: string, note?: string, override = false) {
    const inv = await this.get(id);
    const errors = await this.db.query<{ message: string }>(`SELECT message FROM validation_issues WHERE invoice_id = $1 AND severity = 'error'`, [id]);
    if (errors.length && !override) {
      throw new UnprocessableEntityException({ message: 'Invoice has blocking validation errors; correct them or approve with override=true and a note.', errors: errors.map((e) => e.message) });
    }
    if (override && errors.length && !note) throw new BadRequestException('A note is required when overriding validation errors.');
    await this.db.query(`UPDATE invoices SET status = 'approved', approved_by = $2, approved_at = now(), version = version + 1 WHERE id = $1`, [id, actor]);
    await this.documents.addEvent({ documentId: inv.document_id, invoiceId: id, stage: 'approval', status: 'info', actor, message: `Approved${override && errors.length ? ' with override' : ''}${note ? `: ${note}` : ''}` });
    await this.refreshDocumentReviewFlag(inv.document_id);
    await this.events.publish({ type: 'invoice.updated', invoiceId: id, documentId: inv.document_id, status: 'approved' });
    return this.detail(id);
  }

  async reject(id: string, actor: string, reason: string) {
    const inv = await this.get(id);
    await this.db.query(`UPDATE invoices SET status = 'rejected', version = version + 1 WHERE id = $1`, [id]);
    await this.documents.addEvent({ documentId: inv.document_id, invoiceId: id, stage: 'approval', status: 'info', actor, message: `Rejected: ${reason}` });
    await this.refreshDocumentReviewFlag(inv.document_id);
    return this.detail(id);
  }

  async history(id: string) {
    const inv = await this.get(id);
    const [corrections, events] = await Promise.all([
      this.db.query('SELECT field, old_value, new_value, reason, actor, created_at FROM corrections WHERE invoice_id = $1 ORDER BY id', [id]),
      this.db.query('SELECT stage, status, message, actor, duration_ms, created_at FROM processing_events WHERE document_id = $1 AND (invoice_id = $2 OR invoice_id IS NULL) ORDER BY id', [inv.document_id, id]),
    ]);
    return { corrections, events };
  }

  async refreshDocumentReviewFlag(documentId: string): Promise<void> {
    await this.db.query(
      `UPDATE documents SET needs_review = (invoice_count = 0 OR EXISTS (SELECT 1 FROM invoices WHERE document_id = $1 AND status = 'needs_review')) WHERE id = $1 AND status = 'completed'`,
      [documentId],
    );
  }
}
