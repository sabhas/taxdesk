import { describe, expect, it } from 'vitest';
import {
  InvoiceDraftCreateRequestSchema,
  InvoiceDraftUpdateRequestSchema,
  RecordPaymentRequestSchema,
  VoidInvoiceRequestSchema,
  calculateInvoiceTotals,
  formatInvoiceNumber,
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
