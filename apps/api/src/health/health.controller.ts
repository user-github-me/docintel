import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth/api-key.guard';
import { DatabaseService } from '../database/database.service';
import { LlmService } from '../extraction/llm/llm.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { ProcessorClient } from '../processor/processor.client';

@ApiTags('operations')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService, private readonly processor: ProcessorClient, private readonly llm: LlmService, private readonly pipeline: PipelineService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness/readiness of database, queue, processor, LLM configuration' })
  async health() {
    const [db, processor, queues] = await Promise.all([
      this.db.query('SELECT 1').then(() => true).catch(() => false),
      this.processor.health(),
      this.pipeline.stats().then(() => true).catch(() => false),
    ]);
    const ok = db && queues && !!processor;
    return {
      status: ok ? 'ok' : 'degraded',
      database: db,
      queue: queues,
      processor: processor ? { ok: true, tesseract: processor.tesseract, embedding: processor.embedding } : { ok: false },
      llm: this.llm.info(),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }
}
