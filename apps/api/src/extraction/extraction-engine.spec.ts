import { page } from '../../test/helpers/pages';
import { EngineSettings, ExtractionEngine, LlmGateway } from './extraction-engine';
import { extractWithRules } from './rules/rule-extractor';

const COMPLETE = `ACME CARE LTD
Invoice No: AC-77
Invoice Date: 21/03/2026
Bill To: Beta Clinic Ltd
 Description     Qty   Unit Price   Amount
 Visit             1       100.00   100.00
                   Subtotal         100.00
                   VAT 20%           20.00
                   Total (GBP)      120.00
ACME CARE LTD - 1 King St, Leeds - accounts@acmecare.example
Payment to ACME CARE LTD, account 12345678`;

const settings = (strategy: EngineSettings['strategy']): EngineSettings => ({ strategy, visionFallback: true, visionMaxPages: 2, visionBelowOcrConf: 0.75 });
const gateway = (extract: LlmGateway['extract'] = jest.fn(), enabled = true): LlmGateway => ({ enabled, extract });
const render = jest.fn().mockResolvedValue(Buffer.from('jpeg'));
const doc = { id: 'd', storage_key: 'k', original_filename: 'a.pdf', file_type: 'pdf' };

describe('ExtractionEngine cascade', () => {
  it('skips the LLM when the deterministic result is complete and consistent', () => {
    expect(new ExtractionEngine(settings('fallback'), gateway(), render).shouldUseLlm(extractWithRules({ pages: [page(COMPLETE)] }))).toBe(false);
  });

  it('calls the LLM for incomplete or weak-scan results; "always"/"never" override', () => {
    const fallback = new ExtractionEngine(settings('fallback'), gateway(), render);
    expect(fallback.shouldUseLlm(extractWithRules({ pages: [page('Total 12.00')] }))).toBe(true);
    const scan = extractWithRules({ pages: [page(COMPLETE, 1, 'ocr', 0.62)] });
    expect(fallback.shouldUseLlm(scan)).toBe(true);
    expect(new ExtractionEngine(settings('always'), gateway(), render).shouldUseLlm(extractWithRules({ pages: [page(COMPLETE)] }))).toBe(true);
    expect(new ExtractionEngine(settings('never'), gateway(), render).shouldUseLlm(scan)).toBe(false);
    expect(new ExtractionEngine(settings('always'), gateway(jest.fn(), false), render).shouldUseLlm(scan)).toBe(false);
  });

  it('sends page images for low-confidence OCR pages (vision fallback)', async () => {
    const extract = jest.fn().mockRejectedValue(new Error('stop'));
    await new ExtractionEngine(settings('always'), gateway(extract), render).extractDocument(doc, [page(COMPLETE, 1, 'ocr', 0.5)]);
    expect(render).toHaveBeenCalledWith(doc, 1);
    expect(extract.mock.calls[0][0].images).toHaveLength(1);
  });

  it('falls back to the rules result when the LLM fails, with an informational issue', async () => {
    const engine = new ExtractionEngine(settings('always'), gateway(jest.fn().mockRejectedValue(new Error('upstream 503'))), render);
    const outcome = await engine.extractDocument(doc, [page(COMPLETE)]);
    expect(outcome.drafts[0].fields.total.value).toBe('120.00');
    expect(outcome.drafts[0].issues.map((i) => i.code)).toContain('AI_EXTRACTION_FAILED');
    expect(outcome.llm.failures).toBe(1);
  });
});
