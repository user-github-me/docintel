import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DocumentsRepository } from '../../documents/documents.repository';
import { EventsService } from '../../events/events.service';
import { AnalysisService } from '../analysis.service';
import { PipelineService } from '../pipeline.service';
import { DocJob, QUEUE_ANALYZE } from '../queues';
import { handleJobError } from './document-failure';

/** Step 3 (flow parent): segmentation, AI/rules extraction, validation, persistence. */
@Processor(QUEUE_ANALYZE, { concurrency: Number(process.env.WORKER_CONCURRENCY_ANALYZE ?? 6) })
export class AnalyzeProcessor extends WorkerHost {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly analysis: AnalysisService,
    private readonly pipeline: PipelineService,
    private readonly events: EventsService,
  ) {
    super();
  }

  async process(job: Job<DocJob>): Promise<unknown> {
    const doc = await this.documents.get(job.data.documentId);
    if (!doc || doc.run_id !== job.data.runId) return { skipped: 'stale run' };
    try {
      await this.documents.update(doc.id, { status: 'analyzing', stage: 'extract-fields', progress: 85 });
      await this.events.publish({ type: 'document.updated', documentId: doc.id, status: 'analyzing', stage: 'extract-fields', progress: 85 });
      const summary = await this.analysis.analyze((await this.documents.get(doc.id))!);
      await this.pipeline.enqueueIndex(doc);
      return summary;
    } catch (err) {
      return handleJobError(job, err, 'analyze', this.documents, this.events);
    }
  }
}
