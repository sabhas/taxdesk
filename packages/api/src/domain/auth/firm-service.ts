import {
  AUDIT_ACTIONS,
  FIRM_LOGO_LIMITS,
  FIRM_SETTING_LIMITS,
  FirmSettingsSchema,
  type FirmSettings,
  type FirmSettingsUpdate,
} from '@taxdesk/shared';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { inspectLogoImage, LogoImageError, type LogoProblem } from '../billing/pdf/logo.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import type { Actor, FirmLogoImage, FirmRecord } from './types.js';

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
    logo: firm.logo,
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

const LOGO_PROBLEM_MESSAGES: Readonly<Record<LogoProblem, string>> = {
  empty: 'Choose a logo image to upload.',
  too_large: `Use a logo of at most ${String(FIRM_LOGO_LIMITS.maxBytes / 1024)} KiB.`,
  unsupported_type: 'Use a PNG or JPEG image.',
  too_many_pixels: `Use a logo no larger than ${String(FIRM_LOGO_LIMITS.maxSidePixels)} pixels on either side.`,
  corrupt: 'This image could not be read. Save it again as PNG or JPEG and retry.',
};

export function logoValidationError(problem: LogoProblem): AuthError {
  const message = LOGO_PROBLEM_MESSAGES[problem];
  return new AuthError(400, 'VALIDATION_FAILED', message, {
    errors: [{ field: 'logo', message }],
  });
}

/**
 * A short form of the digest for the audit explorer, which masks long opaque
 * values. The full digest stays in the event for exact matching.
 */
function fingerprint(sha256: string): string {
  return sha256.slice(0, 12);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function notBootstrapped(): AuthError {
  return new AuthError(
    503,
    'FIRM_NOT_BOOTSTRAPPED',
    'This deployment has not been bootstrapped yet.',
  );
}

function staleSettings(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'Firm settings changed since you loaded them. Refresh and try again.',
  );
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

  /** The logo image for the settings preview; 404 when there is none. */
  async getLogo(): Promise<FirmLogoImage> {
    const logo = await this.dependencies.repositories.firm.getLogo();
    if (logo === null) {
      throw new AuthError(404, 'FIRM_LOGO_NOT_FOUND', 'No firm logo has been uploaded.');
    }
    return logo;
  }

  /**
   * Stores or replaces the logo (TD-512). The type is taken from the bytes,
   * and the audit event records a digest of the image, never the image.
   */
  async setLogo(input: {
    readonly actor: Actor;
    readonly bytes: Uint8Array;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<FirmSettings> {
    let info;
    try {
      info = await inspectLogoImage(input.bytes);
    } catch (error) {
      if (error instanceof LogoImageError) {
        throw logoValidationError(error.problem);
      }
      throw error;
    }
    const firm = await this.dependencies.repositories.firm.get();
    if (firm === null) {
      throw notBootstrapped();
    }
    const sha256 = await sha256Hex(input.bytes);
    const now = this.dependencies.clock();
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const saved = await repositories.firm.setLogo({
        id: firm.id,
        contentType: info.contentType,
        bytes: input.bytes,
        sha256,
        updatedByUserId: input.actor.userId,
        expectedVersion: input.expectedVersion,
        updatedAt: now.toISOString(),
      });
      if (saved === null) {
        throw staleSettings();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.firmLogoUpdated,
        entityType: 'firm_settings',
        entityId: firm.id,
        requestId: input.requestId,
        metadata: {
          contentType: info.contentType,
          byteSize: input.bytes.length,
          widthPixels: info.width,
          heightPixels: info.height,
          imageSha256: sha256,
          imageFingerprint: fingerprint(sha256),
          replaced: firm.logo !== null,
          ...(firm.logo === null
            ? {}
            : {
                previousImageSha256: firm.logo.sha256,
                previousImageFingerprint: fingerprint(firm.logo.sha256),
              }),
        },
      });
      return saved;
    });
    return toSettings(updated);
  }

  async removeLogo(input: {
    readonly actor: Actor;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<FirmSettings> {
    const firm = await this.dependencies.repositories.firm.get();
    if (firm === null) {
      throw notBootstrapped();
    }
    const previous = firm.logo;
    if (previous === null) {
      throw new AuthError(404, 'FIRM_LOGO_NOT_FOUND', 'No firm logo has been uploaded.');
    }
    const now = this.dependencies.clock();
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const saved = await repositories.firm.removeLogo({
        id: firm.id,
        expectedVersion: input.expectedVersion,
        updatedAt: now.toISOString(),
      });
      if (saved === null) {
        throw staleSettings();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.firmLogoRemoved,
        entityType: 'firm_settings',
        entityId: firm.id,
        requestId: input.requestId,
        metadata: {
          contentType: previous.contentType,
          byteSize: previous.byteSize,
          previousImageSha256: previous.sha256,
          previousImageFingerprint: fingerprint(previous.sha256),
        },
      });
      return saved;
    });
    return toSettings(updated);
  }
}
