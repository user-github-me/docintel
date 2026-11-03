export const QUEUE_INGEST = 'ingest';
export const QUEUE_PAGES = 'pages';
export const QUEUE_ANALYZE = 'analyze';
export const QUEUE_INDEX = 'index';
export const FLOW_PRODUCER = 'docintel-flow';
export const ALL_QUEUES = [QUEUE_INGEST, QUEUE_PAGES, QUEUE_ANALYZE, QUEUE_INDEX] as const;

export interface DocJob {
  documentId: string;
  runId: number;
}
export interface PagesJob extends DocJob {
  pageStart: number;
  pageEnd: number | null;
}

/** Errors whose retry cannot succeed (corrupt/encrypted/unsupported input). */
export const PERMANENT_CODES = new Set([
  'corrupted_file', 'encrypted_pdf', 'empty_file', 'unsupported_format', 'file_too_large', 'too_many_pages',
  'image_too_large', 'invalid_path', 'file_not_found', 'invalid_page_range', 'not_renderable',
]);
