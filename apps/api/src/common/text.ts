/** Text normalisation and similarity helpers used by extraction, validation and search. */

const LEGAL_SUFFIXES =
  /\b(?:limited|ltd|llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|plc|pvt|private|gmbh|ag|kg|sarl|sa|s\.a|bv|b\.v|nv|pty|pte|llp|lp|oy|ab|as|srl|spa|kft|sro|enterprise|enterprises|traders?|group)\b\.?/gi;

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Invoice numbers compare without case, spaces and punctuation: "INV-001" == "inv 001". */
export function normaliseInvoiceNumber(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n || null;
}

/** Company names compare without legal suffixes/punctuation: "Acme Ltd." == "ACME Limited". */
export function normaliseCompany(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n || null;
}

/** Loose matching key for grounding: lowercase alphanumerics only. */
export function matchKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1 similarity (1 = identical). */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 0;
}

/** Best similarity of `needle` against any equally long window of `haystack` (both pre-normalised). */
export function partialSimilarity(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return 1;
  if (needle.length > haystack.length) return similarity(needle, haystack);
  let best = 0;
  const n = needle.length;
  const step = n > 40 ? 2 : 1;
  for (let i = 0; i + n <= haystack.length; i += step) {
    if (haystack[i] !== needle[0] && haystack[i + n - 1] !== needle[n - 1]) continue;
    const s = similarity(needle, haystack.slice(i, i + n));
    if (s > best) best = s;
    if (best === 1) break;
  }
  return best;
}

export function companySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normaliseCompany(a);
  const nb = normaliseCompany(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // token-set similarity is robust to word order and extra words ("Acme Supplies" vs "Acme Supplies UK")
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const tokenScore = inter / Math.max(ta.size, tb.size);
  // one name fully contained in the other ("Acme Healthcare" vs "Acme Healthcare Supplies"): same party
  const contained = Math.min(ta.size, tb.size) >= 2 && inter === Math.min(ta.size, tb.size) ? 0.9 : 0;
  return Math.max(tokenScore, contained, similarity(na, nb));
}
