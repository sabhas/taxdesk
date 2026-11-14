import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import {
  DirectoryMigrationSource,
  createPostgresExecutor,
  runMigrations,
} from '@taxdesk/database/migrations';
import { IMPORT_LIMITS, STARTER_WORKFLOW_DEFINITION, importTemplate } from '@taxdesk/shared';
import { bytesToBase64Url } from '../crypto/encoding.js';
import { createPasswordHasher } from '../crypto/password.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { buildDependencies, type AppDependencies } from '../dependencies.js';
import { BootstrapService } from '../domain/auth/bootstrap-service.js';
import type { Actor } from '../domain/auth/types.js';
import type { Repositories } from './ports.js';

/**
 * Epic 7 import batches and migration 0010 against PostgreSQL: the commit in
 * bounded transactions, its resume after a failed chunk, the lineage and
 * checksum unique indexes, and the immutability triggers. The suite runs in
 * its own schema so it never races the other PostgreSQL suites.
 */

const baseConnectionString =
  process.env['TAXDESK_API_TEST_DATABASE_URL'] ??
  process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];

const SCHEMA = 'taxdesk_imports_it';

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//u, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run against "${name}": the database name must end with "_test".`);
  }
}

function withSchema(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('search_path', SCHEMA);
  return parsed.toString();
}

const describeWithDatabase = baseConnectionString === undefined ? describe.skip : describe;
const migrationsDirectory = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);

function csv(
  template: 'clients.v1' | 'cases.v1' | 'opening_balances.v1',
  rows: string[][],
): string {
  const header = importTemplate(template).columns.map((column) => column.name);
  const quote = (cell: string) =>
    /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return `${[header, ...rows].map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
}

function clientRow(ref: string, name: string, cnic: number): string[] {
  return [
    ref,
    'individual',
    name,
    '',
    `00000-${String(cnic).padStart(7, '0')}-1`,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
  ];
}

let keyCounter = 0;
const idempotencyKey = (): string => `pg-import-key-${String(++keyCounter).padStart(8, '0')}`;

describeWithDatabase('data import against PostgreSQL', () => {
  let executor: SqlExecutor;
  let dependencies: AppDependencies;
  let repositories: Repositories;
  let clockNow: Date;
  let owner: Actor;

  const tick = (): void => {
    clockNow = new Date(clockNow.getTime() + 1_000);
  };

  beforeAll(async () => {
    assertDisposable(baseConnectionString!);
    const connectionString = withSchema(baseConnectionString!);
    const admin = createPostgresExecutor(baseConnectionString!);
    await admin.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.execute(`CREATE SCHEMA ${SCHEMA}`);
    await admin.close();
    const migrations = createPostgresExecutor(connectionString);
    await runMigrations({
      executor: migrations,
      source: new DirectoryMigrationSource(migrationsDirectory),
    });
    await migrations.close();

    clockNow = new Date('2026-07-01T00:00:00.000Z');
    executor = createSqlExecutor(connectionString, {
      requireTls: !/[?&]sslmode=disable/u.test(connectionString),
      maxConnections: 4,
    });
    const key = bytesToBase64Url(new Uint8Array(32).fill(5));
    dependencies = buildDependencies({
      executor,
      authConfig: {
        mfaEncryptionKey: key,
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
      cipher: createSecretCipher(key),
    });
    repositories = dependencies.repositories;
    const bootstrap = new BootstrapService({
      repositories,
      unitOfWork: dependencies.unitOfWork,
      passwordHasher: dependencies.passwordHasher,
      tokenHasher: dependencies.tokenHasher,
      clock: dependencies.clock,
    });
    const result = await bootstrap.bootstrap({
      firmName: 'Import Firm',
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const user = await repositories.users.findById(result.userId);
    const session = await dependencies.sessionService.issue(user!, {
      mfaVerified: true,
      requestId: 'imp-db-session',
    });
    owner = (await dependencies.sessionService.validate(session.token))!;
    expect(owner.permissions).toContain('imports.manage');

    tick();
    const template = await dependencies.workflowTemplateService.create({
      actor: owner,
      requestId: 'imp-db-template',
      request: {
        name: 'Import workflow',
        description: '',
        definition: STARTER_WORKFLOW_DEFINITION,
      },
    });
    tick();
    await dependencies.workflowTemplateService.publish({
      actor: owner,
      templateId: template.id,
      versionId: template.draft!.id,
      expectedVersion: 1,
      requestId: 'imp-db-publish',
    });
    tick();
    await dependencies.serviceTypeService.create({
      actor: owner,
      requestId: 'imp-db-service',
      request: {
        name: 'Income tax return',
        description: '',
        defaultFeeMinor: 1_000_000,
        defaultDeadlineOffsetDays: 30,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: template.id,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await executor.close();
  });

  const service = () => dependencies.importService;

  it('commits clients in bounded transactions and resumes after a failed chunk', async () => {
    const total = IMPORT_LIMITS.commitChunkRows * 2 + 7;
    const content = csv(
      'clients.v1',
      Array.from({ length: total }, (_, i) =>
        clientRow(`PG-C-${String(i)}`, `Pg Person ${String(i)}`, i + 1),
      ),
    );
    tick();
    const batch = await service().dryRun({
      actor: owner,
      request: { template: 'clients.v1', fileName: 'clients.csv', content },
      requestId: 'imp-db-dry',
    });
    expect(batch.plan.create).toBe(total);

    // Fail the second chunk after it wrote records: the whole chunk must roll back.
    const key = idempotencyKey();
    await executor.query(
      `CREATE OR REPLACE FUNCTION ${SCHEMA}.fail_row_150() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.row_number = 150 AND NEW.outcome IS NOT NULL THEN
           RAISE EXCEPTION 'simulated failure';
         END IF;
         RETURN NEW;
       END; $$`,
    );
    await executor.query(
      `CREATE TRIGGER fail_row_150 BEFORE UPDATE ON ${SCHEMA}.import_batch_rows
       FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.fail_row_150()`,
    );
    tick();
    await expect(
      service().commit({
        actor: owner,
        id: batch.id,
        content,
        expectedVersion: batch.version,
        idempotencyKey: key,
        requestId: 'imp-db-commit-1',
      }),
    ).rejects.toThrow();
    await executor.query(`DROP TRIGGER fail_row_150 ON ${SCHEMA}.import_batch_rows`);

    const midway = await service().getBatch(owner, batch.id);
    expect(midway.status).toBe('committing');
    expect(midway.outcomes.created).toBe(IMPORT_LIMITS.commitChunkRows);
    const [{ count }] = (await executor.query(
      `SELECT count(*)::int AS count FROM clients WHERE legal_name LIKE 'Pg Person %'`,
    )) as [{ count: number }];
    // Only the first chunk's records exist: the failed chunk wrote nothing.
    expect(count).toBe(IMPORT_LIMITS.commitChunkRows);

    tick();
    const resumed = await service().commit({
      actor: owner,
      id: batch.id,
      content,
      expectedVersion: midway.version,
      idempotencyKey: key,
      requestId: 'imp-db-commit-2',
    });
    expect(resumed.batch.status).toBe('committed');
    expect(resumed.batch.outcomes).toMatchObject({ created: total, failed: 0, pending: 0 });
    expect(resumed.batch.reconciliation.balanced).toBe(true);
    const [{ total: after }] = (await executor.query(
      `SELECT count(*)::int AS total FROM clients WHERE legal_name LIKE 'Pg Person %'`,
    )) as [{ total: number }];
    expect(after).toBe(total);
    const audits = await executor.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'client.created'
         AND metadata->>'importBatch' = $1`,
      [batch.batchCode],
    );
    expect(audits[0]?.['n']).toBe(total);

    // Replaying the same key returns the result and writes nothing.
    const replay = await service().commit({
      actor: owner,
      id: batch.id,
      content,
      expectedVersion: resumed.batch.version,
      idempotencyKey: key,
      requestId: 'imp-db-commit-3',
    });
    expect(replay.replayed).toBe(true);
  }, 120_000);

  it('serializes concurrent commits of one batch so each row is written once', async () => {
    const content = csv(
      'clients.v1',
      Array.from({ length: 40 }, (_, i) =>
        clientRow(`PG-R-${String(i)}`, `Race Person ${String(i)}`, 5_000 + i),
      ),
    );
    tick();
    const batch = await service().dryRun({
      actor: owner,
      request: { template: 'clients.v1', fileName: 'race.csv', content },
      requestId: 'imp-db-race-dry',
    });
    const key = idempotencyKey();
    const attempts = await Promise.allSettled(
      [1, 2, 3].map(
        async (n) =>
          await service().commit({
            actor: owner,
            id: batch.id,
            content,
            expectedVersion: batch.version,
            idempotencyKey: key,
            requestId: `imp-db-race-${String(n)}`,
          }),
      ),
    );
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
    const rows = await executor.query(
      `SELECT count(*)::int AS n FROM clients WHERE legal_name LIKE 'Race Person %'`,
    );
    expect(rows[0]?.['n']).toBe(40);
    const final = await service().getBatch(owner, batch.id);
    expect(final.status).toBe('committed');
    expect(final.outcomes.created).toBe(40);
  }, 60_000);

  it('imports cases and opening balances that reference imported clients', async () => {
    const cases = csv('cases.v1', [
      ['PG-T-1', 'PG-C-1', 'Income tax return', '2026', '2026-09-30', 'in_preparation', '', '', ''],
    ]);
    tick();
    const caseBatch = await service().dryRun({
      actor: owner,
      request: { template: 'cases.v1', fileName: 'cases.csv', content: cases },
      requestId: 'imp-db-cases',
    });
    expect(caseBatch.plan.create).toBe(1);
    tick();
    const committedCases = await service().commit({
      actor: owner,
      id: caseBatch.id,
      content: cases,
      expectedVersion: caseBatch.version,
      idempotencyKey: idempotencyKey(),
      requestId: 'imp-db-cases-commit',
    });
    expect(committedCases.batch.outcomes.created).toBe(1);
    const history = await executor.query(
      `SELECT h.to_status_key FROM case_status_history h
       JOIN import_batch_rows r ON r.entity_id = h.case_id
       WHERE r.batch_id = $1 ORDER BY h.occurred_at, h.id`,
      [caseBatch.id],
    );
    expect(history.map((row) => row['to_status_key'])).toEqual(['intake', 'in_preparation']);

    const balances = csv('opening_balances.v1', [
      ['PG-B-1', 'PG-C-1', 'PG-T-1', '2026-06-30', '', '2,500.25', ''],
      ['PG-B-2', 'PG-C-2', '', '2026-06-30', '2026-07-31', '100', ''],
    ]);
    tick();
    const balanceBatch = await service().dryRun({
      actor: owner,
      request: { template: 'opening_balances.v1', fileName: 'balances.csv', content: balances },
      requestId: 'imp-db-balances',
    });
    tick();
    const committed = await service().commit({
      actor: owner,
      id: balanceBatch.id,
      content: balances,
      expectedVersion: balanceBatch.version,
      idempotencyKey: idempotencyKey(),
      requestId: 'imp-db-balances-commit',
    });
    expect(committed.batch.reconciliation).toMatchObject({
      sourceAmountMinor: 260_025,
      importedAmountMinor: 260_025,
      balanced: true,
    });
    const invoices = await executor.query(
      `SELECT v.status, v.invoice_number, to_char(v.issue_date, 'YYYY-MM-DD') AS issue_date,
              v.outstanding_minor::int AS outstanding
       FROM invoices v JOIN import_batch_rows r ON r.entity_id = v.id
       WHERE r.batch_id = $1 ORDER BY r.row_number`,
      [balanceBatch.id],
    );
    expect(invoices).toEqual([
      expect.objectContaining({
        status: 'finalized',
        issue_date: '2026-06-30',
        outstanding: 250_025,
      }),
      expect.objectContaining({
        status: 'finalized',
        issue_date: '2026-06-30',
        outstanding: 10_000,
      }),
    ]);

    const reconciliation = await service().reconciliation(owner, { sample: 3 });
    expect(reconciliation.clients.imported).toBeGreaterThanOrEqual(
      IMPORT_LIMITS.commitChunkRows * 2,
    );
    expect(reconciliation.cases).toMatchObject({ imported: 1, importedStillActive: 1 });
    expect(reconciliation.openingBalances).toMatchObject({ invoices: 2, totalMinor: 260_025 });
    expect(reconciliation.samples).toHaveLength(3);
  }, 60_000);

  it('enforces checksum uniqueness, lineage uniqueness, and immutability in the database', async () => {
    const [committed] = await executor.query(
      `SELECT id, source_checksum FROM import_batches WHERE status = 'committed' LIMIT 1`,
    );
    const batchId = String(committed?.['id']);
    await expect(
      executor.query(`UPDATE import_batches SET file_name = 'x.csv' WHERE id = $1`, [batchId]),
    ).rejects.toThrow(/cannot change/u);
    await expect(
      executor.query(`DELETE FROM import_batches WHERE id = $1`, [batchId]),
    ).rejects.toThrow(/never deleted/u);
    await expect(
      executor.query(
        `UPDATE import_batch_rows SET outcome_code = 'DECIDED_SKIP' WHERE batch_id = $1`,
        [batchId],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      executor.query(`DELETE FROM import_batch_rows WHERE batch_id = $1`, [batchId]),
    ).rejects.toThrow(/never deleted/u);
    await expect(
      executor.query(
        `INSERT INTO import_batches (id, batch_code, kind, template_id, file_name, size_bytes,
           row_count, source_checksum, status, validated_at, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), 'IMP-99999', kind, template_id, 'copy.csv', size_bytes, 0,
                source_checksum, 'validated', now(), created_by, now(), now()
         FROM import_batches WHERE id = $1`,
        [batchId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // A committing batch must have a clean plan.
    await expect(
      executor.query(
        `INSERT INTO import_batches (id, batch_code, kind, template_id, file_name, size_bytes,
           row_count, source_checksum, status, plan_error, validated_at, commit_idempotency_key,
           commit_started_at, commit_started_by, created_by, created_at, updated_at)
         SELECT gen_random_uuid(), 'IMP-99998', kind, template_id, 'bad.csv', 1, 1,
                repeat('a', 64), 'committing', 1, now(), 'abcdefghijklmnop', now(), created_by,
                created_by, now(), now()
         FROM import_batches WHERE id = $1`,
        [batchId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Plaintext identifiers never reach the import tables.
    const leaked = await executor.query(
      `SELECT count(*)::int AS n FROM import_batch_rows WHERE errors::text ~ '[0-9]{5}-[0-9]{7}'`,
    );
    expect(leaked[0]?.['n']).toBe(0);
  });
});
