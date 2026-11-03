import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Actor } from '../common/auth/api-key.guard';
import { DatabaseService } from '../database/database.service';
import { DocumentsService } from '../documents/documents.service';
import { PipelineService } from '../pipeline/pipeline.service';

@ApiTags('operations')
@ApiSecurity('api-key')
@Controller()
export class StatsController {
  constructor(private readonly db: DatabaseService, private readonly pipeline: PipelineService, private readonly documents: DocumentsService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Dashboard metrics: documents by status/type, success & failure rate, processing time, review queue, top issues, LLM usage' })
  async stats() {
    const [byStatus, byType, invoices, timing, issues, llm] = await Promise.all([
      this.db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM documents GROUP BY status`),
      this.db.query<{ file_type: string; n: number }>(`SELECT coalesce(file_type, 'unknown') AS file_type, count(*)::int AS n FROM documents GROUP BY 1`),
      this.db.one<Record<string, number>>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'needs_review')::int AS needs_review,
              count(*) FILTER (WHERE status = 'validated')::int AS validated, count(*) FILTER (WHERE status = 'approved')::int AS approved,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected, count(*) FILTER (WHERE is_corrected)::int AS corrected FROM invoices`),
      this.db.one<Record<string, number>>(`SELECT round(avg(processing_ms))::int AS avg_ms,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY processing_ms)::int AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY processing_ms)::int AS p95_ms,
              coalesce(sum(page_count), 0)::int AS pages FROM documents WHERE status = 'completed'`),
      this.db.query(`SELECT code, severity, count(*)::int AS n FROM validation_issues GROUP BY code, severity ORDER BY n DESC LIMIT 15`),
      this.db.one<Record<string, number>>(`SELECT coalesce(sum(llm_calls), 0)::int AS calls, coalesce(sum(llm_input_tokens), 0)::bigint AS input_tokens, coalesce(sum(llm_output_tokens), 0)::bigint AS output_tokens FROM documents`),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
    const finished = (counts.completed ?? 0) + (counts.failed ?? 0);
    return {
      documents: { byStatus: counts, byType: Object.fromEntries(byType.map((r) => [r.file_type, r.n])), total: byStatus.reduce((a, r) => a + r.n, 0) },
      successRate: finished ? (counts.completed ?? 0) / finished : null,
      failureRate: finished ? (counts.failed ?? 0) / finished : null,
      invoices,
      processing: timing,
      topIssues: issues,
      llm,
    };
  }

  @Get('jobs/stats')
  @ApiOperation({ summary: 'Queue depth per pipeline stage (waiting/active/failed/...)' })
  queues() {
    return this.pipeline.stats();
  }

  @Post('jobs/retry-failed')
  @ApiOperation({ summary: 'Reprocess every failed document (permanent errors such as corrupt files are skipped unless includePermanent=true)' })
  retryFailed(@Actor() actor: string, @Query('includePermanent') includePermanent?: string) {
    return this.documents.retryFailed(actor, includePermanent === 'true');
  }
}
