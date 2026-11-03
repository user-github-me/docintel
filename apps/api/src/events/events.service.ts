import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, filter } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/config';

export interface DocIntelEvent {
  type: 'document.updated' | 'invoice.updated' | 'heartbeat';
  documentId?: string;
  invoiceId?: string;
  status?: string;
  stage?: string | null;
  progress?: number;
  needsReview?: boolean;
  at: string;
}


/**
 * Workers publish progress to Redis; every API replica subscribes and fans out to its SSE clients.
 * This keeps live progress working when API and workers are separate (scaled) processes.
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly publisher: Redis;
  private subscriber: Redis | null = null;
  private readonly stream = new Subject<DocIntelEvent>();
  private readonly channel: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.channel = `${config.QUEUE_PREFIX}:events`;
    this.publisher = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.publisher.on('error', (e) => this.logger.warn(`redis publisher: ${e.message}`));
  }

  async publish(event: Omit<DocIntelEvent, 'at'>): Promise<void> {
    const payload: DocIntelEvent = { ...event, at: new Date().toISOString() };
    await this.publisher.publish(this.channel, JSON.stringify(payload)).catch((e) => this.logger.warn(`publish failed: ${e.message}`));
  }

  /** Lazily subscribe (only API processes serve SSE). */
  events(documentId?: string): Observable<DocIntelEvent> {
    if (!this.subscriber) {
      this.subscriber = new Redis(this.config.REDIS_URL);
      this.subscriber.on('error', (e) => this.logger.warn(`redis subscriber: ${e.message}`));
      void this.subscriber.subscribe(this.channel);
      this.subscriber.on('message', (_ch, message) => {
        try {
          this.stream.next(JSON.parse(message) as DocIntelEvent);
        } catch {
          /* ignore malformed */
        }
      });
    }
    return this.stream.asObservable().pipe(filter((e) => !documentId || e.documentId === documentId));
  }

  async onModuleDestroy(): Promise<void> {
    this.stream.complete();
    await Promise.allSettled([this.publisher.quit(), this.subscriber?.quit()]);
  }
}
