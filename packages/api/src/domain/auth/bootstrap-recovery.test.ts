import { describe, expect, it } from 'vitest';
import { BootstrapService } from './bootstrap-service.js';
import { RecoveryService } from './recovery-service.js';
import { AuthError } from './errors.js';
import { createTestHarness, seedUser, type TestHarness } from '../../testing/harness.js';

const PASSWORD = 'correct horse battery staple';

function bootstrapFor(harness: TestHarness): BootstrapService {
  return new BootstrapService({
    repositories: harness.repositories,
    unitOfWork: harness.unitOfWork,
    passwordHasher: harness.dependencies.passwordHasher,
    tokenHasher: harness.dependencies.tokenHasher,
    clock: harness.now,
  });
}

function recoveryFor(harness: TestHarness): RecoveryService {
  return new RecoveryService({
    repositories: harness.repositories,
    unitOfWork: harness.unitOfWork,
    passwordHasher: harness.dependencies.passwordHasher,
    clock: harness.now,
  });
}

describe('first administrator bootstrap', () => {
  it('creates the firm and the first administrator with a hash and audit event', async () => {
    const harness = createTestHarness();
    const result = await bootstrapFor(harness).bootstrap({
      firmName: 'Firm One',
      email: 'Owner@Example.test',
      displayName: 'Firm Owner',
      password: PASSWORD,
    });

    const firm = await harness.repositories.firm.get();
    expect(firm?.firmName).toBe('Firm One');
    expect(firm?.bootstrapCompletedAt).not.toBeNull();

    const user = await harness.repositories.users.findById(result.userId);
    expect(user?.status).toBe('active');
    expect(user?.emailNormalized).toBe('owner@example.test');
    expect(user?.passwordHash).toMatch(/^pbkdf2-sha256\$1\$/);
    expect(user?.passwordHash).not.toContain(PASSWORD);

    const roles = await harness.repositories.roles.rolesForUser(result.userId);
    expect(roles.map((role) => role.key)).toEqual(['administrator']);
    expect(harness.state.auditEvents.map((event) => event.action)).toContain('firm.bootstrapped');
  });

  it('refuses a second bootstrap and an existing administrator', async () => {
    const harness = createTestHarness();
    const service = bootstrapFor(harness);
    await service.bootstrap({
      firmName: 'Firm One',
      email: 'owner@example.test',
      displayName: 'Firm Owner',
      password: PASSWORD,
    });
    await expect(
      service.bootstrap({
        firmName: 'Firm Two',
        email: 'other@example.test',
        displayName: 'Other',
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'FIRM_ALREADY_BOOTSTRAPPED' });

    const second = createTestHarness();
    await seedUser(second, { email: 'admin@example.test', password: PASSWORD });
    await expect(
      bootstrapFor(second).bootstrap({
        firmName: 'Firm One',
        email: 'owner@example.test',
        displayName: 'Firm Owner',
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a password below the policy', async () => {
    const harness = createTestHarness();
    await expect(
      bootstrapFor(harness).bootstrap({
        firmName: 'Firm One',
        email: 'owner@example.test',
        displayName: 'Firm Owner',
        password: 'short',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('offline recovery', () => {
  it('resets a password, revokes sessions, and writes an audit event', async () => {
    const harness = createTestHarness();
    const { user } = await seedUser(harness, {
      email: 'person@example.test',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const session = await harness.dependencies.sessionService.issue(user, {
      mfaVerified: true,
      requestId: 'test',
    });

    await recoveryFor(harness).resetPassword('person@example.test', 'new correct horse battery');

    const updated = await harness.repositories.users.findById(user.id);
    expect(
      (await harness.dependencies.passwordHasher.verify(PASSWORD, updated?.passwordHash ?? null))
        .valid,
    ).toBe(false);
    expect(
      (
        await harness.dependencies.passwordHasher.verify(
          'new correct horse battery',
          updated?.passwordHash ?? null,
        )
      ).valid,
    ).toBe(true);
    expect(await harness.dependencies.sessionService.validate(session.token)).toBeNull();
    expect(harness.state.auditEvents.map((event) => event.action)).toContain(
      'user.recovery_password_reset',
    );
  });

  it('disables MFA and reactivates a deactivated user', async () => {
    const harness = createTestHarness();
    const { user } = await seedUser(harness, {
      email: 'person@example.test',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const service = recoveryFor(harness);

    await service.disableMfa('person@example.test');
    expect(await harness.repositories.mfa.getCredential(user.id)).toBeNull();
    const afterDisable = await harness.repositories.users.findById(user.id);
    expect(afterDisable?.mfaEnrolledAt).toBeNull();

    const current = await harness.repositories.users.findById(user.id);
    await harness.repositories.users.updateStatus({
      userId: user.id,
      status: 'deactivated',
      expectedVersion: current?.version ?? 1,
      at: harness.now().toISOString(),
    });
    await service.reactivate('person@example.test');
    const reactivated = await harness.repositories.users.findById(user.id);
    expect(reactivated?.status).toBe('active');
    expect(harness.state.auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(['user.recovery_mfa_disabled', 'user.recovery_reactivated']),
    );
  });

  it('reports a missing account without exposing database details', async () => {
    const harness = createTestHarness();
    await expect(
      recoveryFor(harness).resetPassword('missing@example.test', PASSWORD),
    ).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});
