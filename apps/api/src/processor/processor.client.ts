import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';

export class ProcessorError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
  }
}

export interface ProcessorPage {
  page_number: number;
  method: 'text' | 'ocr' | 'empty' | 'error';
  text: string;
  char_count: number;
  lines: Array<{ text: string; bbox: number[]; conf: number | null }>;
  ocr_confidence: number | null;
  width: number;
  height: number;
  warnings: string[];
  ocr_steps: string[];
  duration_ms: number;
}

export interface ProcessorSheet {
  name: string;
  index: number;
  hidden: boolean;
  n_rows: number;
  n_cols: number;
  rows: Array<Array<string | number | null>>;
  text: string;
  warnings: string[];
}

export interface InspectResult {
  file_type: 'pdf' | 'image' | 'xlsx' | 'xls' | 'csv';
  mime_type: string;
  size_bytes: number;
  page_count: number;
  warnings: string[];
  estimated_scanned_ratio?: number;
  sheets?: Array<{ name: string; n_rows: number; n_cols: number; hidden: boolean }>;
}

export interface ExtractResult {
  file_type: InspectResult['file_type'];
  page_count: number;
  pages: ProcessorPage[];
  sheets: ProcessorSheet[];
  warnings: string[];
  duration_ms: number;
}

/** HTTP client for the Python processor. Maps typed errors to permanent vs transient failures. */
@Injectable()
export class ProcessorClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async post<T>(path: string, body: unknown, timeoutMs = this.config.PROCESSOR_TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.PROCESSOR_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ProcessorError('processor_unreachable', `processor request failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error_code?: string; message?: string; retryable?: boolean };
      const retryable = payload.retryable ?? res.status >= 500;
      throw new ProcessorError(payload.error_code ?? `http_${res.status}`, payload.message ?? res.statusText, retryable, res.status);
    }
    return (await res.json()) as T;
  }

  inspect(storageKey: string, originalName: string): Promise<InspectResult> {
    return this.post('/v1/inspect', { storage_key: storageKey, original_name: originalName }, 120_000);
  }

  extract(storageKey: string, originalName: string, pageStart: number, pageEnd: number | null): Promise<ExtractResult> {
    return this.post('/v1/extract', { storage_key: storageKey, original_name: originalName, page_start: pageStart, page_end: pageEnd });
  }

  async embed(texts: string[], kind: 'passage' | 'query' = 'passage'): Promise<{ model: string; dim: number; vectors: number[][] }> {
    return this.post('/v1/embed', { texts, kind }, 300_000);
  }

  async render(storageKey: string, originalName: string, page: number, dpi = 110, maxSide = 1600): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(`${this.config.PROCESSOR_URL}/v1/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storage_key: storageKey, original_name: originalName, page, dpi, max_side: maxSide }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProcessorError('processor_unreachable', (err as Error).message, true);
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error_code?: string; message?: string };
      throw new ProcessorError(payload.error_code ?? `http_${res.status}`, payload.message ?? res.statusText, res.status >= 500, res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async health(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.config.PROCESSOR_URL}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
