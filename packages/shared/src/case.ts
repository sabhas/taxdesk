import { z } from 'zod';
import { ClientCodeSchema } from './client.js';
import { UuidSchema, UuidV7Schema } from './id.js';
import { MinorAmountSchema } from './service-type.js';
import {
  WorkflowKeySchema,
  WorkflowStatusDefinitionSchema,
  WorkflowStatusKindSchema,
  WorkflowTransitionDefinitionSchema,
} from './workflow.js';

/**
 * Tax-case contracts (Epic 3, TD-304–TD-310). A case snapshots its service
 * (name and fee), its workflow version (statuses and transitions), and its
 * checklist when it is opened. The status only changes through the transition
 * command; edits never carry a status.
 */

export const CASE_LIMITS = {
  notesMax: 4000,
  transitionNoteMax: 1000,
  commentMax: 1000,
  overrideReasonMin: 10,
  overrideReasonMax: 500,
  taxYearMin: 2000,
  taxYearMax: 2100,
} as const;

/** "Due soon" means due today or within this many days, in the firm timezone. */
export const CASE_DUE_SOON_DAYS = 7;

export const CASE_CODE_PATTERN = /^TC-\d{5,}$/u;
export const CaseCodeSchema = z.string().regex(CASE_CODE_PATTERN);

/** Server-side case code format: `TC-00042`. Codes are never reused. */
export function formatCaseCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('A case code sequence must be a positive integer.');
  }
  return `TC-${String(sequence).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Calendar dates (due dates are dates, not instants)
// ---------------------------------------------------------------------------

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Use a date in YYYY-MM-DD form.')
  .refine(isRealDate, 'Enter a real calendar date.');

/** Today's calendar date in a timezone, e.g. the firm's `Asia/Karachi`. */
export function calendarDateIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addDaysToDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export const TaxYearSchema = z
  .number()
  .int('Use a whole year.')
  .min(CASE_LIMITS.taxYearMin, `Use a tax year from ${String(CASE_LIMITS.taxYearMin)}.`)
  .max(CASE_LIMITS.taxYearMax, `Use a tax year up to ${String(CASE_LIMITS.taxYearMax)}.`);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CaseNotesSchema = z
  .string()
  .max(CASE_LIMITS.notesMax, `Use at most ${String(CASE_LIMITS.notesMax)} characters.`);

export const CaseDuplicateOverrideReasonSchema = z
  .string()
  .trim()
  .min(
    CASE_LIMITS.overrideReasonMin,
    `Explain the override in at least ${String(CASE_LIMITS.overrideReasonMin)} characters.`,
  )
  .max(CASE_LIMITS.overrideReasonMax, 'Use a shorter reason.');

const differentReviewer = {
  message: 'Choose a reviewer other than the primary consultant.',
  path: ['reviewerUserId'],
};

function reviewerDiffers(value: {
  primaryConsultantUserId: string | null;
  reviewerUserId: string | null;
}): boolean {
  return value.reviewerUserId === null || value.reviewerUserId !== value.primaryConsultantUserId;
}

export const CaseCreateRequestSchema = z
  .object({
    clientId: UuidV7Schema,
    serviceTypeId: UuidV7Schema,
    taxYear: TaxYearSchema,
    workflowVersionId: UuidV7Schema,
    dueDate: IsoDateSchema,
    /** `null` places the case in the unassigned queue (requires `cases.assign`). */
    primaryConsultantUserId: UuidV7Schema.nullable(),
    reviewerUserId: UuidV7Schema.nullable(),
    notes: CaseNotesSchema.default(''),
    /** Required to proceed past a duplicate-case warning. */
    duplicateOverrideReason: CaseDuplicateOverrideReasonSchema.optional(),
  })
  .strict()
  .refine(reviewerDiffers, differentReviewer);

export type CaseCreateRequest = z.infer<typeof CaseCreateRequestSchema>;
export type CaseCreateRequestInput = z.input<typeof CaseCreateRequestSchema>;

/**
 * Full replacement of a case's editable details, guarded by `If-Match`. There
 * is deliberately no status field: status only changes through a transition.
 */
export const CaseUpdateRequestSchema = z
  .object({
    dueDate: IsoDateSchema,
    notes: CaseNotesSchema,
    primaryConsultantUserId: UuidV7Schema.nullable(),
    reviewerUserId: UuidV7Schema.nullable(),
  })
  .strict()
  .refine(reviewerDiffers, differentReviewer);

export type CaseUpdateRequest = z.infer<typeof CaseUpdateRequestSchema>;

export const CaseTransitionRequestSchema = z
  .object({
    toStatus: WorkflowKeySchema,
    note: z.string().trim().max(CASE_LIMITS.transitionNoteMax, 'Use a shorter note.').default(''),
  })
  .strict();

export type CaseTransitionRequest = z.infer<typeof CaseTransitionRequestSchema>;

export const CHECKLIST_ACTIONS = ['complete', 'reopen', 'verify', 'reject'] as const;
export const ChecklistActionSchema = z.enum(CHECKLIST_ACTIONS);
export type ChecklistAction = z.infer<typeof ChecklistActionSchema>;

const CommentSchema = z.string().trim().max(CASE_LIMITS.commentMax, 'Use a shorter comment.');

/** Preparer completion/reopen and reviewer verification take an optional comment. */
export const ChecklistActionRequestSchema = z
  .object({ comment: CommentSchema.default('') })
  .strict();

export type ChecklistActionRequest = z.infer<typeof ChecklistActionRequestSchema>;

/** Rejection must explain what the preparer needs to fix. */
export const ChecklistRejectRequestSchema = z
  .object({ comment: CommentSchema.pipe(z.string().min(1, 'Explain what needs to change.')) })
  .strict();

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const CasePersonSchema = z
  .object({
    id: UuidV7Schema,
    displayName: z.string().min(1).max(120),
  })
  .strict();

export type CasePerson = z.infer<typeof CasePersonSchema>;

export const CaseStatusRefSchema = z
  .object({
    key: WorkflowKeySchema,
    name: z.string().min(1).max(60),
    kind: WorkflowStatusKindSchema,
  })
  .strict();

export type CaseStatusRef = z.infer<typeof CaseStatusRefSchema>;

export const CHECKLIST_ITEM_STATES = ['open', 'completed', 'verified', 'rejected'] as const;
export const ChecklistItemStateSchema = z.enum(CHECKLIST_ITEM_STATES);
export type ChecklistItemState = z.infer<typeof ChecklistItemStateSchema>;

/**
 * An item is satisfied when it is completed and, if it needs review, verified.
 * Required unsatisfied items block statuses that require the checklist.
 */
export function isChecklistItemSatisfied(item: {
  readonly state: ChecklistItemState;
  readonly reviewRequired: boolean;
}): boolean {
  return item.reviewRequired
    ? item.state === 'verified'
    : item.state === 'completed' || item.state === 'verified';
}

export const CaseChecklistItemSchema = z
  .object({
    id: UuidV7Schema,
    key: WorkflowKeySchema,
    label: z.string().min(1).max(200),
    documentType: z.string().max(80).nullable(),
    required: z.boolean(),
    reviewRequired: z.boolean(),
    instructions: z.string().max(2000),
    state: ChecklistItemStateSchema,
    completedBy: CasePersonSchema.nullable(),
    completedAt: z.iso.datetime().nullable(),
    preparerComment: z.string().max(CASE_LIMITS.commentMax),
    reviewedBy: CasePersonSchema.nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewComment: z.string().max(CASE_LIMITS.commentMax),
    version: z.number().int().positive(),
  })
  .strict();

export type CaseChecklistItem = z.infer<typeof CaseChecklistItemSchema>;

export const ChecklistProgressSchema = z
  .object({
    total: z.number().int().min(0),
    required: z.number().int().min(0),
    completed: z.number().int().min(0),
    verified: z.number().int().min(0),
    /** Required items not yet satisfied (completed, and verified when review is needed). */
    requiredOutstanding: z.number().int().min(0),
  })
  .strict();

export type ChecklistProgress = z.infer<typeof ChecklistProgressSchema>;

export function checklistProgress(
  items: readonly {
    readonly state: ChecklistItemState;
    readonly required: boolean;
    readonly reviewRequired: boolean;
  }[],
): ChecklistProgress {
  return {
    total: items.length,
    required: items.filter((item) => item.required).length,
    completed: items.filter((item) => item.state === 'completed' || item.state === 'verified')
      .length,
    verified: items.filter((item) => item.state === 'verified').length,
    requiredOutstanding: items.filter((item) => item.required && !isChecklistItemSatisfied(item))
      .length,
  };
}

export const CaseAvailableTransitionSchema = z
  .object({
    to: CaseStatusRefSchema,
    /** Why the server would refuse it right now, e.g. an incomplete checklist. */
    blockedReason: z.string().max(300).nullable(),
  })
  .strict();

export type CaseAvailableTransition = z.infer<typeof CaseAvailableTransitionSchema>;

/**
 * What the signed-in user may do with this case. UI gating only: the API
 * enforces every one of these rules again on each request.
 */
export const CaseAllowedActionsSchema = z
  .object({
    edit: z.boolean(),
    assign: z.boolean(),
    transition: z.boolean(),
    prepareChecklist: z.boolean(),
    reviewChecklist: z.boolean(),
    archive: z.boolean(),
  })
  .strict();

export type CaseAllowedActions = z.infer<typeof CaseAllowedActionsSchema>;

export const CASE_STATES = ['active', 'archived'] as const;
export const CaseStateSchema = z.enum(CASE_STATES);
export type CaseState = z.infer<typeof CaseStateSchema>;

export const CaseClientRefSchema = z
  .object({
    id: UuidV7Schema,
    clientCode: ClientCodeSchema,
    displayName: z.string().min(1).max(200),
  })
  .strict();

export const CaseUrgencySchema = z.enum(['overdue', 'due_soon']).nullable();
export type CaseUrgency = z.infer<typeof CaseUrgencySchema>;

export const TaxCaseSchema = z
  .object({
    id: UuidV7Schema,
    caseCode: CaseCodeSchema,
    client: CaseClientRefSchema,
    /** Snapshot taken when the case was opened. */
    service: z
      .object({
        id: UuidV7Schema,
        name: z.string().min(1).max(120),
        feeMinor: MinorAmountSchema,
      })
      .strict(),
    taxYear: TaxYearSchema,
    /** Snapshot of the workflow version the case follows. */
    workflow: z
      .object({
        templateId: UuidV7Schema,
        versionId: UuidV7Schema,
        templateName: z.string().min(1).max(120),
        versionNumber: z.number().int().positive(),
        statuses: z.array(WorkflowStatusDefinitionSchema),
        transitions: z.array(WorkflowTransitionDefinitionSchema),
      })
      .strict(),
    status: CaseStatusRefSchema,
    dueDate: IsoDateSchema,
    urgency: CaseUrgencySchema,
    primaryConsultant: CasePersonSchema.nullable(),
    reviewer: CasePersonSchema.nullable(),
    notes: z.string().max(CASE_LIMITS.notesMax),
    checklist: z.array(CaseChecklistItemSchema),
    checklistProgress: ChecklistProgressSchema,
    availableTransitions: z.array(CaseAvailableTransitionSchema),
    allowedActions: CaseAllowedActionsSchema,
    state: CaseStateSchema,
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type TaxCase = z.infer<typeof TaxCaseSchema>;

export const CaseListItemSchema = z
  .object({
    id: UuidV7Schema,
    caseCode: CaseCodeSchema,
    client: CaseClientRefSchema,
    serviceName: z.string().min(1).max(120),
    taxYear: TaxYearSchema,
    status: CaseStatusRefSchema,
    dueDate: IsoDateSchema,
    urgency: CaseUrgencySchema,
    primaryConsultant: CasePersonSchema.nullable(),
    reviewer: CasePersonSchema.nullable(),
    state: CaseStateSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type CaseListItem = z.infer<typeof CaseListItemSchema>;

/**
 * Work queues. Every queue except `closed` and `archived` holds open work
 * (not completed, cancelled, or archived).
 * - `my`: cases where the signed-in user is primary consultant or reviewer;
 * - `team`: every open case the user can see;
 * - `unassigned`: open cases without a primary consultant;
 * - `due_soon`: open cases due today or within `CASE_DUE_SOON_DAYS` days;
 * - `overdue`: open cases whose due date has passed;
 * - `closed`: completed or cancelled cases not yet archived;
 * - `archived`: archived cases.
 */
export const CASE_VIEWS = [
  'my',
  'team',
  'unassigned',
  'due_soon',
  'overdue',
  'closed',
  'archived',
] as const;
export const CaseViewSchema = z.enum(CASE_VIEWS);
export type CaseView = z.infer<typeof CaseViewSchema>;

/** Filters shared by the list and the queue counts, so both use one query. */
const caseFilterFields = {
  service: UuidSchema.optional(),
  status: WorkflowKeySchema.optional(),
  /** Primary consultant user ID. Use the `unassigned` view for cases without one. */
  assignee: UuidSchema.optional(),
  reviewer: UuidSchema.optional(),
  taxYear: z.coerce.number().pipe(TaxYearSchema).optional(),
  client: UuidSchema.optional(),
  /** Status kind of the case's current status (open, filed, completed, cancelled). */
  statusKind: WorkflowStatusKindSchema.optional(),
  /**
   * `gaps`: cases with a required checklist item that is not yet satisfied;
   * `awaiting_review`: cases with an item waiting for a reviewer.
   */
  checklist: z.enum(['gaps', 'awaiting_review']).optional(),
};

export const CaseListQuerySchema = z
  .object({
    view: CaseViewSchema.default('team'),
    ...caseFilterFields,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type CaseListQuery = z.infer<typeof CaseListQuerySchema>;

export const CaseQueueCountsQuerySchema = z.object(caseFilterFields).strict();
export type CaseQueueCountsQuery = z.infer<typeof CaseQueueCountsQuerySchema>;

export const CaseListSchema = z
  .object({
    cases: z.array(CaseListItemSchema),
    nextCursor: z.string().min(1).max(512).nullable(),
    /** Count of every case matching the view and filters, from the same query. */
    total: z.number().int().min(0),
  })
  .strict();

export type CaseList = z.infer<typeof CaseListSchema>;

export const CaseQueueCountsSchema = z
  .object({
    my: z.number().int().min(0),
    team: z.number().int().min(0),
    unassigned: z.number().int().min(0),
    due_soon: z.number().int().min(0),
    overdue: z.number().int().min(0),
  })
  .strict();

export type CaseQueueCounts = z.infer<typeof CaseQueueCountsSchema>;

export const CaseAssigneeListSchema = z
  .object({
    assignees: z.array(CasePersonSchema),
  })
  .strict();

export type CaseAssigneeList = z.infer<typeof CaseAssigneeListSchema>;

export const CaseStatusHistoryEntrySchema = z
  .object({
    id: UuidV7Schema,
    from: z
      .object({ key: WorkflowKeySchema, name: z.string().min(1).max(60) })
      .strict()
      .nullable(),
    to: CaseStatusRefSchema,
    actor: CasePersonSchema.nullable(),
    note: z.string().max(CASE_LIMITS.transitionNoteMax),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export type CaseStatusHistoryEntry = z.infer<typeof CaseStatusHistoryEntrySchema>;

/** Full status history, oldest first. It is append-only and never edited. */
export const CaseStatusHistorySchema = z
  .object({
    entries: z.array(CaseStatusHistoryEntrySchema),
  })
  .strict();

export type CaseStatusHistory = z.infer<typeof CaseStatusHistorySchema>;

export const CASE_FIELDS = ['dueDate', 'notes', 'primaryConsultant', 'reviewer'] as const;
export const CaseFieldSchema = z.enum(CASE_FIELDS);
export type CaseField = z.infer<typeof CaseFieldSchema>;

export const CASE_ACTIVITY_ACTIONS = [
  'case.created',
  'case.updated',
  'case.status_changed',
  'case.archived',
  'case.duplicate_override',
  'case.checklist_completed',
  'case.checklist_reopened',
  'case.checklist_verified',
  'case.checklist_rejected',
] as const;
export const CaseActivityActionSchema = z.enum(CASE_ACTIVITY_ACTIONS);
export type CaseActivityAction = z.infer<typeof CaseActivityActionSchema>;

/**
 * One entry of a case's history (status, assignment, material edits, and
 * checklist decisions). Field values such as notes and comments stay on the
 * case; the history names what changed and who changed it.
 */
export const CaseActivitySchema = z
  .object({
    id: UuidV7Schema,
    occurredAt: z.iso.datetime(),
    action: CaseActivityActionSchema,
    actor: CasePersonSchema.nullable(),
    changedFields: z.array(CaseFieldSchema),
    fromStatus: z.string().max(60).nullable(),
    toStatus: z.string().max(60).nullable(),
    checklistItem: z.string().max(200).nullable(),
    primaryConsultant: CasePersonSchema.nullable(),
    reviewer: CasePersonSchema.nullable(),
    dueDate: IsoDateSchema.nullable(),
    overrideReason: z.string().max(CASE_LIMITS.overrideReasonMax).nullable(),
  })
  .strict();

export type CaseActivity = z.infer<typeof CaseActivitySchema>;

export const CaseActivityListSchema = z
  .object({
    events: z.array(CaseActivitySchema),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type CaseActivityList = z.infer<typeof CaseActivityListSchema>;
