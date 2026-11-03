/**
 * End-to-end tests through the public HTTP API of a running deployment (docker compose or local).
 * They exercise the real queue, workers, processor (OCR) and database - nothing is mocked.
 */
import * as fs from 'fs';
import * as path from 'path';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const KEY = process.env.E2E_API_KEY ?? 'dev-admin-key-change-me';
const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const runTag = `e2e-${Date.now()}`;

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}/api/v1${p}`, {
    method,
    headers: { 'X-API-Key': KEY, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Pipeline tests upload as "reference" documents with allowDuplicates so they are deterministic on a
 * non-empty database (no content-hash linking, no duplicate-invoice flags from earlier runs).
 */
const ISOLATED = '?purpose=reference&allowDuplicates=true';
async function upload(files: Array<{ fixture: string; as?: string }>, query = ISOLATED) {
  const form = new FormData();
  for (const f of files) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, f.fixture)));
    form.append('files', new Blob([bytes]), f.as ?? `${runTag}-${f.fixture}`);
  }
  return api('POST', `/documents${query}`, form);
}

async function waitDone(id: string, timeoutMs = 180000) {
  const started = Date.now();
  for (;;) {
    const { body } = await api('GET', `/documents/${id}/status`);
    if (['completed', 'failed', 'duplicate'].includes(body.status)) return body;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${id} (${body.status})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function invoicesOf(documentId: string) {
  return (await api('GET', `/invoices?documentId=${documentId}&pageSize=100&sort=created_at&order=asc`)).body.items;
}

describe('security', () => {
  it('health is public, everything else requires a valid API key', async () => {
    expect((await fetch(`${API}/health`)).status).toBe(200);
    expect((await fetch(`${API}/api/v1/documents`)).status).toBe(401);
    expect((await fetch(`${API}/api/v1/documents`, { headers: { 'X-API-Key': 'wrong-key-123456' } })).status).toBe(401);
  });

  it('rejects unsupported, empty and executable uploads with reasons', async () => {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('hello')]), 'notes.docx');
    form.append('files', new Blob([Buffer.alloc(0)]), 'empty.pdf');
    form.append('files', new Blob([Buffer.from('MZ\x90\x00binary')]), 'invoice.pdf');
    const { status, body } = await api('POST', '/documents', form);
    expect(status).toBe(201);
    expect(body.documents).toHaveLength(0);
    expect(body.rejected.map((r: { code: string }) => r.code).sort()).toEqual(['empty_file', 'unsupported_format', 'unsupported_format']);
  });

  it('validates input (unknown query params, bad UUIDs)', async () => {
    expect((await api('GET', '/documents?evil=1')).status).toBe(400);
    expect((await api('GET', '/invoices/not-a-uuid')).status).toBe(400);
  });
});

describe('document pipeline', () => {
  let digitalId: string;
  let registerId: string;
  let corruptedId: string;
  let scannedId: string;

  beforeAll(async () => {
    const { status, body } = await upload([{ fixture: 'invoice_digital.pdf' }, { fixture: 'register.xlsx' }, { fixture: 'corrupted.pdf' }, { fixture: 'invoice_scanned.png' }]);
    expect(status).toBe(201);
    [digitalId, registerId, corruptedId, scannedId] = body.documents.map((d: { id: string }) => d.id);
    await Promise.all([digitalId, registerId, corruptedId, scannedId].map((id) => waitDone(id)));
  });

  it('extracts a digital PDF invoice with evidence for every value', async () => {
    const [inv] = await invoicesOf(digitalId);
    expect(inv).toMatchObject({ invoice_number: 'INV-2026-1493', total: '4639.6400', currency: 'AUD' });
    const detail = (await api('GET', `/invoices/${inv.id}`)).body;
    expect(detail.fields.invoice_number.evidence.text).toContain('INV-2026-1493');
    expect(detail.lineItems.length).toBe(4);
  });

  it('OCRs a scanned image', async () => {
    const doc = (await api('GET', `/documents/${scannedId}`)).body;
    expect(doc).toMatchObject({ status: 'completed', ocrPages: 1 });
    expect(doc.avgOcrConfidence).toBeGreaterThan(0.5);
    const pages = (await api('GET', `/documents/${scannedId}/pages`)).body.items;
    expect(pages[0].kind).toBe('ocr');
  });

  it('parses a spreadsheet register into one invoice per row', async () => {
    const invoices = await invoicesOf(registerId);
    expect(invoices).toHaveLength(5);
  });

  it('fails a corrupted file with a typed error and does not retry it', async () => {
    const doc = (await api('GET', `/documents/${corruptedId}`)).body;
    expect(doc).toMatchObject({ status: 'failed', errorCode: 'corrupted_file' });
    const events = (await api('GET', `/documents/${corruptedId}/events`)).body.items;
    expect(events.filter((e: { status: string }) => e.status === 'retrying')).toHaveLength(0);
  });

  it('links byte-identical re-uploads to the original instead of reprocessing', async () => {
    const { body } = await upload([{ fixture: 'invoice_digital.pdf', as: `${runTag}-copy.pdf` }], '');
    expect(body.documents[0].status).toBe('duplicate');
    expect(body.documents[0].duplicateOf).toBeTruthy();
  });

  it('serves page images and the original file', async () => {
    const img = await fetch(`${API}/api/v1/documents/${digitalId}/pages/1/image`, { headers: { 'X-API-Key': KEY } });
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    const file = await fetch(`${API}/api/v1/documents/${digitalId}/file`, { headers: { 'X-API-Key': KEY } });
    expect(file.headers.get('content-disposition')).toContain('attachment');
  });

  it('reprocesses failed jobs on request', async () => {
    const { status, body } = await api('POST', `/documents/${corruptedId}/reprocess`, {});
    expect(status).toBe(202);
    expect(body.runId).toBe(2);
    expect((await waitDone(corruptedId)).status).toBe('failed');
  });

  it('manual corrections: optimistic locking, audit trail, re-validation, approval rules', async () => {
    const [inv] = await invoicesOf(digitalId);
    const before = (await api('GET', `/invoices/${inv.id}`)).body;
    expect((await api('PATCH', `/invoices/${inv.id}`, { version: before.version + 5, fields: { total: '1.00' } })).status).toBe(409);

    // A wrong total must trigger TOTAL_MISMATCH and route the invoice to review
    const broken = (await api('PATCH', `/invoices/${inv.id}`, { version: before.version, fields: { total: '5000.00' }, reason: 'e2e test' })).body;
    expect(broken.status).toBe('needs_review');
    expect(broken.issues.map((i: { code: string }) => i.code)).toContain('TOTAL_MISMATCH');
    expect(broken.fields.total).toMatchObject({ value: '5000.00', source: 'manual' });
    expect((await api('POST', `/invoices/${inv.id}/approve`, {})).status).toBe(422);

    const fixed = (await api('PATCH', `/invoices/${inv.id}`, { version: broken.version, fields: { total: '4639.64' }, reason: 'restore' })).body;
    expect(fixed.issues.map((i: { code: string }) => i.code)).not.toContain('TOTAL_MISMATCH');
    expect(fixed.is_corrected).toBe(true);
    const approved = await api('POST', `/invoices/${inv.id}/approve`, { note: 'checked' });
    expect(approved.body.status).toBe('approved');
    const history = (await api('GET', `/invoices/${inv.id}/history`)).body;
    expect(history.corrections.length).toBeGreaterThanOrEqual(2);

    // re-extraction would discard human corrections: requires force
    expect((await api('POST', `/documents/${digitalId}/reprocess`, {})).status).toBe(409);
  });

  it('keyword and hybrid search find processed invoices', async () => {
    const kw = (await api('GET', '/search?q=INV-2026-1493&mode=keyword')).body;
    expect(kw.results[0].invoice.invoice_number).toBe('INV-2026-1493');
    const hybrid = (await api('GET', '/search?q=Clearview%20Networks%20IT%20support&mode=hybrid')).body;
    expect(hybrid.results.length).toBeGreaterThan(0);
  });

  it('cross-verifies two documents (PDF/Excel register vs reference copy)', async () => {
    const copy = await upload([{ fixture: 'register.xlsx', as: `${runTag}-ledger.xlsx` }]);
    const ledgerId = copy.body.documents[0].id;
    await waitDone(ledgerId);
    const rec = (await api('POST', '/reconciliations', { leftDocumentId: registerId, rightDocumentId: ledgerId })).body;
    expect(rec.summary).toMatchObject({ leftCount: 5, rightCount: 5, matched: 5, mismatched: 0 });
  });

  it('reports operational stats and queue depth', async () => {
    const stats = (await api('GET', '/stats')).body;
    expect(stats.documents.total).toBeGreaterThan(0);
    expect(typeof stats.successRate).toBe('number');
    const queues = (await api('GET', '/jobs/stats')).body;
    expect(Object.keys(queues)).toEqual(expect.arrayContaining(['ingest', 'pages', 'analyze', 'index']));
  });
});

describe('live progress (SSE)', () => {
  it('streams document events while processing', async () => {
    const controller = new AbortController();
    const res = await fetch(`${API}/api/v1/events`, { headers: { 'X-API-Key': KEY }, signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { body } = await upload([{ fixture: 'invoice_multi.pdf' }]);
    const id = body.documents[0].id;
    let seen = '';
    const deadline = Date.now() + 60000;
    while (!seen.includes(id) && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    expect(seen).toContain(id);
    expect(seen).toContain('document.updated');
    await waitDone(id);
  });
});
