import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DatabaseService } from '../../database/database.service';
import { DocumentsRepository } from '../../documents/documents.repository';
import { EventsService } from '../../events/events.service';
import { ProcessorClient } from '../../processor/processor.client';
import { PagesJob, QUEUE_PAGES } from '../queues';
import { handleJobError } from './document-failure';

/** Step 2 (fan-out): text extraction / OCR / sheet parsing for one page range. */
@Processor(QUEUE_PAGES, { concurrency: Number(process.env.WORKER_CONCURRENCY_PAGES ?? 4) })
export class PagesProcessor extends WorkerHost {
  private readonly logger = new Logger(PagesProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentsRepository,
    private readonly processor: ProcessorClient,
    private readonly events: EventsService,
  ) {
    super();
  }

  async process(job: Job<PagesJob>): Promise<unknown> {
    const doc = await this.documents.get(job.data.documentId);
    if (!doc || doc.run_id !== job.data.runId) return { skipped: 'stale run' };
    const started = Date.now();
    try {
      const result = await this.processor.extract(doc.storage_key, doc.original_filename, job.data.pageStart, job.data.pageEnd);
      if (result.sheets.length) await this.documents.upsertSheets(doc.id, result.sheets);
      await this.documents.upsertPages(doc.id, result.pages);
      const stats = await this.documents.pageStats(doc.id);
      const total = Math.max(doc.page_count ?? 1, 1);
      const progress = Math.min(80, 5 + Math.round((75 * stats.processed) / total));
      await this.db.query(
        `UPDATE documents SET pages_processed = $2, ocr_pages = $3, avg_ocr_confidence = $4, progress = GREATEST(progress, $5),
                warnings = coalesce((SELECT jsonb_agg(DISTINCT w) FROM jsonb_array_elements(warnings || $6::jsonb) AS w), '[]'::jsonb)
          WHERE id = $1 AND run_id = $7`,
        [doc.id, stats.processed, stats.ocr, stats.avg_conf, progress, JSON.stringify(result.warnings), doc.run_id],
      );
      await this.documents.addEvent({
        documentId: doc.id, runId: doc.run_id, stage: 'extract-text', status: 'completed', durationMs: Date.now() - started,
        message: result.sheets.length ? `${result.sheets.length} sheet(s) parsed` : `pages ${job.data.pageStart}-${job.data.pageEnd ?? job.data.pageStart}: ${result.pages.filter((p) => p.method === 'ocr').length} OCR, ${result.pages.filter((p) => p.method === 'text').length} text`,
      });
      await this.events.publish({ type: 'document.updated', documentId: doc.id, status: 'processing', stage: 'extract-text', progress });
      return { pages: result.pages.length, sheets: result.sheets.length };
    } catch (err) {
      return handleJobError(job, err, 'extract-text', this.documents, this.events);
    }
  }
}
