import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeMigrationChecksum } from './checksum.js';
import { MigrationChecksumError, MigrationExecutionError } from './errors.js';
import { createPostgresExecutor, type MigrationDatabase } from './postgres-executor.js';
import { planMigrations, runMigrations } from './runner.js';
import { DirectoryMigrationSource } from './source.js';

/**
 * Exercises the runner against a real PostgreSQL database. It is skipped unless
 * `TAXDESK_MIGRATIONS_TEST_DATABASE_URL` points at a disposable database whose
 * name ends in `_test`, so the suite can never touch a development, staging, or
 * production database by accident.
 */
const connectionString = process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];
const committedMigrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LEDGER_TABLE = 'taxdesk_migration_ledger';
const PROBE_TABLE = 'taxdesk_migration_rollback_probe';
const OK_TABLE = 'taxdesk_migration_ok';

function assertDisposableTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run migration integration tests against "${databaseName}": ` +
        'the database name must end with "_test".',
    );
  }
}

const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

describeWithDatabase('migration runner against PostgreSQL', () => {
  let executor: MigrationDatabase;
  const temporaryDirectories: string[] = [];

  beforeAll(() => {
    assertDisposableTestDatabase(connectionString!);
    executor = createPostgresExecutor(connectionString!);
  });

  afterAll(async () => {
    await executor.close();
    await Promise.all(
      temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  beforeEach(async () => {
    await executor.execute(`DROP TABLE IF EXISTS ${LEDGER_TABLE}`);
    await executor.execute(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    await executor.execute(`DROP TABLE IF EXISTS ${OK_TABLE}`);
  });

  async function tableExists(name: string): Promise<boolean> {
    const rows = await executor.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [name],
    );
    return rows[0]?.present === true;
  }

  async function temporaryMigrationsDirectory(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'taxdesk-integration-'));
    temporaryDirectories.push(directory);
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(directory, name), contents, 'utf8');
    }
    return directory;
  }

  it('migrates a clean database and records the ledger', async () => {
    const source = new DirectoryMigrationSource(committedMigrationsDirectory);
    const result = await runMigrations({ executor, source });

    expect(result.applied.map((entry) => entry.name)).toEqual(['0001_initial_baseline.sql']);
    expect(await tableExists(LEDGER_TABLE)).toBe(true);

    const plan = await planMigrations({ executor, source });
    expect(plan.pending).toEqual([]);
    expect(plan.applied).toHaveLength(1);
    expect(plan.applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent on a second run', async () => {
    const source = new DirectoryMigrationSource(committedMigrationsDirectory);
    await runMigrations({ executor, source });
    const second = await runMigrations({ executor, source });
    expect(second.applied).toEqual([]);
  });

  it('rejects an edited historical migration after it was applied', async () => {
    const original = await readFile(
      join(committedMigrationsDirectory, '0001_initial_baseline.sql'),
      'utf8',
    );
    const appliedDirectory = await temporaryMigrationsDirectory({
      '0001_initial_baseline.sql': original,
    });
    await runMigrations({ executor, source: new DirectoryMigrationSource(appliedDirectory) });

    const editedDirectory = await temporaryMigrationsDirectory({
      '0001_initial_baseline.sql': `${original}\n-- edited after apply`,
    });

    await expect(
      runMigrations({ executor, source: new DirectoryMigrationSource(editedDirectory) }),
    ).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('rolls back a failing migration and records no ledger row for it', async () => {
    const directory = await temporaryMigrationsDirectory({
      '0001_ok.sql': 'CREATE TABLE taxdesk_migration_ok (id integer);',
      '0002_failing.sql':
        `CREATE TABLE ${PROBE_TABLE} (id integer);\n` +
        'SELECT * FROM taxdesk_migration_missing_table;',
    });

    await expect(
      runMigrations({ executor, source: new DirectoryMigrationSource(directory) }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);

    // The failing file's transaction rolled back: neither its table nor its
    // ledger row survives, and the earlier migration stays applied.
    expect(await tableExists(PROBE_TABLE)).toBe(false);
    const rows = await executor.query<{ name: string }>(
      `SELECT name FROM ${LEDGER_TABLE} ORDER BY name`,
    );
    expect(rows.map((row) => row.name)).toEqual(['0001_ok.sql']);
  });

  it('stores the same checksum that the runner computes locally', async () => {
    const source = new DirectoryMigrationSource(committedMigrationsDirectory);
    await runMigrations({ executor, source });

    const baseline = await readFile(
      join(committedMigrationsDirectory, '0001_initial_baseline.sql'),
      'utf8',
    );
    const rows = await executor.query<{ checksum: string }>(
      `SELECT checksum FROM ${LEDGER_TABLE} WHERE name = $1`,
      ['0001_initial_baseline.sql'],
    );
    expect(rows[0]?.checksum).toBe(computeMigrationChecksum(baseline));
  });
});
