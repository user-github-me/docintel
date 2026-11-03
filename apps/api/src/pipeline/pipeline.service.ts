import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { FlowProducer, JobsOptions, Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DocumentRow, DocumentsRepository } from '../documents/documents.repository';
import { EventsService } from '../events/events.service';
import { DocJob, FLOW_PRODUCER, PagesJob, QUEUE_ANALYZE, QUEUE_INDEX, QUEUE_INGEST, QUEUE_PAGES } from './queues';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(QUEUE_INGEST) private readonly ingest: Queue,
    @InjectQueue(QUEUE_PAGES) private readonly pages: Queue,
    @InjectQueue(QUEUE_ANALYZE) private readonly analyze: Queue,
    @InjectQueue(QUEUE_INDEX) private readonly index: Queue,
    @InjectFlowProducer(FLOW_PRODUCER) private readonly flow: FlowProducer,
    private readonly documents: DocumentsRepository,
    private readonly events: EventsService,
  ) {}

  jobOptions(jobId: string): JobsOptions {
    return {
      jobId,
      attempts: this.config.JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 14 * 24 * 3600 },
    };
  }

  async enqueue(doc: Pick<DocumentRow, 'id' | 'run_id'>): Promise<void> {
    const data: DocJob = { documentId: doc.id, runId: doc.run_id };
    await this.ingest.add('inspect', data, this.jobOptions(`inspect-${doc.id}-${doc.run_id}`));
  }

  /**
   * Fan out page-range extraction jobs; the parent analyze job runs when all children finish.
   * Priority lanes: cheap work (spreadsheets, digital PDFs) is not stuck behind OCR-heavy batches
   * (BullMQ: lower number = higher priority).
   */
  async startFlow(doc: Pick<DocumentRow, 'id' | 'run_id'>, chunks: Array<{ start: number; end: number | null }>, priority = 5): Promise<void> {
    await this.flow.add({
      name: 'analyze',
      queueName: QUEUE_ANALYZE,
      data: { documentId: doc.id, runId: doc.run_id } satisfies DocJob,
      opts: { ...this.jobOptions(`analyze-${doc.id}-${doc.run_id}`), priority },
      children: chunks.map((c) => ({
        name: 'extract-pages',
        queueName: QUEUE_PAGES,
        data: { documentId: doc.id, runId: doc.run_id, pageStart: c.start, pageEnd: c.end } satisfies PagesJob,
        opts: { ...this.jobOptions(`pages-${doc.id}-${doc.run_id}-${c.start}`), failParentOnFailure: true, priority },
      })),
    });
  }

  async enqueueIndex(doc: Pick<DocumentRow, 'id' | 'run_id'>): Promise<void> {
    await this.index.add('index', { documentId: doc.id, runId: doc.run_id }, { ...this.jobOptions(`index-${doc.id}-${doc.run_id}-${Date.now()}`), attempts: 2 });
  }

  /** New run id => old in-flight jobs become no-ops (they check run_id), no job-id collisions. */
  async reprocess(doc: DocumentRow, actor: string, reason = 'reprocess'): Promise<DocumentRow> {
    const runId = doc.run_id + 1;
    await this.documents.update(doc.id, {
      run_id: runId,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      error_code: null,
      error_message: null,
      pages_processed: 0,
      processing_started_at: new Date(),
      processing_finished_at: null,
      processing_ms: null,
    });
    await this.documents.addEvent({ documentId: doc.id, runId, stage: reason, status: 'info', message: `Reprocessing requested by ${actor}`, actor });
    await this.enqueue({ id: doc.id, run_id: runId });
    await this.events.publish({ type: 'document.updated', documentId: doc.id, status: 'queued', stage: 'queued', progress: 0 });
    return (await this.documents.get(doc.id))!;
  }

  async stats() {
    const out: Record<string, Record<string, number>> = {};
    for (const q of [this.ingest, this.pages, this.analyze, this.index]) {
      out[q.name] = await q.getJobCounts('waiting', 'prioritized', 'active', 'completed', 'failed', 'delayed', 'waiting-children');
    }
    return out;
  }
}
