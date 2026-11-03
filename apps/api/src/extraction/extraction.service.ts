import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ProcessorClient } from '../processor/processor.client';
import { DocRef, ExtractionEngine, ExtractionOutcome } from './extraction-engine';
import { LlmService } from './llm/llm.service';
import { PageText } from './types';

export type { ExtractionOutcome } from './extraction-engine';

/** Nest wrapper around the framework-free ExtractionEngine. */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  private readonly engine: ExtractionEngine;

  constructor(@Inject(APP_CONFIG) config: AppConfig, llm: LlmService, processor: ProcessorClient) {
    this.engine = new ExtractionEngine(
      {
        strategy: config.LLM_STRATEGY,
        visionFallback: config.LLM_VISION_FALLBACK,
        visionMaxPages: config.LLM_VISION_MAX_PAGES,
        visionBelowOcrConf: config.LLM_VISION_BELOW_OCR_CONF,
      },
      llm,
      (doc, page) => processor.render(doc.storage_key, doc.original_filename, page, 150, 2000),
      (msg) => this.logger.warn(msg),
    );
  }

  extractDocument(doc: DocRef, pages: PageText[]): Promise<ExtractionOutcome> {
    return this.engine.extractDocument(doc, pages);
  }
}
