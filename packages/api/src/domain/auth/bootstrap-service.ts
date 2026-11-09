import { AUDIT_ACTIONS, PasswordPolicySchema, newUuidV7, type UuidV7 } from '@taxdesk/shared';
import type { PasswordHasher } from '../../crypto/password.js';
import type { TokenHasher } from '../../crypto/token.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import { isUniqueViolation } from '../../repositories/postgres.js';
import { normalizeEmail } from './session-view.js';

export interface BootstrapInput {
  readonly firmName: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
  readonly timezone?: string;
}

export interface BootstrapResult {
  readonly firmId: UuidV7;
  readonly userId: UuidV7;
}

export interface BootstrapDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly tokenHasher: TokenHasher;
  readonly clock: () => Date;
}

/**
 * First-administrator bootstrap. There is no default credential: the operator
 * supplies the firm name, email, display name, and password interactively (or
 * through explicit CLI flags). The operation refuses to run when setup has
 * already completed or any administrator already exists.
 */
export class BootstrapService {
  constructor(private readonly dependencies: BootstrapDependencies) {}

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    const now = this.dependencies.clock();
    const policy = PasswordPolicySchema.safeParse(input.password);
    if (!policy.success) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'The password does not meet the policy.', {
        errors: policy.error.issues.map((issue) => ({
          field: 'password',
          message: issue.message,
        })),
      });
    }

    const existingFirm = await this.dependencies.repositories.firm.get();
    if (existingFirm !== null && existingFirm.bootstrapCompletedAt !== null) {
      throw new AuthError(
        409,
        'FIRM_ALREADY_BOOTSTRAPPED',
        'This deployment already has an initial administrator.',
      );
    }
    if (await this.hasAdministrator()) {
      throw new AuthError(
        409,
        'FIRM_ALREADY_BOOTSTRAPPED',
        'An administrator already exists. Use the standard invitation flow instead.',
      );
    }

    const normalizedEmail = normalizeEmail(input.email);
    if ((await this.dependencies.repositories.users.findByEmail(normalizedEmail)) !== null) {
      throw new AuthError(409, 'EMAIL_IN_USE', 'A user with that email already exists.');
    }

    const passwordHash = await this.dependencies.passwordHasher.hash(input.password);
    const passwordHashVersion = this.dependencies.passwordHasher.currentParameters.version;
    const firmId = existingFirm?.id ?? newUuidV7(now.getTime());
    const userId = newUuidV7(now.getTime());
    const timezone = input.timezone ?? existingFirm?.timezone ?? 'Asia/Karachi';

    try {
      await this.dependencies.unitOfWork.run(async (repositories) => {
        await repositories.roles.seedBuiltInRoles(now.toISOString());
        if (existingFirm === null) {
          await repositories.firm.create({
            id: firmId,
            firmName: input.firmName.trim(),
            timezone,
            createdAt: now.toISOString(),
          });
        }
        await repositories.users.create({
          id: userId,
          email: input.email.trim(),
          emailNormalized: normalizedEmail,
          displayName: input.displayName.trim(),
          passwordHash,
          passwordHashVersion,
          status: 'active',
          createdAt: now.toISOString(),
        });
        await repositories.roles.replaceRoles({
          userId,
          roleKeys: ['administrator'],
          assignedAt: now.toISOString(),
          assignedBy: null,
        });
        await repositories.firm.completeBootstrap(firmId, now.toISOString());
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: userId,
          action: AUDIT_ACTIONS.firmBootstrapped,
          entityType: 'firm_settings',
          entityId: firmId,
          requestId: 'cli-bootstrap',
          metadata: { timezone },
        });
      });
    } catch (error) {
      if (
        isUniqueViolation(error) ||
        (error instanceof Error && error.message.includes('exists'))
      ) {
        throw new AuthError(
          409,
          'FIRM_ALREADY_BOOTSTRAPPED',
          'Setup completed in another process. Use the standard invitation flow instead.',
        );
      }
      throw error;
    }

    return { firmId: firmId, userId: userId };
  }

  private async hasAdministrator(): Promise<boolean> {
    const users = await this.dependencies.repositories.users.list();
    for (const user of users) {
      const roles = await this.dependencies.repositories.roles.rolesForUser(user.id);
      if (roles.some((role) => role.key === 'administrator')) {
        return true;
      }
    }
    return false;
  }
}
