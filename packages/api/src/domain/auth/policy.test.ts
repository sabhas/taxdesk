/* eslint-disable @typescript-eslint/no-confusing-void-expression -- expect(() => void) assertions are the vitest idiom */
import { describe, expect, it } from 'vitest';
import { permissionsForRoles, type RoleKey } from '@taxdesk/shared';
import {
  assertCanAccessAssignedRecord,
  assertCanManageAssignedRecord,
  assertMfaReady,
  assertPermission,
  assertSelfOrPermission,
  canAccessAssignedRecord,
  canManageAssignedRecord,
  hasPermission,
} from './authorization.js';
import { AuthError } from './errors.js';
import {
  ACCOUNT_DENY_THRESHOLD,
  ACCOUNT_TURNSTILE_THRESHOLD,
  NETWORK_DENY_THRESHOLD,
  NETWORK_TURNSTILE_THRESHOLD,
  evaluateLoginThrottle,
} from './login-throttle.js';
import {
  SESSION_IDLE_TIMEOUT_MS,
  computeSessionExpiry,
  isSessionExpired,
  nextIdleExpiry,
} from './session-policy.js';
import type { Actor, SessionRecord, UserRecord } from './types.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const session: SessionRecord = {
  id: '0198a000-0000-7000-8000-000000000001',
  userId: '0198a000-0000-7000-8000-000000000002',
  tokenHash: 'a'.repeat(64),
  createdAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString(),
  absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
  mfaVerifiedAt: now.toISOString(),
  revokedAt: null,
  version: 1,
};
const user: UserRecord = {
  id: session.userId,
  email: 'consultant@example.test',
  emailNormalized: 'consultant@example.test',
  displayName: 'Consultant',
  passwordHash: 'hash',
  passwordHashVersion: 1,
  status: 'active',
  mfaEnrolledAt: now.toISOString(),
  lastLoginAt: null,
  deactivatedAt: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  version: 1,
};

function actorFor(role: RoleKey): Actor {
  return {
    userId: user.id,
    sessionId: session.id,
    session,
    user,
    roles: [role],
    permissions: permissionsForRoles([role]),
    mfaEnrolled: true,
    mfaVerified: true,
  };
}

describe('permission and MFA guards', () => {
  it('allows an explicitly granted permission and denies others', () => {
    const consultant = actorFor('consultant');
    expect(hasPermission(consultant, 'documents.manage')).toBe(true);
    expect(() => assertPermission(consultant, 'users.manage')).toThrow(AuthError);
  });

  it('blocks application routes until MFA is enrolled and verified', () => {
    const pending = { ...actorFor('administrator'), mfaEnrolled: false, mfaVerified: false };
    expect(() => assertMfaReady(pending)).toThrowError(/multi-factor authentication/i);
    const enrolled = { ...actorFor('administrator'), mfaVerified: false };
    expect(() => assertMfaReady(enrolled)).toThrowError(/Complete multi-factor/i);
    expect(() => assertMfaReady(actorFor('administrator'))).not.toThrow();
  });
});

describe('assigned-record authorization', () => {
  it('lets managers see every case and consultants only assigned cases', () => {
    const manager = actorFor('manager');
    const consultant = actorFor('consultant');
    expect(canAccessAssignedRecord(manager, { assignedUserIds: ['other'] })).toBe(true);
    expect(canAccessAssignedRecord(consultant, { assignedUserIds: [user.id] })).toBe(true);
    expect(canAccessAssignedRecord(consultant, { assignedUserIds: ['other'] })).toBe(false);
  });

  it('returns the same 403 for an unassigned record as for a missing permission', () => {
    const consultant = actorFor('consultant');
    expect(() => assertCanAccessAssignedRecord(consultant, { assignedUserIds: ['other'] })).toThrow(
      AuthError,
    );
    expect(() => assertCanManageAssignedRecord(consultant, { assignedUserIds: ['other'] })).toThrow(
      AuthError,
    );
    expect(() =>
      assertCanManageAssignedRecord(actorFor('manager'), { assignedUserIds: ['other'] }),
    ).not.toThrow();
  });

  it('lets consultants work only their assigned cases and denies non-case roles', () => {
    const assigned = { assignedUserIds: [user.id] };
    const unassigned = { assignedUserIds: ['other'] };
    const expectations: Record<RoleKey, { assigned: boolean; unassigned: boolean }> = {
      administrator: { assigned: true, unassigned: true },
      manager: { assigned: true, unassigned: true },
      consultant: { assigned: true, unassigned: false },
      billing: { assigned: false, unassigned: false },
      read_only: { assigned: false, unassigned: false },
    };
    for (const [role, expected] of Object.entries(expectations) as [
      RoleKey,
      { assigned: boolean; unassigned: boolean },
    ][]) {
      const actor = actorFor(role);
      expect(canManageAssignedRecord(actor, assigned), `${role} assigned`).toBe(expected.assigned);
      expect(canManageAssignedRecord(actor, unassigned), `${role} unassigned`).toBe(
        expected.unassigned,
      );
    }
  });

  it('permits a user to read their own record but not another user without permission', () => {
    const consultant = actorFor('consultant');
    expect(() => assertSelfOrPermission(consultant, user.id, 'users.read')).not.toThrow();
    expect(() => assertSelfOrPermission(consultant, 'other-user', 'users.read')).toThrow(AuthError);
  });
});

describe('login throttle policy', () => {
  it('allows normal attempts and escalates by account or network', () => {
    expect(evaluateLoginThrottle({ accountFailures: 0, networkFailures: 0 }).action).toBe('allow');
    expect(
      evaluateLoginThrottle({
        accountFailures: ACCOUNT_TURNSTILE_THRESHOLD,
        networkFailures: 0,
      }).action,
    ).toBe('require_turnstile');
    expect(
      evaluateLoginThrottle({ accountFailures: ACCOUNT_DENY_THRESHOLD, networkFailures: 0 }).action,
    ).toBe('deny');
    expect(
      evaluateLoginThrottle({
        accountFailures: 0,
        networkFailures: NETWORK_TURNSTILE_THRESHOLD,
      }).action,
    ).toBe('require_turnstile');
    expect(
      evaluateLoginThrottle({ accountFailures: 0, networkFailures: NETWORK_DENY_THRESHOLD }).action,
    ).toBe('deny');
  });
});

describe('session expiry policy', () => {
  it('applies a 30-minute idle and 12-hour absolute limit', () => {
    const expiry = computeSessionExpiry(now);
    expect(new Date(expiry.idleExpiresAt).getTime() - now.getTime()).toBe(30 * 60 * 1000);
    expect(new Date(expiry.absoluteExpiresAt).getTime() - now.getTime()).toBe(12 * 60 * 60 * 1000);
    expect(isSessionExpired(expiry, new Date(now.getTime() + 29 * 60 * 1000))).toBe(false);
    expect(isSessionExpired(expiry, new Date(now.getTime() + 31 * 60 * 1000))).toBe(true);
    expect(isSessionExpired(expiry, new Date(now.getTime() + 13 * 60 * 60 * 1000))).toBe(true);
  });

  it('never slides the idle deadline past the absolute limit', () => {
    const absolute = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    expect(nextIdleExpiry(now, absolute)).toBe(absolute);
  });
});
