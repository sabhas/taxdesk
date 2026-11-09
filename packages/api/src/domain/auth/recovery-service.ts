import { AUDIT_ACTIONS, PasswordPolicySchema, normalizeUsername } from '@taxdesk/shared';
import type { PasswordHasher } from '../../crypto/password.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';

export interface RecoveryDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly clock: () => Date;
}

/**
 * Offline, deployment-level recovery. It is reachable only from a CLI with the
 * database credential and is never exposed as an HTTP route. Every action
 * revokes existing sessions and writes an audit event with no acting user.
 */
export class RecoveryService {
  constructor(private readonly dependencies: RecoveryDependencies) {}

  async resetPassword(username: string, newPassword: string): Promise<void> {
    const policy = PasswordPolicySchema.safeParse(newPassword);
    if (!policy.success) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'The password does not meet the policy.', {
        errors: policy.error.issues.map((issue) => ({
          field: 'password',
          message: issue.message,
        })),
      });
    }
    const user = await this.requireUser(username);
    const now = this.dependencies.clock();
    const passwordHash = await this.dependencies.passwordHasher.hash(newPassword);
    const passwordHashVersion = this.dependencies.passwordHasher.currentParameters.version;
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.users.updatePassword({
        userId: user.id,
        passwordHash,
        passwordHashVersion,
        at: now.toISOString(),
      });
      await repositories.sessions.revokeAllForUser({ userId: user.id, at: now.toISOString() });
      await repositories.activationTokens.invalidateForUser({
        userId: user.id,
        purpose: 'password_reset',
        at: now.toISOString(),
      });
      await repositories.activationTokens.invalidateForUser({
        userId: user.id,
        purpose: 'activation',
        at: now.toISOString(),
      });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: null,
        action: AUDIT_ACTIONS.recoveryPasswordReset,
        entityType: 'user',
        entityId: user.id,
        requestId: 'cli-recovery',
      });
    });
  }

  async disableMfa(username: string): Promise<void> {
    const user = await this.requireUser(username);
    const now = this.dependencies.clock();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.mfa.deleteForUser(user.id);
      await repositories.users.setMfaEnrolledAt(user.id, null);
      await repositories.sessions.revokeAllForUser({ userId: user.id, at: now.toISOString() });
      await repositories.loginChallenges.invalidateForUser(user.id, now.toISOString());
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: null,
        action: AUDIT_ACTIONS.recoveryMfaDisabled,
        entityType: 'user',
        entityId: user.id,
        requestId: 'cli-recovery',
      });
    });
  }

  async reactivate(username: string): Promise<void> {
    const user = await this.requireUser(username);
    const now = this.dependencies.clock();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      if (user.status === 'deactivated') {
        const updated = await repositories.users.updateStatus({
          userId: user.id,
          status: 'active',
          expectedVersion: user.version,
          at: now.toISOString(),
        });
        if (updated === null) {
          throw new AuthError(409, 'CONFLICT', 'The user changed. Run the command again.');
        }
      }
      await repositories.sessions.revokeAllForUser({ userId: user.id, at: now.toISOString() });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: null,
        action: AUDIT_ACTIONS.recoveryReactivated,
        entityType: 'user',
        entityId: user.id,
        requestId: 'cli-recovery',
      });
    });
  }

  private async requireUser(username: string) {
    const user = await this.dependencies.repositories.users.findByUsername(
      normalizeUsername(username),
    );
    if (user === null) {
      throw new AuthError(404, 'USER_NOT_FOUND', 'No user with that username exists.');
    }
    return user;
  }
}
