import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiKeyGuard } from './common/auth/api-key.guard';
import { APP_CONFIG, AppConfig, loadConfig } from './config/config';
import { DatabaseService } from './database/database.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsRepository } from './documents/documents.repository';
import { DocumentsService } from './documents/documents.service';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { ExtractionService } from './extraction/extraction.service';
import { LlmService } from './extraction/llm/llm.service';
import { HealthController } from './health/health.controller';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { AnalysisService } from './pipeline/analysis.service';
import { IndexingService } from './pipeline/indexing.service';
import { PipelineService } from './pipeline/pipeline.service';
import { ALL_QUEUES, FLOW_PRODUCER } from './pipeline/queues';
import { AnalyzeProcessor } from './pipeline/workers/analyze.processor';
import { IndexProcessor } from './pipeline/workers/index.processor';
import { IngestProcessor } from './pipeline/workers/ingest.processor';
import { PagesProcessor } from './pipeline/workers/pages.processor';
import { ProcessorClient } from './processor/processor.client';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { StatsController } from './stats/stats.controller';
import { StorageService } from './storage/storage.service';
import { ValidationService } from './validation/validation.service';

function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ workers
  };
}

@Module({})
export class AppModule {
  /** role "api" serves HTTP only, "worker" runs queue consumers only, "all" does both (local dev). */
  static register(config: AppConfig = loadConfig()): DynamicModule {
    const withWorkers = config.APP_ROLE !== 'api';
    const withHttp = config.APP_ROLE !== 'worker';
    const workers: Provider[] = withWorkers ? [IngestProcessor, PagesProcessor, AnalyzeProcessor, IndexProcessor] : [];
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }]),
        BullModule.forRoot({ connection: redisConnection(config.REDIS_URL), prefix: config.QUEUE_PREFIX }),
        BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
        BullModule.registerFlowProducer({ name: FLOW_PRODUCER }),
      ],
      controllers: withHttp
        ? [DocumentsController, InvoicesController, SearchController, ReconciliationController, StatsController, HealthController, EventsController]
        : [],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DatabaseService,
        StorageService,
        ProcessorClient,
        EventsService,
        LlmService,
        ExtractionService,
        ValidationService,
        DocumentsRepository,
        DocumentsService,
        InvoicesService,
        SearchService,
        ReconciliationService,
        PipelineService,
        AnalysisService,
        IndexingService,
        ...workers,
        ...(withHttp ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: ApiKeyGuard }] : []),
      ],
    };
  }
}
