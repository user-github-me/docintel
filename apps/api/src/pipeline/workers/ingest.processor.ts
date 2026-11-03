import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../../config/config';
import { DocumentsRepository } from '../../documents/documents.repository';
import { EventsService } from '../../events/events.service';
import { ProcessorClient } from '../../processor/processor.client';
import { PipelineService } from '../pipeline.service';
import { DocJob, QUEUE_INGEST } from '../queues';
import { handleJobError } from './document-failure';

/** Step 1: inspect the file (type, pages, encryption) and plan page-range chunks. */
@Processor(QUEUE_INGEST, { concurrency: Number(process.env.WORKER_CONCURRENCY_INGEST ?? 4) })
export class IngestProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly documents: DocumentsRepository,
    private readonly processor: ProcessorClient,
    private readonly pipeline: PipelineService,
    private readonly events: EventsService,
  ) {
    super();
  }

  async process(job: Job<DocJob>): Promise<unknown> {
    const doc = await this.documents.get(job.data.documentId);
    if (!doc || doc.run_id !== job.data.runId) return { skipped: 'stale run' };
    const started = Date.now();
    try {
      await this.documents.update(doc.id, { status: 'processing', stage: 'inspect', progress: 2, processing_started_at: doc.processing_started_at ?? new Date() });
      await this.events.publish({ type: 'document.updated', documentId: doc.id, status: 'processing', stage: 'inspect', progress: 2 });
      const info = await this.processor.inspect(doc.storage_key, doc.original_filename);
      const isSheet = ['xlsx', 'xls', 'csv'].includes(info.file_type);
      await this.documents.update(doc.id, {
        file_type: info.file_type,
        mime_type: info.mime_type,
        page_count: info.page_count,
        warnings: info.warnings,
        progress: 5,
        stage: isSheet ? 'parse' : 'extract-text',
        metadata: { ...doc.metadata, inspect: { scanned_ratio: info.estimated_scanned_ratio ?? null, sheets: info.sheets ?? null } },
      });
      // Scanned PDFs are OCR-bound: smaller chunks spread better across workers.
      const size = info.file_type === 'pdf' && (info.estimated_scanned_ratio ?? 0) > 0.5 ? Math.max(4, Math.floor(this.config.PAGE_CHUNK_SIZE / 2)) : this.config.PAGE_CHUNK_SIZE;
      const chunks: Array<{ start: number; end: number | null }> = [];
      if (isSheet) chunks.push({ start: 1, end: null });
      else for (let s = 1; s <= Math.max(1, info.page_count); s += size) chunks.push({ start: s, end: Math.min(info.page_count, s + size - 1) });
      // fast lane: spreadsheets and born-digital PDFs; OCR-bound scans/images queue behind them
      const scanned = info.file_type === 'image' || (info.estimated_scanned_ratio ?? 0) > 0.5;
      const priority = isSheet ? 1 : scanned ? 5 + Math.min(4, Math.floor(info.page_count / 50)) : 2;
      await this.pipeline.startFlow(doc, chunks, priority);
      await this.documents.addEvent({ documentId: doc.id, runId: doc.run_id, stage: 'inspect', status: 'completed', durationMs: Date.now() - started, message: `${info.file_type}, ${info.page_count} ${isSheet ? 'sheet(s)' : 'page(s)'}, ${chunks.length} chunk(s)`, details: { warnings: info.warnings } });
      return { chunks: chunks.length };
    } catch (err) {
      return handleJobError(job, err, 'inspect', this.documents, this.events);
    }
  }
}
