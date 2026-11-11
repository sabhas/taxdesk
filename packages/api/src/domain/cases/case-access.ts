import {
  canAccessAssignedRecord,
  canManageAssignedRecord,
  hasPermission,
} from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import type { TaxCaseRecord } from './types.js';

/**
 * Case authorization rules. They reuse the Epic 1 assignment rule
 * (`canAccessAssignedRecord` / `canManageAssignedRecord`), where "assigned"
 * means primary consultant or reviewer:
 *
 * - read: `cases.read_all`, or `cases.read_assigned` and assigned;
 * - edit details and move status: `cases.manage` and readable, or
 *   `cases.work_assigned` and assigned;
 * - change assignees: additionally `cases.assign`;
 * - prepare checklist items: `cases.manage`, or the primary consultant;
 * - review checklist items: `cases.manage`, or the reviewer (and never one's
 *   own completed item — checked by the service);
 * - archive: `cases.manage`.
 */
function assigned(record: TaxCaseRecord) {
  return {
    assignedUserIds: [record.primaryConsultantUserId, record.reviewerUserId].filter(
      (id): id is string => id !== null,
    ),
  };
}

export function canReadCase(actor: Actor, record: TaxCaseRecord): boolean {
  return canAccessAssignedRecord(actor, assigned(record));
}

export function canWorkCase(actor: Actor, record: TaxCaseRecord): boolean {
  return canManageAssignedRecord(actor, assigned(record));
}

export function canAssignCase(actor: Actor, record: TaxCaseRecord): boolean {
  return hasPermission(actor, 'cases.assign') && canWorkCase(actor, record);
}

export function canPrepareChecklist(actor: Actor, record: TaxCaseRecord): boolean {
  if (hasPermission(actor, 'cases.manage') && canReadCase(actor, record)) {
    return true;
  }
  return (
    hasPermission(actor, 'cases.work_assigned') && record.primaryConsultantUserId === actor.userId
  );
}

export function canReviewChecklist(actor: Actor, record: TaxCaseRecord): boolean {
  if (hasPermission(actor, 'cases.manage') && canReadCase(actor, record)) {
    return true;
  }
  return hasPermission(actor, 'cases.work_assigned') && record.reviewerUserId === actor.userId;
}

export function canArchiveCase(actor: Actor, record: TaxCaseRecord): boolean {
  return hasPermission(actor, 'cases.manage') && canReadCase(actor, record);
}

/** Whether the list must be restricted to the actor's assigned cases. */
export function readsAllCases(actor: Actor): boolean {
  return hasPermission(actor, 'cases.read_all');
}

/**
 * Resolves a looked-up case for the actor. Without `cases.read_all` a missing
 * case and someone else's case get the same 403, so guessing an ID reveals
 * nothing.
 */
export function requireReadableCase(actor: Actor, record: TaxCaseRecord | null): TaxCaseRecord {
  if (record === null) {
    if (readsAllCases(actor)) {
      throw new AuthError(404, 'CASE_NOT_FOUND', 'The requested case was not found.');
    }
    throw forbidden();
  }
  if (!canReadCase(actor, record)) {
    throw forbidden();
  }
  return record;
}
