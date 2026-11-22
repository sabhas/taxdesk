import { describe, expect, it } from 'vitest';
import {
  InvoiceDraftCreateRequestSchema,
  WhatsAppPhoneSchema,
  buildInvoiceShareMessage,
  formatShareDate,
  InvoiceItemInputSchema,
  InvoiceDraftUpdateRequestSchema,
  RecordPaymentRequestSchema,
  VoidInvoiceRequestSchema,
  calculateInvoiceTotals,
  caseLineDescription,
  formatInvoiceNumber,
  groupLinesByClient,
  formatReceiptNumber,
  paymentStatusFor,
} from './billing.js';

const item = (quantity: number, unitAmountMinor: number) => ({
  description: 'Return filing',
  quantity,
  unitAmountMinor,
});

describe('calculateInvoiceTotals', () => {
  it('sums line totals and subtracts the discount', () => {
    const result = calculateInvoiceTotals([item(2, 150_000), item(1, 50_000)], 25_000);
    expect(result).toEqual({
      ok: true,
      totals: {
        lineTotalsMinor: [300_000, 50_000],
        subtotalMinor: 350_000,
        discountMinor: 25_000,
        totalMinor: 325_000,
      },
    });
  });

  it('accepts an empty draft with a zero total', () => {
    const result = calculateInvoiceTotals([], 0);
    expect(result.ok && result.totals.totalMinor).toBe(0);
  });

  it('rejects a discount above the subtotal', () => {
    const result = calculateInvoiceTotals([item(1, 1_000)], 1_001);
    expect(result).toMatchObject({ ok: false, field: 'discountMinor' });
  });

  it('rejects negative, fractional and unsafe discounts', () => {
    for (const discount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(calculateInvoiceTotals([item(1, 1_000)], discount).ok).toBe(false);
    }
  });

  it.each([
    ['zero quantity', item(0, 100)],
    ['negative quantity', item(-1, 100)],
    ['fractional quantity', item(1.5, 100)],
    ['negative amount', item(1, -100)],
    ['fractional amount', item(1, 10.5)],
  ])('rejects a malformed line: %s', (_name, line) => {
    expect(calculateInvoiceTotals([line], 0)).toMatchObject({ ok: false, field: 'items.0' });
  });

  it('guards against overflow near the firm-wide ceiling', () => {
    expect(calculateInvoiceTotals([item(1, 1_000_000_000_000)], 0).ok).toBe(true);
    expect(calculateInvoiceTotals([item(2, 1_000_000_000_000)], 0).ok).toBe(false);
    expect(calculateInvoiceTotals([item(1, 600_000_000_000), item(1, 600_000_000_000)], 0).ok).toBe(
      false,
    );
    expect(calculateInvoiceTotals([item(Number.MAX_SAFE_INTEGER, 2)], 0).ok).toBe(false);
  });

  it('rejects too many line items', () => {
    const items = Array.from({ length: 51 }, () => item(1, 1));
    expect(calculateInvoiceTotals(items, 0)).toMatchObject({ ok: false, field: 'items' });
  });
});

describe('numbers and status', () => {
  it('formats gapless numbers', () => {
    expect(formatInvoiceNumber(1)).toBe('INV-00001');
    expect(formatReceiptNumber(12_345)).toBe('RCP-12345');
    expect(formatInvoiceNumber(123_456)).toBe('INV-123456');
  });

  it('derives payment status', () => {
    expect(paymentStatusFor(1_000, 0)).toBe('unpaid');
    expect(paymentStatusFor(1_000, 400)).toBe('partially_paid');
    expect(paymentStatusFor(1_000, 1_000)).toBe('paid');
  });
});

describe('request schemas', () => {
  const id = '0190a8e2-7b3c-7a1e-8d4f-123456789abc';

  it('needs exactly one of client or case to draft', () => {
    expect(InvoiceDraftCreateRequestSchema.safeParse({ clientId: id }).success).toBe(true);
    expect(InvoiceDraftCreateRequestSchema.safeParse({ caseId: id }).success).toBe(true);
    expect(InvoiceDraftCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(InvoiceDraftCreateRequestSchema.safeParse({ clientId: id, caseId: id }).success).toBe(
      false,
    );
  });

  it('starts a combined invoice from a client only (TD-511)', () => {
    expect(
      InvoiceDraftCreateRequestSchema.safeParse({ clientId: id, billingMode: 'combined' }).success,
    ).toBe(true);
    expect(
      InvoiceDraftCreateRequestSchema.safeParse({ caseId: id, billingMode: 'combined' }).success,
    ).toBe(false);
    expect(
      InvoiceDraftCreateRequestSchema.safeParse({ clientId: id, billingMode: 'group' }).success,
    ).toBe(false);
  });

  it('accepts a line client and case, but no case without a client (TD-511)', () => {
    const base = { description: 'Filing', quantity: 1, unitAmountMinor: 100 };
    expect(InvoiceItemInputSchema.safeParse({ ...base, clientId: id }).success).toBe(true);
    expect(InvoiceItemInputSchema.safeParse({ ...base, clientId: id, caseId: id }).success).toBe(
      true,
    );
    expect(InvoiceItemInputSchema.safeParse({ ...base, caseId: id }).success).toBe(false);
  });

  it('never accepts client-supplied totals', () => {
    const base = { items: [], discountMinor: 0, issueDate: null, dueDate: null, notes: '' };
    expect(InvoiceDraftUpdateRequestSchema.safeParse(base).success).toBe(true);
    expect(InvoiceDraftUpdateRequestSchema.safeParse({ ...base, totalMinor: 5 }).success).toBe(
      false,
    );
  });

  it('rejects a due date before the issue date', () => {
    const parsed = InvoiceDraftUpdateRequestSchema.safeParse({
      items: [],
      discountMinor: 0,
      issueDate: '2026-02-10',
      dueDate: '2026-02-09',
      notes: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects zero payments and requires explicit void confirmation', () => {
    const base = { method: 'cash', receivedOn: '2026-02-10' };
    expect(RecordPaymentRequestSchema.safeParse({ ...base, amountMinor: 0 }).success).toBe(false);
    expect(RecordPaymentRequestSchema.safeParse({ ...base, amountMinor: 1 }).success).toBe(true);
    expect(VoidInvoiceRequestSchema.safeParse({ reason: 'Mistake', confirm: false }).success).toBe(
      false,
    );
    expect(VoidInvoiceRequestSchema.safeParse({ reason: 'Mistake', confirm: true }).success).toBe(
      true,
    );
  });
});

describe('combined invoice helpers (TD-511)', () => {
  it('groups lines by client in first-appearance order with subtotals', () => {
    const groups = groupLinesByClient([
      { clientId: 'b', lineTotalMinor: 100 },
      { clientId: 'a', lineTotalMinor: 50 },
      { clientId: 'b', lineTotalMinor: 25 },
      { clientId: null, lineTotalMinor: 999 },
    ]);
    expect(
      groups.map((group) => [group.clientId, group.subtotalMinor, group.items.length]),
    ).toEqual([
      ['b', 125, 2],
      ['a', 50, 1],
    ]);
  });

  it('describes a case line by service and tax year within the description limit', () => {
    expect(caseLineDescription('Income tax return', 2026)).toBe(
      'Income tax return (tax year 2026)',
    );
    expect(caseLineDescription('x'.repeat(400), 2026)).toHaveLength(300);
  });
});

describe('invoice share message (TD-513)', () => {
  const base = {
    firmName: 'Synthetic Tax Firm',
    clientName: 'Example Traders',
    invoiceNumber: 'INV-00012',
    currency: 'PKR',
    totalMinor: 2_500_000,
    outstandingMinor: 1_000_000,
    dueDate: '2026-11-30',
  };

  it('states the number, total, outstanding amount, due date, and firm', () => {
    expect(buildInvoiceShareMessage(base)).toBe(
      [
        'Dear Example Traders,',
        '',
        'Please find attached invoice INV-00012 from Synthetic Tax Firm.',
        'Total: PKR 25,000.00',
        'Outstanding: PKR 10,000.00',
        'Due date: 30 Nov 2026',
        '',
        'Thank you,',
        'Synthetic Tax Firm',
      ].join('\n'),
    );
  });

  it('marks a settled invoice and omits a missing due date', () => {
    const message = buildInvoiceShareMessage({ ...base, outstandingMinor: 0, dueDate: null });
    expect(message).toContain('Outstanding: PKR 0.00 (paid in full)');
    expect(message).not.toContain('Due date');
  });

  it('formats dates without depending on the device locale', () => {
    expect(formatShareDate('2026-01-05')).toBe('5 Jan 2026');
    expect(formatShareDate('not-a-date')).toBe('not-a-date');
  });

  it('accepts only wa.me phone digits', () => {
    expect(WhatsAppPhoneSchema.safeParse('923001234567').success).toBe(true);
    for (const bad of ['+923001234567', '03001234567', '12', '9230012345678901']) {
      expect(WhatsAppPhoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
