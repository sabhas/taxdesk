import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import type { ClientListQuery } from '@taxdesk/shared';
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
        clientDataEncryptionKey: bytesToBase64Url(new Uint8Array(32).fill(21)),
        clientIdentifierIndexKey: bytesToBase64Url(new Uint8Array(32).fill(23)),
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

  describe('client repositories', () => {
    async function ownerActor() {
      const owner = await dependencies.repositories.users.findByUsername('owner');
      const session = await dependencies.sessionService.issue(owner!, {
        mfaVerified: true,
        requestId: 'db-client-session',
      });
      return (await dependencies.sessionService.validate(session.token))!;
    }

    function tick(): void {
      clockNow = new Date(clockNow.getTime() + 1_000);
    }

    it('creates clients with sequence codes and protected identifiers', async () => {
      const actor = await ownerActor();
      const service = dependencies.clientService;
      const first = await service.createClient({
        actor,
        requestId: 'db-client-1',
        request: {
          type: 'individual',
          legalName: 'Database Individual',
          cnic: '35202-1234567-1',
          contacts: [
            { name: 'Self', email: 'db.one@example.test', phone: '0300 1112223', isPrimary: true },
          ],
          notes: 'Synthetic.',
          assignedManagerUserId: actor.userId,
        },
      });
      tick();
      const second = await service.createClient({
        actor,
        requestId: 'db-client-2',
        request: {
          type: 'business',
          legalName: 'Database Traders (Pvt.) Ltd.',
          ntn: '7654321-0',
          contacts: [{ name: 'Accounts', email: 'db.accounts@example.test', isPrimary: true }],
          assignedManagerUserId: null,
        },
      });
      expect(first.clientCode).toMatch(/^CL-\d{5}$/u);
      expect(Number(second.clientCode.slice(3))).toBe(Number(first.clientCode.slice(3)) + 1);
      expect(first.cnicMasked).toBe('•••••-••••567-1');

      const rows = await executor.query(
        'SELECT cnic_ciphertext, cnic_blind_index, cnic_masked FROM clients WHERE id = $1',
        [first.id],
      );
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain('3520212345671');
      expect(stored).not.toContain('35202-1234567-1');
      const audit = await executor.query(
        "SELECT metadata FROM audit_events WHERE entity_type = 'client'",
      );
      expect(JSON.stringify(audit)).not.toContain('3520212345671');
    });

    it('enforces deployment-wide identifier uniqueness in the database', async () => {
      const actor = await ownerActor();
      await expect(
        dependencies.clientService.createClient({
          actor,
          requestId: 'db-client-dup',
          request: {
            type: 'individual',
            legalName: 'Someone Else',
            cnic: '3520212345671',
            contacts: [],
            assignedManagerUserId: null,
          },
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_IDENTIFIER_EXISTS' });

      // The unique index itself rejects a racing insert that skipped the pre-check.
      const existing = await executor.query(
        'SELECT cnic_blind_index FROM clients WHERE cnic_blind_index IS NOT NULL LIMIT 1',
      );
      await expect(
        executor.query(
          `INSERT INTO clients (id, client_code, client_type, legal_name, display_name,
             normalized_name, normalized_display_name, cnic_ciphertext, cnic_blind_index,
             cnic_masked, identifier_key_version, created_at, updated_at, version)
           VALUES (gen_random_uuid(), 'CL-99999', 'individual', 'Race', 'Race', 'race', 'race',
             'v1.x.y', $1, '•••••-••••567-1', 1, now(), now(), 1)`,
          [existing[0]?.['cnic_blind_index']],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('searches, filters, and pages with real SQL', async () => {
      const actor = await ownerActor();
      const service = dependencies.clientService;
      const names = async (q: Partial<ClientListQuery>) =>
        (await service.listClients(actor, { state: 'active', limit: 25, ...q })).clients.map(
          (client) => client.legalName,
        );

      expect(await names({ q: 'database traders ltd' })).toEqual(['Database Traders (Pvt.) Ltd.']);
      expect(await names({ q: '+92 300 1112223' })).toEqual(['Database Individual']);
      expect(await names({ q: 'DB.ACCOUNTS@' })).toEqual(['Database Traders (Pvt.) Ltd.']);
      expect(await names({ q: '35202-1234567-1' })).toEqual(['Database Individual']);
      expect(await names({ q: '35202-12345' })).toEqual([]);
      expect(await names({ q: '%' })).toEqual([]);
      expect(await names({ type: 'business' })).toEqual(['Database Traders (Pvt.) Ltd.']);
      expect(await names({ manager: 'unassigned' })).toEqual(['Database Traders (Pvt.) Ltd.']);

      const firstPage = await service.listClients(actor, { state: 'active', limit: 1 });
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await service.listClients(actor, {
        state: 'active',
        limit: 1,
        cursor: firstPage.nextCursor!,
      });
      expect([...firstPage.clients, ...secondPage.clients].map((c) => c.legalName)).toEqual([
        'Database Individual',
        'Database Traders (Pvt.) Ltd.',
      ]);
      expect(secondPage.nextCursor).toBeNull();
    });

    it('detects duplicate warnings and updates optimistically', async () => {
      const actor = await ownerActor();
      const service = dependencies.clientService;
      const preview = await service.checkDuplicates({
        type: 'individual',
        legalName: 'Mr. Database Individual',
        cnic: '42101-7654321-9',
        contacts: [{ name: 'Other', email: 'DB.ONE@example.test', isPrimary: false }],
        assignedManagerUserId: null,
      });
      expect(preview.blocking).toEqual([]);
      expect(preview.warnings[0]?.reasons).toEqual(['email', 'name']);

      const [client] = (await service.listClients(actor, { state: 'active', limit: 1 })).clients;
      tick();
      const updated = await service.updateClient({
        actor,
        clientId: client!.id,
        expectedVersion: 1,
        requestId: 'db-client-update',
        request: {
          type: 'individual',
          legalName: 'Database Individual',
          contacts: [{ name: 'Self', email: 'db.one@example.test', isPrimary: true }],
          notes: 'Changed.',
          assignedManagerUserId: actor.userId,
        },
      });
      expect(updated.version).toBe(2);
      expect(updated.contacts).toHaveLength(1);
      await expect(
        service.updateClient({
          actor,
          clientId: client!.id,
          expectedVersion: 1,
          requestId: 'db-client-stale',
          request: {
            type: 'individual',
            legalName: 'Stale',
            contacts: [],
            notes: '',
            assignedManagerUserId: null,
          },
        }),
      ).rejects.toMatchObject({ status: 412 });

      tick();
      const archived = await service.setArchived({
        actor,
        clientId: client!.id,
        archived: true,
        expectedVersion: 2,
        requestId: 'db-client-archive',
      });
      expect(archived.state).toBe('archived');
      const activity = await service.listActivity({
        actor,
        clientId: client!.id,
        limit: 10,
        cursor: null,
      });
      expect(activity.events.map((event) => event.action)).toEqual([
        'client.archived',
        'client.updated',
        'client.created',
      ]);
      expect(activity.events[1]?.changedFields).toEqual(['contacts', 'notes']);
    });

    it('keeps client audit events append-only', async () => {
      await expect(
        executor.query("UPDATE audit_events SET action = 'x.y' WHERE entity_type = 'client'"),
      ).rejects.toThrow();
    });
  });
});
