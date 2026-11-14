/**
 * CSV encoding for report exports (TD-602, TD-603).
 *
 * Cells that a spreadsheet would read as a formula (a leading `=`, `+`, `-`,
 * `@`, tab, or carriage return) are prefixed with an apostrophe, so a client
 * or service name can never run as a formula when someone opens the export.
 */
const FORMULA_START = /^[=+\-@\t\r]/u;
/** A plain signed decimal such as a formatted amount is not a formula. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/u;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** Integer minor units as a plain decimal in major units, e.g. 123450 -> "1234.50". */
export function formatMinorAsDecimal(minor: number, minorUnits = 100): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / minorUnits);
  const fraction = String(absolute % minorUnits).padStart(String(minorUnits - 1).length, '0');
  return `${sign}${String(whole)}.${fraction}`;
}

/** Header row, data rows, and CRLF line endings, as spreadsheets expect. */
export function buildCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return `${[csvRow(header), ...rows.map(csvRow)].join('\r\n')}\r\n`;
}
