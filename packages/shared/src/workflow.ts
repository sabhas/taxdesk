import { z } from 'zod';
import { UuidV7Schema } from './id.js';

/**
 * Workflow and checklist template contracts (Epic 3, TD-302/TD-303).
 *
 * A template has numbered versions. One version at a time may be a draft; a
 * published version is immutable and is what a case snapshots. A version holds
 * the workflow (statuses and allowed transitions) and the checklist together,
 * so the two are always published "alongside" each other.
 *
 * `validateWorkflowDefinition` is the single semantic validator. The browser
 * uses it for feedback; the API runs it again before publishing.
 */

export const WORKFLOW_LIMITS = {
  nameMax: 120,
  descriptionMax: 1000,
  statusesMax: 30,
  statusNameMax: 60,
  transitionsMax: 200,
  checklistMax: 100,
  itemLabelMax: 200,
  documentTypeMax: 80,
  instructionsMax: 2000,
} as const;

export const WORKFLOW_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

export const WorkflowKeySchema = z
  .string()
  .regex(
    WORKFLOW_KEY_PATTERN,
    'Use 1–40 lowercase letters, digits, or underscores, starting with a letter.',
  );

/**
 * What a status means for the case, independent of its display name:
 * - `open`: work in progress;
 * - `filed`: the return or filing has been submitted;
 * - `completed`: the engagement is finished;
 * - `cancelled`: the engagement stopped without completion.
 */
export const WORKFLOW_STATUS_KINDS = ['open', 'filed', 'completed', 'cancelled'] as const;
export const WorkflowStatusKindSchema = z.enum(WORKFLOW_STATUS_KINDS);
export type WorkflowStatusKind = z.infer<typeof WorkflowStatusKindSchema>;

/** Kinds that end a case. They have no outgoing transitions and allow archiving. */
export const TERMINAL_STATUS_KINDS: readonly WorkflowStatusKind[] = ['completed', 'cancelled'];

/** Kinds that always require a complete, verified checklist before entry. */
export const CHECKLIST_GATED_STATUS_KINDS: readonly WorkflowStatusKind[] = ['filed', 'completed'];

export function isTerminalStatusKind(kind: WorkflowStatusKind): boolean {
  return TERMINAL_STATUS_KINDS.includes(kind);
}

export const WorkflowStatusDefinitionSchema = z
  .object({
    key: WorkflowKeySchema,
    name: z
      .string()
      .trim()
      .min(1, 'Enter a status name.')
      .max(WORKFLOW_LIMITS.statusNameMax, 'Use a shorter status name.'),
    kind: WorkflowStatusKindSchema,
    initial: z.boolean(),
    requiresChecklistComplete: z.boolean(),
  })
  .strict();

export type WorkflowStatusDefinition = z.infer<typeof WorkflowStatusDefinitionSchema>;

export const WorkflowTransitionDefinitionSchema = z
  .object({
    from: WorkflowKeySchema,
    to: WorkflowKeySchema,
  })
  .strict();

export type WorkflowTransitionDefinition = z.infer<typeof WorkflowTransitionDefinitionSchema>;

export const ChecklistItemDefinitionSchema = z
  .object({
    key: WorkflowKeySchema,
    label: z
      .string()
      .trim()
      .min(1, 'Enter the item label.')
      .max(WORKFLOW_LIMITS.itemLabelMax, 'Use a shorter label.'),
    /** The kind of document this item expects, e.g. "Bank statement"; `null` for none. */
    documentType: z
      .string()
      .trim()
      .min(1)
      .max(WORKFLOW_LIMITS.documentTypeMax, 'Use a shorter document type.')
      .nullable(),
    /** Required items gate entry to Filed/Completed (and any status that asks for it). */
    required: z.boolean(),
    /** The preparer completes the item; when true, a reviewer must also verify it. */
    reviewRequired: z.boolean(),
    instructions: z
      .string()
      .max(WORKFLOW_LIMITS.instructionsMax, 'Use shorter instructions.')
      .default(''),
  })
  .strict();

export type ChecklistItemDefinition = z.infer<typeof ChecklistItemDefinitionSchema>;
export type ChecklistItemDefinitionInput = z.input<typeof ChecklistItemDefinitionSchema>;

/**
 * Structural contract for a workflow definition. Array order is meaningful:
 * statuses are listed in display order and the checklist in work order.
 */
export const WorkflowDefinitionSchema = z
  .object({
    statuses: z
      .array(WorkflowStatusDefinitionSchema)
      .min(1, 'Add at least one status.')
      .max(
        WORKFLOW_LIMITS.statusesMax,
        `Use at most ${String(WORKFLOW_LIMITS.statusesMax)} statuses.`,
      ),
    transitions: z
      .array(WorkflowTransitionDefinitionSchema)
      .max(
        WORKFLOW_LIMITS.transitionsMax,
        `Use at most ${String(WORKFLOW_LIMITS.transitionsMax)} transitions.`,
      ),
    checklist: z
      .array(ChecklistItemDefinitionSchema)
      .max(
        WORKFLOW_LIMITS.checklistMax,
        `Use at most ${String(WORKFLOW_LIMITS.checklistMax)} checklist items.`,
      ),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;

export const WorkflowValidationIssueSchema = z
  .object({
    path: z.string().max(80),
    message: z.string().max(300),
  })
  .strict();

export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssueSchema>;

/**
 * Semantic validation for publishing. Returns every issue found; an empty list
 * means the definition may be published.
 *
 * Rules: unique status and checklist keys; transitions reference known
 * statuses, are unique, and never loop to the same status; exactly one initial
 * status, which is an `open` status; at least one `completed` status; Filed and
 * Completed statuses require the checklist; every status is reachable from the
 * initial status; terminal statuses have no outgoing transitions and every
 * other status has at least one.
 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const statusByKey = new Map<string, WorkflowStatusDefinition>();

  definition.statuses.forEach((status, index) => {
    if (statusByKey.has(status.key)) {
      issues.push({
        path: `statuses.${String(index)}.key`,
        message: `The status key "${status.key}" is used more than once.`,
      });
    } else {
      statusByKey.set(status.key, status);
    }
    if (CHECKLIST_GATED_STATUS_KINDS.includes(status.kind) && !status.requiresChecklistComplete) {
      issues.push({
        path: `statuses.${String(index)}.requiresChecklistComplete`,
        message: `"${status.name}" is a ${status.kind} status, so it must require a complete checklist.`,
      });
    }
  });

  const initial = definition.statuses.filter((status) => status.initial);
  if (initial.length !== 1) {
    issues.push({
      path: 'statuses',
      message:
        initial.length === 0
          ? 'Mark exactly one status as the initial status.'
          : 'Only one status can be the initial status.',
    });
  }
  const start = initial.length === 1 ? initial[0] : undefined;
  if (start !== undefined && start.kind !== 'open') {
    issues.push({ path: 'statuses', message: 'The initial status must be an open status.' });
  }
  if (!definition.statuses.some((status) => status.kind === 'completed')) {
    issues.push({ path: 'statuses', message: 'Add at least one completed status.' });
  }

  const seenTransitions = new Set<string>();
  const outgoing = new Map<string, string[]>();
  definition.transitions.forEach((transition, index) => {
    const path = `transitions.${String(index)}`;
    const from = statusByKey.get(transition.from);
    const to = statusByKey.get(transition.to);
    if (from === undefined) {
      issues.push({
        path,
        message: `The transition starts at an unknown status "${transition.from}".`,
      });
    }
    if (to === undefined) {
      issues.push({
        path,
        message: `The transition ends at an unknown status "${transition.to}".`,
      });
    }
    if (transition.from === transition.to) {
      issues.push({ path, message: 'A transition must move to a different status.' });
    }
    const id = `${transition.from}→${transition.to}`;
    if (seenTransitions.has(id)) {
      issues.push({ path, message: 'This transition is listed more than once.' });
    }
    seenTransitions.add(id);
    if (from !== undefined && to !== undefined && transition.from !== transition.to) {
      outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), transition.to]);
      if (isTerminalStatusKind(from.kind)) {
        issues.push({
          path,
          message: `"${from.name}" ends the case, so it cannot move to another status.`,
        });
      }
    }
  });

  definition.statuses.forEach((status, index) => {
    if (!isTerminalStatusKind(status.kind) && (outgoing.get(status.key) ?? []).length === 0) {
      issues.push({
        path: `statuses.${String(index)}`,
        message: `"${status.name}" has no way forward. Add a transition out of it.`,
      });
    }
  });

  if (start !== undefined) {
    const reached = new Set<string>([start.key]);
    const queue = [start.key];
    while (queue.length > 0) {
      const key = queue.shift() ?? '';
      for (const next of outgoing.get(key) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    definition.statuses.forEach((status, index) => {
      if (!reached.has(status.key) && statusByKey.get(status.key) === status) {
        issues.push({
          path: `statuses.${String(index)}`,
          message: `"${status.name}" cannot be reached from the initial status.`,
        });
      }
    });
  }

  const itemKeys = new Set<string>();
  definition.checklist.forEach((item, index) => {
    if (itemKeys.has(item.key)) {
      issues.push({
        path: `checklist.${String(index)}.key`,
        message: `The checklist key "${item.key}" is used more than once.`,
      });
    }
    itemKeys.add(item.key);
  });

  return issues;
}

/** Turns a display name into a definition key: "In review" → `in_review`. */
export function workflowKeyFrom(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 40);
  if (base.length === 0) {
    return 'item';
  }
  return /^[a-z]/u.test(base) ? base : `s_${base}`.slice(0, 40);
}

/**
 * A sensible starting point for a new template: a typical annual return
 * engagement. Managers edit it before publishing.
 */
export const STARTER_WORKFLOW_DEFINITION: WorkflowDefinition = {
  statuses: [
    {
      key: 'intake',
      name: 'Intake',
      kind: 'open',
      initial: true,
      requiresChecklistComplete: false,
    },
    {
      key: 'collecting_documents',
      name: 'Collecting documents',
      kind: 'open',
      initial: false,
      requiresChecklistComplete: false,
    },
    {
      key: 'in_preparation',
      name: 'In preparation',
      kind: 'open',
      initial: false,
      requiresChecklistComplete: false,
    },
    {
      key: 'in_review',
      name: 'In review',
      kind: 'open',
      initial: false,
      requiresChecklistComplete: false,
    },
    { key: 'filed', name: 'Filed', kind: 'filed', initial: false, requiresChecklistComplete: true },
    {
      key: 'completed',
      name: 'Completed',
      kind: 'completed',
      initial: false,
      requiresChecklistComplete: true,
    },
    {
      key: 'cancelled',
      name: 'Cancelled',
      kind: 'cancelled',
      initial: false,
      requiresChecklistComplete: false,
    },
  ],
  transitions: [
    { from: 'intake', to: 'collecting_documents' },
    { from: 'collecting_documents', to: 'in_preparation' },
    { from: 'in_preparation', to: 'collecting_documents' },
    { from: 'in_preparation', to: 'in_review' },
    { from: 'in_review', to: 'in_preparation' },
    { from: 'in_review', to: 'filed' },
    { from: 'filed', to: 'completed' },
    { from: 'intake', to: 'cancelled' },
    { from: 'collecting_documents', to: 'cancelled' },
    { from: 'in_preparation', to: 'cancelled' },
    { from: 'in_review', to: 'cancelled' },
  ],
  checklist: [
    {
      key: 'identity_document',
      label: 'Client identity document',
      documentType: 'CNIC copy',
      required: true,
      reviewRequired: false,
      instructions: 'Confirm the identity document matches the client record.',
    },
    {
      key: 'bank_statements',
      label: 'Bank statements for the tax year',
      documentType: 'Bank statement',
      required: true,
      reviewRequired: true,
      instructions: 'Collect statements for every account held during the tax year.',
    },
    {
      key: 'income_evidence',
      label: 'Income evidence',
      documentType: 'Salary certificate',
      required: true,
      reviewRequired: true,
      instructions: 'Salary certificate, business income records, or rent receipts as applicable.',
    },
    {
      key: 'prior_year_return',
      label: 'Prior-year return',
      documentType: 'Tax return',
      required: false,
      reviewRequired: false,
      instructions: '',
    },
  ],
};

// ---------------------------------------------------------------------------
// Template requests and responses
// ---------------------------------------------------------------------------

export const WORKFLOW_VERSION_STATES = ['draft', 'published'] as const;
export const WorkflowVersionStateSchema = z.enum(WORKFLOW_VERSION_STATES);
export type WorkflowVersionState = z.infer<typeof WorkflowVersionStateSchema>;

const TemplateNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a template name.')
  .max(WORKFLOW_LIMITS.nameMax, 'Use a shorter name.');

const TemplateDescriptionSchema = z
  .string()
  .trim()
  .max(WORKFLOW_LIMITS.descriptionMax, 'Use a shorter description.');

/** Creates a template with draft version 1. */
export const WorkflowTemplateCreateRequestSchema = z
  .object({
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema.default(''),
    definition: WorkflowDefinitionSchema,
  })
  .strict();

export type WorkflowTemplateCreateRequest = z.infer<typeof WorkflowTemplateCreateRequestSchema>;

/** Renames a template (guarded by the template's `If-Match`). Versions are unaffected. */
export const WorkflowTemplateUpdateRequestSchema = z
  .object({
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema,
  })
  .strict();

export type WorkflowTemplateUpdateRequest = z.infer<typeof WorkflowTemplateUpdateRequestSchema>;

/** Replaces a draft version's definition (guarded by the draft's `If-Match`). */
export const WorkflowDraftUpdateRequestSchema = z
  .object({
    definition: WorkflowDefinitionSchema,
  })
  .strict();

export type WorkflowDraftUpdateRequest = z.infer<typeof WorkflowDraftUpdateRequestSchema>;

const PersonSchema = z
  .object({
    id: UuidV7Schema,
    displayName: z.string().min(1).max(120),
  })
  .strict();

export const WorkflowVersionSummarySchema = z
  .object({
    id: UuidV7Schema,
    versionNumber: z.number().int().positive(),
    state: WorkflowVersionStateSchema,
    publishedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type WorkflowVersionSummary = z.infer<typeof WorkflowVersionSummarySchema>;

export const WorkflowTemplateSummarySchema = z
  .object({
    id: UuidV7Schema,
    name: z.string().min(1).max(WORKFLOW_LIMITS.nameMax),
    description: z.string().max(WORKFLOW_LIMITS.descriptionMax),
    latestPublished: WorkflowVersionSummarySchema.nullable(),
    draft: WorkflowVersionSummarySchema.nullable(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type WorkflowTemplateSummary = z.infer<typeof WorkflowTemplateSummarySchema>;

export const WorkflowTemplateListSchema = z
  .object({
    templates: z.array(WorkflowTemplateSummarySchema),
  })
  .strict();

export type WorkflowTemplateList = z.infer<typeof WorkflowTemplateListSchema>;

export const WorkflowTemplateSchema = WorkflowTemplateSummarySchema.extend({
  versions: z.array(WorkflowVersionSummarySchema),
  createdAt: z.iso.datetime(),
}).strict();

export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

export const WorkflowVersionSchema = z
  .object({
    id: UuidV7Schema,
    templateId: UuidV7Schema,
    templateName: z.string().min(1).max(WORKFLOW_LIMITS.nameMax),
    versionNumber: z.number().int().positive(),
    state: WorkflowVersionStateSchema,
    definition: WorkflowDefinitionSchema,
    /** Publishing is refused while this list is non-empty. */
    issues: z.array(WorkflowValidationIssueSchema),
    publishedAt: z.iso.datetime().nullable(),
    publishedBy: PersonSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;
