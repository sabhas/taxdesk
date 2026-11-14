import { z } from 'zod';
import { AuditEventSchema } from './audit.js';
import { CaseListItemSchema, IsoDateSchema, TaxYearSchema } from './case.js';
import { UuidSchema, UuidV7Schema } from './id.js';
import { InvoiceSummarySchema } from './billing.js';
import { MinorAmountSchema } from './service-type.js';
import { WorkflowKeySchema, WorkflowStatusKindSchema } from './workflow.js';

/**
 * Dashboard, report, and audit-explorer contracts (Epic 6). Every count a
 * dashboard shows carries the `href` of the list or report that returns the
 * same rows, and the server computes both from one query definition.
 */

export const REPORT_LIMITS = {
  defaultLimit: 25,
  maxLimit: 100,
  /** The longest date range a report accepts, in days. */
  maxRangeDays: 3660,
  /** Rows a CSV export includes before it stops and says so. */
  csvMaxRows: 10_000,
} as const;

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

function rangeIssue(
  value: { readonly from?: string | undefined; readonly to?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (value.from !== undefined && value.to !== undefined) {
    const days = daysBetween(value.from, value.to);
    if (days < 0) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'The end date must be on or after the start date.',
      });
    } else if (days > REPORT_LIMITS.maxRangeDays) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'Choose a shorter date range.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard (TD-601)
// ---------------------------------------------------------------------------

/** A count and the in-app list or report that returns exactly those rows. */
export const DashboardCountSchema = z
  .object({
    count: z.number().int().min(0),
    href: z.string().min(1).max(300),
  })
  .strict();

export type DashboardCount = z.infer<typeof DashboardCountSchema>;

export const DashboardAmountSchema = z
  .object({
    count: z.number().int().min(0),
    amountMinor: MinorAmountSchema,
    href: z.string().min(1).max(300),
  })
  .strict();

export type DashboardAmount = z.infer<typeof DashboardAmountSchema>;

export const DashboardWorkSectionSchema = z
  .object({
    assigned: DashboardCountSchema,
    overdue: DashboardCountSchema,
    dueSoon: DashboardCountSchema,
    checklistGaps: DashboardCountSchema,
    filing: z
      .object({
        inProgress: DashboardCountSchema,
        filed: DashboardCountSchema,
        completed: DashboardCountSchema,
      })
      .strict(),
  })
  .strict();

export type DashboardWorkSection = z.infer<typeof DashboardWorkSectionSchema>;

export const WorkloadRowSchema = z
  .object({
    /** `null` is the unassigned row. */
    userId: UuidSchema.nullable(),
    displayName: z.string().nullable(),
    open: DashboardCountSchema,
    overdue: DashboardCountSchema,
    dueSoon: DashboardCountSchema,
    reviewing: DashboardCountSchema,
  })
  .strict();

export type WorkloadRow = z.infer<typeof WorkloadRowSchema>;

export const DashboardManagementSectionSchema = z
  .object({
    unassigned: DashboardCountSchema,
    teamOpen: DashboardCountSchema,
    teamOverdue: DashboardCountSchema,
    reviewQueue: DashboardCountSchema,
    workload: z.array(WorkloadRowSchema),
  })
  .strict();

export type DashboardManagementSection = z.infer<typeof DashboardManagementSectionSchema>;

export const DashboardBillingSectionSchema = z
  .object({
    unpaid: DashboardAmountSchema,
    overdue: DashboardAmountSchema,
    monthStart: IsoDateSchema,
    monthEnd: IsoDateSchema,
    collected: z
      .object({
        receivedMinor: MinorAmountSchema,
        reversedMinor: MinorAmountSchema,
        netMinor: z.number().int(),
        href: z.string().min(1).max(300),
      })
      .strict(),
  })
  .strict();

export type DashboardBillingSection = z.infer<typeof DashboardBillingSectionSchema>;

export const DashboardSummarySchema = z
  .object({
    generatedAt: z.iso.datetime(),
    today: IsoDateSchema,
    dueSoonDays: z.number().int().min(1),
    /** `null` when the signed-in user's roles do not include the section. */
    work: DashboardWorkSectionSchema.nullable(),
    management: DashboardManagementSectionSchema.nullable(),
    billing: DashboardBillingSectionSchema.nullable(),
  })
  .strict();

export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

// ---------------------------------------------------------------------------
// Case and workload reports (TD-602)
// ---------------------------------------------------------------------------

export const REPORT_CASE_STATES = ['active', 'archived', 'all'] as const;
export const ReportCaseStateSchema = z.enum(REPORT_CASE_STATES);
export type ReportCaseState = z.infer<typeof ReportCaseStateSchema>;

const caseReportFields = {
  /** Due-date range, inclusive. */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  service: UuidSchema.optional(),
  status: WorkflowKeySchema.optional(),
  statusKind: WorkflowStatusKindSchema.optional(),
  assignee: UuidSchema.optional(),
  taxYear: z.coerce.number().pipe(TaxYearSchema).optional(),
  state: ReportCaseStateSchema.default('active'),
};

export const CaseReportQuerySchema = z
  .object({
    ...caseReportFields,
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(REPORT_LIMITS.maxLimit)
      .default(REPORT_LIMITS.defaultLimit),
  })
  .strict()
  .superRefine(rangeIssue);

export type CaseReportQuery = z.infer<typeof CaseReportQuerySchema>;

/** The export takes the same filters but no paging. */
export const CaseReportExportQuerySchema = z
  .object(caseReportFields)
  .strict()
  .superRefine(rangeIssue);

export type CaseReportExportQuery = z.infer<typeof CaseReportExportQuerySchema>;

export const CaseReportSchema = z
  .object({
    cases: z.array(CaseListItemSchema),
    nextCursor: z.string().min(1).max(512).nullable(),
    /** Count of every case matching the filters, from the same query. */
    total: z.number().int().min(0),
  })
  .strict();

export type CaseReport = z.infer<typeof CaseReportSchema>;

export const WorkloadReportQuerySchema = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    service: UuidSchema.optional(),
    taxYear: z.coerce.number().pipe(TaxYearSchema).optional(),
  })
  .strict()
  .superRefine(rangeIssue);

export type WorkloadReportQuery = z.infer<typeof WorkloadReportQuerySchema>;

export const WorkloadReportSchema = z
  .object({
    today: IsoDateSchema,
    dueSoonDays: z.number().int().min(1),
    rows: z.array(WorkloadRowSchema),
  })
  .strict();

export type WorkloadReport = z.infer<typeof WorkloadReportSchema>;

// ---------------------------------------------------------------------------
// Billing report (TD-603)
// ---------------------------------------------------------------------------

const billingReportFields = {
  /** Invoices are selected by issue date; payments by received date. */
  from: IsoDateSchema,
  to: IsoDateSchema,
  client: UuidV7Schema.optional(),
};

export const BillingReportQuerySchema = z
  .object({
    ...billingReportFields,
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(REPORT_LIMITS.maxLimit)
      .default(REPORT_LIMITS.defaultLimit),
  })
  .strict()
  .superRefine(rangeIssue);

export type BillingReportQuery = z.infer<typeof BillingReportQuerySchema>;

export const BillingReportExportQuerySchema = z
  .object(billingReportFields)
  .strict()
  .superRefine(rangeIssue);

export type BillingReportExportQuery = z.infer<typeof BillingReportExportQuerySchema>;

const CountAmountSchema = z
  .object({ count: z.number().int().min(0), amountMinor: MinorAmountSchema })
  .strict();

export const BillingReportSchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    today: IsoDateSchema,
    currency: z.string().length(3),
    totals: z
      .object({
        /** Finalized invoices issued in the range. */
        invoiced: CountAmountSchema,
        /** Payments received in the range. */
        collected: CountAmountSchema,
        /** Reversals recorded in the range. */
        reversed: CountAmountSchema,
        netCollectedMinor: z.number().int(),
        /** Invoices issued in the range that still have a balance. */
        outstanding: CountAmountSchema,
        /** Of those, invoices past their due date today. */
        overdue: CountAmountSchema,
      })
      .strict(),
    invoices: z.array(InvoiceSummarySchema),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict();

export type BillingReport = z.infer<typeof BillingReportSchema>;

export const REPORT_EXPORT_KINDS = ['cases', 'billing'] as const;
export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];

// ---------------------------------------------------------------------------
// Audit explorer (TD-604)
// ---------------------------------------------------------------------------

export const AUDIT_EXPLORER_LIMITS = { defaultLimit: 25, maxLimit: 100 } as const;

export const AUDIT_MASKED_VALUE = '[masked]';

export const AuditExplorerQuerySchema = z
  .object({
    actor: UuidSchema.optional(),
    /** Firm-calendar dates, inclusive. */
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    /** An exact action, or a prefix ending in `.*` such as `billing.*`. */
    action: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*(\.([a-z0-9_]+|\*))+$/u, 'Use an action such as billing.*')
      .max(120)
      .optional(),
    entityType: z.string().trim().min(1).max(80).optional(),
    entityId: UuidSchema.optional(),
    requestId: z.string().trim().min(1).max(128).optional(),
    cursor: UuidV7Schema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_EXPLORER_LIMITS.maxLimit)
      .default(AUDIT_EXPLORER_LIMITS.defaultLimit),
  })
  .strict()
  .superRefine(rangeIssue);

export type AuditExplorerQuery = z.infer<typeof AuditExplorerQuerySchema>;

export const AuditExplorerEventSchema = AuditEventSchema.extend({
  actorDisplayName: z.string().nullable(),
}).strict();

export type AuditExplorerEvent = z.infer<typeof AuditExplorerEventSchema>;

export const AuditExplorerListSchema = z
  .object({
    events: z.array(AuditExplorerEventSchema),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type AuditExplorerList = z.infer<typeof AuditExplorerListSchema>;

/**
 * Masks a metadata value for display. Secrets, hashes, and national tax
 * identifiers are replaced; everything else is shown as recorded.
 */
const SENSITIVE_KEY =
  /token|secret|password|passphrase|hash|ciphertext|cnic|ntn|identifier|apikey|api_key|encryption/iu;
const CNIC_VALUE = /\b\d{5}-?\d{7}-?\d\b/u;
const LONG_OPAQUE_VALUE = /^[A-Za-z0-9_+/=-]{40,}$/u;

export function maskAuditMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, string | number | boolean | null> {
  const masked: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || typeof value !== 'string') {
      masked[key] = SENSITIVE_KEY.test(key) ? AUDIT_MASKED_VALUE : value;
      continue;
    }
    masked[key] =
      SENSITIVE_KEY.test(key) || CNIC_VALUE.test(value) || LONG_OPAQUE_VALUE.test(value)
        ? AUDIT_MASKED_VALUE
        : value;
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** First and last calendar day of the month that contains `today`. */
export function monthBounds(today: string): { readonly start: string; readonly end: string } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: `${start.slice(0, 8)}${String(last).padStart(2, '0')}` };
}
