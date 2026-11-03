import { Injectable, Logger } from '@nestjs/common';
import { normaliseInvoiceNumber } from '../common/text';
import { DatabaseService } from '../database/database.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ListInvoicesQuery } from '../invoices/invoices.dto';
import { ProcessorClient } from '../processor/processor.client';

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

interface Hit {
  id: string;
  score: number;
  snippet?: string | null;
  page?: number | null;
}

const RRF_K = 60;

/**
 * Keyword search: PostgreSQL full-text (invoice fields + page text) plus trigram/ILIKE on invoice
 * numbers. Semantic search: pgvector cosine similarity over invoice summaries and text chunks.
 * Hybrid: reciprocal-rank fusion of both lists. All modes accept the structured filters.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly db: DatabaseService, private readonly processor: ProcessorClient) {}

  private async keyword(q: string, filters: Partial<ListInvoicesQuery>, limit: number): Promise<Hit[]> {
    const params: unknown[] = [q];
    const where = InvoicesService.filters(filters, params);
    const num = params.push(`%${normaliseInvoiceNumber(q) ?? q}%`);
    const fw = where.length ? `AND ${where.join(' AND ')}` : '';
    const invoiceHits = await this.db.query<{ id: string; score: number; snippet: string }>(
      `SELECT i.id, ts_rank(i.tsv, query) + CASE WHEN i.invoice_number_norm ILIKE $${num} THEN 1 ELSE 0 END AS score,
              ts_headline('simple', i.search_text, query, 'MaxFragments=2, MaxWords=18, MinWords=5') AS snippet
         FROM invoices i, websearch_to_tsquery('simple', $1) query
        WHERE (i.tsv @@ query OR i.invoice_number_norm ILIKE $${num}) ${fw}
        ORDER BY score DESC LIMIT $${params.push(limit)}`,
      params,
    );
    // Raw page text (finds words that are not in extracted fields), mapped to the invoice covering the page.
    const pparams: unknown[] = [q];
    const pwhere = InvoicesService.filters(filters, pparams);
    const pageHits = await this.db.query<{ id: string; score: number; snippet: string; page: number }>(
      `SELECT DISTINCT ON (i.id) i.id, ts_rank(p.tsv, query) AS score, p.page_number AS page,
              ts_headline('simple', p.text, query, 'MaxFragments=1, MaxWords=20, MinWords=6') AS snippet
         FROM document_pages p JOIN invoices i ON i.document_id = p.document_id
              AND (p.kind = 'sheet' OR p.page_number BETWEEN coalesce(i.page_start, 1) AND coalesce(i.page_end, i.page_start, 100000)),
              websearch_to_tsquery('simple', $1) query
        WHERE p.tsv @@ query ${pwhere.length ? `AND ${pwhere.join(' AND ')}` : ''}
        ORDER BY i.id, score DESC LIMIT $${pparams.push(limit)}`,
      pparams,
    );
    const merged = new Map<string, Hit>();
    for (const h of [...invoiceHits, ...pageHits.map((p) => ({ ...p, score: p.score * 0.8 }))]) {
      const prev = merged.get(h.id);
      if (!prev || h.score > prev.score) merged.set(h.id, { id: h.id, score: Number(h.score), snippet: h.snippet, page: (h as { page?: number }).page ?? prev?.page ?? null });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private async semantic(q: string, filters: Partial<ListInvoicesQuery>, limit: number): Promise<{ hits: Hit[]; model: string | null }> {
    let embedding: { model: string; vectors: number[][] };
    try {
      embedding = await this.processor.embed([q], 'query');
    } catch (err) {
      this.logger.warn(`semantic search unavailable: ${(err as Error).message}`);
      return { hits: [], model: null };
    }
    const vec = `[${embedding.vectors[0].map((x) => x.toFixed(6)).join(',')}]`;
    const params: unknown[] = [vec, embedding.model];
    const where = InvoicesService.filters(filters, params);
    const fw = where.length ? `AND ${where.join(' AND ')}` : '';
    const invoiceHits = await this.db.query<{ id: string; score: number }>(
      `SELECT i.id, 1 - (i.embedding <=> $1::vector) AS score FROM invoices i
        WHERE i.embedding IS NOT NULL AND i.embedding_model = $2 ${fw}
        ORDER BY i.embedding <=> $1::vector LIMIT $${params.push(limit)}`,
      params,
    );
    const cparams: unknown[] = [vec, embedding.model];
    const cwhere = InvoicesService.filters(filters, cparams);
    const chunkHits = await this.db.query<{ id: string; score: number; snippet: string; page: number }>(
      `SELECT DISTINCT ON (i.id) i.id, 1 - (c.embedding <=> $1::vector) AS score, left(c.content, 220) AS snippet, c.page_number AS page
         FROM (SELECT * FROM document_chunks WHERE embedding IS NOT NULL AND embedding_model = $2 ORDER BY embedding <=> $1::vector LIMIT 200) c
         JOIN invoices i ON i.document_id = c.document_id
              AND (i.page_start IS NULL OR c.page_number BETWEEN i.page_start AND coalesce(i.page_end, i.page_start))
        ${cwhere.length ? `WHERE ${cwhere.join(' AND ')}` : ''}
        ORDER BY i.id, score DESC LIMIT $${cparams.push(limit)}`,
      cparams,
    );
    const merged = new Map<string, Hit>();
    for (const h of [...invoiceHits, ...chunkHits.map((c) => ({ ...c, score: c.score * 0.9 }))]) {
      const prev = merged.get(h.id);
      if (!prev || h.score > prev.score) merged.set(h.id, { id: h.id, score: Number(h.score), snippet: (h as Hit).snippet ?? prev?.snippet ?? null, page: (h as Hit).page ?? prev?.page ?? null });
    }
    return { hits: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit), model: embedding.model };
  }

  async search(q: string, mode: SearchMode, filters: Partial<ListInvoicesQuery>, limit = 20) {
    const started = Date.now();
    const pool = Math.max(limit * 3, 30);
    const keyword = mode !== 'semantic' ? await this.keyword(q, filters, pool) : [];
    const sem = mode !== 'keyword' ? await this.semantic(q, filters, pool) : { hits: [], model: null };
    const fused = new Map<string, { id: string; score: number; matchedBy: string[]; snippet: string | null; page: number | null; keywordScore?: number; semanticScore?: number }>();
    const add = (hits: Hit[], label: 'keyword' | 'semantic') =>
      hits.forEach((h, rank) => {
        const entry = fused.get(h.id) ?? { id: h.id, score: 0, matchedBy: [], snippet: null, page: null };
        entry.score += mode === 'hybrid' ? 1 / (RRF_K + rank + 1) : h.score;
        entry.matchedBy.push(label);
        entry.snippet = entry.snippet ?? h.snippet ?? null;
        entry.page = entry.page ?? h.page ?? null;
        if (label === 'keyword') entry.keywordScore = h.score;
        else entry.semanticScore = h.score;
        fused.set(h.id, entry);
      });
    add(keyword, 'keyword');
    add(sem.hits, 'semantic');
    const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    const rows = ranked.length
      ? await this.db.query<Record<string, unknown>>(
          `SELECT i.id, i.document_id, d.original_filename AS filename, d.file_type, i.invoice_number, i.invoice_date, i.supplier_name, i.customer_name,
                  i.currency, i.total, i.status, i.confidence, i.page_start, i.page_end, i.sheet_name
             FROM invoices i JOIN documents d ON d.id = i.document_id WHERE i.id = ANY($1::uuid[])`,
          [ranked.map((r) => r.id)],
        )
      : [];
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    return {
      query: q,
      mode,
      embeddingModel: sem.model,
      tookMs: Date.now() - started,
      results: ranked
        .filter((r) => byId.has(r.id))
        .map((r) => ({ invoice: byId.get(r.id), score: Number(r.score.toFixed(5)), matchedBy: r.matchedBy, snippet: r.snippet, page: r.page, keywordScore: r.keywordScore, semanticScore: r.semanticScore })),
    };
  }
}
