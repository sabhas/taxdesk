import type {
  ImportBatchStatus,
  ImportCellError,
  ImportDecision,
  ImportKind,
  ImportPlanCounts,
  ImportReasonCode,
  ImportRowAction,
  ImportRowOutcome,
  ImportTemplateId,
} from '@taxdesk/shared';

export type ImportEntityType = 'client' | 'tax_case' | 'invoice';

export interface ImportEntityRef {
  readonly entityType: ImportEntityType;
  readonly entityId: string;
  /** Business code: `CL-00001`, `TC-00001`, or an invoice number. */
  readonly code: string;
}

export interface ImportBatchRecord {
  readonly id: string;
  readonly batchCode: string;
  readonly kind: ImportKind;
  readonly templateId: ImportTemplateId;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly rowCount: number;
  readonly sourceChecksum: string;
  readonly status: ImportBatchStatus;
  /** Undecided reviews count as `review`; decided ones as `create` or `skip`. */
  readonly plan: ImportPlanCounts;
  readonly sourceAmountMinor: number | null;
  readonly validatedAt: string;
  readonly commitIdempotencyKey: string | null;
  readonly commitStartedAt: string | null;
  readonly commitStartedBy: string | null;
  readonly committedAt: string | null;
  readonly committedBy: string | null;
  readonly discardedAt: string | null;
  readonly discardedBy: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Mutable batch columns; the repository bumps `version` and sets `updatedAt`. */
export interface ImportBatchChanges {
  readonly status: ImportBatchStatus;
  readonly plan: ImportPlanCounts;
  readonly sourceAmountMinor: number | null;
  readonly validatedAt: string;
  readonly commitIdempotencyKey: string | null;
  readonly commitStartedAt: string | null;
  readonly commitStartedBy: string | null;
  readonly committedAt: string | null;
  readonly committedBy: string | null;
  readonly discardedAt: string | null;
  readonly discardedBy: string | null;
}

export interface ImportRowDecisionRecord {
  readonly decision: ImportDecision;
  readonly reason: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/** The dry-run plan of one row. Holds codes and links, never cell values. */
export interface ImportRowPlan {
  readonly rowNumber: number;
  readonly externalRef: string | null;
  readonly action: ImportRowAction;
  readonly reasonCode: ImportReasonCode | null;
  readonly errors: readonly ImportCellError[];
  readonly match: ImportEntityRef | null;
  readonly amountMinor: number | null;
}

export interface ImportRowRecord extends ImportRowPlan {
  readonly id: string;
  readonly batchId: string;
  readonly kind: ImportKind;
  readonly decision: ImportRowDecisionRecord | null;
  readonly outcome: ImportRowOutcome | null;
  readonly outcomeCode: ImportReasonCode | null;
  /** The record this row created, updated, or linked to (lineage). */
  readonly entity: ImportEntityRef | null;
  readonly committedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ImportRowOutcomeInput {
  readonly batchId: string;
  readonly rowNumber: number;
  readonly outcome: ImportRowOutcome;
  readonly outcomeCode: ImportReasonCode | null;
  readonly entity: ImportEntityRef | null;
  readonly at: string;
}

export interface ImportBatchListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ImportRowFilter {
  readonly batchId: string;
  readonly action: ImportRowAction | null;
  readonly outcome: ImportRowOutcome | null;
  readonly afterRowNumber: number | null;
  readonly limit: number;
}

export interface ImportRowTotals {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly pending: number;
  /** Sum of `amountMinor` over rows that created a record. */
  readonly createdAmountMinor: number;
  /** Sum of `amountMinor` over rows that were skipped. */
  readonly skippedAmountMinor: number;
}

export interface ImportReconciliationTotals {
  readonly clientsTotal: number;
  readonly clientsActive: number;
  readonly clientsImported: number;
  readonly casesActive: number;
  readonly casesImported: number;
  readonly casesImportedStillActive: number;
  readonly openingInvoices: number;
  readonly openingTotalMinor: number;
  readonly openingOutstandingMinor: number;
  readonly committedBatches: number;
  readonly failedRows: number;
}

export interface ImportLineageSample {
  readonly kind: ImportKind;
  readonly batchCode: string;
  readonly rowNumber: number;
  readonly externalRef: string;
  readonly entity: ImportEntityRef;
}

/** Row is the effective plan for commit: a decided review becomes create/skip. */
export function effectiveAction(row: {
  readonly action: ImportRowAction;
  readonly decision: ImportRowDecisionRecord | null;
}): ImportRowAction {
  if (row.action === 'review' && row.decision !== null) {
    return row.decision.decision;
  }
  return row.action;
}

export function planCounts(
  rows: readonly {
    readonly action: ImportRowAction;
    readonly decision: ImportRowDecisionRecord | null;
  }[],
): ImportPlanCounts {
  const counts = { create: 0, update: 0, skip: 0, review: 0, error: 0 };
  for (const row of rows) {
    counts[effectiveAction(row)] += 1;
  }
  return counts;
}
