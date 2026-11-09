/* eslint-disable @typescript-eslint/prefer-optional-chain -- explicit null checks keep domain narrowing readable */
import {
  AUDIT_ACTIONS,
  newUuidV7,
  type CurrentSession,
  type PermissionKey,
  type RoleKey,
} from '@taxdesk/shared';
import type { TokenHasher } from '../../crypto/token.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import type { Actor, SessionRecord, UserRecord } from './types.js';
import {
  SESSION_TOUCH_INTERVAL_MS,
  computeSessionExpiry,
  isSessionExpired,
  nextIdleExpiry,
} from './session-policy.js';
import { buildCurrentSession, toPublicUser } from './session-view.js';

export interface SessionServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly tokenHasher: TokenHasher;
  readonly clock: () => Date;
}

export interface IssuedSession {
  readonly token: string;
  readonly session: SessionRecord;
  readonly view: CurrentSession;
}

/**
 * Owns session issuance, sliding idle expiry, and authenticated-principal
 * reconstruction. The raw token is returned only to the transport layer for a
 * cookie; the database stores a SHA-256 digest.
 */
export class SessionService {
  constructor(private readonly dependencies: SessionServiceDependencies) {}

  async issue(
    user: UserRecord,
    options: { readonly mfaVerified: boolean; readonly requestId: string },
  ): Promise<IssuedSession> {
    const now = this.dependencies.clock();
    const token = this.dependencies.tokenHasher.generate(32);
    const tokenHash = await this.dependencies.tokenHasher.hash(token);
    const expiry = computeSessionExpiry(now);
    const session: SessionRecord = {
      id: newUuidV7(now.getTime()),
      userId: user.id,
      tokenHash,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      idleExpiresAt: expiry.idleExpiresAt,
      absoluteExpiresAt: expiry.absoluteExpiresAt,
      mfaVerifiedAt: options.mfaVerified ? now.toISOString() : null,
      revokedAt: null,
      version: 1,
    };

    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.sessions.create(session);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: user.id,
        action: AUDIT_ACTIONS.sessionCreated,
        entityType: 'session',
        entityId: session.id,
        requestId: options.requestId,
        metadata: { mfaVerified: options.mfaVerified },
      });
    });

    const roles = await this.dependencies.repositories.roles.rolesForUser(user.id);
    const permissions = await this.dependencies.repositories.roles.permissionsForUser(user.id);
    return {
      token,
      session,
      view: buildCurrentSession({
        user,
        session,
        roles,
        permissions,
      }),
    };
  }

  /**
   * Reconstructs the actor from an opaque cookie token. Returns `null` for any
   * absent, revoked, idle-expired, absolute-expired, deactivated, or
   * MFA-incomplete session; the caller maps that to a 401.
   */
  async validate(token: string): Promise<Actor | null> {
    const tokenHash = await this.dependencies.tokenHasher.hash(token);
    const session = await this.dependencies.repositories.sessions.findByTokenHash(tokenHash);
    if (session === null) {
      return null;
    }

    const now = this.dependencies.clock();
    if (session.revokedAt !== null || isSessionExpired(session, now)) {
      if (session.revokedAt === null) {
        await this.dependencies.repositories.sessions.revoke(session.id, now.toISOString());
      }
      return null;
    }

    const user = await this.dependencies.repositories.users.findById(session.userId);
    if (user === null || user.status !== 'active') {
      await this.dependencies.repositories.sessions.revokeAllForUser({
        userId: session.userId,
        at: now.toISOString(),
      });
      return null;
    }

    // A session created before MFA enrollment must never retain application
    // access after enrollment is confirmed; those sessions are revoked when MFA
    // changes. Fail closed if one is nevertheless observed.
    if (user.mfaEnrolledAt !== null && session.mfaVerifiedAt === null) {
      await this.dependencies.repositories.sessions.revoke(session.id, now.toISOString());
      return null;
    }

    let current = session;
    const lastSeen = new Date(session.lastSeenAt).getTime();
    if (now.getTime() - lastSeen >= SESSION_TOUCH_INTERVAL_MS) {
      const idleExpiresAt = nextIdleExpiry(now, session.absoluteExpiresAt);
      await this.dependencies.repositories.sessions.touch(
        session.id,
        now.toISOString(),
        idleExpiresAt,
      );
      current = { ...session, lastSeenAt: now.toISOString(), idleExpiresAt };
    }

    const roles = await this.dependencies.repositories.roles.rolesForUser(user.id);
    const permissions = await this.dependencies.repositories.roles.permissionsForUser(user.id);

    return {
      userId: user.id,
      sessionId: current.id,
      session: current,
      user,
      roles: roles.map((role) => role.key),
      permissions,
      mfaEnrolled: user.mfaEnrolledAt !== null,
      mfaVerified: current.mfaVerifiedAt !== null,
    };
  }

  async revoke(actor: Actor, requestId: string): Promise<void> {
    const now = this.dependencies.clock();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.sessions.revoke(actor.sessionId, now.toISOString());
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.sessionRevoked,
        entityType: 'session',
        entityId: actor.sessionId,
        requestId,
      });
    });
  }

  async revokeAllForUser(input: {
    readonly userId: string;
    readonly actorUserId: string | null;
    readonly requestId: string;
    readonly exceptSessionId?: string;
  }): Promise<number> {
    const now = this.dependencies.clock();
    return await this.dependencies.unitOfWork.run(async (repositories) => {
      const count = await repositories.sessions.revokeAllForUser({
        userId: input.userId,
        at: now.toISOString(),
        ...(input.exceptSessionId === undefined ? {} : { exceptSessionId: input.exceptSessionId }),
      });
      if (count > 0) {
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actorUserId,
          action: AUDIT_ACTIONS.sessionsRevoked,
          entityType: 'user',
          entityId: input.userId,
          requestId: input.requestId,
          metadata: { revokedSessions: count },
        });
      }
      return count;
    });
  }

  currentSession(actor: Actor): CurrentSession {
    return {
      user: toPublicUser(actor.user),
      roles: actor.roles as RoleKey[],
      permissions: actor.permissions as PermissionKey[],
      session: {
        idleExpiresAt: actor.session.idleExpiresAt,
        absoluteExpiresAt: actor.session.absoluteExpiresAt,
        mfaVerified: actor.session.mfaVerifiedAt !== null,
      },
    };
  }
}
