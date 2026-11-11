import { newUuidV7, type RoleKey } from '@taxdesk/shared';
import { bytesToBase64Url } from '../crypto/encoding.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { createPasswordHasher } from '../crypto/password.js';
import { TOTP_DEFAULTS, createTotpService, type TotpService } from '../crypto/totp.js';
import { composeDependencies, type AppDependencies } from '../dependencies.js';
import type { Repositories, UnitOfWork } from '../repositories/ports.js';
import { createInMemoryRepositories, type InMemoryState } from '../repositories/in-memory.js';
import type { TurnstileVerifier } from '../domain/auth/turnstile.js';
import type { UserRecord } from '../domain/auth/types.js';

export const TEST_MFA_KEY = bytesToBase64Url(new Uint8Array(32).fill(7));
export const TEST_SITE_KEY = 'test-site-key';
export const TEST_CLIENT_DATA_KEY = bytesToBase64Url(new Uint8Array(32).fill(11));
export const TEST_CLIENT_INDEX_KEY = bytesToBase64Url(new Uint8Array(32).fill(13));

export interface TestHarness {
  readonly dependencies: AppDependencies;
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly state: InMemoryState;
  readonly totp: TotpService;
  readonly advance: (milliseconds: number) => void;
  readonly now: () => Date;
}

export interface TestHarnessOptions {
  readonly now?: Date;
  readonly turnstileValid?: boolean;
  readonly siteKey?: string;
  readonly allowedOrigins?: readonly string[];
  readonly appPublicUrl?: string;
  readonly passwordIterations?: number;
  /** `false` simulates a deployment without client identifier keys. */
  readonly clientKeys?: boolean;
}

export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const memory = createInMemoryRepositories();
  let current = new Date(options.now ?? '2026-01-01T00:00:00.000Z');
  const clock = (): Date => new Date(current);
  const totp = createTotpService(TOTP_DEFAULTS);
  const cipher = createSecretCipher(TEST_MFA_KEY);
  const turnstileValid = options.turnstileValid ?? false;
  const turnstile: TurnstileVerifier = {
    configured: true,
    verify: () => Promise.resolve(turnstileValid),
  };
  const siteKey = options.siteKey ?? TEST_SITE_KEY;
  const dependencies = composeDependencies({
    repositories: memory.repositories,
    unitOfWork: memory.unitOfWork,
    authConfig: {
      mfaEncryptionKey: TEST_MFA_KEY,
      turnstileSecretKey: 'test-turnstile-secret',
      turnstileSiteKey: siteKey,
      allowedOrigins: options.allowedOrigins ?? [],
      appPublicUrl: options.appPublicUrl ?? 'https://taxdesk.test',
      ...(options.clientKeys === false
        ? {}
        : {
            clientDataEncryptionKey: TEST_CLIENT_DATA_KEY,
            clientIdentifierIndexKey: TEST_CLIENT_INDEX_KEY,
          }),
    },
    clock,
    passwordHasher: createPasswordHasher({
      version: 1,
      iterations: options.passwordIterations ?? 1_000,
      saltBytes: 16,
      hashBytes: 32,
    }),
    cipher,
    totp,
    turnstile,
  });

  return {
    dependencies,
    repositories: memory.repositories,
    unitOfWork: memory.unitOfWork,
    state: memory.state,
    totp,
    advance: (milliseconds) => {
      current = new Date(current.getTime() + milliseconds);
    },
    now: clock,
  };
}

export interface SeedUserInput {
  readonly username: string;
  readonly password: string;
  readonly role?: RoleKey;
  readonly roles?: readonly RoleKey[];
  readonly status?: 'invited' | 'active' | 'deactivated';
  readonly mfaEnrolled?: boolean;
  readonly displayName?: string;
}

export interface SeededUser {
  readonly user: UserRecord;
  readonly mfaSecret: string | null;
}

/**
 * Seeds a user with a known password (and optionally confirmed MFA). Test-only:
 * the work factor is low and the data never leaves the in-memory store.
 */
export async function seedUser(harness: TestHarness, input: SeedUserInput): Promise<SeededUser> {
  const now = harness.now();
  const passwordHash = await harness.dependencies.passwordHasher.hash(input.password);
  const user = await harness.repositories.users.create({
    id: newUuidV7(now.getTime()),
    username: input.username.trim().toLowerCase(),
    displayName: input.displayName ?? 'Test User',
    passwordHash: input.status === 'invited' ? null : passwordHash,
    passwordHashVersion: input.status === 'invited' ? null : 1,
    status: input.status ?? 'active',
    createdAt: now.toISOString(),
  });
  const roles = input.roles ?? [input.role ?? 'administrator'];
  await harness.repositories.roles.replaceRoles({
    userId: user.id,
    roleKeys: roles,
    assignedAt: now.toISOString(),
    assignedBy: null,
  });

  let mfaSecret: string | null = null;
  if (input.mfaEnrolled === true) {
    const secret = harness.dependencies.totp.generateSecret();
    const cipher = harness.dependencies.cipher;
    if (cipher === null) {
      throw new Error('Test harness has no cipher.');
    }
    await harness.repositories.mfa.upsertUnconfirmed({
      userId: user.id,
      secretCiphertext: await cipher.encrypt(secret),
      keyVersion: cipher.keyVersion,
      at: now.toISOString(),
    });
    await harness.repositories.mfa.confirm(user.id, now.toISOString());
    await harness.repositories.users.setMfaEnrolledAt(user.id, now.toISOString());
    mfaSecret = secret;
  }

  const latest = await harness.repositories.users.findById(user.id);
  return { user: latest ?? user, mfaSecret };
}

export async function seedFirm(
  harness: TestHarness,
  input: { firmName?: string; timezone?: string } = {},
): Promise<void> {
  const now = harness.now();
  const firm = await harness.repositories.firm.create({
    id: newUuidV7(now.getTime()),
    firmName: input.firmName ?? 'Test Firm',
    timezone: input.timezone ?? 'Asia/Karachi',
    createdAt: now.toISOString(),
  });
  await harness.repositories.firm.completeBootstrap(firm.id, now.toISOString());
}

/** Issues a verified session and returns the Cookie header value. */
export async function sessionCookieFor(
  harness: TestHarness,
  user: UserRecord,
  options: { mfaVerified?: boolean } = {},
): Promise<{ cookie: string; token: string }> {
  const issued = await harness.dependencies.sessionService.issue(user, {
    mfaVerified: options.mfaVerified ?? true,
    requestId: 'test-session',
  });
  return { cookie: `__Host-taxdesk_session=${issued.token}`, token: issued.token };
}
