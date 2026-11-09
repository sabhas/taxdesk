import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import {
  DirectoryMigrationSource,
  runMigrations,
  createPostgresExecutor,
} from '@taxdesk/database/migrations';
import { bytesToBase64Url } from '../crypto/encoding.js';
import { createPasswordHasher } from '../crypto/password.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { buildDependencies, type AppDependencies } from '../dependencies.js';
import { BootstrapService } from '../domain/auth/bootstrap-service.js';

const connectionString =
  process.env['TAXDESK_API_TEST_DATABASE_URL'] ??
  process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//u, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run against "${name}": the database name must end with "_test".`);
  }
}

const describeWithDatabase = connectionString === undefined ? describe.skip : describe;
const migrationsDirectory = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);
const PASSWORD = 'correct horse battery staple';

describeWithDatabase('identity repositories against PostgreSQL', () => {
  let executor: SqlExecutor;
  let dependencies: AppDependencies;
  let clockNow: Date;

  beforeAll(async () => {
    assertDisposable(connectionString!);
    const migrations = createPostgresExecutor(connectionString!);
    await migrations.execute('DROP SCHEMA IF EXISTS public CASCADE');
    await migrations.execute('CREATE SCHEMA public');
    await runMigrations({
      executor: migrations,
      source: new DirectoryMigrationSource(migrationsDirectory),
    });
    const committed = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'));
    expect(committed.length).toBeGreaterThan(0);
    await migrations.close();

    clockNow = new Date('2026-01-01T00:00:00.000Z');
    executor = createSqlExecutor(connectionString!, {
      requireTls: !/[?&]sslmode=disable/u.test(connectionString!),
    });
    dependencies = buildDependencies({
      executor,
      authConfig: {
        mfaEncryptionKey: bytesToBase64Url(new Uint8Array(32).fill(5)),
        turnstileSecretKey: undefined,
        turnstileSiteKey: undefined,
        allowedOrigins: [],
        appPublicUrl: 'https://taxdesk.test',
      },
      clock: () => new Date(clockNow),
      passwordHasher: createPasswordHasher({
        version: 1,
        iterations: 1_000,
        saltBytes: 16,
        hashBytes: 32,
      }),
      cipher: createSecretCipher(bytesToBase64Url(new Uint8Array(32).fill(5))),
    });
  });

  afterAll(async () => {
    await executor.close();
  });

  it('bootstraps, stores hashed credentials, and validates a session', async () => {
    const bootstrap = new BootstrapService({
      repositories: dependencies.repositories,
      unitOfWork: dependencies.unitOfWork,
      passwordHasher: dependencies.passwordHasher,
      tokenHasher: dependencies.tokenHasher,
      clock: dependencies.clock,
    });
    const result = await bootstrap.bootstrap({
      firmName: 'Database Firm',
      username: 'owner',
      displayName: 'Owner',
      password: PASSWORD,
    });

    const firm = await dependencies.repositories.firm.get();
    expect(firm?.id).toBe(result.firmId);
    expect(firm?.bootstrapCompletedAt).not.toBeNull();

    const user = await dependencies.repositories.users.findById(result.userId);
    expect(user?.passwordHash).toMatch(/^pbkdf2-sha256\$1\$/);

    const login = await dependencies.authService.login({
      username: 'owner',
      password: PASSWORD,
      requestId: 'db-login',
    });
    expect(login.status).toBe('mfa_enrollment_required');
    if (login.status !== 'mfa_enrollment_required') {
      throw new Error('Expected enrollment-required login.');
    }
    const actor = await dependencies.sessionService.validate(login.issued.token);
    expect(actor?.permissions).toContain('users.manage');
    expect(actor?.roles).toEqual(['administrator']);
  });

  it('enrolls MFA, consumes a recovery code once, and records audit events', async () => {
    const user = await dependencies.repositories.users.findByUsername('owner');
    if (user === null) {
      throw new Error('Bootstrap user missing.');
    }
    const session = await dependencies.sessionService.issue(user, {
      mfaVerified: false,
      requestId: 'db-mfa-session',
    });
    const actor = (await dependencies.sessionService.validate(session.token))!;

    const enrollment = await dependencies.mfaService.beginEnrollment(actor);
    const code = await dependencies.totp.generate(enrollment.secret, clockNow.getTime());
    const recovery = await dependencies.mfaService.confirmEnrollment(
      actor,
      code,
      'integration-mfa',
    );
    expect(recovery.recoveryCodes).toHaveLength(10);

    const refreshed = (await dependencies.sessionService.validate(session.token))!;
    expect(refreshed.mfaVerified).toBe(true);

    const challenge = await dependencies.authService.login({
      username: 'owner',
      password: PASSWORD,
      requestId: 'db-mfa-login',
    });
    expect(challenge.status).toBe('mfa_required');
    if (challenge.status !== 'mfa_required') {
      throw new Error('Expected an MFA challenge.');
    }
    const firstUse = await dependencies.authService.completeMfaRecovery({
      challengeToken: challenge.challengeToken,
      recoveryCode: recovery.recoveryCodes[0] ?? '',
      requestId: 'db-recovery-1',
    });
    expect(firstUse.token.length).toBeGreaterThan(20);

    const replay = await dependencies.authService.login({
      username: 'owner',
      password: PASSWORD,
      requestId: 'db-mfa-login-2',
    });
    if (replay.status !== 'mfa_required') {
      throw new Error('Expected an MFA challenge.');
    }
    await expect(
      dependencies.authService.completeMfaRecovery({
        challengeToken: replay.challengeToken,
        recoveryCode: recovery.recoveryCodes[0] ?? '',
        requestId: 'db-recovery-2',
      }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });

    const audit = await dependencies.repositories.audit.list({ limit: 50, cursor: null });
    expect(audit.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['firm.bootstrapped', 'user.mfa_enabled', 'auth.login_succeeded']),
    );
  });

  it('invites, activates, updates with ETags, and revokes sessions on deactivation', async () => {
    const adminUser = await dependencies.repositories.users.findByUsername('owner');
    if (adminUser === null) {
      throw new Error('Admin missing.');
    }
    const adminSession = await dependencies.sessionService.issue(adminUser, {
      mfaVerified: true,
      requestId: 'db-admin-session',
    });
    const admin = (await dependencies.sessionService.validate(adminSession.token))!;

    const invitation = await dependencies.userService.inviteUser({
      actor: admin,
      invitation: {
        username: 'member',
        displayName: 'Member',
        role: 'manager',
      },
      requestId: 'db-invite',
      baseUrl: 'https://taxdesk.test',
    });
    const token = new URL(invitation.activationUrl).searchParams.get('token') ?? '';
    await dependencies.authService.activate({
      token,
      password: 'another correct horse battery',
      requestId: 'db-activate',
    });

    const member = await dependencies.repositories.users.findByUsername('member');
    expect(member?.status).toBe('active');
    const memberSession = await dependencies.sessionService.issue(member!, {
      mfaVerified: true,
      requestId: 'db-member-session',
    });
    const memberActor = (await dependencies.sessionService.validate(memberSession.token))!;

    const updated = await dependencies.userService.updateUser({
      actor: admin,
      userId: member!.id,
      update: { status: 'deactivated' },
      expectedVersion: member!.version,
      requestId: 'db-deactivate',
    });
    expect(updated.status).toBe('deactivated');
    expect(await dependencies.sessionService.validate(memberSession.token)).toBeNull();
    expect(memberActor.userId).toBe(member!.id);
  });
});
