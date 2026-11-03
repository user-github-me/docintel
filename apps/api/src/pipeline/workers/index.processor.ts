import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DocumentsRepository } from '../../documents/documents.repository';
import { IndexingService } from '../indexing.service';
import { DocJob, QUEUE_INDEX } from '../queues';

/** Step 4 (async, best effort): embeddings for semantic search. Keyword search works before this. */
@Processor(QUEUE_INDEX, { concurrency: Number(process.env.WORKER_CONCURRENCY_INDEX ?? 1) })
export class IndexProcessor extends WorkerHost {
  private readonly logger = new Logger(IndexProcessor.name);

  constructor(private readonly documents: DocumentsRepository, private readonly indexing: IndexingService) {
    super();
  }

  async process(job: Job<DocJob>): Promise<unknown> {
    const doc = await this.documents.get(job.data.documentId);
    if (!doc || doc.run_id !== job.data.runId || doc.status !== 'completed') return { skipped: true };
    const started = Date.now();
    const result = await this.indexing.indexDocument(doc.id);
    await this.documents.addEvent({ documentId: doc.id, runId: doc.run_id, stage: 'index', status: 'completed', durationMs: Date.now() - started, message: `semantic index: ${result.invoices} invoice(s), ${result.chunks} text chunk(s)` });
    return result;
  }
}
