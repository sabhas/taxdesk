import { describe, expect, it } from 'vitest';
import {
  CaseCreateRequestSchema,
  CaseListQuerySchema,
  CaseUpdateRequestSchema,
  ChecklistRejectRequestSchema,
  IsoDateSchema,
  addDaysToDate,
  calendarDateIn,
  checklistProgress,
  formatCaseCode,
  isChecklistItemSatisfied,
} from './case.js';
import { formatMinorAmount, parseMajorAmount } from './service-type.js';

const A = '0198a000-0000-7000-8000-000000000001';
const B = '0198a000-0000-7000-8000-000000000002';

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    clientId: A,
    serviceTypeId: A,
    taxYear: 2026,
    workflowVersionId: A,
    dueDate: '2026-09-30',
    primaryConsultantUserId: A,
    reviewerUserId: B,
    ...overrides,
  };
}

describe('case contracts', () => {
  it('formats case codes', () => {
    expect(formatCaseCode(42)).toBe('TC-00042');
    expect(() => formatCaseCode(0)).toThrow();
  });

  it('requires client, service, tax year, workflow version, and due date', () => {
    expect(CaseCreateRequestSchema.safeParse(createRequest()).success).toBe(true);
    for (const field of ['clientId', 'serviceTypeId', 'taxYear', 'workflowVersionId', 'dueDate']) {
      const request = Object.fromEntries(
        Object.entries(createRequest()).filter(([key]) => key !== field),
      );
      expect(CaseCreateRequestSchema.safeParse(request).success, field).toBe(false);
    }
  });

  it('rejects a reviewer who is also the primary consultant', () => {
    const result = CaseCreateRequestSchema.safeParse(createRequest({ reviewerUserId: A }));
    expect(result.success).toBe(false);
  });

  it('has no status field on case edits', () => {
    const edit = {
      dueDate: '2026-10-01',
      notes: '',
      primaryConsultantUserId: A,
      reviewerUserId: null,
    };
    expect(CaseUpdateRequestSchema.safeParse(edit).success).toBe(true);
    expect(CaseUpdateRequestSchema.safeParse({ ...edit, status: 'completed' }).success).toBe(false);
  });

  it('validates real calendar dates', () => {
    expect(IsoDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(IsoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(IsoDateSchema.safeParse('30/09/2026').success).toBe(false);
  });

  it('computes calendar dates in the firm timezone', () => {
    // 20:00 UTC is already the next day in Karachi (UTC+5).
    expect(calendarDateIn('Asia/Karachi', new Date('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    expect(addDaysToDate('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('requires a comment to reject a checklist item', () => {
    expect(ChecklistRejectRequestSchema.safeParse({ comment: '  ' }).success).toBe(false);
    expect(ChecklistRejectRequestSchema.safeParse({ comment: 'Wrong year' }).success).toBe(true);
  });

  it('counts checklist progress and satisfaction', () => {
    const items = [
      { state: 'verified', required: true, reviewRequired: true },
      { state: 'completed', required: true, reviewRequired: true },
      { state: 'completed', required: true, reviewRequired: false },
      { state: 'open', required: false, reviewRequired: false },
      { state: 'rejected', required: true, reviewRequired: true },
    ] as const;
    expect(checklistProgress(items)).toEqual({
      total: 5,
      required: 4,
      completed: 3,
      verified: 1,
      requiredOutstanding: 2,
    });
    expect(isChecklistItemSatisfied({ state: 'completed', reviewRequired: true })).toBe(false);
    expect(isChecklistItemSatisfied({ state: 'completed', reviewRequired: false })).toBe(true);
  });

  it('defaults the list to the team queue and coerces query strings', () => {
    const parsed = CaseListQuerySchema.parse({ taxYear: '2026', limit: '10' });
    expect(parsed).toMatchObject({ view: 'team', taxYear: 2026, limit: 10 });
    expect(CaseListQuerySchema.safeParse({ view: 'everything' }).success).toBe(false);
  });
});

describe('money helpers', () => {
  it('parses and formats minor units without floating point', () => {
    expect(parseMajorAmount('1,500')).toBe(150_000);
    expect(parseMajorAmount('1500.5')).toBe(150_050);
    expect(parseMajorAmount('0.07')).toBe(7);
    expect(parseMajorAmount('-1')).toBeNull();
    expect(parseMajorAmount('1.234')).toBeNull();
    expect(formatMinorAmount(150_050)).toBe('1,500.50');
  });
});
