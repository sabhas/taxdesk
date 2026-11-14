import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_TEMPLATES,
  ImportDryRunRequestSchema,
  formatImportBatchCode,
  importReasonMessage,
  IMPORT_REASON_CODES,
  parseCsv,
  templateCsv,
} from './imports.js';

const TEMPLATE_DIRECTORY = new URL('../../../docs/templates/imports/', import.meta.url);

describe('published import templates (TD-701)', () => {
  it('match the committed CSV files byte for byte', async () => {
    for (const template of IMPORT_TEMPLATES) {
      const file = `${template.id.replace('.', '-').replaceAll('_', '-')}.csv`;
      const committed = await readFile(fileURLToPath(new URL(file, TEMPLATE_DIRECTORY)), 'utf8');
      expect(committed).toBe(templateCsv(template));
    }
  });

  it('give every column a format, description, and an example of the right width', () => {
    for (const template of IMPORT_TEMPLATES) {
      expect(template.columns[0]?.name).toBe('external_ref');
      for (const column of template.columns) {
        expect(column.format.length).toBeGreaterThan(0);
        expect(column.description.length).toBeGreaterThan(0);
      }
      for (const example of template.examples) {
        expect(example).toHaveLength(template.columns.length);
      }
    }
  });

  it('use only synthetic identifiers and example.test contacts in examples', () => {
    const all = IMPORT_TEMPLATES.map(templateCsv).join('\n');
    for (const match of all.matchAll(/\b(\d{5})-\d{7}-\d\b/gu)) {
      expect(match[1]).toBe('00000');
    }
    for (const match of all.matchAll(/@([a-z.]+)/gu)) {
      expect(match[1]).toBe('example.test');
    }
  });
});

describe('parseCsv', () => {
  it('handles a BOM, CRLF and LF, quoted commas, doubled quotes, and newlines in quotes', () => {
    const result = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n\n');
    expect(result).toEqual({
      ok: true,
      rows: [
        ['a', 'b'],
        ['x, y', 'he said "hi"'],
        ['multi\nline', 'z'],
      ],
    });
  });

  it('reports malformed input by line and code without the content', () => {
    expect(parseCsv('a,b\r\nx,"open')).toEqual({ ok: false, line: 2, code: 'UNTERMINATED_QUOTE' });
    expect(parseCsv('a,b\r\nx,y"z\r\n')).toEqual({
      ok: false,
      line: 2,
      code: 'QUOTE_IN_UNQUOTED_FIELD',
    });
    expect(parseCsv('a,b\r\n"x"y,z\r\n')).toEqual({ ok: false, line: 2, code: 'TEXT_AFTER_QUOTE' });
    expect(parseCsv('a\u0000b')).toEqual({ ok: false, line: 1, code: 'BINARY_CONTENT' });
    expect(parseCsv('')).toEqual({ ok: false, line: 1, code: 'EMPTY_FILE' });
    expect(parseCsv(`h\n${'x'.repeat(5_000)}\n`)).toMatchObject({
      ok: false,
      code: 'CELL_TOO_LONG',
    });
    expect(parseCsv('h\n1\n2\n3\n', 2)).toMatchObject({ ok: false, code: 'TOO_MANY_ROWS' });
  });
});

describe('import contracts', () => {
  it('bound the file size and name', () => {
    const ok = ImportDryRunRequestSchema.safeParse({
      template: 'clients.v1',
      fileName: 'clients.csv',
      content: 'a',
    });
    expect(ok.success).toBe(true);
    expect(
      ImportDryRunRequestSchema.safeParse({
        template: 'clients.v1',
        fileName: '../etc/passwd',
        content: 'a',
      }).success,
    ).toBe(false);
    expect(
      ImportDryRunRequestSchema.safeParse({
        template: 'clients.v1',
        fileName: 'x.csv',
        content: 'x'.repeat(2 * 1024 * 1024 + 1),
      }).success,
    ).toBe(false);
  });

  it('format batch codes and give every reason a fixed message', () => {
    expect(formatImportBatchCode(42)).toBe('IMP-00042');
    expect(() => formatImportBatchCode(0)).toThrow();
    for (const code of IMPORT_REASON_CODES) {
      expect(importReasonMessage(code).length).toBeGreaterThan(0);
    }
  });
});
