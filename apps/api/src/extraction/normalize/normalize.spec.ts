import { detectNumberLocale, findAmounts, parseAmount } from './amount';
import { detectCurrency, normaliseCurrency } from './currency';
import { detectDateOrder, findDates, parseDate } from './date';

describe('parseAmount', () => {
  it.each([
    ['1,234.56', '1234.56'],
    ['$1,234.56', '1234.56'],
    ['USD 1,234.56', '1234.56'],
    ['1.234,56 €', '1234.56'],
    ['1 234,50', '1234.5'],
    ['1,23,456.00', '123456'],
    ['(45.00)', '-45'],
    ['-323.50', '-323.5'],
    ['12.50-', '-12.5'],
    ['Tk 2,01,725.00', '201725'],
    ['706.1', '706.1'],
    ['1,234', '1234'],
  ])('%s -> %s', (raw, expected) => {
    expect(parseAmount(raw)?.toString()).toBe(expected);
  });

  it('respects the document locale for ambiguous grouping', () => {
    expect(parseAmount('1.234', 'comma')?.toString()).toBe('1234');
    expect(parseAmount('1.234', 'dot')?.toString()).toBe('1.234');
    expect(parseAmount('23.012,48', 'comma')?.toString()).toBe('23012.48');
  });

  it('refuses text that is not a clean number (never guesses)', () => {
    for (const raw of ['abc', '12 34 56', '1,2,3', '', 'N/A']) expect(parseAmount(raw)).toBeNull();
  });

  it('finds amounts in a line and detects locale', () => {
    expect(findAmounts('Subtotal      4,217.85').map((a) => a.value.toString())).toEqual(['4217.85']);
    expect(detectNumberLocale('Total 1.234,56 €\nVAT 234,56')).toBe('comma');
    expect(detectNumberLocale('Total 1,234.56\nVAT 234.56')).toBe('dot');
  });
});

describe('dates', () => {
  it('parses common invoice formats', () => {
    expect(parseDate('Invoice Date: 14/07/2026')?.iso).toBe('2026-07-14');
    expect(parseDate('27.03.2025')?.iso).toBe('2025-03-27');
    expect(parseDate('July 31, 2025')?.iso).toBe('2025-07-31');
    expect(parseDate('14 Mar 2026')?.iso).toBe('2026-03-14');
    expect(parseDate('2026-11-03')?.iso).toBe('2026-11-03');
    expect(parseDate('Dated: 3rd January 2026')?.iso).toBe('2026-01-03');
  });

  it('flags ambiguous day/month order and resolves it with the document convention', () => {
    const dmy = findDates('04/11/2025', 'dmy')[0];
    expect(dmy).toMatchObject({ iso: '2025-11-04', ambiguous: true });
    expect(findDates('04/11/2025', 'mdy')[0].iso).toBe('2025-04-11');
    expect(findDates('23/02/2025', 'mdy')[0]).toMatchObject({ iso: '2025-02-23', ambiguous: false });
  });

  it('rejects impossible dates', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('99/99/2026')).toBeNull();
  });

  it('detects date order from unambiguous dates, then currency', () => {
    expect(detectDateOrder('Date 23/02/2025 Due 03/04/2025')).toBe('dmy');
    expect(detectDateOrder('Date 02/23/2025')).toBe('mdy');
    expect(detectDateOrder('Date 03/04/2025', 'USD')).toBe('mdy');
  });
});

describe('currency', () => {
  it('prefers explicit codes and unambiguous symbols', () => {
    expect(detectCurrency(['Total (AUD)  $4,639.64'])?.code).toBe('AUD');
    expect(detectCurrency(['Grand Total   1.234,56 €'])?.code).toBe('EUR');
    expect(detectCurrency(['Amount (Tk)  40,650.00', 'Total Payable (BDT) 1,59,836.38'])?.code).toBe('BDT');
    expect(normaliseCurrency('£')).toBe('GBP');
  });

  it('does not turn a bare "$" into a currency', () => {
    expect(detectCurrency(['Total $120.00'])).toBeNull();
  });
});
