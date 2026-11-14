import {
  WorkflowDefinitionSchema,
  WorkflowStatusDefinitionSchema,
  WorkflowTransitionDefinitionSchema,
  type ChecklistItemState,
  type DuplicateCasePolicy,
  type WorkflowStatusKind,
  type WorkflowVersionState,
} from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
import type {
  ServiceTypeRecord,
  WorkflowTemplateRecord,
  WorkflowVersionRecord,
} from '../domain/catalog/types.js';
import type {
  CaseChecklistItemRecord,
  CaseQueryFilter,
  CaseStatusHistoryRecord,
  TaxCaseRecord,
} from '../domain/cases/types.js';
import {
  DraftExistsError,
  DuplicateNameError,
  type CaseRepository,
  type ServiceTypeRepository,
  type WorkflowTemplateRepository,
} from './ports.js';

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected a string column "${key}".`);
  }
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected a nullable string column "${key}".`);
  }
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  // bigint columns and sequence values arrive as strings.
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return Number(value);
  }
  throw new Error(`Expected an integer column "${key}".`);
}

function boolean(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected a boolean column "${key}".`);
  }
  return value;
}

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  throw new Error('Expected a timestamp column.');
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function json(row: SqlRow, key: string): unknown {
  const value = row[key];
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function constraintOf(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  ) {
    return String((error as { constraint_name?: unknown }).constraint_name);
  }
  return null;
}

async function guardUnique<T>(
  work: () => Promise<T>,
  map: Record<string, () => Error>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const constraint = constraintOf(error);
    const mapped = constraint === null ? undefined : map[constraint];
    if (mapped !== undefined) {
      throw mapped();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Service types
// ---------------------------------------------------------------------------

function mapServiceType(row: SqlRow): ServiceTypeRecord {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    defaultFeeMinor: integer(row, 'default_fee_minor'),
    defaultDeadlineOffsetDays: integer(row, 'default_deadline_offset_days'),
    duplicateCasePolicy: text(row, 'duplicate_case_policy') as DuplicateCasePolicy,
    defaultWorkflowTemplateId: nullableText(row, 'default_workflow_template_id'),
    createdBy: nullableText(row, 'created_by'),
    deletedAt: nullableIso(row['deleted_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const SERVICE_NAME = { service_types_active_name_key: () => new DuplicateNameError() };

export function createPostgresServiceTypeRepository(executor: SqlExecutor): ServiceTypeRepository {
  return {
    create: async (record) => {
      await guardUnique(
        () =>
          executor.query(
            `INSERT INTO service_types (
               id, name, description, default_fee_minor, default_deadline_offset_days,
               duplicate_case_policy, default_workflow_template_id, created_by, deleted_at,
               created_at, updated_at, version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9, 1)`,
            [
              record.id,
              record.name,
              record.description,
              record.defaultFeeMinor,
              record.defaultDeadlineOffsetDays,
              record.duplicateCasePolicy,
              record.defaultWorkflowTemplateId,
              record.createdBy,
              record.createdAt,
            ],
          ),
        SERVICE_NAME,
      );
    },
    findById: async (id) => {
      const rows = await executor.query('SELECT * FROM service_types WHERE id = $1', [id]);
      return rows[0] === undefined ? null : mapServiceType(rows[0]);
    },
    list: async (state) => {
      const rows = await executor.query(
        `SELECT * FROM service_types
         WHERE ($1 = 'all' OR ($1 = 'active') = (deleted_at IS NULL))
         ORDER BY lower(name), id`,
        [state],
      );
      return rows.map(mapServiceType);
    },
    update: async (input) => {
      const rows = await guardUnique(
        () =>
          executor.query(
            `UPDATE service_types
             SET name = $3, description = $4, default_fee_minor = $5,
                 default_deadline_offset_days = $6, duplicate_case_policy = $7,
                 default_workflow_template_id = $8, updated_at = $9, version = version + 1
             WHERE id = $1 AND version = $2
             RETURNING *`,
            [
              input.id,
              input.expectedVersion,
              input.changes.name,
              input.changes.description,
              input.changes.defaultFeeMinor,
              input.changes.defaultDeadlineOffsetDays,
              input.changes.duplicateCasePolicy,
              input.changes.defaultWorkflowTemplateId,
              input.at,
            ],
          ),
        SERVICE_NAME,
      );
      return rows[0] === undefined ? null : mapServiceType(rows[0]);
    },
    setArchived: async (input) => {
      const rows = await guardUnique(
        () =>
          executor.query(
            `UPDATE service_types
             SET deleted_at = $3, updated_at = $4, version = version + 1
             WHERE id = $1 AND version = $2
             RETURNING *`,
            [input.id, input.expectedVersion, input.archivedAt, input.at],
          ),
        SERVICE_NAME,
      );
      return rows[0] === undefined ? null : mapServiceType(rows[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow templates
// ---------------------------------------------------------------------------

function mapTemplate(row: SqlRow): WorkflowTemplateRecord {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    description: text(row, 'description'),
    createdBy: nullableText(row, 'created_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapVersion(row: SqlRow): WorkflowVersionRecord {
  return {
    id: text(row, 'id'),
    templateId: text(row, 'template_id'),
    versionNumber: integer(row, 'version_number'),
    state: text(row, 'state') as WorkflowVersionState,
    // Stored definitions were validated on write; parsing again keeps the
    // record type honest if the column were ever edited out of band.
    definition: WorkflowDefinitionSchema.parse(json(row, 'definition')),
    publishedAt: nullableIso(row['published_at']),
    publishedBy: nullableText(row, 'published_by'),
    createdBy: nullableText(row, 'created_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const TEMPLATE_UNIQUES = {
  workflow_templates_name_key: () => new DuplicateNameError(),
  workflow_template_versions_one_draft: () => new DraftExistsError(),
  workflow_template_versions_number_key: () => new DraftExistsError(),
};

export function createPostgresWorkflowTemplateRepository(
  executor: SqlExecutor,
): WorkflowTemplateRepository {
  const insertVersion = async (record: WorkflowVersionRecord): Promise<void> => {
    await guardUnique(
      () =>
        executor.query(
          `INSERT INTO workflow_template_versions (
             id, template_id, version_number, state, definition, published_at, published_by,
             created_by, created_at, updated_at, version
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9, 1)`,
          [
            record.id,
            record.templateId,
            record.versionNumber,
            record.state,
            record.definition,
            record.publishedAt,
            record.publishedBy,
            record.createdBy,
            record.createdAt,
          ],
        ),
      TEMPLATE_UNIQUES,
    );
  };
  return {
    create: async (template, draft) => {
      await guardUnique(
        () =>
          executor.query(
            `INSERT INTO workflow_templates (id, name, description, created_by, created_at, updated_at, version)
             VALUES ($1, $2, $3, $4, $5, $5, 1)`,
            [
              template.id,
              template.name,
              template.description,
              template.createdBy,
              template.createdAt,
            ],
          ),
        TEMPLATE_UNIQUES,
      );
      await insertVersion(draft);
    },
    findTemplate: async (id) => {
      const rows = await executor.query('SELECT * FROM workflow_templates WHERE id = $1', [id]);
      return rows[0] === undefined ? null : mapTemplate(rows[0]);
    },
    listTemplates: async () => {
      const rows = await executor.query(
        'SELECT * FROM workflow_templates ORDER BY lower(name), id',
      );
      return rows.map(mapTemplate);
    },
    updateTemplate: async (input) => {
      const rows = await guardUnique(
        () =>
          executor.query(
            `UPDATE workflow_templates
             SET name = $3, description = $4, updated_at = $5, version = version + 1
             WHERE id = $1 AND version = $2
             RETURNING *`,
            [input.id, input.expectedVersion, input.name, input.description, input.at],
          ),
        TEMPLATE_UNIQUES,
      );
      return rows[0] === undefined ? null : mapTemplate(rows[0]);
    },
    listVersions: async (templateIds) => {
      if (templateIds.length === 0) {
        return [];
      }
      const rows = await executor.query(
        `SELECT * FROM workflow_template_versions
         WHERE template_id = ANY ($1::uuid[])
         ORDER BY template_id, version_number`,
        [[...templateIds]],
      );
      return rows.map(mapVersion);
    },
    findVersion: async (id) => {
      const rows = await executor.query('SELECT * FROM workflow_template_versions WHERE id = $1', [
        id,
      ]);
      return rows[0] === undefined ? null : mapVersion(rows[0]);
    },
    createVersion: insertVersion,
    updateDraft: async (input) => {
      const rows = await executor.query(
        `UPDATE workflow_template_versions
         SET definition = $3::jsonb, updated_at = $4, version = version + 1
         WHERE id = $1 AND version = $2 AND state = 'draft'
         RETURNING *`,
        [input.id, input.expectedVersion, input.definition, input.at],
      );
      return rows[0] === undefined ? null : mapVersion(rows[0]);
    },
    publish: async (input) => {
      const rows = await executor.query(
        `UPDATE workflow_template_versions
         SET state = 'published', published_at = $3, published_by = $4,
             updated_at = $3, version = version + 1
         WHERE id = $1 AND version = $2 AND state = 'draft'
         RETURNING *`,
        [input.id, input.expectedVersion, input.at, input.publishedBy],
      );
      return rows[0] === undefined ? null : mapVersion(rows[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// Tax cases
// ---------------------------------------------------------------------------

/** Every case read joins the client's code and display name. */
const CASE_SELECT = `
  SELECT c.*, to_char(c.due_date, 'YYYY-MM-DD') AS due_date_text,
         cl.client_code AS client_code, cl.display_name AS client_display_name
  FROM tax_cases c
  JOIN clients cl ON cl.id = c.client_id`;

function mapCase(row: SqlRow): TaxCaseRecord {
  const snapshot = json(row, 'workflow_snapshot') as {
    statuses?: unknown;
    transitions?: unknown;
  };
  return {
    id: text(row, 'id'),
    caseCode: text(row, 'case_code'),
    clientId: text(row, 'client_id'),
    clientCode: text(row, 'client_code'),
    clientDisplayName: text(row, 'client_display_name'),
    serviceTypeId: text(row, 'service_type_id'),
    serviceName: text(row, 'service_name'),
    serviceFeeMinor: integer(row, 'service_fee_minor'),
    taxYear: integer(row, 'tax_year'),
    workflowVersionId: text(row, 'workflow_version_id'),
    workflowTemplateId: text(row, 'workflow_template_id'),
    workflowTemplateName: text(row, 'workflow_template_name'),
    workflowVersionNumber: integer(row, 'workflow_version_number'),
    workflowSnapshot: {
      statuses: WorkflowStatusDefinitionSchema.array().parse(snapshot.statuses),
      transitions: WorkflowTransitionDefinitionSchema.array().parse(snapshot.transitions),
    },
    currentStatusKey: text(row, 'current_status_key'),
    currentStatusName: text(row, 'current_status_name'),
    currentStatusKind: text(row, 'current_status_kind') as WorkflowStatusKind,
    currentStatusHistoryId: text(row, 'current_status_history_id'),
    dueDate: text(row, 'due_date_text'),
    primaryConsultantUserId: nullableText(row, 'primary_consultant_user_id'),
    reviewerUserId: nullableText(row, 'reviewer_user_id'),
    notes: text(row, 'notes'),
    createdBy: nullableText(row, 'created_by'),
    deletedAt: nullableIso(row['deleted_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapHistory(row: SqlRow): CaseStatusHistoryRecord {
  return {
    id: text(row, 'id'),
    caseId: text(row, 'case_id'),
    fromStatusKey: nullableText(row, 'from_status_key'),
    fromStatusName: nullableText(row, 'from_status_name'),
    toStatusKey: text(row, 'to_status_key'),
    toStatusName: text(row, 'to_status_name'),
    toStatusKind: text(row, 'to_status_kind') as WorkflowStatusKind,
    note: text(row, 'note'),
    actorUserId: nullableText(row, 'actor_user_id'),
    requestId: text(row, 'request_id'),
    occurredAt: iso(row['occurred_at']),
  };
}

function mapItem(row: SqlRow): CaseChecklistItemRecord {
  return {
    id: text(row, 'id'),
    caseId: text(row, 'case_id'),
    position: integer(row, 'position'),
    itemKey: text(row, 'item_key'),
    label: text(row, 'label'),
    documentType: nullableText(row, 'document_type'),
    required: boolean(row, 'required'),
    reviewRequired: boolean(row, 'review_required'),
    instructions: text(row, 'instructions'),
    state: text(row, 'state') as ChecklistItemState,
    completedBy: nullableText(row, 'completed_by'),
    completedAt: nullableIso(row['completed_at']),
    preparerComment: text(row, 'preparer_comment'),
    reviewedBy: nullableText(row, 'reviewed_by'),
    reviewedAt: nullableIso(row['reviewed_at']),
    reviewComment: text(row, 'review_comment'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

/**
 * The single SQL translation of `matchesCaseFilter`. The list and the counts
 * both call it, so a queue count always describes the list it labels.
 */
export function caseFilterSql(
  filter: CaseQueryFilter,
  firstParameter = 1,
): { readonly where: string; readonly parameters: unknown[] } {
  const parameters: unknown[] = [];
  const bind = (value: unknown): string => {
    parameters.push(value);
    return `$${String(firstParameter + parameters.length - 1)}`;
  };
  const open = `c.deleted_at IS NULL AND c.current_status_kind NOT IN ('completed', 'cancelled')`;
  const conditions: string[] = [];
  switch (filter.view) {
    case 'my': {
      const actor = bind(filter.actorUserId);
      conditions.push(
        open,
        `(c.primary_consultant_user_id = ${actor}::uuid OR c.reviewer_user_id = ${actor}::uuid)`,
      );
      break;
    }
    case 'team':
      conditions.push(open);
      break;
    case 'unassigned':
      conditions.push(open, 'c.primary_consultant_user_id IS NULL');
      break;
    case 'due_soon':
      conditions.push(
        open,
        `c.due_date >= ${bind(filter.today)}::date`,
        `c.due_date <= ${bind(filter.dueSoonUntil)}::date`,
      );
      break;
    case 'overdue':
      conditions.push(open, `c.due_date < ${bind(filter.today)}::date`);
      break;
    case 'closed':
      conditions.push(
        `c.deleted_at IS NULL AND c.current_status_kind IN ('completed', 'cancelled')`,
      );
      break;
    case 'archived':
      conditions.push('c.deleted_at IS NOT NULL');
      break;
    case 'active':
      conditions.push('c.deleted_at IS NULL');
      break;
    case 'any':
      break;
  }
  if (filter.statusKind != null) {
    conditions.push(`c.current_status_kind = ${bind(filter.statusKind)}`);
  }
  if (filter.dueFrom != null) {
    conditions.push(`c.due_date >= ${bind(filter.dueFrom)}::date`);
  }
  if (filter.dueTo != null) {
    conditions.push(`c.due_date <= ${bind(filter.dueTo)}::date`);
  }
  if (filter.checklist === 'gaps') {
    conditions.push(
      `EXISTS (SELECT 1 FROM case_checklist_items i WHERE i.case_id = c.id AND i.required
         AND NOT (CASE WHEN i.review_required THEN i.state = 'verified'
                       ELSE i.state IN ('completed', 'verified') END))`,
    );
  }
  if (filter.checklist === 'awaiting_review') {
    conditions.push(
      `EXISTS (SELECT 1 FROM case_checklist_items i WHERE i.case_id = c.id
         AND i.review_required AND i.state = 'completed')`,
    );
  }
  if (filter.restrictToAssignedUserId !== null) {
    const user = bind(filter.restrictToAssignedUserId);
    conditions.push(
      `(c.primary_consultant_user_id = ${user}::uuid OR c.reviewer_user_id = ${user}::uuid)`,
    );
  }
  if (filter.serviceTypeId !== null) {
    conditions.push(`c.service_type_id = ${bind(filter.serviceTypeId)}::uuid`);
  }
  if (filter.statusKey !== null) {
    conditions.push(`c.current_status_key = ${bind(filter.statusKey)}`);
  }
  if (filter.primaryConsultantUserId !== null) {
    conditions.push(`c.primary_consultant_user_id = ${bind(filter.primaryConsultantUserId)}::uuid`);
  }
  if (filter.reviewerUserId !== null) {
    conditions.push(`c.reviewer_user_id = ${bind(filter.reviewerUserId)}::uuid`);
  }
  if (filter.taxYear !== null) {
    conditions.push(`c.tax_year = ${bind(filter.taxYear)}::int`);
  }
  if (filter.clientId !== null) {
    conditions.push(`c.client_id = ${bind(filter.clientId)}::uuid`);
  }
  // The report-only `any` view with no other filter has no condition at all.
  return { where: conditions.length === 0 ? 'TRUE' : conditions.join(' AND '), parameters };
}

export function createPostgresCaseRepository(executor: SqlExecutor): CaseRepository {
  const findOne = async (id: string, lock: boolean): Promise<TaxCaseRecord | null> => {
    const rows = await executor.query(
      `${CASE_SELECT} WHERE c.id = $1${lock ? ' FOR UPDATE OF c' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : mapCase(rows[0]);
  };
  const reload = async (rows: SqlRow[]): Promise<TaxCaseRecord | null> => {
    const id = rows[0]?.['id'];
    return typeof id === 'string' ? await findOne(id, false) : null;
  };
  return {
    nextCaseNumber: async () => {
      const rows = await executor.query("SELECT nextval('tax_case_code_seq') AS value");
      const row = rows[0];
      if (row === undefined) {
        throw new Error('The case code sequence returned no value.');
      }
      return integer(row, 'value');
    },
    lockClientForCaseCreation: async (clientId) => {
      await executor.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    },
    findActiveDuplicates: async (input) => {
      const rows = await executor.query(
        `${CASE_SELECT}
         WHERE c.client_id = $1 AND c.service_type_id = $2 AND c.tax_year = $3
           AND c.deleted_at IS NULL AND c.current_status_kind NOT IN ('completed', 'cancelled')
         ORDER BY c.due_date, c.id`,
        [input.clientId, input.serviceTypeId, input.taxYear],
      );
      return rows.map(mapCase);
    },
    create: async (record, initialStatus, items) => {
      // History first: the case points at it, and its own case FK is deferred.
      await executor.query(
        `INSERT INTO case_status_history (
           id, case_id, from_status_key, from_status_name, to_status_key, to_status_name,
           to_status_kind, note, actor_user_id, request_id, occurred_at
         ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, $9)`,
        [
          initialStatus.id,
          initialStatus.caseId,
          initialStatus.toStatusKey,
          initialStatus.toStatusName,
          initialStatus.toStatusKind,
          initialStatus.note,
          initialStatus.actorUserId,
          initialStatus.requestId,
          initialStatus.occurredAt,
        ],
      );
      await executor.query(
        `INSERT INTO tax_cases (
           id, case_code, client_id, service_type_id, service_name, service_fee_minor, tax_year,
           workflow_version_id, workflow_template_id, workflow_template_name,
           workflow_version_number, workflow_snapshot, current_status_key, current_status_name,
           current_status_kind, current_status_history_id, due_date, primary_consultant_user_id,
           reviewer_user_id, notes, created_by, deleted_at, created_at, updated_at, version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
           $17::date, $18, $19, $20, $21, NULL, $22, $22, 1
         )`,
        [
          record.id,
          record.caseCode,
          record.clientId,
          record.serviceTypeId,
          record.serviceName,
          record.serviceFeeMinor,
          record.taxYear,
          record.workflowVersionId,
          record.workflowTemplateId,
          record.workflowTemplateName,
          record.workflowVersionNumber,
          record.workflowSnapshot,
          record.currentStatusKey,
          record.currentStatusName,
          record.currentStatusKind,
          record.currentStatusHistoryId,
          record.dueDate,
          record.primaryConsultantUserId,
          record.reviewerUserId,
          record.notes,
          record.createdBy,
          record.createdAt,
        ],
      );
      for (const item of items) {
        await executor.query(
          `INSERT INTO case_checklist_items (
             id, case_id, position, item_key, label, document_type, required, review_required,
             instructions, state, completed_by, completed_at, preparer_comment, reviewed_by,
             reviewed_at, review_comment, created_at, updated_at, version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', NULL, NULL, '', NULL, NULL, '', $10, $10, 1)`,
          [
            item.id,
            item.caseId,
            item.position,
            item.itemKey,
            item.label,
            item.documentType,
            item.required,
            item.reviewRequired,
            item.instructions,
            item.createdAt,
          ],
        );
      }
    },
    findById: async (id) => await findOne(id, false),
    lockById: async (id) => await findOne(id, true),
    updateDetails: async (input) =>
      await reload(
        await executor.query(
          `UPDATE tax_cases
           SET due_date = $3::date, notes = $4, primary_consultant_user_id = $5,
               reviewer_user_id = $6, updated_at = $7, version = version + 1
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL
           RETURNING id`,
          [
            input.id,
            input.expectedVersion,
            input.changes.dueDate,
            input.changes.notes,
            input.changes.primaryConsultantUserId,
            input.changes.reviewerUserId,
            input.at,
          ],
        ),
      ),
    transition: async (input) => {
      const entry = input.entry;
      // Check the version first so a stale request writes no history row.
      const current = await executor.query(
        'SELECT id FROM tax_cases WHERE id = $1 AND version = $2 AND deleted_at IS NULL FOR UPDATE',
        [entry.caseId, input.expectedVersion],
      );
      if (current.length === 0) {
        return null;
      }
      await executor.query(
        `INSERT INTO case_status_history (
           id, case_id, from_status_key, from_status_name, to_status_key, to_status_name,
           to_status_kind, note, actor_user_id, request_id, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.id,
          entry.caseId,
          entry.fromStatusKey,
          entry.fromStatusName,
          entry.toStatusKey,
          entry.toStatusName,
          entry.toStatusKind,
          entry.note,
          entry.actorUserId,
          entry.requestId,
          entry.occurredAt,
        ],
      );
      return await reload(
        await executor.query(
          `UPDATE tax_cases
           SET current_status_key = $3, current_status_name = $4, current_status_kind = $5,
               current_status_history_id = $6, updated_at = $7, version = version + 1
           WHERE id = $1 AND version = $2
           RETURNING id`,
          [
            entry.caseId,
            input.expectedVersion,
            entry.toStatusKey,
            entry.toStatusName,
            entry.toStatusKind,
            entry.id,
            input.at,
          ],
        ),
      );
    },
    archive: async (input) =>
      await reload(
        await executor.query(
          `UPDATE tax_cases
           SET deleted_at = $3, updated_at = $3, version = version + 1
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL
           RETURNING id`,
          [input.id, input.expectedVersion, input.at],
        ),
      ),
    listItems: async (caseIds) => {
      if (caseIds.length === 0) {
        return [];
      }
      const rows = await executor.query(
        `SELECT * FROM case_checklist_items
         WHERE case_id = ANY ($1::uuid[])
         ORDER BY case_id, position`,
        [[...caseIds]],
      );
      return rows.map(mapItem);
    },
    updateItem: async (input) => {
      const rows = await executor.query(
        `UPDATE case_checklist_items
         SET state = $4, completed_by = $5, completed_at = $6, preparer_comment = $7,
             reviewed_by = $8, reviewed_at = $9, review_comment = $10,
             updated_at = $11, version = version + 1
         WHERE id = $1 AND case_id = $2 AND version = $3
         RETURNING *`,
        [
          input.itemId,
          input.caseId,
          input.expectedVersion,
          input.changes.state,
          input.changes.completedBy,
          input.changes.completedAt,
          input.changes.preparerComment,
          input.changes.reviewedBy,
          input.changes.reviewedAt,
          input.changes.reviewComment,
          input.at,
        ],
      );
      return rows[0] === undefined ? null : mapItem(rows[0]);
    },
    listStatusHistory: async (caseId) => {
      const rows = await executor.query(
        'SELECT * FROM case_status_history WHERE case_id = $1 ORDER BY id',
        [caseId],
      );
      return rows.map(mapHistory);
    },
    list: async (filter) => {
      const { where, parameters } = caseFilterSql(filter);
      const extra: unknown[] = [...parameters];
      let after = '';
      if (filter.after !== null) {
        extra.push(filter.after.dueDate, filter.after.id);
        const date = `$${String(extra.length - 1)}`;
        const id = `$${String(extra.length)}`;
        after = ` AND (c.due_date, c.id) > (${date}::date, ${id}::uuid)`;
      }
      extra.push(filter.limit + 1);
      const rows = await executor.query(
        `${CASE_SELECT} WHERE ${where}${after} ORDER BY c.due_date, c.id LIMIT $${String(extra.length)}`,
        extra,
      );
      return {
        cases: rows.slice(0, filter.limit).map(mapCase),
        hasMore: rows.length > filter.limit,
      };
    },
    count: async (filter) => {
      const { where, parameters } = caseFilterSql(filter);
      const rows = await executor.query(
        `SELECT count(*)::int AS count FROM tax_cases c WHERE ${where}`,
        parameters,
      );
      return rows[0] === undefined ? 0 : integer(rows[0], 'count');
    },
  };
}
