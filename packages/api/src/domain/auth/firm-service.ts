import {
  AUDIT_ACTIONS,
  FirmSettingsSchema,
  type FirmSettings,
  type FirmSettingsUpdate,
} from '@taxdesk/shared';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import type { Actor } from './types.js';

export interface FirmServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Choose a valid IANA timezone.', {
      errors: [{ field: 'timezone', message: 'Choose a valid IANA timezone.' }],
    });
  }
}

export class FirmService {
  constructor(private readonly dependencies: FirmServiceDependencies) {}

  async getSettings(): Promise<FirmSettings> {
    const firm = await this.dependencies.repositories.firm.get();
    if (firm === null) {
      throw new AuthError(
        503,
        'FIRM_NOT_BOOTSTRAPPED',
        'This deployment has not been bootstrapped yet.',
      );
    }
    return FirmSettingsSchema.parse({
      id: firm.id,
      firmName: firm.firmName,
      timezone: firm.timezone,
      createdAt: firm.createdAt,
      updatedAt: firm.updatedAt,
      version: firm.version,
    });
  }

  async updateSettings(input: {
    readonly actor: Actor;
    readonly update: FirmSettingsUpdate;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<FirmSettings> {
    assertTimezone(input.update.timezone);
    const now = this.dependencies.clock();
    const firm = await this.dependencies.repositories.firm.get();
    if (firm === null) {
      throw new AuthError(
        503,
        'FIRM_NOT_BOOTSTRAPPED',
        'This deployment has not been bootstrapped yet.',
      );
    }
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const next = await repositories.firm.updateSettings({
        id: firm.id,
        firmName: input.update.firmName,
        timezone: input.update.timezone,
        expectedVersion: input.expectedVersion,
        updatedAt: now.toISOString(),
      });
      if (next === null) {
        throw new AuthError(
          412,
          'PRECONDITION_FAILED',
          'Firm settings changed since you loaded them. Refresh and try again.',
        );
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.firmSettingsUpdated,
        entityType: 'firm_settings',
        entityId: firm.id,
        requestId: input.requestId,
        metadata: { timezone: input.update.timezone },
      });
      return next;
    });
    return FirmSettingsSchema.parse({
      id: updated.id,
      firmName: updated.firmName,
      timezone: updated.timezone,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      version: updated.version,
    });
  }
}
