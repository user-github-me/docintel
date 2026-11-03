import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { invoiceSemanticText } from '../invoices/invoice-text';
import { ProcessorClient } from '../processor/processor.client';

const toVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

/** Builds the semantic index: one vector per invoice summary plus vectors for raw-text chunks. */
@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, private readonly db: DatabaseService, private readonly processor: ProcessorClient) {}

  static chunk(text: string, size = 1200, overlap = 150): string[] {
    const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) return [];
    const out: string[] = [];
    for (let i = 0; i < clean.length; i += size - overlap) {
      out.push(clean.slice(i, i + size));
      if (i + size >= clean.length) break;
    }
    return out;
  }

  private async embed(texts: string[]): Promise<{ model: string; vectors: number[][] }> {
    const vectors: number[][] = [];
    let model = '';
    for (let i = 0; i < texts.length; i += 64) {
      const res = await this.processor.embed(texts.slice(i, i + 64), 'passage');
      model = res.model;
      vectors.push(...res.vectors);
    }
    return { model, vectors };
  }

  async indexInvoices(documentId: string, invoiceIds?: string[]): Promise<number> {
    const rows = await this.db.query<{ id: string; invoice_number: string | null; supplier_name: string | null; customer_name: string | null; invoice_date: string | null; currency: string | null; total: string | null; subtotal: string | null; tax: string | null; items: string[] }>(
      `SELECT i.id, i.invoice_number, i.supplier_name, i.customer_name, i.invoice_date::text, i.currency, i.total, i.subtotal, i.tax,
              coalesce(array_agg(li.description ORDER BY li.position) FILTER (WHERE li.description IS NOT NULL), '{}') AS items
         FROM invoices i LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
        WHERE i.document_id = $1 AND ($2::uuid[] IS NULL OR i.id = ANY($2))
        GROUP BY i.id`,
      [documentId, invoiceIds ?? null],
    );
    if (!rows.length) return 0;
    const { model, vectors } = await this.embed(rows.map((r) => invoiceSemanticText(r)));
    await this.db.query(
      `UPDATE invoices AS i SET embedding = v.embedding::vector, embedding_model = $2
         FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, embedding text) WHERE i.id = v.id`,
      [JSON.stringify(rows.map((r, k) => ({ id: r.id, embedding: toVector(vectors[k]) }))), model],
    );
    return rows.length;
  }

  async indexDocument(documentId: string): Promise<{ invoices: number; chunks: number }> {
    if (!this.config.EMBEDDINGS_ENABLED) return { invoices: 0, chunks: 0 };
    const invoices = await this.indexInvoices(documentId);
    const pages = await this.db.query<{ page_number: number; text: string }>(`SELECT page_number, text FROM document_pages WHERE document_id = $1 ORDER BY page_number`, [documentId]);
    const chunks: Array<{ page: number; index: number; content: string }> = [];
    for (const p of pages) IndexingService.chunk(p.text).forEach((content, index) => chunks.push({ page: p.page_number, index, content }));
    await this.db.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
    if (chunks.length) {
      const { model, vectors } = await this.embed(chunks.map((c) => c.content));
      for (let i = 0; i < chunks.length; i += 500) {
        const slice = chunks.slice(i, i + 500).map((c, k) => ({ ...c, embedding: toVector(vectors[i + k]) }));
        await this.db.query(
          `INSERT INTO document_chunks (document_id, page_number, chunk_index, content, embedding, embedding_model)
           SELECT $1, c.page, c.index, c.content, c.embedding::vector, $3 FROM jsonb_to_recordset($2::jsonb) AS c(page int, index int, content text, embedding text)`,
          [documentId, JSON.stringify(slice), model],
        );
      }
    }
    await this.db.query('UPDATE documents SET indexed_at = now() WHERE id = $1', [documentId]);
    return { invoices, chunks: chunks.length };
  }
}
