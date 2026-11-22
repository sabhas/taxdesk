import { PDFDocument } from 'pdf-lib';
import { JPEG_LOGO, PNG_LOGO, imageCount } from '../../../testing/logo-fixtures.js';
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
  billingMode: 'individual',
  items: [
    {
      description: 'Income tax return',
      quantity: 1,
      unitAmountMinor: 1_500_000,
      lineTotalMinor: 1_500_000,
      clientId: null,
      clientName: null,
      caseCode: null,
    },
    {
      description: 'Advisory hours',
      quantity: 3,
      unitAmountMinor: 250_000,
      lineTotalMinor: 750_000,
      clientId: null,
      clientName: null,
      caseCode: null,
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

describe('combined invoice layout (TD-511)', () => {
  const head = '0198a000-0000-7000-8000-0000000000c1';
  const member = '0198a000-0000-7000-8000-0000000000c2';
  const line = (
    description: string,
    lineTotalMinor: number,
    clientId: string,
    clientName: string,
    caseCode: string | null = null,
  ) => ({
    description,
    quantity: 1,
    unitAmountMinor: lineTotalMinor,
    lineTotalMinor,
    clientId,
    clientName,
    caseCode,
  });
  const combined: InvoicePdfSnapshot = {
    ...invoice,
    caseCode: null,
    billingMode: 'combined',
    client: { clientCode: 'CL-00010', displayName: 'Group Head Holdings' },
    items: [
      line('Group advisory', 200_000, head, 'Group Head Holdings'),
      line('Return filing', 1_500_000, member, 'Member One', 'TC-00009'),
      line('Wealth statement', 100_000, member, 'Member One'),
      line('Notice reply', 300_000, head, 'Group Head Holdings'),
    ],
    subtotalMinor: 2_100_000,
    discountMinor: 100_000,
    totalMinor: 2_000_000,
  };

  it('groups lines under each client name with a subtotal, then the discount and total', () => {
    const layout = buildInvoiceLayout(combined);
    expect(layout.rows.map((row) => row.cells)).toEqual([
      ['Group Head Holdings', '', '', ''],
      ['Group advisory', '1', '2,000.00', '2,000.00'],
      ['Notice reply', '1', '3,000.00', '3,000.00'],
      ['Subtotal for Group Head Holdings', '', '', '5,000.00'],
      ['Member One', '', '', ''],
      ['Return filing (TC-00009)', '1', '15,000.00', '15,000.00'],
      ['Wealth statement', '1', '1,000.00', '1,000.00'],
      ['Subtotal for Member One', '', '', '16,000.00'],
    ]);
    expect(layout.rows.filter((row) => row.emphasis === true).map((row) => row.cells[0])).toEqual([
      'Group Head Holdings',
      'Member One',
    ]);
    expect(layout.summary.map((row) => row.cells)).toEqual([
      ['Subtotal', 'PKR 21,000.00'],
      ['Discount', '- PKR 1,000.00'],
      ['Total', 'PKR 20,000.00'],
    ]);
    const header = layout.header.map((entry) => entry.text).join('\n');
    expect(header).toContain('Billed to: Group Head Holdings (CL-00010)');
    expect(header).toContain('Combined invoice for the Group Head Holdings group');
  });

  it('prints names only, never a CNIC or NTN', async () => {
    const layout = buildInvoiceLayout(combined);
    const text = JSON.stringify(layout);
    expect(text).not.toMatch(/\d{5}-\d{7}-\d/u);
    expect(text).not.toMatch(/NTN|CNIC/u);
    const bytes = await createPdfRenderer().render(layout);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
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

describe('firm logo (TD-512)', () => {
  it('draws a PNG or JPEG logo and leaves the text and metadata unchanged', async () => {
    const renderer = createPdfRenderer();
    const plain = await renderer.render(buildInvoiceLayout(invoice));
    expect(await imageCount(plain)).toBe(0);
    for (const logo of [
      { contentType: 'image/png' as const, bytes: PNG_LOGO },
      { contentType: 'image/jpeg' as const, bytes: JPEG_LOGO },
    ]) {
      const branded = await renderer.render({ ...buildInvoiceLayout(invoice), logo });
      expect(await imageCount(branded)).toBeGreaterThan(0);
      const loaded = await PDFDocument.load(branded);
      expect(loaded.getTitle()).toBe('Invoice INV-00012');
      expect(loaded.getPageCount()).toBe(1);
    }
    const receiptBytes = await renderer.render({
      ...buildReceiptLayout(receipt),
      logo: { contentType: 'image/png', bytes: PNG_LOGO },
    });
    expect(await imageCount(receiptBytes)).toBeGreaterThan(0);
  });

  it('renders the same bytes for the same snapshot and logo', async () => {
    const renderer = createPdfRenderer();
    const layout = {
      ...buildInvoiceLayout(invoice),
      logo: { contentType: 'image/png' as const, bytes: PNG_LOGO },
    };
    const first = await renderer.render(layout);
    const second = await renderer.render(layout);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
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
      clientId: null,
      clientName: null,
      caseCode: null,
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
