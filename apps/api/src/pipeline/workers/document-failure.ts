import { Job, UnrecoverableError } from 'bullmq';
import { DocumentsRepository } from '../../documents/documents.repository';
import { EventsService } from '../../events/events.service';
import { ProcessorError } from '../../processor/processor.client';
import { DocJob, PERMANENT_CODES } from '../queues';

/**
 * Shared failure policy: permanent errors fail the document immediately (UnrecoverableError skips
 * BullMQ retries); transient errors are retried with backoff and only marked failed on the last attempt.
 */
export async function handleJobError(job: Job<DocJob>, err: unknown, stage: string, documents: DocumentsRepository, events: EventsService): Promise<never> {
  const e = err as Error & { code?: string; retryable?: boolean };
  const permanent = err instanceof UnrecoverableError || (err instanceof ProcessorError && (!err.retryable || PERMANENT_CODES.has(err.code)));
  const attempts = job.opts.attempts ?? 1;
  const last = permanent || job.attemptsMade + 1 >= attempts;
  const code = err instanceof ProcessorError ? err.code : permanent ? 'processing_failed' : 'internal_error';
  const doc = await documents.get(job.data.documentId);
  if (doc && doc.run_id === job.data.runId) {
    if (last) {
      await documents.update(doc.id, { status: 'failed', stage, error_code: code, error_message: e.message?.slice(0, 1000) ?? 'unknown error', processing_finished_at: new Date(), attempts: doc.attempts + 1 });
      await documents.addEvent({ documentId: doc.id, runId: doc.run_id, stage, status: 'failed', message: e.message?.slice(0, 500), details: { code, attempt: job.attemptsMade + 1, permanent } });
      await events.publish({ type: 'document.updated', documentId: doc.id, status: 'failed', stage });
    } else {
      await documents.addEvent({ documentId: doc.id, runId: doc.run_id, stage, status: 'retrying', message: e.message?.slice(0, 500), details: { code, attempt: job.attemptsMade + 1 } });
    }
  }
  if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(e.message);
  throw err;
}
