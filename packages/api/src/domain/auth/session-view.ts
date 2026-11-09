import type { CurrentSession, PublicUser, UserSummary } from '@taxdesk/shared';
import type { RoleRecord, SessionRecord, UserRecord } from './types.js';

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    mfaEnrolled: user.mfaEnrolledAt !== null,
    createdAt: user.createdAt,
  };
}

export function toUserSummary(user: UserRecord, roles: readonly RoleRecord[]): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    roles: roles.map((role) => role.key) as UserSummary['roles'],
    mfaEnrolled: user.mfaEnrolledAt !== null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: user.version,
  };
}

export function buildCurrentSession(input: {
  readonly user: UserRecord;
  readonly session: SessionRecord;
  readonly roles: readonly RoleRecord[];
  readonly permissions: readonly string[];
}): CurrentSession {
  return {
    user: toPublicUser(input.user),
    roles: input.roles.map((role) => role.key) as CurrentSession['roles'],
    permissions: [...input.permissions] as CurrentSession['permissions'],
    session: {
      idleExpiresAt: input.session.idleExpiresAt,
      absoluteExpiresAt: input.session.absoluteExpiresAt,
      mfaVerified: input.session.mfaVerifiedAt !== null,
    },
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
