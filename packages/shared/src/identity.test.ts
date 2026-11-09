import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ROLES,
  PERMISSION_KEYS,
  ROLE_DEFINITIONS,
  ROLE_KEYS,
  permissionsForRoles,
  roleHasPermission,
} from './identity.js';
import { LoginRequestSchema, CurrentSessionSchema, UserUpdateRequestSchema } from './auth.js';
import { newUuidV7, UuidV7Schema } from './id.js';
import { AuditEventSchema } from './audit.js';

describe('identity catalog', () => {
  it('defines exactly the five built-in roles', () => {
    expect(ROLE_KEYS).toEqual(['administrator', 'manager', 'consultant', 'billing', 'read_only']);
    expect(BUILT_IN_ROLES.map((role) => role.key)).toEqual([...ROLE_KEYS]);
  });

  it('gives the administrator every permission', () => {
    expect([...ROLE_DEFINITIONS.administrator.permissions].sort()).toEqual(
      [...PERMISSION_KEYS].sort(),
    );
  });

  it('keeps mutation permissions away from read-only and consultant roles', () => {
    expect(roleHasPermission('read_only', 'clients.manage')).toBe(false);
    expect(roleHasPermission('read_only', 'users.manage')).toBe(false);
    expect(roleHasPermission('consultant', 'cases.manage')).toBe(false);
    expect(roleHasPermission('consultant', 'cases.read_assigned')).toBe(true);
    expect(roleHasPermission('billing', 'billing.manage')).toBe(true);
    expect(roleHasPermission('manager', 'audit.read')).toBe(false);
    expect(roleHasPermission('manager', 'users.manage')).toBe(false);
  });

  it('unions permissions across roles without duplicates', () => {
    const permissions = permissionsForRoles(['consultant', 'billing', 'consultant']);
    expect(permissions).toEqual([...new Set(permissions)]);
    expect(permissions).toContain('documents.manage');
    expect(permissions).toContain('billing.manage');
    expect(permissions).not.toContain('users.manage');
  });
});

describe('identity contracts', () => {
  it('rejects a request-supplied role or permission in the login contract', () => {
    expect(
      LoginRequestSchema.safeParse({
        email: 'person@example.test',
        password: 'correct horse battery',
        roles: ['administrator'],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown permissions in a current-session payload', () => {
    const parsed = CurrentSessionSchema.safeParse({
      user: {
        id: newUuidV7(),
        email: 'person@example.test',
        displayName: 'Test Person',
        status: 'active',
        mfaEnrolled: true,
        createdAt: new Date().toISOString(),
      },
      roles: ['administrator'],
      permissions: ['records.export'],
      session: {
        idleExpiresAt: new Date().toISOString(),
        absoluteExpiresAt: new Date().toISOString(),
        mfaVerified: true,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a status or role change on an update request', () => {
    expect(UserUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(UserUpdateRequestSchema.safeParse({ role: 'manager' }).success).toBe(true);
    expect(UserUpdateRequestSchema.safeParse({ status: 'invited' }).success).toBe(false);
  });
});

describe('UUIDv7', () => {
  it('produces a valid, time-ordered identifier', () => {
    const early = newUuidV7(1_700_000_000_000);
    const late = newUuidV7(1_700_000_000_001);
    expect(UuidV7Schema.safeParse(early).success).toBe(true);
    expect(UuidV7Schema.safeParse(late).success).toBe(true);
    expect(early < late).toBe(true);
  });

  it('preserves the 48-bit millisecond timestamp', () => {
    const id = newUuidV7(0x0123456789ab);
    expect(id.slice(0, 8)).toBe('01234567');
    expect(id.slice(9, 13)).toBe('89ab');
  });
});

describe('audit contract', () => {
  it('accepts only scalar metadata values', () => {
    const base = {
      id: newUuidV7(),
      occurredAt: new Date().toISOString(),
      actorUserId: null,
      action: 'user.invited',
      entityType: 'user',
      entityId: newUuidV7(),
      requestId: 'request-1',
    };
    expect(AuditEventSchema.safeParse({ ...base, metadata: { role: 'manager' } }).success).toBe(
      true,
    );
    expect(
      AuditEventSchema.safeParse({ ...base, metadata: { nested: { secret: 'value' } } }).success,
    ).toBe(false);
  });
});
