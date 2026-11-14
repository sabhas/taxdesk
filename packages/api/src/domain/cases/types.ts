import { isChecklistItemSatisfied } from '@taxdesk/shared';
import type {
  CaseView,
  ChecklistItemState,
  WorkflowStatusDefinition,
  WorkflowStatusKind,
  WorkflowTransitionDefinition,
} from '@taxdesk/shared';

/** The statuses and transitions a case copied from its workflow version. */
export interface WorkflowSnapshot {
  readonly statuses: readonly WorkflowStatusDefinition[];
  readonly transitions: readonly WorkflowTransitionDefinition[];
}

export interface TaxCaseRecord {
  readonly id: string;
  readonly caseCode: string;
  readonly clientId: string;
  /** Read-only join fields, never written. */
  readonly clientCode: string;
  readonly clientDisplayName: string;
  readonly serviceTypeId: string;
  readonly serviceName: string;
  readonly serviceFeeMinor: number;
  readonly taxYear: number;
  readonly workflowVersionId: string;
  readonly workflowTemplateId: string;
  readonly workflowTemplateName: string;
  readonly workflowVersionNumber: number;
  readonly workflowSnapshot: WorkflowSnapshot;
  readonly currentStatusKey: string;
  readonly currentStatusName: string;
  readonly currentStatusKind: WorkflowStatusKind;
  readonly currentStatusHistoryId: string;
  /** Calendar date, `YYYY-MM-DD`. */
  readonly dueDate: string;
  readonly primaryConsultantUserId: string | null;
  readonly reviewerUserId: string | null;
  readonly notes: string;
  readonly createdBy: string | null;
  /** Archive timestamp; `null` while the case is not archived. */
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CaseStatusHistoryRecord {
  readonly id: string;
  readonly caseId: string;
  readonly fromStatusKey: string | null;
  readonly fromStatusName: string | null;
  readonly toStatusKey: string;
  readonly toStatusName: string;
  readonly toStatusKind: WorkflowStatusKind;
  readonly note: string;
  readonly actorUserId: string | null;
  readonly requestId: string;
  readonly occurredAt: string;
}

export interface CaseChecklistItemRecord {
  readonly id: string;
  readonly caseId: string;
  readonly position: number;
  readonly itemKey: string;
  readonly label: string;
  readonly documentType: string | null;
  readonly required: boolean;
  readonly reviewRequired: boolean;
  readonly instructions: string;
  readonly state: ChecklistItemState;
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  readonly preparerComment: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewComment: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The checklist fields a preparer or reviewer action writes. */
export interface ChecklistItemChanges {
  readonly state: ChecklistItemState;
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  readonly preparerComment: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewComment: string;
}

export interface CaseDetailChanges {
  readonly dueDate: string;
  readonly notes: string;
  readonly primaryConsultantUserId: string | null;
  readonly reviewerUserId: string | null;
}

/**
 * One filter for both the queue list and its counts, so a count can never
 * disagree with the list it labels (TD-308).
 */
export interface CaseQueryFilter {
  /**
   * The queue views, plus two used only by reports: `active` (every case that
   * is not archived, open or closed) and `any` (archived cases too).
   */
  readonly view: CaseView | 'active' | 'any';
  /** Firm-calendar today and the last "due soon" date, `YYYY-MM-DD`. */
  readonly today: string;
  readonly dueSoonUntil: string;
  /** The signed-in user (for the `my` view). */
  readonly actorUserId: string;
  /** Assignment rule: when set, only cases this user is assigned to. */
  readonly restrictToAssignedUserId: string | null;
  readonly serviceTypeId: string | null;
  readonly statusKey: string | null;
  readonly primaryConsultantUserId: string | null;
  readonly reviewerUserId: string | null;
  readonly taxYear: number | null;
  readonly clientId: string | null;
  /** Report filters; the queue never sets them. */
  readonly statusKind?: WorkflowStatusKind | null;
  readonly dueFrom?: string | null;
  readonly dueTo?: string | null;
  /**
   * `gaps`: a required checklist item is not satisfied; `awaiting_review`: a
   * review-required item is completed but not yet verified.
   */
  readonly checklist?: 'gaps' | 'awaiting_review' | null;
}

export interface CaseListCursor {
  readonly dueDate: string;
  readonly id: string;
}

export interface CaseListFilter extends CaseQueryFilter {
  readonly limit: number;
  readonly after: CaseListCursor | null;
}

export interface CaseListPage {
  readonly cases: readonly TaxCaseRecord[];
  readonly hasMore: boolean;
}

const CLOSED_KINDS: readonly WorkflowStatusKind[] = ['completed', 'cancelled'];

/**
 * Reference implementation of the queue predicate. The in-memory repository
 * uses it directly; the PostgreSQL repository builds the same conditions in
 * SQL, and an integration test checks the two agree.
 */
export function matchesCaseFilter(
  record: TaxCaseRecord,
  filter: CaseQueryFilter,
  /** The case's checklist items; only the `checklist` filter reads them. */
  items: readonly CaseChecklistItemRecord[] = [],
): boolean {
  const archived = record.deletedAt !== null;
  const closed = CLOSED_KINDS.includes(record.currentStatusKind);
  const open = !archived && !closed;
  let inView: boolean;
  switch (filter.view) {
    case 'my':
      inView =
        open &&
        (record.primaryConsultantUserId === filter.actorUserId ||
          record.reviewerUserId === filter.actorUserId);
      break;
    case 'team':
      inView = open;
      break;
    case 'unassigned':
      inView = open && record.primaryConsultantUserId === null;
      break;
    case 'due_soon':
      inView = open && record.dueDate >= filter.today && record.dueDate <= filter.dueSoonUntil;
      break;
    case 'overdue':
      inView = open && record.dueDate < filter.today;
      break;
    case 'closed':
      inView = !archived && closed;
      break;
    case 'archived':
      inView = archived;
      break;
    case 'active':
      inView = !archived;
      break;
    case 'any':
      inView = true;
      break;
  }
  if (!inView) {
    return false;
  }
  const restrict = filter.restrictToAssignedUserId;
  if (
    restrict !== null &&
    record.primaryConsultantUserId !== restrict &&
    record.reviewerUserId !== restrict
  ) {
    return false;
  }
  if (filter.statusKind != null && record.currentStatusKind !== filter.statusKind) {
    return false;
  }
  if (filter.dueFrom != null && record.dueDate < filter.dueFrom) {
    return false;
  }
  if (filter.dueTo != null && record.dueDate > filter.dueTo) {
    return false;
  }
  if (
    filter.checklist === 'gaps' &&
    !items.some((item) => item.required && !isChecklistItemSatisfied(item))
  ) {
    return false;
  }
  if (
    filter.checklist === 'awaiting_review' &&
    !items.some((item) => item.reviewRequired && item.state === 'completed')
  ) {
    return false;
  }
  return (
    (filter.serviceTypeId === null || record.serviceTypeId === filter.serviceTypeId) &&
    (filter.statusKey === null || record.currentStatusKey === filter.statusKey) &&
    (filter.primaryConsultantUserId === null ||
      record.primaryConsultantUserId === filter.primaryConsultantUserId) &&
    (filter.reviewerUserId === null || record.reviewerUserId === filter.reviewerUserId) &&
    (filter.taxYear === null || record.taxYear === filter.taxYear) &&
    (filter.clientId === null || record.clientId === filter.clientId)
  );
}

export function compareCaseOrder(left: TaxCaseRecord, right: TaxCaseRecord): number {
  if (left.dueDate !== right.dueDate) {
    return left.dueDate < right.dueDate ? -1 : 1;
  }
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}
