import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { EventsService } from '../events/events.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { ProcessorClient } from '../processor/processor.client';
import { StorageService } from '../storage/storage.service';
import { DocumentRow, DocumentsRepository } from './documents.repository';
import { extensionOf, mimeFor, sanitizeFilename, screenUpload } from './upload-validation';

export interface UploadResult {
  documents: Array<Record<string, unknown>>;
  rejected: Array<{ filename: string; code: string; reason: string }>;
}

export function documentSummary(d: DocumentRow) {
  return {
    id: d.id,
    filename: d.original_filename,
    fileType: d.file_type,
    mimeType: d.mime_type,
    sizeBytes: Number(d.size_bytes),
    purpose: d.purpose,
    status: d.status,
    stage: d.stage,
    progress: d.progress,
    needsReview: d.needs_review,
    duplicateOf: d.duplicate_of,
    pageCount: d.page_count,
    pagesProcessed: d.pages_processed,
    ocrPages: d.ocr_pages,
    avgOcrConfidence: d.avg_ocr_confidence,
    invoiceCount: d.invoice_count,
    errorCode: d.error_code,
    errorMessage: d.error_message,
    warnings: d.warnings,
    runId: d.run_id,
    uploadedBy: d.uploaded_by,
    processingMs: d.processing_ms,
    indexedAt: d.indexed_at,
    llm: { calls: d.llm_calls, inputTokens: d.llm_input_tokens, outputTokens: d.llm_output_tokens },
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly documents: DocumentsRepository,
    private readonly storage: StorageService,
    private readonly pipeline: PipelineService,
    private readonly processor: ProcessorClient,
    private readonly events: EventsService,
  ) {}

  async upload(files: Express.Multer.File[], purpose: 'invoices' | 'reference', allowDuplicates: boolean, actor: string): Promise<UploadResult> {
    const result: UploadResult = { documents: [], rejected: [] };
    for (const file of files) {
      const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
      try {
        const head = await this.storage.readHead(file.path);
        const screen = screenUpload(filename, file.size, head);
        if (!screen.ok) {
          result.rejected.push({ filename, code: screen.code, reason: screen.reason });
          await fs.promises.unlink(file.path).catch(() => undefined);
          continue;
        }
        const sha256 = await this.storage.sha256(file.path);
        const existing = allowDuplicates ? null : await this.documents.findBySha(sha256);
        const storageKey = await this.storage.persist(file.path, extensionOf(filename));
        const doc = await this.documents.create({
          original_filename: filename, storage_key: storageKey, mime_type: mimeFor(filename), size_bytes: file.size, sha256, purpose,
          uploaded_by: actor, status: existing ? 'duplicate' : 'queued', duplicate_of: existing?.id ?? null, file_type: existing?.file_type ?? null,
        });
        await this.documents.addEvent({ documentId: doc.id, runId: doc.run_id, stage: 'upload', status: 'completed', actor, message: existing ? `Identical to ${existing.original_filename}; not reprocessed` : `Uploaded ${filename} (${file.size} bytes)` });
        if (!existing) await this.pipeline.enqueue(doc);
        await this.events.publish({ type: 'document.updated', documentId: doc.id, status: doc.status, stage: 'queued', progress: 0 });
        result.documents.push(documentSummary(doc));
      } catch (err) {
        await fs.promises.unlink(file.path).catch(() => undefined);
        result.rejected.push({ filename, code: 'upload_failed', reason: (err as Error).message });
      }
    }
    return result;
  }

  async require(id: string): Promise<DocumentRow> {
    const doc = await this.documents.get(id);
    if (!doc) throw new NotFoundException(`Document ${id} not found`);
    return doc;
  }

  async detail(id: string) {
    const doc = await this.require(id);
    const invoices = await this.db.query(
      `SELECT i.id, i.sequence, i.invoice_number, i.invoice_date, i.supplier_name, i.customer_name, i.currency, i.total, i.status,
              i.confidence, i.extraction_method, i.page_start, i.page_end, i.sheet_name, i.row_start, i.is_corrected,
              count(v.id) FILTER (WHERE v.severity = 'error')::int AS errors, count(v.id) FILTER (WHERE v.severity = 'warning')::int AS warnings
         FROM invoices i LEFT JOIN validation_issues v ON v.invoice_id = i.id
        WHERE i.document_id = $1 GROUP BY i.id ORDER BY i.sequence LIMIT 5000`,
      [id],
    );
    const documentIssues = await this.db.query(`SELECT code, severity, message, details FROM validation_issues WHERE document_id = $1 AND invoice_id IS NULL`, [id]);
    const corrections = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM corrections WHERE document_id = $1`, [id]);
    return { ...documentSummary(doc), invoices, documentIssues, correctionCount: corrections?.n ?? 0 };
  }

  async pageImage(id: string, page: number): Promise<Buffer> {
    const doc = await this.require(id);
    if (!['pdf', 'image'].includes(doc.file_type ?? '')) throw new NotFoundException('This document type has no page images');
    const cacheKey = `derived/${doc.id}/page-${page}.jpg`;
    const cached = await this.storage.cached(cacheKey);
    if (cached) return cached;
    const img = await this.processor.render(doc.storage_key, doc.original_filename, page);
    await this.storage.writeCache(cacheKey, img);
    return img;
  }

  async reprocess(id: string, force: boolean, actor: string): Promise<DocumentRow> {
    const doc = await this.require(id);
    if (doc.status === 'duplicate') throw new ConflictException('Duplicate uploads are linked to the original; reprocess the original document.');
    if (['queued', 'processing', 'analyzing'].includes(doc.status) && !force) throw new ConflictException('Document is already being processed.');
    const c = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM corrections c JOIN invoices i ON i.id = c.invoice_id WHERE i.document_id = $1`, [id]);
    if ((c?.n ?? 0) > 0 && !force) throw new ConflictException('This document has manual corrections; re-extraction would replace them. Pass {"force": true} to continue.');
    return this.pipeline.reprocess(doc, actor);
  }

  async retryFailed(actor: string, includePermanent: boolean): Promise<{ retried: number; skipped: number }> {
    const failed = await this.db.query<DocumentRow>(`SELECT * FROM documents WHERE status = 'failed' ORDER BY created_at`);
    let retried = 0;
    let skipped = 0;
    const permanent = new Set(['corrupted_file', 'encrypted_pdf', 'empty_file', 'unsupported_format', 'too_many_pages', 'image_too_large', 'file_too_large']);
    for (const doc of failed) {
      if (!includePermanent && doc.error_code && permanent.has(doc.error_code)) {
        skipped++;
        continue;
      }
      await this.pipeline.reprocess(doc, actor, 'retry-failed');
      retried++;
    }
    return { retried, skipped };
  }

  async remove(id: string, actor: string): Promise<void> {
    const doc = await this.require(id);
    await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    await this.storage.remove(doc.storage_key);
    await this.events.publish({ type: 'document.updated', documentId: id, status: 'deleted' });
    void actor;
  }
}
