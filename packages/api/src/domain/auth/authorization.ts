import type { PermissionKey } from '@taxdesk/shared';
import { AuthError, forbidden } from './errors.js';
import type { Actor } from './types.js';

export function hasPermission(actor: Actor, permission: PermissionKey): boolean {
  return actor.permissions.includes(permission);
}

/**
 * Server-side permission enforcement. Routes declare a permission explicitly;
 * this guard is the only place a permission decision is made.
 */
export function assertPermission(actor: Actor, permission: PermissionKey): void {
  if (!hasPermission(actor, permission)) {
    throw forbidden();
  }
}

/** Passes when the actor holds at least one of the permissions. */
export function assertAnyPermission(actor: Actor, permissions: readonly PermissionKey[]): void {
  if (!permissions.some((permission) => hasPermission(actor, permission))) {
    throw forbidden();
  }
}

/**
 * MFA gate. A signed-in user without confirmed MFA may only reach enrollment,
 * session, and logout routes; a session that has not completed the MFA
 * challenge may not reach application routes at all.
 */
export function assertMfaReady(actor: Actor): void {
  if (!actor.mfaEnrolled) {
    throw new AuthError(
      403,
      'MFA_ENROLLMENT_REQUIRED',
      'Set up multi-factor authentication before using TaxDesk.',
    );
  }
  if (!actor.mfaVerified) {
    throw new AuthError(403, 'MFA_REQUIRED', 'Complete multi-factor authentication to continue.');
  }
}

/** Fields needed to decide whether an actor may see an assigned record. */
export interface AssignedRecord {
  readonly assignedUserIds: readonly string[];
}

/**
 * Case-work ownership/assignment rule. Managers and read-only users with
 * `cases.read_all` see every case; a consultant with `cases.read_assigned` sees
 * only cases where they are assigned. The rule is pure and unit-tested so the
 * Epic 3 case routes can call it without duplicating authorization logic.
 */
export function canAccessAssignedRecord(actor: Actor, record: AssignedRecord): boolean {
  if (hasPermission(actor, 'cases.read_all')) {
    return true;
  }
  if (hasPermission(actor, 'cases.read_assigned')) {
    return record.assignedUserIds.includes(actor.userId);
  }
  return false;
}

export function assertCanAccessAssignedRecord(actor: Actor, record: AssignedRecord): void {
  if (!canAccessAssignedRecord(actor, record)) {
    // Deliberately the same 403 as any other permission failure so guessing a
    // record identifier does not reveal whether the record exists.
    throw forbidden();
  }
}

/**
 * Case-work mutation rule. `cases.manage` lets managers update any case they
 * can see; `cases.work_assigned` lets consultants update only cases they are
 * assigned to. Read-only and billing users hold neither and are always denied.
 */
export function canManageAssignedRecord(actor: Actor, record: AssignedRecord): boolean {
  if (hasPermission(actor, 'cases.manage') && canAccessAssignedRecord(actor, record)) {
    return true;
  }
  return (
    hasPermission(actor, 'cases.work_assigned') && record.assignedUserIds.includes(actor.userId)
  );
}

export function assertCanManageAssignedRecord(actor: Actor, record: AssignedRecord): void {
  if (!canManageAssignedRecord(actor, record)) {
    throw forbidden();
  }
}

/**
 * Self-or-permission ownership rule for a user-scoped resource. A signed-in
 * user may read their own record without `users.read`; everyone else needs the
 * declared permission. The target ID always comes from the path, never from
 * request-supplied scope.
 */
export function assertSelfOrPermission(
  actor: Actor,
  targetUserId: string,
  permission: PermissionKey,
): void {
  if (actor.userId === targetUserId) {
    return;
  }
  assertPermission(actor, permission);
}
