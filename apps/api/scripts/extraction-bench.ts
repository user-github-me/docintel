/**
 * Offline extraction benchmark (development tool).
 * Runs processor output -> segmentation -> rule extraction against eval labels, without the
 * queue/database, so extractor changes can be measured in seconds. Processor results are cached
 * under eval/cache/. The official end-to-end evaluation is eval/run_eval.py (through the REST API).
 *
 *   npx ts-node scripts/extraction-bench.ts --categories pdf_digital,pdf_scanned --split dev [--verbose]
 */
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { segmentPages } from '../src/extraction/segmentation';
import { extractWithRules } from '../src/extraction/rules/rule-extractor';
import { extractFromSheets } from '../src/extraction/spreadsheet/spreadsheet-extractor';
import { PageText, InvoiceDraft } from '../src/extraction/types';
import { normaliseInvoiceNumber } from '../src/common/text';
import { loadConfig } from '../src/config/config';
import { ExtractionEngine } from '../src/extraction/extraction-engine';
import { LlmService } from '../src/extraction/llm/llm.service';

const ROOT = path.resolve(__dirname, '../../../eval');
const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const categories = arg('categories', 'pdf_digital').split(',');
const split = arg('split', 'dev');
const dataDir = arg('data', 'data');
const verbose = args.includes('--verbose');
const useLlm = args.includes('--llm');
const strategy = arg('strategy', 'always') as 'always' | 'fallback';
const level = arg('level', '');
const limit = Number(arg('limit', '0'));
const only = arg('only', '');
const PROCESSOR = process.env.PROCESSOR_URL ?? 'http://localhost:8000';

const FIELDS = ['invoice_number', 'invoice_date', 'due_date', 'supplier_name', 'customer_name', 'currency', 'subtotal', 'tax', 'total'] as const;

async function pagesFor(label: any): Promise<PageText[]> {
  const cacheDir = path.join(ROOT, 'cache', dataDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${label.doc_id}.json`);
  let out: any;
  if (fs.existsSync(cacheFile)) out = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  else {
    const res = await fetch(`${PROCESSOR}/v1/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storage_key: `_eval/${dataDir}/${label.file}`, page_start: 1, page_end: 200 }),
    });
    out = await res.json();
    if (res.ok) fs.writeFileSync(cacheFile, JSON.stringify(out));
  }
  if (out.sheets?.length) {
    return out.sheets.map((s: any) => ({ page_number: s.index + 1, kind: 'sheet', text: s.text, ocr_confidence: null, sheet_name: s.name, table_data: s.rows }));
  }
  return (out.pages ?? []).map((p: any) => ({
    page_number: p.page_number, kind: p.method, text: p.text, ocr_confidence: p.ocr_confidence, lines: p.lines,
  }));
}

const norm = (s: any) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().toLowerCase());
function same(field: string, a: any, b: any): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (['subtotal', 'tax', 'total'].includes(field)) return new Decimal(a).minus(new Decimal(b)).abs().lt(0.005);
  if (field === 'invoice_number') return normaliseInvoiceNumber(a) === normaliseInvoiceNumber(b);
  return norm(a) === norm(b);
}

async function main() {
  const labels = fs.readFileSync(path.join(ROOT, dataDir, 'labels.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((l) => categories.includes(l.category) && (split === 'all' || l.split === split) && !l.expect_failure && (!only || l.doc_id.includes(only)))
    .filter((l) => !level || (l.degradation?.level ?? 'digital') === level)
    .slice(0, limit || undefined);
  const config = loadConfig({ LLM_STRATEGY: strategy });
  const llmService = new LlmService(config);
  const engine = new ExtractionEngine(
    { strategy, visionFallback: true, visionMaxPages: config.LLM_VISION_MAX_PAGES, visionBelowOcrConf: config.LLM_VISION_BELOW_OCR_CONF },
    llmService,
    async (doc, pageNo) => {
      const res = await fetch(`${PROCESSOR}/v1/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storage_key: doc.storage_key, page: pageNo, dpi: 150, max_side: 2000 }) });
      return Buffer.from(await res.arrayBuffer());
    },
    (m) => console.warn(m),
  );
  const llmTotals = { calls: 0, input: 0, output: 0, ms: 0, failures: 0 };
  const stats: Record<string, { ok: number; n: number }> = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, n: 0 }]));
  let items = { tp: 0, gt: 0, pred: 0 };
  const byLevel: Record<string, { ok: number; n: number }> = {};
  let invoices = { gt: 0, pred: 0, matched: 0 };
  for (const label of labels) {
    const pages = await pagesFor(label);
    let drafts: InvoiceDraft[];
    if (useLlm) {
      const t0 = Date.now();
      const out = await engine.extractDocument({ id: label.doc_id, storage_key: `_eval/${dataDir}/${label.file}`, original_filename: label.file, file_type: label.file_type }, pages);
      llmTotals.calls += out.llm.calls; llmTotals.input += out.llm.inputTokens; llmTotals.output += out.llm.outputTokens; llmTotals.ms += Date.now() - t0; llmTotals.failures += out.llm.failures;
      drafts = out.drafts;
    } else {
      drafts = pages.length && pages.every((p) => p.kind === 'sheet')
        ? extractFromSheets(pages).drafts
        : segmentPages(pages).map((s) => extractWithRules(s));
    }
    invoices.gt += label.invoices.length;
    invoices.pred += drafts.length;
    for (const gt of label.invoices) {
      const match = drafts.find((d) => normaliseInvoiceNumber(d.fields.invoice_number.value) === normaliseInvoiceNumber(gt.invoice_number))
        ?? (label.invoices.length === 1 && drafts.length >= 1 ? drafts[0] : undefined);
      if (match) invoices.matched++;
      const wrong: string[] = [];
      for (const f of FIELDS) {
        const pred = match?.fields[f].value ?? null;
        stats[f].n++;
        const level = label.degradation?.level ?? 'digital';
        byLevel[level] = byLevel[level] ?? { ok: 0, n: 0 };
        byLevel[level].n++;
        if (same(f, pred, gt[f])) { stats[f].ok++; byLevel[level].ok++; }
        else wrong.push(`${f}: got ${JSON.stringify(pred)} want ${JSON.stringify(gt[f])}`);
      }
      const gtItems = gt.line_items ?? [];
      const predItems = match?.line_items ?? [];
      items.gt += gtItems.length;
      items.pred += predItems.length;
      const used = new Set<number>();
      for (const gi of gtItems) {
        const k = predItems.findIndex((p, idx) => !used.has(idx) && p.amount && new Decimal(p.amount).eq(new Decimal(gi.amount)));
        if (k >= 0) { used.add(k); items.tp++; }
      }
      if (verbose && (wrong.length || predItems.length !== gtItems.length)) {
        console.log(`${label.doc_id} [${gt.invoice_number}] items ${predItems.length}/${gtItems.length}\n   ` + wrong.join('\n   '));
      }
    }
  }
  console.log(`\n${labels.length} docs, invoices gt=${invoices.gt} pred=${invoices.pred} matched=${invoices.matched}`);
  if (useLlm) console.log(`  LLM (${llmService.info().provider}/${llmService.info().model}, ${strategy}): calls=${llmTotals.calls} failures=${llmTotals.failures} input_tokens=${llmTotals.input} output_tokens=${llmTotals.output} avg_doc_ms=${Math.round(llmTotals.ms / Math.max(1, labels.length))}`);
  let okSum = 0, nSum = 0;
  for (const f of FIELDS) {
    const s = stats[f];
    okSum += s.ok; nSum += s.n;
    console.log(`  ${f.padEnd(15)} ${((100 * s.ok) / Math.max(1, s.n)).toFixed(1).padStart(5)}%  (${s.ok}/${s.n})`);
  }
  console.log('  by level: ' + Object.entries(byLevel).map(([k, v]) => `${k} ${((100 * v.ok) / v.n).toFixed(1)}%`).join(' | '));
  const p = items.tp / Math.max(1, items.pred), r = items.tp / Math.max(1, items.gt);
  console.log(`  ${'ALL FIELDS'.padEnd(15)} ${((100 * okSum) / nSum).toFixed(1).padStart(5)}%`);
  console.log(`  line items     P=${(100 * p).toFixed(1)}% R=${(100 * r).toFixed(1)}% F1=${((200 * p * r) / Math.max(1e-9, p + r)).toFixed(1)}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
