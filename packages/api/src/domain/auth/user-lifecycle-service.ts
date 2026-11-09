import {
  AUDIT_ACTIONS,
  newUuidV7,
  normalizeUsername,
  type ActivationLink,
  type InviteUserRequest,
  type InviteUserResponse,
  type UserSummary,
  type UserUpdateRequest,
} from '@taxdesk/shared';
import type { TokenHasher } from '../../crypto/token.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import { ACTIVATION_TOKEN_TTL_MS } from './session-policy.js';
import { toUserSummary } from './session-view.js';
import type { Actor, UserRecord } from './types.js';

export interface UserLifecycleDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly tokenHasher: TokenHasher;
  readonly clock: () => Date;
}

export interface UpdateUserInput {
  readonly actor: Actor;
  readonly userId: string;
  readonly update: UserUpdateRequest;
  readonly expectedVersion: number;
  readonly requestId: string;
}

/**
 * Administrator-managed user lifecycle. Activation and reset links are returned
 * once to the administrator for manual delivery; no email is sent. Every
 * password, role, active-status, or MFA change revokes the affected sessions.
 */
export class UserLifecycleService {
  constructor(private readonly dependencies: UserLifecycleDependencies) {}

  async listUsers(): Promise<UserSummary[]> {
    const users = await this.dependencies.repositories.users.list();
    const summaries: UserSummary[] = [];
    for (const user of users) {
      const roles = await this.dependencies.repositories.roles.rolesForUser(user.id);
      summaries.push(toUserSummary(user, roles));
    }
    return summaries;
  }

  async getUser(userId: string): Promise<UserSummary> {
    const user = await this.dependencies.repositories.users.findById(userId);
    if (user === null) {
      throw new AuthError(404, 'USER_NOT_FOUND', 'The requested user was not found.');
    }
    const roles = await this.dependencies.repositories.roles.rolesForUser(user.id);
    return toUserSummary(user, roles);
  }

  async inviteUser(input: {
    readonly actor: Actor;
    readonly invitation: InviteUserRequest;
    readonly requestId: string;
    readonly baseUrl: string;
  }): Promise<InviteUserResponse> {
    const now = this.dependencies.clock();
    const username = normalizeUsername(input.invitation.username);
    const existing = await this.dependencies.repositories.users.findByUsername(username);
    if (existing !== null) {
      throw new AuthError(409, 'USERNAME_IN_USE', 'A user with that username already exists.');
    }

    const userId = newUuidV7(now.getTime());
    const token = this.dependencies.tokenHasher.generate(32);
    const tokenHash = await this.dependencies.tokenHasher.hash(token);
    const expiresAt = new Date(now.getTime() + ACTIVATION_TOKEN_TTL_MS).toISOString();

    const created = await this.dependencies.unitOfWork.run(async (repositories) => {
      const user = await repositories.users.create({
        id: userId,
        username,
        displayName: input.invitation.displayName,
        passwordHash: null,
        passwordHashVersion: null,
        status: 'invited',
        createdAt: now.toISOString(),
      });
      await repositories.roles.replaceRoles({
        userId: user.id,
        roleKeys: [input.invitation.role],
        assignedAt: now.toISOString(),
        assignedBy: input.actor.userId,
      });
      await repositories.activationTokens.create({
        id: newUuidV7(now.getTime()),
        userId: user.id,
        tokenHash,
        purpose: 'activation',
        expiresAt,
        usedAt: null,
        createdAt: now.toISOString(),
        createdBy: input.actor.userId,
      });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.userInvited,
        entityType: 'user',
        entityId: user.id,
        requestId: input.requestId,
        metadata: { role: input.invitation.role },
      });
      return user;
    });

    const roles = await this.dependencies.repositories.roles.rolesForUser(created.id);
    return {
      user: toUserSummary(created, roles),
      activationUrl: activationUrl(input.baseUrl, token),
      expiresAt,
    };
  }

  async issuePasswordResetLink(input: {
    readonly actor: Actor;
    readonly userId: string;
    readonly requestId: string;
    readonly baseUrl: string;
  }): Promise<ActivationLink> {
    const now = this.dependencies.clock();
    const user = await this.dependencies.repositories.users.findById(input.userId);
    if (user === null) {
      throw new AuthError(404, 'USER_NOT_FOUND', 'The requested user was not found.');
    }
    if (user.status === 'deactivated') {
      throw new AuthError(409, 'CONFLICT', 'Reactivate the user before issuing a reset link.');
    }
    const token = this.dependencies.tokenHasher.generate(32);
    const tokenHash = await this.dependencies.tokenHasher.hash(token);
    const expiresAt = new Date(now.getTime() + ACTIVATION_TOKEN_TTL_MS).toISOString();

    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.activationTokens.invalidateForUser({
        userId: user.id,
        purpose: 'password_reset',
        at: now.toISOString(),
      });
      await repositories.activationTokens.create({
        id: newUuidV7(now.getTime()),
        userId: user.id,
        tokenHash,
        purpose: 'password_reset',
        expiresAt,
        usedAt: null,
        createdAt: now.toISOString(),
        createdBy: input.actor.userId,
      });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.userPasswordResetLinkIssued,
        entityType: 'user',
        entityId: user.id,
        requestId: input.requestId,
      });
    });

    return { activationUrl: activationUrl(input.baseUrl, token), expiresAt };
  }

  async updateUser(input: UpdateUserInput): Promise<UserSummary> {
    const now = this.dependencies.clock();
    const user = await this.dependencies.repositories.users.findById(input.userId);
    if (user === null) {
      throw new AuthError(404, 'USER_NOT_FOUND', 'The requested user was not found.');
    }
    const currentRoles = await this.dependencies.repositories.roles.rolesForUser(user.id);
    const currentRoleKeys = currentRoles.map((role) => role.key);

    const deactivating = input.update.status === 'deactivated';
    const role = input.update.role;
    const removingAdministrator =
      role !== undefined && currentRoleKeys.includes('administrator') && role !== 'administrator';

    if (deactivating && input.userId === input.actor.userId) {
      throw new AuthError(403, 'FORBIDDEN', 'You cannot deactivate your own account.');
    }

    if (deactivating || removingAdministrator) {
      const activeAdministrators =
        await this.dependencies.repositories.users.countActiveAdministrators();
      if (currentRoleKeys.includes('administrator') && activeAdministrators <= 1) {
        throw new AuthError(
          409,
          'CONFLICT',
          'At least one active administrator must remain. Ask another administrator to help.',
        );
      }
    }

    const actions: string[] = [];
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      let latest: UserRecord = user;
      if (input.update.status !== undefined) {
        const next = await repositories.users.updateStatus({
          userId: user.id,
          status: input.update.status,
          expectedVersion: input.expectedVersion,
          at: now.toISOString(),
        });
        if (next === null) {
          throw new AuthError(
            412,
            'PRECONDITION_FAILED',
            'This user changed since you loaded it. Refresh and try again.',
          );
        }
        latest = next;
        actions.push(
          input.update.status === 'deactivated'
            ? AUDIT_ACTIONS.userDeactivated
            : AUDIT_ACTIONS.userReactivated,
        );
      }

      if (role !== undefined) {
        const changed = currentRoleKeys.length !== 1 || currentRoleKeys[0] !== role;
        if (changed) {
          if (input.update.status === undefined) {
            const bumped = await repositories.users.bumpVersion({
              userId: user.id,
              expectedVersion: input.expectedVersion,
              at: now.toISOString(),
            });
            if (bumped === null) {
              throw new AuthError(
                412,
                'PRECONDITION_FAILED',
                'This user changed since you loaded it. Refresh and try again.',
              );
            }
            latest = bumped;
          }
          await repositories.roles.replaceRoles({
            userId: user.id,
            roleKeys: [role],
            assignedAt: now.toISOString(),
            assignedBy: input.actor.userId,
          });
          actions.push(AUDIT_ACTIONS.userRolesChanged);
        }
      }

      if (actions.length > 0) {
        await repositories.sessions.revokeAllForUser({
          userId: user.id,
          at: now.toISOString(),
        });
      }

      for (const action of actions) {
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action,
          entityType: 'user',
          entityId: user.id,
          requestId: input.requestId,
          ...(action === AUDIT_ACTIONS.userRolesChanged && role !== undefined
            ? { metadata: { role } }
            : {}),
        });
      }

      return latest;
    });

    const roles = await this.dependencies.repositories.roles.rolesForUser(updated.id);
    return toUserSummary(updated, roles);
  }
}

function activationUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  return `${base}/activate?token=${encodeURIComponent(token)}`;
}
