import type {
  CaseActivityAction,
  CaseField,
  CaseUrgency,
  ChecklistItemState,
  DuplicateCasePolicy,
  WorkflowStatusKind,
} from '@taxdesk/shared';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export const STATUS_KIND_LABELS: Readonly<Record<WorkflowStatusKind, string>> = {
  open: 'Open',
  filed: 'Filed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const STATUS_KIND_BADGE: Readonly<Record<WorkflowStatusKind, BadgeVariant>> = {
  open: 'outline',
  filed: 'default',
  completed: 'success',
  cancelled: 'secondary',
};

export const CHECKLIST_STATE_LABELS: Readonly<Record<ChecklistItemState, string>> = {
  open: 'To do',
  completed: 'Completed',
  verified: 'Verified',
  rejected: 'Returned',
};

export const CHECKLIST_STATE_BADGE: Readonly<Record<ChecklistItemState, BadgeVariant>> = {
  open: 'outline',
  completed: 'default',
  verified: 'success',
  rejected: 'destructive',
};

export const DUPLICATE_POLICY_LABELS: Readonly<Record<DuplicateCasePolicy, string>> = {
  warn: 'Warn and require a reason',
  block: 'Block',
};

export const CASE_FIELD_LABELS: Readonly<Record<CaseField, string>> = {
  dueDate: 'Due date',
  notes: 'Notes',
  primaryConsultant: 'Primary consultant',
  reviewer: 'Reviewer',
};

export const CASE_ACTIVITY_LABELS: Readonly<Record<CaseActivityAction, string>> = {
  'case.created': 'Opened the case',
  'case.updated': 'Updated the case',
  'case.status_changed': 'Changed the status',
  'case.archived': 'Archived the case',
  'case.duplicate_override': 'Overrode a duplicate-case warning',
  'case.checklist_completed': 'Completed a checklist item',
  'case.checklist_reopened': 'Reopened a checklist item',
  'case.checklist_verified': 'Verified a checklist item',
  'case.checklist_rejected': 'Returned a checklist item',
};

export function urgencyLabel(urgency: CaseUrgency): string | null {
  if (urgency === 'overdue') return 'Overdue';
  if (urgency === 'due_soon') return 'Due soon';
  return null;
}

/** Due dates are calendar dates, so format them without shifting time zones. */
export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/** Pakistani tax years end on 30 June: tax year 2026 covers July 2025–June 2026. */
export function taxYearLabel(taxYear: number): string {
  return `Tax year ${String(taxYear)}`;
}
