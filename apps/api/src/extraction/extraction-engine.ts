import { buildGroundingContext } from './grounding';
import { buildDocumentText } from './llm/prompt';
import { LlmImage, LlmRequest, LlmResult } from './llm/provider';
import { mergeDrafts } from './merge';
import { extractWithRules } from './rules/rule-extractor';
import { segmentPages } from './segmentation';
import { extractFromSheets } from './spreadsheet/spreadsheet-extractor';
import { CRITICAL_FIELDS, InvoiceDraft, PageText, Segment } from './types';

export interface ExtractionOutcome {
  drafts: InvoiceDraft[];
  notes: string[];
  llm: { calls: number; inputTokens: number; outputTokens: number; failures: number; visionPages: number };
}

export interface DocRef {
  id: string;
  storage_key: string;
  original_filename: string;
  file_type: string | null;
}

export interface EngineSettings {
  strategy: 'always' | 'fallback' | 'never';
  visionFallback: boolean;
  visionMaxPages: number;
  visionBelowOcrConf: number;
}

export interface LlmGateway {
  readonly enabled: boolean;
  extract(request: LlmRequest): Promise<LlmResult>;
}

export type PageRenderer = (doc: DocRef, page: number) => Promise<Buffer>;

/**
 * Framework-free extraction pipeline for one document: segment -> rules -> (LLM per strategy) -> merge.
 * Cascade ("fallback"): the LLM is called only when the deterministic result is incomplete,
 * inconsistent or comes from a weak scan, which keeps cost proportional to difficulty.
 */
export class ExtractionEngine {
  constructor(
    private readonly settings: EngineSettings,
    private readonly llm: LlmGateway,
    private readonly render: PageRenderer,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {}

  async extractDocument(doc: DocRef, pages: PageText[]): Promise<ExtractionOutcome> {
    const outcome: ExtractionOutcome = { drafts: [], notes: [], llm: { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0, visionPages: 0 } };
    if (pages.length && pages.every((p) => p.kind === 'sheet')) {
      const { drafts, notes } = extractFromSheets(pages);
      outcome.drafts = drafts;
      outcome.notes.push(...notes);
      return outcome;
    }
    const segments = segmentPages(pages);
    if (segments.length > 1) outcome.notes.push(`split into ${segments.length} invoices (${[...new Set(segments.map((s) => s.reason))].join('; ')})`);
    outcome.drafts = await Promise.all(segments.map((seg) => this.extractSegment(doc, seg, outcome)));
    return outcome;
  }

  shouldUseLlm(rules: InvoiceDraft): boolean {
    if (!this.llm.enabled || this.settings.strategy === 'never') return false;
    if (this.settings.strategy === 'always') return true;
    const f = rules.fields;
    if (CRITICAL_FIELDS.some((k) => !f[k].value || f[k].confidence < 0.85)) return true;
    if (!f.customer_name.value && rules.document_type !== 'receipt') return true;
    if (!f.subtotal.value && !f.tax.value) return true;
    if (rules.notes.some((n) => n.includes('do not reconcile'))) return true;
    if (rules.ocr_confidence !== null && rules.ocr_confidence < 0.85) return true;
    if (!rules.line_items.length) return true;
    return false;
  }

  private async pageImages(doc: DocRef, seg: Segment): Promise<LlmImage[]> {
    if (!this.settings.visionFallback || !['pdf', 'image'].includes(doc.file_type ?? '')) return [];
    // A page average hides a garbled totals block, so the bar is high; header (first) and totals
    // (last) pages go first, then the weakest pages, up to the cap.
    const candidates = seg.pages.filter((p) => p.kind === 'ocr' && (p.ocr_confidence ?? 0) < this.settings.visionBelowOcrConf);
    const first = seg.pages[0];
    const last = seg.pages[seg.pages.length - 1];
    const ordered = [...candidates].sort((a, b) => {
      const rank = (p: PageText) => (p === last ? 0 : p === first ? 1 : 2);
      return rank(a) - rank(b) || (a.ocr_confidence ?? 0) - (b.ocr_confidence ?? 0);
    });
    const weak = ordered.slice(0, this.settings.visionMaxPages).sort((a, b) => a.page_number - b.page_number);
    const images: LlmImage[] = [];
    for (const page of weak) {
      try {
        const jpeg = await this.render(doc, page.page_number);
        images.push({ page: page.page_number, mediaType: 'image/jpeg', base64: jpeg.toString('base64') });
      } catch (err) {
        this.warn(`could not render page ${page.page_number} of ${doc.id}: ${(err as Error).message}`);
      }
    }
    return images;
  }

  async extractSegment(doc: DocRef, seg: Segment, outcome: ExtractionOutcome): Promise<InvoiceDraft> {
    const rules = extractWithRules(seg);
    if (!this.shouldUseLlm(rules)) return rules;
    const images = await this.pageImages(doc, seg);
    const { text, truncated } = buildDocumentText(seg.pages);
    try {
      const result = await this.llm.extract({ documentText: text, images });
      outcome.llm.calls++;
      outcome.llm.inputTokens += result.usage.input_tokens;
      outcome.llm.outputTokens += result.usage.output_tokens;
      outcome.llm.visionPages += images.length;
      const merged = mergeDrafts(rules, result.output, buildGroundingContext(seg.pages), result.usage);
      if (truncated) merged.notes.push('document text was too long and was truncated for AI extraction');
      return merged;
    } catch (err) {
      outcome.llm.failures++;
      this.warn(`LLM extraction failed for ${doc.id} pages ${seg.page_start}-${seg.page_end}: ${(err as Error).message}`);
      rules.issues.push({
        code: 'AI_EXTRACTION_FAILED',
        severity: 'info',
        message: `AI extraction was unavailable (${(err as Error).message}); result is from deterministic rules only.`,
      });
      return rules;
    }
  }
}
