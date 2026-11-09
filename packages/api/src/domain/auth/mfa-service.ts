/* eslint-disable @typescript-eslint/prefer-optional-chain -- explicit null checks keep domain narrowing readable */
import { AUDIT_ACTIONS, newUuidV7, type MfaEnrollment, type RecoveryCodes } from '@taxdesk/shared';
import type { PasswordHasher } from '../../crypto/password.js';
import type { TokenHasher } from '../../crypto/token.js';
import type { SecretCipher } from '../../crypto/cipher.js';
import type { TotpService } from '../../crypto/totp.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import { RECOVERY_CODE_COUNT } from './session-policy.js';
import { generateRecoveryCode, normalizeRecoveryCode } from './recovery-code.js';
import type { Actor, RecoveryCodeRecord } from './types.js';

export interface MfaServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly tokenHasher: TokenHasher;
  readonly totp: TotpService;
  readonly cipher: SecretCipher | null;
  readonly clock: () => Date;
}

/**
 * TOTP enrollment/confirmation, recovery codes, and MFA disablement. Secrets
 * are encrypted with a deployment key; recovery codes are stored as SHA-256
 * hashes and consumed exactly once.
 */
export class MfaService {
  constructor(private readonly dependencies: MfaServiceDependencies) {}

  async beginEnrollment(actor: Actor): Promise<MfaEnrollment> {
    if (actor.mfaEnrolled) {
      throw new AuthError(
        409,
        'MFA_ALREADY_ENROLLED',
        'Multi-factor authentication is already enabled.',
      );
    }
    const cipher = this.requireCipher();
    const now = this.dependencies.clock();
    const secret = this.dependencies.totp.generateSecret();
    const ciphertext = await cipher.encrypt(secret);
    await this.dependencies.repositories.mfa.upsertUnconfirmed({
      userId: actor.userId,
      secretCiphertext: ciphertext,
      keyVersion: cipher.keyVersion,
      at: now.toISOString(),
    });
    return {
      secret,
      otpauthUri: this.dependencies.totp.otpauthUri(secret, actor.user.email),
      issuer: this.dependencies.totp.options.issuer,
    };
  }

  async confirmEnrollment(actor: Actor, code: string, requestId: string): Promise<RecoveryCodes> {
    const cipher = this.requireCipher();
    const now = this.dependencies.clock();
    const credential = await this.dependencies.repositories.mfa.getCredential(actor.userId);
    if (credential === null || credential.confirmedAt !== null) {
      throw new AuthError(
        409,
        'MFA_ALREADY_ENROLLED',
        'Multi-factor authentication is already enabled.',
      );
    }
    const secret = await cipher.decrypt(credential.secretCiphertext);
    const valid = await this.dependencies.totp.verify(secret, code, now.getTime());
    if (!valid) {
      await appendAuditEvent(this.dependencies.repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.mfaChallengeFailed,
        entityType: 'user',
        entityId: actor.userId,
        requestId,
      });
      throw new AuthError(401, 'MFA_CODE_INVALID', 'That code is not valid. Try the next one.');
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    const records: RecoveryCodeRecord[] = await Promise.all(
      recoveryCodes.map(async (recoveryCode) => ({
        id: newUuidV7(now.getTime()),
        userId: actor.userId,
        codeHash: await this.dependencies.tokenHasher.hash(normalizeRecoveryCode(recoveryCode)),
        usedAt: null,
        createdAt: now.toISOString(),
      })),
    );

    await this.dependencies.unitOfWork.run(async (repositories) => {
      const confirmed = await repositories.mfa.confirm(actor.userId, now.toISOString());
      if (!confirmed) {
        throw new AuthError(
          409,
          'MFA_ALREADY_ENROLLED',
          'Multi-factor authentication is already enabled.',
        );
      }
      await repositories.users.setMfaEnrolledAt(actor.userId, now.toISOString());
      await repositories.sessions.markMfaVerified(actor.sessionId, now.toISOString());
      await repositories.sessions.revokeAllForUser({
        userId: actor.userId,
        at: now.toISOString(),
        exceptSessionId: actor.sessionId,
      });
      await repositories.mfa.replaceRecoveryCodes(actor.userId, records);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.userMfaEnabled,
        entityType: 'user',
        entityId: actor.userId,
        requestId,
        metadata: { recoveryCodes: records.length },
      });
    });

    return { recoveryCodes };
  }

  async disable(
    actor: Actor,
    input: { password: string; code: string },
    requestId: string,
  ): Promise<void> {
    await this.verifyPasswordAndCode(actor, input);
    const now = this.dependencies.clock();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.mfa.deleteForUser(actor.userId);
      await repositories.users.setMfaEnrolledAt(actor.userId, null);
      await repositories.sessions.revokeAllForUser({
        userId: actor.userId,
        at: now.toISOString(),
        exceptSessionId: actor.sessionId,
      });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.userMfaDisabled,
        entityType: 'user',
        entityId: actor.userId,
        requestId,
      });
    });
  }

  async regenerateRecoveryCodes(
    actor: Actor,
    input: { password: string; code: string },
    requestId: string,
  ): Promise<RecoveryCodes> {
    await this.verifyPasswordAndCode(actor, input);
    const now = this.dependencies.clock();
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    const records: RecoveryCodeRecord[] = await Promise.all(
      recoveryCodes.map(async (recoveryCode) => ({
        id: newUuidV7(now.getTime()),
        userId: actor.userId,
        codeHash: await this.dependencies.tokenHasher.hash(normalizeRecoveryCode(recoveryCode)),
        usedAt: null,
        createdAt: now.toISOString(),
      })),
    );
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await repositories.mfa.replaceRecoveryCodes(actor.userId, records);
      await repositories.sessions.revokeAllForUser({
        userId: actor.userId,
        at: now.toISOString(),
        exceptSessionId: actor.sessionId,
      });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.userRecoveryCodesRegenerated,
        entityType: 'user',
        entityId: actor.userId,
        requestId,
        metadata: { recoveryCodes: records.length },
      });
    });
    return { recoveryCodes };
  }

  private requireCipher(): SecretCipher {
    if (this.dependencies.cipher === null) {
      throw new AuthError(
        503,
        'MFA_UNAVAILABLE',
        'Multi-factor authentication is not configured for this environment.',
      );
    }
    return this.dependencies.cipher;
  }

  private async verifyPasswordAndCode(
    actor: Actor,
    input: { password: string; code: string },
  ): Promise<void> {
    const cipher = this.requireCipher();
    const now = this.dependencies.clock();
    const verification = await this.dependencies.passwordHasher.verify(
      input.password,
      actor.user.passwordHash,
    );
    if (!verification.valid) {
      throw new AuthError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
    }
    const credential = await this.dependencies.repositories.mfa.getCredential(actor.userId);
    if (credential === null || credential.confirmedAt === null) {
      throw new AuthError(409, 'CONFLICT', 'Multi-factor authentication is not enabled.');
    }
    const secret = await cipher.decrypt(credential.secretCiphertext);
    const valid = await this.dependencies.totp.verify(secret, input.code, now.getTime());
    if (!valid) {
      throw new AuthError(401, 'MFA_CODE_INVALID', 'That code is not valid. Try the next one.');
    }
  }
}
