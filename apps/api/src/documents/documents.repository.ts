import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';
import { PageText } from '../extraction/types';
import { ProcessorPage, ProcessorSheet } from '../processor/processor.client';

export interface DocumentRow {
  id: string;
  original_filename: string;
  storage_key: string;
  mime_type: string | null;
  file_type: 'pdf' | 'image' | 'xlsx' | 'xls' | 'csv' | null;
  size_bytes: number;
  sha256: string;
  purpose: 'invoices' | 'reference';
  status: 'queued' | 'processing' | 'analyzing' | 'completed' | 'failed' | 'duplicate';
  stage: string | null;
  progress: number;
  needs_review: boolean;
  duplicate_of: string | null;
  page_count: number | null;
  pages_processed: number;
  ocr_pages: number;
  avg_ocr_confidence: number | null;
  invoice_count: number;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
  run_id: number;
  attempts: number;
  uploaded_by: string | null;
  processing_started_at: string | null;
  processing_finished_at: string | null;
  processing_ms: number | null;
  indexed_at: string | null;
  llm_calls: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DocumentFilters {
  status?: string;
  fileType?: string;
  needsReview?: boolean;
  q?: string;
  limit: number;
  offset: number;
}

@Injectable()
export class DocumentsRepository {
  constructor(private readonly db: DatabaseService) {}

  create(d: Pick<DocumentRow, 'original_filename' | 'storage_key' | 'mime_type' | 'size_bytes' | 'sha256' | 'purpose' | 'uploaded_by'> & { status?: string; duplicate_of?: string | null; file_type?: string | null }): Promise<DocumentRow> {
    return this.db.one<DocumentRow>(
      `INSERT INTO documents (original_filename, storage_key, mime_type, size_bytes, sha256, purpose, uploaded_by, status, duplicate_of, file_type, processing_started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $8 = 'queued' THEN now() END) RETURNING *`,
      [d.original_filename, d.storage_key, d.mime_type, d.size_bytes, d.sha256, d.purpose, d.uploaded_by, d.status ?? 'queued', d.duplicate_of ?? null, d.file_type ?? null],
    ) as Promise<DocumentRow>;
  }

  get(id: string, client?: Queryable): Promise<DocumentRow | null> {
    return this.db.one<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id], client);
  }

  findBySha(sha: string): Promise<DocumentRow | null> {
    return this.db.one<DocumentRow>(`SELECT * FROM documents WHERE sha256 = $1 AND status NOT IN ('failed', 'duplicate') ORDER BY created_at ASC LIMIT 1`, [sha]);
  }

  async list(f: DocumentFilters): Promise<{ items: DocumentRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status) where.push(`status = $${params.push(f.status)}`);
    if (f.fileType) where.push(`file_type = $${params.push(f.fileType)}`);
    if (f.needsReview !== undefined) where.push(`needs_review = $${params.push(f.needsReview)}`);
    if (f.q) where.push(`original_filename ILIKE $${params.push(`%${f.q.replace(/[%_]/g, '\\$&')}%`)}`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM documents ${clause}`, params);
    const items = await this.db.query<DocumentRow>(
      `SELECT * FROM documents ${clause} ORDER BY created_at DESC LIMIT $${params.push(f.limit)} OFFSET $${params.push(f.offset)}`,
      params,
    );
    return { items, total: total?.n ?? 0 };
  }

  async update(id: string, patch: Partial<Record<keyof DocumentRow, unknown>>, client?: Queryable): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map((k) => {
      const v = patch[k as keyof DocumentRow];
      return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
    });
    await this.db.query(`UPDATE documents SET ${sets.join(', ')} WHERE id = $1`, [id, ...values], client);
  }

  async addEvent(e: { documentId: string; stage: string; status: 'started' | 'completed' | 'failed' | 'retrying' | 'info'; message?: string; durationMs?: number; details?: Record<string, unknown>; runId?: number; invoiceId?: string; actor?: string }, client?: Queryable): Promise<void> {
    await this.db.query(
      `INSERT INTO processing_events (document_id, invoice_id, run_id, stage, status, message, duration_ms, details, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.documentId, e.invoiceId ?? null, e.runId ?? null, e.stage, e.status, e.message ?? null, e.durationMs ?? null, JSON.stringify(e.details ?? {}), e.actor ?? null],
      client,
    );
  }

  events(documentId: string) {
    return this.db.query(`SELECT * FROM processing_events WHERE document_id = $1 ORDER BY id ASC LIMIT 2000`, [documentId]);
  }

  /** Idempotent page upsert (chunks may be retried). */
  async upsertPages(documentId: string, pages: ProcessorPage[]): Promise<void> {
    if (!pages.length) return;
    await this.db.query(
      `INSERT INTO document_pages (document_id, page_number, kind, text, ocr_confidence, lines, width, height, warnings, ocr_steps, duration_ms)
       SELECT $1, p.page_number, p.kind, p.text, p.ocr_confidence, p.lines, p.width, p.height, p.warnings, p.ocr_steps, p.duration_ms
         FROM jsonb_to_recordset($2::jsonb) AS p(page_number int, kind text, text text, ocr_confidence real, lines jsonb, width real, height real, warnings jsonb, ocr_steps jsonb, duration_ms int)
       ON CONFLICT (document_id, page_number) DO UPDATE SET kind = EXCLUDED.kind, text = EXCLUDED.text, ocr_confidence = EXCLUDED.ocr_confidence,
         lines = EXCLUDED.lines, width = EXCLUDED.width, height = EXCLUDED.height, warnings = EXCLUDED.warnings, ocr_steps = EXCLUDED.ocr_steps, duration_ms = EXCLUDED.duration_ms`,
      [documentId, JSON.stringify(pages.map((p) => ({ ...p, kind: p.method })))],
    );
  }

  async upsertSheets(documentId: string, sheets: ProcessorSheet[]): Promise<void> {
    if (!sheets.length) return;
    await this.db.query(
      `INSERT INTO document_pages (document_id, page_number, kind, sheet_name, text, table_data, warnings)
       SELECT $1, s.index + 1, 'sheet', s.name, s.text, s.rows, s.warnings
         FROM jsonb_to_recordset($2::jsonb) AS s(index int, name text, text text, rows jsonb, warnings jsonb)
       ON CONFLICT (document_id, page_number) DO UPDATE SET sheet_name = EXCLUDED.sheet_name, text = EXCLUDED.text, table_data = EXCLUDED.table_data, warnings = EXCLUDED.warnings`,
      [documentId, JSON.stringify(sheets)],
    );
  }

  async loadPages(documentId: string): Promise<PageText[]> {
    return this.db.query<PageText>(
      `SELECT page_number, kind, text, ocr_confidence, lines, sheet_name, table_data FROM document_pages WHERE document_id = $1 ORDER BY page_number`,
      [documentId],
    );
  }

  pages(documentId: string, from: number, to: number) {
    return this.db.query(
      `SELECT page_number, kind, sheet_name, text, ocr_confidence, lines, table_data, width, height, warnings, ocr_steps, duration_ms
         FROM document_pages WHERE document_id = $1 AND page_number BETWEEN $2 AND $3 ORDER BY page_number`,
      [documentId, from, to],
    );
  }

  async pageStats(documentId: string): Promise<{ processed: number; ocr: number; avg_conf: number | null }> {
    const r = await this.db.one<{ processed: number; ocr: number; avg_conf: number | null }>(
      `SELECT count(*)::int AS processed, count(*) FILTER (WHERE kind = 'ocr')::int AS ocr, avg(ocr_confidence)::real AS avg_conf
         FROM document_pages WHERE document_id = $1`,
      [documentId],
    );
    return r ?? { processed: 0, ocr: 0, avg_conf: null };
  }
}
