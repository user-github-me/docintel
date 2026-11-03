import * as fs from 'fs';
import * as path from 'path';
import { PageText } from '../../src/extraction/types';

export function page(text: string, page_number = 1, kind: PageText['kind'] = 'text', ocr_confidence: number | null = null): PageText {
  return { page_number, kind, text, ocr_confidence, lines: null };
}

/** Processor output snapshot (test/fixtures/processor/<file>.json) -> PageText[] as stored by the pipeline. */
export function snapshotPages(file: string): PageText[] {
  const out = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/processor', `${file}.json`), 'utf8'));
  if (out.sheets?.length) {
    return out.sheets.map((s: any) => ({ page_number: s.index + 1, kind: 'sheet', text: s.text, ocr_confidence: null, sheet_name: s.name, table_data: s.rows }));
  }
  return out.pages.map((p: any) => ({ page_number: p.page_number, kind: p.method, text: p.text, ocr_confidence: p.ocr_confidence, lines: p.lines }));
}

export function fixtureLabels(): any[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../fixtures/labels.json'), 'utf8'));
}
