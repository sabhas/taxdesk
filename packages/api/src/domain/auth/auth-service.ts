/* eslint-disable @typescript-eslint/prefer-optional-chain -- explicit null checks keep domain narrowing readable */
import {
  AUDIT_ACTIONS,
  PasswordPolicySchema,
  newUuidV7,
  type CurrentSession,
} from '@taxdesk/shared';
import type { PasswordHasher } from '../../crypto/password.js';
import type { TokenHasher } from '../../crypto/token.js';
import type { TotpService } from '../../crypto/totp.js';
import type { SecretCipher } from '../../crypto/cipher.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from './audit-service.js';
import { AuthError } from './errors.js';
import { throttleDenied, type LoginKeys, type LoginThrottle } from './login-throttle-service.js';
import { normalizeRecoveryCode } from './recovery-code.js';
import { LOGIN_CHALLENGE_TTL_MS } from './session-policy.js';
import type { SessionService } from './session-service.js';
import { normalizeEmail } from './session-view.js';
import type { Actor, UserRecord } from './types.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.js';

export interface AuthServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly tokenHasher: TokenHasher;
  readonly totp: TotpService;
  readonly cipher: SecretCipher | null;
  readonly throttle: LoginThrottle;
  readonly sessionService: SessionService;
  readonly clock: () => Date;
  readonly turnstile: TurnstileVerifier;
  readonly turnstileSiteKey?: string;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly turnstileToken?: string;
  readonly remoteIp?: string;
  readonly requestId: string;
}

export type LoginOutcome =
  | {
      readonly status: 'authenticated';
      readonly issued: Awaited<ReturnType<SessionService['issue']>>;
    }
  | {
      readonly status: 'mfa_enrollment_required';
      readonly issued: Awaited<ReturnType<SessionService['issue']>>;
    }
  | { readonly status: 'mfa_required'; readonly challengeToken: string; readonly expiresAt: string }
  | { readonly status: 'turnstile_required' };

export interface IssuedLogin {
  readonly token: string;
  readonly view: CurrentSession;
}

const GENERIC_CREDENTIAL_FAILURE = 'The email or password is incorrect.';

/**
 * Credential verification, MFA challenge, activation, and logout. Every
 * failure path returns a generic public message so account existence and
 * password validity cannot be probed.
 */
export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  async login(input: LoginInput): Promise<LoginOutcome> {
    const now = this.dependencies.clock();
    const normalizedEmail = normalizeEmail(input.email);
    const keys = await this.dependencies.throttle.keysFor(normalizedEmail, input.remoteIp);
    await this.dependencies.throttle.prune();

    const decision = await this.dependencies.throttle.evaluate(keys);
    if (decision.action === 'deny') {
      throw throttleDenied(decision);
    }

    if (decision.action === 'require_turnstile') {
      if (this.dependencies.turnstileSiteKey === undefined) {
        throw new AuthError(
          503,
          'SERVICE_UNAVAILABLE',
          'Sign-in verification is not configured for this environment.',
        );
      }
      if (input.turnstileToken === undefined || input.turnstileToken.length === 0) {
        // An attempt that fails to complete the required challenge still counts
        // toward the throttle, otherwise the deny threshold would be unreachable
        // once Turnstile becomes mandatory.
        await this.recordLoginFailure(keys, now, input.requestId, null, 'turnstile_not_completed');
        return { status: 'turnstile_required' };
      }
      const verified = await this.dependencies.turnstile.verify({
        token: input.turnstileToken,
        remoteIp: input.remoteIp,
      });
      if (!verified) {
        await this.recordLoginFailure(keys, now, input.requestId, null, 'turnstile_failed');
        throw new AuthError(403, 'TURNSTILE_FAILED', 'Complete the verification and try again.');
      }
    }

    const user = await this.dependencies.repositories.users.findByEmail(normalizedEmail);
    const verification = await this.dependencies.passwordHasher.verify(
      input.password,
      user?.passwordHash ?? null,
    );

    if (
      user === null ||
      user.passwordHash === null ||
      !verification.valid ||
      user.status !== 'active'
    ) {
      await this.recordLoginFailure(
        keys,
        now,
        input.requestId,
        user?.id ?? null,
        'invalid_credentials',
      );
      if (user !== null && user.status !== 'active') {
        await this.dependencies.repositories.sessions.revokeAllForUser({
          userId: user.id,
          at: now.toISOString(),
        });
      }
      throw new AuthError(401, 'INVALID_CREDENTIALS', GENERIC_CREDENTIAL_FAILURE);
    }

    await this.dependencies.throttle.record(keys, true);

    if (verification.needsRehash) {
      const rehashed = await this.dependencies.passwordHasher.hash(input.password);
      await this.dependencies.repositories.users.updatePassword({
        userId: user.id,
        passwordHash: rehashed,
        passwordHashVersion: this.dependencies.passwordHasher.currentParameters.version,
        at: now.toISOString(),
      });
    }

    const enrolled = await this.isMfaEnrolled(user);
    if (enrolled) {
      const challengeToken = this.dependencies.tokenHasher.generate(32);
      const challengeHash = await this.dependencies.tokenHasher.hash(challengeToken);
      const expiresAt = new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS).toISOString();
      await this.dependencies.repositories.loginChallenges.invalidateForUser(
        user.id,
        now.toISOString(),
      );
      await this.dependencies.repositories.loginChallenges.create({
        id: newUuidV7(now.getTime()),
        userId: user.id,
        tokenHash: challengeHash,
        expiresAt,
        consumedAt: null,
        createdAt: now.toISOString(),
      });
      return { status: 'mfa_required', challengeToken, expiresAt };
    }

    const issued = await this.dependencies.sessionService.issue(user, {
      mfaVerified: false,
      requestId: input.requestId,
    });
    await this.dependencies.repositories.users.touchLastLogin(user.id, now.toISOString());
    await appendAuditEvent(this.dependencies.repositories.audit, now, {
      actorUserId: user.id,
      action: AUDIT_ACTIONS.loginSucceeded,
      entityType: 'user',
      entityId: user.id,
      requestId: input.requestId,
      metadata: { mfa: 'not_enrolled' },
    });
    return { status: 'mfa_enrollment_required', issued };
  }

  /**
   * Verifies a TOTP challenge and creates a full session. The challenge token
   * is single-use; replaying it fails.
   */
  async completeMfaChallenge(input: {
    readonly challengeToken: string;
    readonly code: string;
    readonly remoteIp?: string;
    readonly requestId: string;
  }): Promise<IssuedLogin> {
    const now = this.dependencies.clock();
    const challengeHash = await this.dependencies.tokenHasher.hash(input.challengeToken);
    const challenge =
      await this.dependencies.repositories.loginChallenges.findByTokenHash(challengeHash);
    if (
      challenge === null ||
      challenge.consumedAt !== null ||
      now.getTime() >= new Date(challenge.expiresAt).getTime()
    ) {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }

    const user = await this.dependencies.repositories.users.findById(challenge.userId);
    if (user === null || user.status !== 'active') {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }

    const keys = await this.assertMfaNotThrottled(user, challenge.id, input.remoteIp, now);

    const credential = await this.dependencies.repositories.mfa.getCredential(user.id);
    if (credential === null || credential.confirmedAt === null) {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }
    if (this.dependencies.cipher === null) {
      throw new AuthError(
        503,
        'MFA_UNAVAILABLE',
        'Multi-factor authentication is not configured for this environment.',
      );
    }

    const secret = await this.dependencies.cipher.decrypt(credential.secretCiphertext);
    const valid = await this.dependencies.totp.verify(secret, input.code, now.getTime());
    if (!valid) {
      await this.recordMfaFailure(user.id, keys, input.requestId, now);
      throw new AuthError(401, 'MFA_CODE_INVALID', 'That code is not valid. Try the next one.');
    }

    return await this.issueAfterChallenge(challenge.id, user, now, input.requestId, 'totp');
  }

  /** Verifies a single-use recovery code instead of a TOTP challenge. */
  async completeMfaRecovery(input: {
    readonly challengeToken: string;
    readonly recoveryCode: string;
    readonly remoteIp?: string;
    readonly requestId: string;
  }): Promise<IssuedLogin> {
    const now = this.dependencies.clock();
    const challengeHash = await this.dependencies.tokenHasher.hash(input.challengeToken);
    const challenge =
      await this.dependencies.repositories.loginChallenges.findByTokenHash(challengeHash);
    if (
      challenge === null ||
      challenge.consumedAt !== null ||
      now.getTime() >= new Date(challenge.expiresAt).getTime()
    ) {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }

    const user = await this.dependencies.repositories.users.findById(challenge.userId);
    if (user === null || user.status !== 'active') {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }

    const keys = await this.assertMfaNotThrottled(user, challenge.id, input.remoteIp, now);

    const normalized = normalizeRecoveryCode(input.recoveryCode);
    if (normalized.length < 8) {
      await this.recordMfaFailure(user.id, keys, input.requestId, now);
      throw new AuthError(401, 'MFA_CODE_INVALID', 'That recovery code is not valid.');
    }
    const codeHash = await this.dependencies.tokenHasher.hash(normalized);

    const consumed = await this.dependencies.unitOfWork.run(async (repositories) => {
      const challengeConsumed = await repositories.loginChallenges.consume(
        challenge.id,
        now.toISOString(),
      );
      if (!challengeConsumed) {
        return false;
      }
      return await repositories.mfa.consumeRecoveryCode(user.id, codeHash, now.toISOString());
    });

    if (!consumed) {
      await this.recordMfaFailure(user.id, keys, input.requestId, now);
      throw new AuthError(401, 'MFA_CODE_INVALID', 'That recovery code is not valid.');
    }

    return await this.finishLogin(user, now, input.requestId, 'recovery');
  }

  async activate(input: {
    readonly token: string;
    readonly password: string;
    readonly requestId: string;
  }): Promise<{ readonly email: string }> {
    const now = this.dependencies.clock();
    const policy = PasswordPolicySchema.safeParse(input.password);
    if (!policy.success) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'The new password does not meet the policy.', {
        errors: policy.error.issues.map((issue) => ({
          field: 'password',
          message: issue.message,
        })),
      });
    }

    const tokenHash = await this.dependencies.tokenHasher.hash(input.token);
    const record = await this.dependencies.repositories.activationTokens.findByTokenHash(tokenHash);
    if (record === null || record.usedAt !== null) {
      throw new AuthError(401, 'ACTIVATION_TOKEN_INVALID', 'This link is no longer valid.');
    }
    if (now.getTime() >= new Date(record.expiresAt).getTime()) {
      throw new AuthError(
        401,
        'ACTIVATION_TOKEN_EXPIRED',
        'This link has expired. Ask an administrator for a new one.',
      );
    }

    const passwordHash = await this.dependencies.passwordHasher.hash(input.password);
    const passwordHashVersion = this.dependencies.passwordHasher.currentParameters.version;

    return await this.dependencies.unitOfWork.run(async (repositories) => {
      const consumed = await repositories.activationTokens.consume(record.id, now.toISOString());
      if (!consumed) {
        throw new AuthError(401, 'ACTIVATION_TOKEN_INVALID', 'This link is no longer valid.');
      }
      const user = await repositories.users.findById(record.userId);
      if (user === null || user.status === 'deactivated') {
        throw new AuthError(401, 'ACTIVATION_TOKEN_INVALID', 'This link is no longer valid.');
      }
      if (user.status === 'invited') {
        // One statement sets the password and flips the status so the
        // invited/password database constraint never sees an invalid row.
        const activated = await repositories.users.activateWithPassword({
          userId: user.id,
          passwordHash,
          passwordHashVersion,
          expectedVersion: user.version,
          at: now.toISOString(),
        });
        if (activated === null) {
          throw new AuthError(409, 'CONFLICT', 'The account changed while it was being activated.');
        }
      } else {
        await repositories.users.updatePassword({
          userId: user.id,
          passwordHash,
          passwordHashVersion,
          at: now.toISOString(),
        });
      }
      await repositories.activationTokens.invalidateForUser({
        userId: user.id,
        purpose: 'activation',
        at: now.toISOString(),
      });
      await repositories.activationTokens.invalidateForUser({
        userId: user.id,
        purpose: 'password_reset',
        at: now.toISOString(),
      });
      await repositories.sessions.revokeAllForUser({ userId: user.id, at: now.toISOString() });
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: null,
        action:
          record.purpose === 'activation'
            ? AUDIT_ACTIONS.userActivated
            : AUDIT_ACTIONS.userPasswordResetCompleted,
        entityType: 'user',
        entityId: user.id,
        requestId: input.requestId,
      });
      return { email: user.email };
    });
  }

  async logout(actor: Actor, requestId: string): Promise<void> {
    await this.dependencies.sessionService.revoke(actor, requestId);
  }

  currentSession(actor: Actor): CurrentSession {
    return this.dependencies.sessionService.currentSession(actor);
  }

  private async issueAfterChallenge(
    challengeId: string,
    user: UserRecord,
    now: Date,
    requestId: string,
    method: 'totp' | 'recovery',
  ): Promise<IssuedLogin> {
    const result = await this.dependencies.unitOfWork.run(async (repositories) => {
      const consumed = await repositories.loginChallenges.consume(challengeId, now.toISOString());
      if (!consumed) {
        return null;
      }
      await repositories.users.touchLastLogin(user.id, now.toISOString());
      return true;
    });
    if (result !== true) {
      throw new AuthError(401, 'MFA_CHALLENGE_INVALID', 'Start signing in again.');
    }
    return await this.finishLogin(user, now, requestId, method);
  }

  private async finishLogin(
    user: UserRecord,
    now: Date,
    requestId: string,
    method: 'totp' | 'recovery',
  ): Promise<IssuedLogin> {
    const issued = await this.dependencies.sessionService.issue(user, {
      mfaVerified: true,
      requestId,
    });
    await appendAuditEvent(this.dependencies.repositories.audit, now, {
      actorUserId: user.id,
      action: AUDIT_ACTIONS.loginSucceeded,
      entityType: 'user',
      entityId: user.id,
      requestId,
      metadata: { mfa: method },
    });
    return { token: issued.token, view: issued.view };
  }

  private async recordLoginFailure(
    keys: LoginKeys,
    now: Date,
    requestId: string,
    userId: string | null,
    reason: string,
  ): Promise<void> {
    await this.dependencies.throttle.record(keys, false);
    await appendAuditEvent(this.dependencies.repositories.audit, now, {
      actorUserId: userId,
      action: AUDIT_ACTIONS.loginFailed,
      entityType: 'user',
      entityId: userId,
      requestId,
      metadata: { reason },
    });
  }

  /**
   * Second-factor guesses share the account/network throttle with password
   * failures. Without this, a holder of the password could submit unlimited
   * TOTP guesses against one five-minute challenge. Once the throttle denies,
   * the challenge is burned so the attacker must start over (and stay denied).
   */
  private async assertMfaNotThrottled(
    user: UserRecord,
    challengeId: string,
    remoteIp: string | undefined,
    now: Date,
  ): Promise<LoginKeys> {
    const keys = await this.dependencies.throttle.keysFor(user.emailNormalized, remoteIp);
    const decision = await this.dependencies.throttle.evaluate(keys);
    if (decision.action === 'deny') {
      await this.dependencies.repositories.loginChallenges.consume(challengeId, now.toISOString());
      throw throttleDenied(decision);
    }
    return keys;
  }

  private async recordMfaFailure(
    userId: string,
    keys: LoginKeys,
    requestId: string,
    now: Date,
  ): Promise<void> {
    await this.dependencies.throttle.record(keys, false);
    await appendAuditEvent(this.dependencies.repositories.audit, now, {
      actorUserId: userId,
      action: AUDIT_ACTIONS.mfaChallengeFailed,
      entityType: 'user',
      entityId: userId,
      requestId,
    });
  }

  private async isMfaEnrolled(user: UserRecord): Promise<boolean> {
    if (user.mfaEnrolledAt === null) {
      return false;
    }
    const credential = await this.dependencies.repositories.mfa.getCredential(user.id);
    if (credential === null || credential.confirmedAt === null) {
      // Self-heal an inconsistent enrollment flag rather than locking the user
      // out of the enrollment route.
      await this.dependencies.repositories.users.setMfaEnrolledAt(user.id, null);
      return false;
    }
    return true;
  }
}

export { createTurnstileVerifier };
