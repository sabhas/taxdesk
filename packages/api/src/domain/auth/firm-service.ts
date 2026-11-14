import {
  AUDIT_ACTIONS,
  FIRM_SETTING_LIMITS,
  FirmSettingsSchema,
  type FirmSettings,
  type FirmSettingsUpdate,
} from '@taxdesk/shared';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import type { Actor, FirmRecord } from './types.js';

export interface FirmServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
}

function toSettings(firm: FirmRecord): FirmSettings {
  return FirmSettingsSchema.parse({
    id: firm.id,
    firmName: firm.firmName,
    timezone: firm.timezone,
    currency: firm.currency,
    invoicePrefix: firm.invoicePrefix,
    receiptPrefix: firm.receiptPrefix,
    documentMaxUploadBytes: firm.documentMaxUploadBytes,
    dueSoonDays: firm.dueSoonDays,
    createdAt: firm.createdAt,
    updatedAt: firm.updatedAt,
    version: firm.version,
  });
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

/**
 * The audit record of a settings change: which fields changed and their old
 * and new values. None of these values is confidential.
 */
function changedSettings(
  firm: FirmRecord,
  update: FirmSettingsUpdate,
  next: Pick<
    FirmRecord,
    'currency' | 'invoicePrefix' | 'receiptPrefix' | 'documentMaxUploadBytes' | 'dueSoonDays'
  >,
): Record<string, string | number> {
  const pairs: [string, string | number, string | number][] = [
    ['firmName', firm.firmName, update.firmName],
    ['timezone', firm.timezone, update.timezone],
    ['currency', firm.currency, next.currency],
    ['invoicePrefix', firm.invoicePrefix, next.invoicePrefix],
    ['receiptPrefix', firm.receiptPrefix, next.receiptPrefix],
    ['documentMaxUploadBytes', firm.documentMaxUploadBytes, next.documentMaxUploadBytes],
    ['dueSoonDays', firm.dueSoonDays, next.dueSoonDays],
  ];
  const changed = pairs.filter(([, before, after]) => before !== after);
  const metadata: Record<string, string | number> = {
    changedFields: changed.map(([name]) => name).join(','),
  };
  for (const [name, before, after] of changed) {
    metadata[`${name}From`] = typeof before === 'string' ? before.slice(0, 160) : before;
    metadata[`${name}To`] = typeof after === 'string' ? after.slice(0, 160) : after;
  }
  return metadata;
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
    return toSettings(firm);
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
    const next = {
      currency: input.update.currency ?? firm.currency,
      invoicePrefix: input.update.invoicePrefix ?? firm.invoicePrefix,
      receiptPrefix: input.update.receiptPrefix ?? firm.receiptPrefix,
      documentMaxUploadBytes: input.update.documentMaxUploadBytes ?? firm.documentMaxUploadBytes,
      dueSoonDays: input.update.dueSoonDays ?? firm.dueSoonDays,
    };
    if (!(FIRM_SETTING_LIMITS.supportedCurrencies as readonly string[]).includes(next.currency)) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'Choose a supported currency.', {
        errors: [{ field: 'currency', message: 'Choose a supported currency.' }],
      });
    }
    const changes = changedSettings(firm, input.update, next);
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const saved = await repositories.firm.updateSettings({
        id: firm.id,
        firmName: input.update.firmName,
        timezone: input.update.timezone,
        currency: next.currency,
        invoicePrefix: next.invoicePrefix,
        receiptPrefix: next.receiptPrefix,
        documentMaxUploadBytes: next.documentMaxUploadBytes,
        dueSoonDays: next.dueSoonDays,
        expectedVersion: input.expectedVersion,
        updatedAt: now.toISOString(),
      });
      if (saved === null) {
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
        metadata: { timezone: input.update.timezone, ...changes },
      });
      return saved;
    });
    return toSettings(updated);
  }
}
