import { companySimilarity, normaliseCompany, normaliseInvoiceNumber, partialSimilarity } from './text';

describe('text normalisation', () => {
  it('normalises invoice numbers and company names for matching', () => {
    expect(normaliseInvoiceNumber('INV-2026/001')).toBe(normaliseInvoiceNumber('inv 2026 001'));
    expect(normaliseCompany('Acme Supplies Ltd.')).toBe(normaliseCompany('ACME SUPPLIES LIMITED'));
    expect(normaliseCompany('Café Délices S.A.')).toBe('cafe delices');
  });

  it('scores company names robustly (suffixes, order, truncation)', () => {
    expect(companySimilarity('Acme Supplies Ltd', 'ACME Supplies Limited')).toBe(1);
    expect(companySimilarity('Shaw & Ramos Healthcare', 'Shaw & Ramos Healthcare Supplies Pty. Ltd.')).toBeGreaterThanOrEqual(0.85);
    expect(companySimilarity('Northwind Traders', 'Contoso Logistics')).toBeLessThan(0.5);
  });

  it('finds fuzzy substrings for OCR-damaged evidence', () => {
    expect(partialSimilarity('daviesdunnnursingservicesltd', 'fromdaviesdunnnursingserviceslidbilledto')).toBeGreaterThan(0.9);
  });
});
