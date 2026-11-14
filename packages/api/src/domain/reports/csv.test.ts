import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, formatMinorAsDecimal } from './csv.js';

describe('csv', () => {
  it('quotes commas, quotes, and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(2026)).toBe('2026');
  });

  it('neutralizes spreadsheet formulas', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcell']) {
      expect(csvCell(value).replace(/^"/u, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('-12.50')).toBe('-12.50');
  });

  it('formats minor units without floating point', () => {
    expect(formatMinorAsDecimal(0)).toBe('0.00');
    expect(formatMinorAsDecimal(5)).toBe('0.05');
    expect(formatMinorAsDecimal(1_234_550)).toBe('12345.50');
    expect(formatMinorAsDecimal(-250)).toBe('-2.50');
  });

  it('joins rows with CRLF', () => {
    expect(buildCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
});
