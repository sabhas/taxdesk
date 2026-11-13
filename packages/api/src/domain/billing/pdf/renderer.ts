import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PdfLayout, PdfTextLine } from './layout.js';

/**
 * Turns a layout into PDF bytes. `pdf-lib` is pure JavaScript, so it runs in
 * the Worker. The renderer is behind an interface so tests and a future
 * engine swap never touch the billing domain.
 */
export interface PdfRenderer {
  render(layout: PdfLayout): Promise<Uint8Array>;
}

/**
 * Helvetica draws WinAnsi (Windows-1252). Anything it cannot draw is replaced
 * with `?` instead of failing the whole document; the database record, not the
 * PDF, is the source of truth for the exact text.
 */
export function toWinAnsi(text: string): string {
  let result = '';
  for (const character of text.normalize('NFC')) {
    const code = character.codePointAt(0) ?? 0;
    const printable =
      code >= 0x20 && code !== 0x7f && code <= 0xff && !(code >= 0x80 && code <= 0x9f);
    result += printable ? character : code === 0x09 || code === 0x0a ? ' ' : '?';
  }
  return result;
}

const PAGE = { width: 595.28, height: 841.89, margin: 48 } as const;
const COLORS = { ink: rgb(0.1, 0.1, 0.12), muted: rgb(0.4, 0.42, 0.46), rule: rgb(0.8, 0.8, 0.82) };
const FOOTER_ROOM = 70;

class Cursor {
  page: PDFPage;
  y: number;

  constructor(private readonly document: PDFDocument) {
    this.page = document.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }

  ensure(height: number): void {
    if (this.y - height < PAGE.margin + FOOTER_ROOM / 2) {
      this.page = this.document.addPage([PAGE.width, PAGE.height]);
      this.y = PAGE.height - PAGE.margin;
    }
  }
}

function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }
  let shortened = text;
  while (shortened.length > 1 && font.widthOfTextAtSize(`${shortened}...`, size) > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}...`;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.map((line) => fit(font, line, size, maxWidth));
}

export function createPdfRenderer(): PdfRenderer {
  return {
    render: async (layout) => {
      const document = await PDFDocument.create();
      const regular = await document.embedFont(StandardFonts.Helvetica);
      const bold = await document.embedFont(StandardFonts.HelveticaBold);
      const created = new Date(layout.metadata.createdAt);
      document.setTitle(toWinAnsi(layout.metadata.title));
      document.setSubject(toWinAnsi(layout.metadata.subject));
      document.setKeywords(layout.metadata.keywords.map(toWinAnsi));
      document.setCreator('TaxDesk');
      document.setProducer('TaxDesk');
      document.setCreationDate(created);
      document.setModificationDate(created);

      const cursor = new Cursor(document);
      const contentWidth = PAGE.width - PAGE.margin * 2;

      const drawLine = (line: PdfTextLine): void => {
        const heading = line.kind === 'heading';
        const size = heading ? 22 : 10.5;
        const font = heading ? bold : regular;
        for (const piece of wrap(font, toWinAnsi(line.text), size, contentWidth)) {
          cursor.ensure(size + 6);
          cursor.page.drawText(piece, {
            x: PAGE.margin,
            y: cursor.y - size,
            size,
            font,
            color: line.kind === 'muted' ? COLORS.muted : COLORS.ink,
          });
          cursor.y -= size + (heading ? 10 : 5);
        }
      };

      for (const line of layout.header) {
        drawLine(line);
      }
      cursor.y -= 12;

      // The first column takes what the right-aligned columns leave.
      const rightWidth = layout.columns.length === 2 ? 190 : 96;
      const columnWidths = layout.columns.map((_, index) =>
        index === 0 ? contentWidth - rightWidth * (layout.columns.length - 1) : rightWidth,
      );
      const drawRow = (
        cells: readonly string[],
        options: { readonly heading?: boolean; readonly emphasis?: boolean },
      ): void => {
        const font = options.heading === true || options.emphasis === true ? bold : regular;
        const size = options.emphasis === true ? 12 : 10;
        const wrapped = cells.map((cell, index) =>
          wrap(font, toWinAnsi(cell), size, (columnWidths[index] ?? rightWidth) - 8),
        );
        const height = Math.max(...wrapped.map((lines) => lines.length), 1) * (size + 4) + 6;
        cursor.ensure(height);
        let x = PAGE.margin;
        wrapped.forEach((lines, index) => {
          const width = columnWidths[index] ?? rightWidth;
          const align = layout.columns[index]?.align ?? 'left';
          lines.forEach((piece, lineIndex) => {
            const textWidth = font.widthOfTextAtSize(piece, size);
            cursor.page.drawText(piece, {
              x: align === 'right' ? x + width - 4 - textWidth : x + 4,
              y: cursor.y - size - lineIndex * (size + 4),
              size,
              font,
              color: COLORS.ink,
            });
          });
          x += width;
        });
        cursor.y -= height;
        cursor.page.drawLine({
          start: { x: PAGE.margin, y: cursor.y + 2 },
          end: { x: PAGE.margin + contentWidth, y: cursor.y + 2 },
          thickness: 0.5,
          color: COLORS.rule,
        });
      };

      drawRow(
        layout.columns.map((column) => column.title),
        { heading: true },
      );
      for (const row of layout.rows) {
        drawRow(row.cells, { emphasis: row.emphasis === true });
      }

      cursor.y -= 10;
      for (const row of layout.summary) {
        const [label = '', value = ''] = row.cells;
        const font = row.emphasis === true ? bold : regular;
        const size = row.emphasis === true ? 12 : 10.5;
        cursor.ensure(size + 8);
        const valueText = toWinAnsi(value);
        cursor.page.drawText(toWinAnsi(label), {
          x: PAGE.margin + contentWidth - 250,
          y: cursor.y - size,
          size,
          font,
          color: COLORS.ink,
        });
        cursor.page.drawText(valueText, {
          x: PAGE.margin + contentWidth - 4 - font.widthOfTextAtSize(valueText, size),
          y: cursor.y - size,
          size,
          font,
          color: COLORS.ink,
        });
        cursor.y -= size + 8;
      }

      cursor.y -= 14;
      for (const line of layout.footer) {
        drawLine(line);
      }

      return await document.save();
    },
  };
}
