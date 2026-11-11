import {
  AUDIT_ACTIONS,
  CASE_ACTIVITY_ACTIONS,
  CASE_DUE_SOON_DAYS,
  CASE_FIELDS,
  CHECKLIST_GATED_STATUS_KINDS,
  addDaysToDate,
  calendarDateIn,
  checklistProgress,
  formatCaseCode,
  isTerminalStatusKind,
  newUuidV7,
  type AuditMetadataValue,
  type CaseActivity,
  type CaseActivityAction,
  type CaseActivityList,
  type CaseAvailableTransition,
  type CaseChecklistItem,
  type CaseCreateRequest,
  type CaseField,
  type CaseList,
  type CaseListItem,
  type CaseListQuery,
  type CasePerson,
  type CaseQueueCounts,
  type CaseQueueCountsQuery,
  type CaseStatusHistory,
  type CaseTransitionRequest,
  type CaseUpdateRequest,
  type CaseUrgency,
  type CaseView,
  type ChecklistAction,
  type TaxCase,
  type WorkflowStatusDefinition,
} from '@taxdesk/shared';
import { base64UrlToBytes, bytesToBase64Url } from '../../crypto/encoding.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { requireAccessibleClient } from '../clients/client-access.js';
import { personLookup, type Person } from '../people.js';
import {
  canArchiveCase,
  canAssignCase,
  canPrepareChecklist,
  canReviewChecklist,
  canWorkCase,
  readsAllCases,
  requireReadableCase,
} from './case-access.js';
import type {
  CaseChecklistItemRecord,
  CaseListCursor,
  CaseQueryFilter,
  CaseStatusHistoryRecord,
  ChecklistItemChanges,
  TaxCaseRecord,
} from './types.js';

export interface CaseServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
}

const ENTITY_TYPE = 'tax_case';
const DEFAULT_TIMEZONE = 'Asia/Karachi';

function stale(what = 'case'): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    `This ${what} changed since you loaded it. Refresh, review the latest values, and try again.`,
  );
}

function validation(field: string, message: string): AuthError {
  return new AuthError(400, 'VALIDATION_FAILED', message, { errors: [{ field, message }] });
}

function encodeCursor(cursor: CaseListCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([cursor.dueDate, cursor.id])));
}

function decodeCursor(value: string): CaseListCursor {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(parsed[1])
    ) {
      return { dueDate: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw validation('cursor', 'The page cursor is not valid.');
}

function statusOf(record: TaxCaseRecord, key: string): WorkflowStatusDefinition | undefined {
  return record.workflowSnapshot.statuses.find((status) => status.key === key);
}

/** A status gates on the checklist when it asks to, or is a Filed/Completed status. */
function requiresChecklist(status: WorkflowStatusDefinition): boolean {
  return status.requiresChecklistComplete || CHECKLIST_GATED_STATUS_KINDS.includes(status.kind);
}

function checklistBlockedReason(outstanding: number): string {
  return outstanding === 1
    ? '1 required checklist item is not complete and verified.'
    : `${String(outstanding)} required checklist items are not complete and verified.`;
}

function isOpen(record: TaxCaseRecord): boolean {
  return record.deletedAt === null && !isTerminalStatusKind(record.currentStatusKind);
}

/**
 * Tax cases (TD-304–TD-310). Every rule — assignment, transitions, checklist
 * gates, separation of preparer and reviewer, optimistic concurrency — is
 * decided here and re-checked under a row lock inside the transaction that
 * writes, so two concurrent requests cannot both pass a check.
 */
export class CaseService {
  constructor(private readonly dependencies: CaseServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private async firmDates(): Promise<{ today: string; dueSoonUntil: string }> {
    const firm = await this.repositories.firm.get();
    const today = calendarDateIn(firm?.timezone ?? DEFAULT_TIMEZONE, this.dependencies.clock());
    return { today, dueSoonUntil: addDaysToDate(today, CASE_DUE_SOON_DAYS) };
  }

  private urgency(
    record: TaxCaseRecord,
    dates: { today: string; dueSoonUntil: string },
  ): CaseUrgency {
    if (!isOpen(record)) {
      return null;
    }
    if (record.dueDate < dates.today) {
      return 'overdue';
    }
    return record.dueDate <= dates.dueSoonUntil ? 'due_soon' : null;
  }

  // -------------------------------------------------------------------------
  // Assignees
  // -------------------------------------------------------------------------

  private async isAssignable(userId: string): Promise<boolean> {
    const user = await this.repositories.users.findById(userId);
    if (user?.status !== 'active') {
      return false;
    }
    const permissions = await this.repositories.roles.permissionsForUser(userId);
    return permissions.includes('cases.work_assigned') || permissions.includes('cases.manage');
  }

  /** Active staff who can hold case work (consultants, managers, administrators). */
  async listAssignees(): Promise<CasePerson[]> {
    const users = await this.repositories.users.list();
    const people: CasePerson[] = [];
    for (const user of users) {
      if (await this.isAssignable(user.id)) {
        people.push({ id: user.id, displayName: user.displayName });
      }
    }
    return people.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private async assertAssignees(
    primaryConsultantUserId: string | null,
    reviewerUserId: string | null,
  ): Promise<void> {
    if (primaryConsultantUserId !== null && !(await this.isAssignable(primaryConsultantUserId))) {
      throw new AuthError(
        400,
        'ASSIGNEE_INVALID',
        'Choose an active staff member who can work cases.',
        {
          errors: [
            {
              field: 'primaryConsultantUserId',
              message: 'Choose an active staff member who can work cases.',
            },
          ],
        },
      );
    }
    if (reviewerUserId !== null && !(await this.isAssignable(reviewerUserId))) {
      throw new AuthError(
        400,
        'ASSIGNEE_INVALID',
        'Choose an active staff member who can review cases.',
        {
          errors: [
            {
              field: 'reviewerUserId',
              message: 'Choose an active staff member who can review cases.',
            },
          ],
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // DTO mapping
  // -------------------------------------------------------------------------

  private toChecklistItem(
    item: CaseChecklistItemRecord,
    lookup: (id: string | null) => Promise<Person | null>,
  ): Promise<CaseChecklistItem> {
    return (async () => ({
      id: item.id,
      key: item.itemKey,
      label: item.label,
      documentType: item.documentType,
      required: item.required,
      reviewRequired: item.reviewRequired,
      instructions: item.instructions,
      state: item.state,
      completedBy: await lookup(item.completedBy),
      completedAt: item.completedAt,
      preparerComment: item.preparerComment,
      reviewedBy: await lookup(item.reviewedBy),
      reviewedAt: item.reviewedAt,
      reviewComment: item.reviewComment,
      version: item.version,
    }))();
  }

  private async toCase(actor: Actor, record: TaxCaseRecord): Promise<TaxCase> {
    const lookup = personLookup(this.repositories.users);
    const items = await this.repositories.cases.listItems([record.id]);
    const progress = checklistProgress(items);
    const dates = await this.firmDates();
    const open = isOpen(record);
    const mayWork = canWorkCase(actor, record);
    const availableTransitions: CaseAvailableTransition[] =
      record.deletedAt !== null
        ? []
        : record.workflowSnapshot.transitions
            .filter((transition) => transition.from === record.currentStatusKey)
            .flatMap((transition) => {
              const target = statusOf(record, transition.to);
              if (target === undefined) {
                return [];
              }
              return [
                {
                  to: { key: target.key, name: target.name, kind: target.kind },
                  blockedReason:
                    requiresChecklist(target) && progress.requiredOutstanding > 0
                      ? checklistBlockedReason(progress.requiredOutstanding)
                      : null,
                },
              ];
            });
    const checklistOpen = record.deletedAt === null && record.currentStatusKind === 'open';
    return {
      id: record.id,
      caseCode: record.caseCode,
      client: {
        id: record.clientId,
        clientCode: record.clientCode,
        displayName: record.clientDisplayName,
      },
      service: {
        id: record.serviceTypeId,
        name: record.serviceName,
        feeMinor: record.serviceFeeMinor,
      },
      taxYear: record.taxYear,
      workflow: {
        templateId: record.workflowTemplateId,
        versionId: record.workflowVersionId,
        templateName: record.workflowTemplateName,
        versionNumber: record.workflowVersionNumber,
        statuses: [...record.workflowSnapshot.statuses],
        transitions: [...record.workflowSnapshot.transitions],
      },
      status: {
        key: record.currentStatusKey,
        name: record.currentStatusName,
        kind: record.currentStatusKind,
      },
      dueDate: record.dueDate,
      urgency: this.urgency(record, dates),
      primaryConsultant: await lookup(record.primaryConsultantUserId),
      reviewer: await lookup(record.reviewerUserId),
      notes: record.notes,
      checklist: await Promise.all(items.map((item) => this.toChecklistItem(item, lookup))),
      checklistProgress: progress,
      availableTransitions,
      allowedActions: {
        edit: open && mayWork,
        assign: open && canAssignCase(actor, record),
        transition: record.deletedAt === null && mayWork && availableTransitions.length > 0,
        prepareChecklist: checklistOpen && canPrepareChecklist(actor, record),
        reviewChecklist: checklistOpen && canReviewChecklist(actor, record),
        archive:
          record.deletedAt === null &&
          isTerminalStatusKind(record.currentStatusKind) &&
          canArchiveCase(actor, record),
      },
      state: record.deletedAt === null ? 'active' : 'archived',
      archivedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  async getCase(actor: Actor, caseId: string): Promise<TaxCase> {
    const record = requireReadableCase(actor, await this.repositories.cases.findById(caseId));
    return await this.toCase(actor, record);
  }

  // -------------------------------------------------------------------------
  // Queues (TD-308)
  // -------------------------------------------------------------------------

  private async queryFilter(
    actor: Actor,
    view: CaseQueryFilter['view'],
    query: CaseQueueCountsQuery,
  ): Promise<CaseQueryFilter> {
    return {
      view,
      ...(await this.firmDates()),
      actorUserId: actor.userId,
      restrictToAssignedUserId: readsAllCases(actor) ? null : actor.userId,
      serviceTypeId: query.service ?? null,
      statusKey: query.status ?? null,
      primaryConsultantUserId: query.assignee ?? null,
      reviewerUserId: query.reviewer ?? null,
      taxYear: query.taxYear ?? null,
      clientId: query.client ?? null,
    };
  }

  async listCases(actor: Actor, query: CaseListQuery): Promise<CaseList> {
    const filter = await this.queryFilter(actor, query.view, query);
    const page = await this.repositories.cases.list({
      ...filter,
      limit: query.limit,
      after: query.cursor === undefined ? null : decodeCursor(query.cursor),
    });
    const total = await this.repositories.cases.count(filter);
    const lookup = personLookup(this.repositories.users);
    const cases: CaseListItem[] = [];
    for (const record of page.cases) {
      cases.push({
        id: record.id,
        caseCode: record.caseCode,
        client: {
          id: record.clientId,
          clientCode: record.clientCode,
          displayName: record.clientDisplayName,
        },
        serviceName: record.serviceName,
        taxYear: record.taxYear,
        status: {
          key: record.currentStatusKey,
          name: record.currentStatusName,
          kind: record.currentStatusKind,
        },
        dueDate: record.dueDate,
        urgency: this.urgency(record, filter),
        primaryConsultant: await lookup(record.primaryConsultantUserId),
        reviewer: await lookup(record.reviewerUserId),
        state: record.deletedAt === null ? 'active' : 'archived',
        updatedAt: record.updatedAt,
      });
    }
    const last = page.cases.at(-1);
    return {
      cases,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor({ dueDate: last.dueDate, id: last.id })
          : null,
      total,
    };
  }

  /** Queue counts use the same filter builder and predicate as the list. */
  async queueCounts(actor: Actor, query: CaseQueueCountsQuery): Promise<CaseQueueCounts> {
    const counts: Partial<Record<CaseView, number>> = {};
    for (const view of ['my', 'team', 'unassigned', 'due_soon', 'overdue'] as const) {
      counts[view] = await this.repositories.cases.count(
        await this.queryFilter(actor, view, query),
      );
    }
    return {
      my: counts.my ?? 0,
      team: counts.team ?? 0,
      unassigned: counts.unassigned ?? 0,
      due_soon: counts.due_soon ?? 0,
      overdue: counts.overdue ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Create (TD-304)
  // -------------------------------------------------------------------------

  async createCase(input: {
    readonly actor: Actor;
    readonly request: CaseCreateRequest;
    readonly requestId: string;
  }): Promise<TaxCase> {
    const { actor, request } = input;
    const now = this.dependencies.clock();
    const at = now.toISOString();

    const client = requireAccessibleClient(
      actor,
      await this.repositories.clients.findById(request.clientId),
    );
    if (client.deletedAt !== null) {
      throw new AuthError(409, 'CLIENT_ARCHIVED', 'Restore this client before opening a case.');
    }
    const service = await this.repositories.serviceTypes.findById(request.serviceTypeId);
    if (service === null) {
      throw validation('serviceTypeId', 'Choose an existing service.');
    }
    if (service.deletedAt !== null) {
      throw new AuthError(409, 'SERVICE_TYPE_ARCHIVED', 'This service is archived.', {
        errors: [{ field: 'serviceTypeId', message: 'Choose an active service.' }],
      });
    }
    const version = await this.repositories.workflowTemplates.findVersion(
      request.workflowVersionId,
    );
    if (version === null) {
      throw validation('workflowVersionId', 'Choose an existing workflow version.');
    }
    if (version.state !== 'published') {
      throw new AuthError(
        409,
        'WORKFLOW_VERSION_NOT_PUBLISHED',
        'Only a published workflow version can be used for a case.',
        { errors: [{ field: 'workflowVersionId', message: 'Choose a published version.' }] },
      );
    }
    const template = await this.repositories.workflowTemplates.findTemplate(version.templateId);
    const initial = version.definition.statuses.find((status) => status.initial);
    if (template === null || initial === undefined) {
      throw validation('workflowVersionId', 'Choose a valid workflow version.');
    }

    // Without `cases.assign` a user can only open a case for themselves.
    if (!hasPermission(actor, 'cases.assign')) {
      if (request.primaryConsultantUserId !== actor.userId || request.reviewerUserId !== null) {
        throw forbidden(
          'Only a manager can assign other staff. Open the case with yourself as primary consultant.',
        );
      }
    }
    await this.assertAssignees(request.primaryConsultantUserId, request.reviewerUserId);

    const caseId = newUuidV7(now.getTime());
    const history: CaseStatusHistoryRecord = {
      id: newUuidV7(now.getTime()),
      caseId,
      fromStatusKey: null,
      fromStatusName: null,
      toStatusKey: initial.key,
      toStatusName: initial.name,
      toStatusKind: initial.kind,
      note: '',
      actorUserId: actor.userId,
      requestId: input.requestId,
      occurredAt: at,
    };
    const items: CaseChecklistItemRecord[] = version.definition.checklist.map((item, position) => ({
      id: newUuidV7(now.getTime()),
      caseId,
      position,
      itemKey: item.key,
      label: item.label,
      documentType: item.documentType,
      required: item.required,
      reviewRequired: item.reviewRequired,
      instructions: item.instructions,
      state: 'open',
      completedBy: null,
      completedAt: null,
      preparerComment: '',
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: '',
      createdAt: at,
      updatedAt: at,
      version: 1,
    }));

    const created = await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.cases.lockClientForCaseCreation(client.id);
      const duplicates = await repositories.cases.findActiveDuplicates({
        clientId: client.id,
        serviceTypeId: service.id,
        taxYear: request.taxYear,
      });
      const overrideReason = request.duplicateOverrideReason;
      if (duplicates.length > 0) {
        const codes = duplicates.map((duplicate) => duplicate.caseCode).join(', ');
        if (service.duplicateCasePolicy === 'block') {
          throw new AuthError(
            409,
            'CASE_DUPLICATE_BLOCKED',
            `This client already has an open ${service.name} case for tax year ${String(request.taxYear)} (${codes}). Close it before opening another.`,
          );
        }
        if (overrideReason === undefined) {
          throw new AuthError(
            409,
            'CASE_DUPLICATE_WARNING',
            `This client already has an open ${service.name} case for tax year ${String(request.taxYear)} (${codes}). Give a reason to open another.`,
          );
        }
      }
      const record: TaxCaseRecord = {
        id: caseId,
        caseCode: formatCaseCode(await repositories.cases.nextCaseNumber()),
        clientId: client.id,
        clientCode: client.clientCode,
        clientDisplayName: client.displayName,
        serviceTypeId: service.id,
        serviceName: service.name,
        serviceFeeMinor: service.defaultFeeMinor,
        taxYear: request.taxYear,
        workflowVersionId: version.id,
        workflowTemplateId: template.id,
        workflowTemplateName: template.name,
        workflowVersionNumber: version.versionNumber,
        workflowSnapshot: {
          statuses: version.definition.statuses,
          transitions: version.definition.transitions,
        },
        currentStatusKey: initial.key,
        currentStatusName: initial.name,
        currentStatusKind: initial.kind,
        currentStatusHistoryId: history.id,
        dueDate: request.dueDate,
        primaryConsultantUserId: request.primaryConsultantUserId,
        reviewerUserId: request.reviewerUserId,
        notes: request.notes,
        createdBy: actor.userId,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      await repositories.cases.create(record, history, items);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.caseCreated,
        entityType: ENTITY_TYPE,
        entityId: caseId,
        requestId: input.requestId,
        metadata: {
          caseCode: record.caseCode,
          clientId: client.id,
          serviceName: service.name,
          taxYear: request.taxYear,
          workflowVersionId: version.id,
          toStatus: initial.name,
          dueDate: request.dueDate,
          primaryConsultantUserId: request.primaryConsultantUserId,
          reviewerUserId: request.reviewerUserId,
        },
      });
      if (duplicates.length > 0 && overrideReason !== undefined) {
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.caseDuplicateOverride,
          entityType: ENTITY_TYPE,
          entityId: caseId,
          requestId: input.requestId,
          metadata: {
            reason: overrideReason,
            matchedCases: duplicates
              .map((duplicate) => duplicate.caseCode)
              .join(',')
              .slice(0, 500),
          },
        });
      }
      return record;
    });
    return await this.toCase(actor, created);
  }

  // -------------------------------------------------------------------------
  // Edit details (TD-305)
  // -------------------------------------------------------------------------

  async updateCase(input: {
    readonly actor: Actor;
    readonly caseId: string;
    readonly request: CaseUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<TaxCase> {
    const { actor, request } = input;
    const now = this.dependencies.clock();
    const current = requireReadableCase(
      actor,
      await this.repositories.cases.findById(input.caseId),
    );
    if (!canWorkCase(actor, current)) {
      throw forbidden();
    }
    const assignmentChanged =
      request.primaryConsultantUserId !== current.primaryConsultantUserId ||
      request.reviewerUserId !== current.reviewerUserId;
    if (assignmentChanged && !canAssignCase(actor, current)) {
      throw forbidden('Only a manager can change who is assigned to a case.');
    }
    if (current.version !== input.expectedVersion) {
      throw stale();
    }
    this.assertEditable(current);
    if (assignmentChanged) {
      await this.assertAssignees(
        request.primaryConsultantUserId === current.primaryConsultantUserId
          ? null
          : request.primaryConsultantUserId,
        request.reviewerUserId === current.reviewerUserId ? null : request.reviewerUserId,
      );
    }

    const changed: CaseField[] = [];
    if (request.dueDate !== current.dueDate) changed.push('dueDate');
    if (request.notes !== current.notes) changed.push('notes');
    if (request.primaryConsultantUserId !== current.primaryConsultantUserId) {
      changed.push('primaryConsultant');
    }
    if (request.reviewerUserId !== current.reviewerUserId) changed.push('reviewer');
    if (changed.length === 0) {
      return await this.toCase(actor, current);
    }

    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const locked = await repositories.cases.lockById(current.id);
      if (locked?.version !== input.expectedVersion) {
        throw stale();
      }
      this.assertEditable(locked);
      const next = await repositories.cases.updateDetails({
        id: current.id,
        changes: {
          dueDate: request.dueDate,
          notes: request.notes,
          primaryConsultantUserId: request.primaryConsultantUserId,
          reviewerUserId: request.reviewerUserId,
        },
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stale();
      }
      const metadata: Record<string, AuditMetadataValue> = {
        caseCode: current.caseCode,
        changedFields: CASE_FIELDS.filter((field) => changed.includes(field)).join(','),
      };
      if (changed.includes('dueDate')) metadata['dueDate'] = request.dueDate;
      if (changed.includes('primaryConsultant')) {
        metadata['primaryConsultantUserId'] = request.primaryConsultantUserId;
      }
      if (changed.includes('reviewer')) metadata['reviewerUserId'] = request.reviewerUserId;
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.caseUpdated,
        entityType: ENTITY_TYPE,
        entityId: current.id,
        requestId: input.requestId,
        metadata,
      });
      return next;
    });
    return await this.toCase(actor, updated);
  }

  private assertEditable(record: TaxCaseRecord): void {
    if (record.deletedAt !== null) {
      throw new AuthError(409, 'CASE_ARCHIVED', 'Archived cases cannot be changed.');
    }
    if (isTerminalStatusKind(record.currentStatusKind)) {
      throw new AuthError(
        409,
        'CASE_CLOSED',
        `This case is ${record.currentStatusName.toLowerCase()} and can no longer be edited.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Status transitions (TD-306)
  // -------------------------------------------------------------------------

  async transitionCase(input: {
    readonly actor: Actor;
    readonly caseId: string;
    readonly request: CaseTransitionRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<TaxCase> {
    const { actor, request } = input;
    const now = this.dependencies.clock();
    const current = requireReadableCase(
      actor,
      await this.repositories.cases.findById(input.caseId),
    );
    if (!canWorkCase(actor, current)) {
      throw forbidden();
    }
    if (current.version !== input.expectedVersion) {
      throw stale();
    }

    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      // The lock makes the state, transition, and checklist checks atomic
      // with the write: a concurrent checklist reopen waits for this commit.
      const locked = await repositories.cases.lockById(current.id);
      if (locked?.version !== input.expectedVersion) {
        throw stale();
      }
      if (locked.deletedAt !== null) {
        throw new AuthError(409, 'CASE_ARCHIVED', 'Archived cases cannot change status.');
      }
      const target = statusOf(locked, request.toStatus);
      const allowed = locked.workflowSnapshot.transitions.some(
        (transition) =>
          transition.from === locked.currentStatusKey && transition.to === request.toStatus,
      );
      if (target === undefined || !allowed) {
        throw new AuthError(
          409,
          'TRANSITION_NOT_ALLOWED',
          `This case cannot move from ${locked.currentStatusName} to ${target?.name ?? `"${request.toStatus}"`}.`,
        );
      }
      if (requiresChecklist(target)) {
        const outstanding = checklistProgress(
          await repositories.cases.listItems([locked.id]),
        ).requiredOutstanding;
        if (outstanding > 0) {
          throw new AuthError(
            409,
            'CHECKLIST_INCOMPLETE',
            `${target.name} needs a complete checklist: ${checklistBlockedReason(outstanding)}`,
          );
        }
      }
      const entry: CaseStatusHistoryRecord = {
        id: newUuidV7(now.getTime()),
        caseId: locked.id,
        fromStatusKey: locked.currentStatusKey,
        fromStatusName: locked.currentStatusName,
        toStatusKey: target.key,
        toStatusName: target.name,
        toStatusKind: target.kind,
        note: request.note,
        actorUserId: actor.userId,
        requestId: input.requestId,
        occurredAt: now.toISOString(),
      };
      const next = await repositories.cases.transition({
        entry,
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stale();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.caseStatusChanged,
        entityType: ENTITY_TYPE,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: {
          caseCode: locked.caseCode,
          statusHistoryId: entry.id,
          fromStatus: locked.currentStatusName,
          toStatus: target.name,
          toStatusKind: target.kind,
        },
      });
      return next;
    });
    return await this.toCase(actor, updated);
  }

  async statusHistory(actor: Actor, caseId: string): Promise<CaseStatusHistory> {
    const record = requireReadableCase(actor, await this.repositories.cases.findById(caseId));
    const lookup = personLookup(this.repositories.users);
    const entries = await this.repositories.cases.listStatusHistory(record.id);
    return {
      entries: await Promise.all(
        entries.map(async (entry) => ({
          id: entry.id,
          from:
            entry.fromStatusKey === null || entry.fromStatusName === null
              ? null
              : { key: entry.fromStatusKey, name: entry.fromStatusName },
          to: { key: entry.toStatusKey, name: entry.toStatusName, kind: entry.toStatusKind },
          actor: await lookup(entry.actorUserId),
          note: entry.note,
          occurredAt: entry.occurredAt,
        })),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Checklist (TD-307)
  // -------------------------------------------------------------------------

  async checklistAction(input: {
    readonly actor: Actor;
    readonly caseId: string;
    readonly itemId: string;
    readonly action: ChecklistAction;
    readonly comment: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<TaxCase> {
    const { actor, action } = input;
    const now = this.dependencies.clock();
    const at = now.toISOString();
    const current = requireReadableCase(
      actor,
      await this.repositories.cases.findById(input.caseId),
    );
    const preparing = action === 'complete' || action === 'reopen';
    const permitted = preparing
      ? canPrepareChecklist(actor, current)
      : canReviewChecklist(actor, current);
    if (!permitted) {
      throw forbidden(
        preparing
          ? 'Only the primary consultant or a manager can complete checklist items.'
          : 'Only the reviewer or a manager can verify checklist items.',
      );
    }

    const result = await this.dependencies.unitOfWork.run(async (repositories) => {
      const locked = await repositories.cases.lockById(current.id);
      if (locked === null) {
        throw stale();
      }
      const item = (await repositories.cases.listItems([locked.id])).find(
        (candidate) => candidate.id === input.itemId,
      );
      if (item === undefined) {
        throw new AuthError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
      }
      if (item.version !== input.expectedVersion) {
        throw stale('checklist item');
      }
      if (locked.deletedAt !== null || locked.currentStatusKind !== 'open') {
        throw new AuthError(
          409,
          'CHECKLIST_LOCKED',
          `The checklist is locked because this case is ${locked.currentStatusName.toLowerCase()}.`,
        );
      }
      const changes = this.nextItemState(actor, item, action, input.comment, at);
      const next = await repositories.cases.updateItem({
        caseId: locked.id,
        itemId: item.id,
        changes,
        expectedVersion: input.expectedVersion,
        at,
      });
      if (next === null) {
        throw stale('checklist item');
      }
      const actions = {
        complete: AUDIT_ACTIONS.caseChecklistCompleted,
        reopen: AUDIT_ACTIONS.caseChecklistReopened,
        verify: AUDIT_ACTIONS.caseChecklistVerified,
        reject: AUDIT_ACTIONS.caseChecklistRejected,
      } as const;
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: actions[action],
        entityType: ENTITY_TYPE,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: { caseCode: locked.caseCode, itemId: item.id, checklistItem: item.label },
      });
      return locked;
    });
    const refreshed = await this.repositories.cases.findById(result.id);
    return await this.toCase(actor, refreshed ?? result);
  }

  private nextItemState(
    actor: Actor,
    item: CaseChecklistItemRecord,
    action: ChecklistAction,
    comment: string,
    at: string,
  ): ChecklistItemChanges {
    const refuse = (message: string): never => {
      throw new AuthError(409, 'CHECKLIST_ACTION_NOT_ALLOWED', message);
    };
    switch (action) {
      case 'complete':
        if (item.state !== 'open' && item.state !== 'rejected') {
          refuse('This item is already complete.');
        }
        return {
          state: 'completed',
          completedBy: actor.userId,
          completedAt: at,
          preparerComment: comment,
          reviewedBy: null,
          reviewedAt: null,
          reviewComment: item.reviewComment,
        };
      case 'reopen':
        if (item.state !== 'completed' && item.state !== 'verified') {
          refuse('Only a completed or verified item can be reopened.');
        }
        return {
          state: 'open',
          completedBy: null,
          completedAt: null,
          preparerComment: comment,
          reviewedBy: null,
          reviewedAt: null,
          reviewComment: '',
        };
      case 'verify':
      case 'reject':
        if (!item.reviewRequired) {
          refuse('This item does not need reviewer verification.');
        }
        if (item.state !== 'completed') {
          refuse('Only a completed item awaiting review can be verified or rejected.');
        }
        if (item.completedBy === actor.userId) {
          refuse('You completed this item, so someone else must review it.');
        }
        return {
          state: action === 'verify' ? 'verified' : 'rejected',
          completedBy: item.completedBy,
          completedAt: item.completedAt,
          preparerComment: item.preparerComment,
          reviewedBy: actor.userId,
          reviewedAt: at,
          reviewComment: comment,
        };
    }
  }

  // -------------------------------------------------------------------------
  // History and archive (TD-309)
  // -------------------------------------------------------------------------

  async listActivity(input: {
    readonly actor: Actor;
    readonly caseId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<CaseActivityList> {
    requireReadableCase(input.actor, await this.repositories.cases.findById(input.caseId));
    const page = await this.repositories.audit.listForEntity({
      entityType: ENTITY_TYPE,
      entityId: input.caseId,
      limit: input.limit,
      cursor: input.cursor,
    });
    const lookup = personLookup(this.repositories.users);
    const events: CaseActivity[] = [];
    for (const event of page.events) {
      if (!(CASE_ACTIVITY_ACTIONS as readonly string[]).includes(event.action)) {
        continue;
      }
      const metadata = event.metadata;
      const text = (key: string): string | null => {
        const value = metadata[key];
        return typeof value === 'string' ? value : null;
      };
      const person = async (key: string): Promise<Person | null> =>
        key in metadata ? await lookup(text(key)) : null;
      const changedFields = (text('changedFields') ?? '')
        .split(',')
        .filter((field): field is CaseField => (CASE_FIELDS as readonly string[]).includes(field));
      events.push({
        id: event.id,
        occurredAt: event.occurredAt,
        action: event.action as CaseActivityAction,
        actor: await lookup(event.actorUserId),
        changedFields,
        fromStatus: text('fromStatus'),
        toStatus: text('toStatus'),
        checklistItem: text('checklistItem'),
        primaryConsultant: await person('primaryConsultantUserId'),
        reviewer: await person('reviewerUserId'),
        dueDate: text('dueDate'),
        overrideReason:
          event.action === AUDIT_ACTIONS.caseDuplicateOverride ? text('reason') : null,
      });
    }
    return { events, nextCursor: page.nextCursor };
  }

  async archiveCase(input: {
    readonly actor: Actor;
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<TaxCase> {
    const now = this.dependencies.clock();
    const current = requireReadableCase(
      input.actor,
      await this.repositories.cases.findById(input.caseId),
    );
    if (!canArchiveCase(input.actor, current)) {
      throw forbidden();
    }
    if (current.version !== input.expectedVersion) {
      throw stale();
    }
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const locked = await repositories.cases.lockById(current.id);
      if (locked?.version !== input.expectedVersion) {
        throw stale();
      }
      if (locked.deletedAt !== null) {
        throw new AuthError(409, 'CASE_ARCHIVED', 'This case is already archived.');
      }
      if (!isTerminalStatusKind(locked.currentStatusKind)) {
        throw new AuthError(
          409,
          'CASE_NOT_CLOSED',
          'Only completed or cancelled cases can be archived.',
        );
      }
      const next = await repositories.cases.archive({
        id: locked.id,
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stale();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.caseArchived,
        entityType: ENTITY_TYPE,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: { caseCode: locked.caseCode, toStatus: locked.currentStatusName },
      });
      return next;
    });
    return await this.toCase(input.actor, updated);
  }
}
