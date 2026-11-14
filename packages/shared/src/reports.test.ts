import { describe, expect, it } from 'vitest';
import {
  AuditExplorerQuerySchema,
  BillingReportQuerySchema,
  CaseReportQuerySchema,
  FirmSettingsUpdateSchema,
  maskAuditMetadata,
  monthBounds,
} from './index.js';

describe('reports contracts', () => {
  it('finds the month bounds, including leap February', () => {
    expect(monthBounds('2026-06-15')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(monthBounds('2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('rejects reversed and oversized date ranges', () => {
    expect(CaseReportQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(
      BillingReportQuerySchema.safeParse({ from: '2000-01-01', to: '2026-01-01' }).success,
    ).toBe(false);
    expect(
      BillingReportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success,
    ).toBe(true);
    expect(BillingReportQuerySchema.safeParse({ to: '2026-01-31' }).success).toBe(false);
  });

  it('accepts an action prefix filter and rejects junk', () => {
    expect(AuditExplorerQuerySchema.safeParse({ action: 'billing.*' }).success).toBe(true);
    expect(AuditExplorerQuerySchema.safeParse({ action: 'Billing' }).success).toBe(false);
    expect(AuditExplorerQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('masks sensitive keys and identifier-shaped values', () => {
    expect(
      maskAuditMetadata({
        token: 'x',
        note: '35202-1234567-1',
        plain: 'ok',
        n: 1,
        hashValue: null,
      }),
    ).toEqual({ token: '[masked]', note: '[masked]', plain: 'ok', n: 1, hashValue: '[masked]' });
  });

  it('bounds firm settings', () => {
    const base = { firmName: 'Firm', timezone: 'Asia/Karachi' };
    expect(FirmSettingsUpdateSchema.safeParse({ ...base, dueSoonDays: 60 }).success).toBe(true);
    expect(FirmSettingsUpdateSchema.safeParse({ ...base, dueSoonDays: 61 }).success).toBe(false);
    expect(FirmSettingsUpdateSchema.safeParse({ ...base, invoicePrefix: 'ab' }).success).toBe(
      false,
    );
  });
});
