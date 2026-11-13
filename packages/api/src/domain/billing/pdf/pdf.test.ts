import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildInvoiceLayout,
  buildReceiptLayout,
  type InvoicePdfSnapshot,
  type ReceiptPdfSnapshot,
} from './layout.js';
import { createPdfRenderer, toWinAnsi } from './renderer.js';

const invoice: InvoicePdfSnapshot = {
  firmName: 'Test Firm',
  invoiceNumber: 'INV-00012',
  currency: 'PKR',
  issueDate: '2026-02-10',
  dueDate: '2026-02-24',
  finalizedAt: '2026-02-10T08:00:00.000Z',
  client: { clientCode: 'CL-00007', displayName: 'Example Traders' },
  caseCode: 'TC-00003',
  items: [
    {
      description: 'Income tax return',
      quantity: 1,
      unitAmountMinor: 1_500_000,
      lineTotalMinor: 1_500_000,
    },
    {
      description: 'Advisory hours',
      quantity: 3,
      unitAmountMinor: 250_000,
      lineTotalMinor: 750_000,
    },
  ],
  subtotalMinor: 2_250_000,
  discountMinor: 50_000,
  totalMinor: 2_200_000,
  notes: 'Thank you.',
};

const receipt: ReceiptPdfSnapshot = {
  firmName: 'Test Firm',
  receiptNumber: 'RCP-00004',
  invoiceNumber: 'INV-00012',
  currency: 'PKR',
  recordedAt: '2026-02-11T08:00:00.000Z',
  receivedOn: '2026-02-11',
  method: 'bank_transfer',
  reference: 'TRX-9',
  amountMinor: 1_000_000,
  invoiceTotalMinor: 2_200_000,
  client: { clientCode: 'CL-00007', displayName: 'Example Traders' },
  caseCode: null,
};

describe('invoice layout', () => {
  it('states the number, client, lines, and totals from the snapshot', () => {
    const layout = buildInvoiceLayout(invoice);
    const header = layout.header.map((line) => line.text).join('\n');
    expect(header).toContain('Invoice number: INV-00012');
    expect(header).toContain('Example Traders (CL-00007)');
    expect(header).toContain('Case: TC-00003');
    expect(layout.rows.map((row) => row.cells)).toEqual([
      ['Income tax return', '1', '15,000.00', '15,000.00'],
      ['Advisory hours', '3', '2,500.00', '7,500.00'],
    ]);
    expect(layout.summary.map((row) => row.cells)).toEqual([
      ['Subtotal', 'PKR 22,500.00'],
      ['Discount', '- PKR 500.00'],
      ['Total', 'PKR 22,000.00'],
    ]);
  });

  it('omits the discount row and case line when there are none', () => {
    const layout = buildInvoiceLayout({
      ...invoice,
      discountMinor: 0,
      caseCode: null,
      dueDate: null,
    });
    expect(layout.summary.map((row) => row.cells[0])).toEqual(['Subtotal', 'Total']);
    expect(layout.header.some((line) => line.text.startsWith('Case:'))).toBe(false);
    expect(layout.header.some((line) => line.text.startsWith('Due date:'))).toBe(false);
  });
});

describe('receipt layout', () => {
  it('states the receipt, invoice, and amount', () => {
    const layout = buildReceiptLayout(receipt);
    expect(layout.summary[0]?.cells).toEqual(['Amount received', 'PKR 10,000.00']);
    expect(layout.rows.map((row) => row.cells[0])).toEqual([
      'Payment method',
      'Reference',
      'Invoice total',
    ]);
  });
});

describe('renderer', () => {
  it('embeds the number, total, currency, and client in the PDF metadata', async () => {
    const bytes = await createPdfRenderer().render(buildInvoiceLayout(invoice));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getTitle()).toBe('Invoice INV-00012');
    expect(loaded.getSubject()).toContain('total PKR 22,000.00');
    expect(loaded.getKeywords()).toBe('INV-00012 CL-00007 PKR 2200000');
    expect(loaded.getCreationDate()?.toISOString()).toBe('2026-02-10T08:00:00.000Z');
    expect(loaded.getPageCount()).toBe(1);
  });

  it('renders the same bytes for the same snapshot', async () => {
    const renderer = createPdfRenderer();
    const first = await renderer.render(buildInvoiceLayout(invoice));
    const second = await renderer.render(buildInvoiceLayout(invoice));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('paginates long invoices', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      description: `Line item ${String(index + 1)} with a fairly long description for wrapping`,
      quantity: 1,
      unitAmountMinor: 1_000,
      lineTotalMinor: 1_000,
    }));
    const bytes = await createPdfRenderer().render(
      buildInvoiceLayout({
        ...invoice,
        items,
        subtotalMinor: 50_000,
        discountMinor: 0,
        totalMinor: 50_000,
      }),
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });

  it('replaces characters Helvetica cannot draw instead of failing', async () => {
    expect(toWinAnsi('Café – محمد')).toBe('Café ? ????');
    const bytes = await createPdfRenderer().render(
      buildInvoiceLayout({
        ...invoice,
        client: { clientCode: 'CL-00007', displayName: 'محمد Traders' },
      }),
    );
    expect(bytes.length).toBeGreaterThan(500);
  });
});
