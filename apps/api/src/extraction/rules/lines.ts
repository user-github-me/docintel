import { PageText, Segment } from '../types';
import { findDates } from '../normalize/date';

/** A text cell: a run of text separated from its neighbours by 2+ spaces (a layout column). */
export interface Cell {
  text: string;
  start: number;
  end: number;
}

export interface DocLine {
  idx: number;
  page: number;
  text: string;
  cells: Cell[];
  bbox: number[] | null;
  conf: number | null;
  /** OCR confidence of the page the line belongs to (null for digital text). */
  pageConf: number | null;
}

export function splitCells(text: string): Cell[] {
  const cells: Cell[] = [];
  const re = /\S+(?: \S+)*/g; // words separated by single spaces form one cell
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    cells.push({ text: m[0], start, end: start + m[0].length });
  }
  return cells;
}

/** Flatten segment pages into lines, keeping page number and bounding boxes for evidence. */
export function toDocLines(segment: Segment | { pages: PageText[] }): DocLine[] {
  const out: DocLine[] = [];
  for (const page of segment.pages) {
    const pageConf = page.kind === 'ocr' ? page.ocr_confidence : null;
    const texts = page.text.split('\n');
    // page.lines (from the processor) skip blank lines; map them back by order of non-empty text
    const boxes = (page.lines ?? []).slice();
    let b = 0;
    for (const text of texts) {
      if (!text.trim()) continue;
      let bbox: number[] | null = null;
      let conf: number | null = null;
      if (b < boxes.length && boxes[b].text === text) {
        bbox = boxes[b].bbox;
        conf = boxes[b].conf;
        b++;
      }
      out.push({ idx: out.length, page: page.page_number, text, cells: splitCells(text), bbox, conf, pageConf });
    }
  }
  return out;
}

/**
 * Replace dates, times, percentages and long identifiers with spaces (same length, so column
 * positions survive) before looking for amounts: "VAT (20%)" must not yield an amount of 20.
 */
export function maskNonAmounts(text: string): string {
  let masked = text;
  const blank = (s: string) => ' '.repeat(s.length);
  for (const d of findDates(masked)) {
    masked = masked.slice(0, d.index) + blank(d.raw) + masked.slice(d.index + d.raw.length);
  }
  masked = masked
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank) // times
    .replace(/\d+(?:[.,]\d+)?\s?%/g, blank) // percentages
    .replace(/\+\d[\d\s()-]{7,}\d/g, blank) // phone numbers
    .replace(/\b[A-Z]{2}\d{2}(?: ?\d{4}){3,}/g, blank); // IBAN-like
  return masked;
}

export const PAGE_FOOTER = /\bpage\s+\d+\s*(?:of|\/)\s*\d+\b|^\s*-?\s*\d+\s*-?\s*$|continued|cont'd|carried\s+forward|brought\s+forward/i;
