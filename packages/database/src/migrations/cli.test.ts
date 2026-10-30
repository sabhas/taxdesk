import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDependencies } from './cli.js';
import { MigrationReportSchema } from './contracts.js';
import { computeMigrationChecksum } from './checksum.js';
import { MIGRATION_MANIFEST_FILE, serializeMigrationManifest } from './manifest.js';
import type { MigrationDatabase, SqlExecutor, SqlParameter } from './postgres-executor.js';
import { FakeSqlExecutor, InMemoryMigrationSource, type LedgerRowFixture } from './test-doubles.js';

const MIGRATIONS_DIR = '/migrations';
const DATABASE_URL = 'postgres://app:sup3rsecret@db.internal.example:5432/taxdesk_test';
const ONE = 'SELECT 1;';
const TWO = 'SELECT 2;';
const manifestPath = join(MIGRATIONS_DIR, MIGRATION_MANIFEST_FILE);

interface HarnessOptions {
  readonly migrations?: Record<string, string>;
  readonly manifest?: string;
  readonly applied?: readonly LedgerRowFixture[];
  readonly env?: Record<string, string | undefined>;
}

interface Harness {
  readonly deps: CliDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly executor: FakeSqlExecutor;
  readonly wasClosed: () => boolean;
  readonly manifest: () => string | undefined;
}

function harness(options: HarnessOptions = {}): Harness {
  const migrations = { ...(options.migrations ?? {}) };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const executor = new FakeSqlExecutor({
    ledgerExists: options.applied !== undefined,
    ...(options.applied !== undefined ? { applied: options.applied } : {}),
  });
  let manifest = options.manifest;
  let closed = false;

  const database: MigrationDatabase = {
    execute: async (script) => {
      await executor.execute(script);
    },
    query: async <TRow>(statement: string, params?: readonly SqlParameter[]) =>
      await executor.query<TRow>(statement, params),
    transaction: async <T>(work: (e: SqlExecutor) => Promise<T>) =>
      await executor.transaction(async () => await work(database)),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    deps: {
      env: options.env ?? {},
      createExecutor: () => database,
      createSource: () => new InMemoryMigrationSource(migrations),
      readFile: (path) => {
        if (path !== manifestPath || manifest === undefined) {
          throw new Error(`No such file: ${path}`);
        }
        return Promise.resolve(manifest);
      },
      writeFile: (path, contents) => {
        if (path !== manifestPath) {
          throw new Error(`Unexpected write: ${path}`);
        }
        manifest = contents;
        return Promise.resolve();
      },
      fileExists: (path) => Promise.resolve(path === manifestPath && manifest !== undefined),
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
    },
    stdout,
    stderr,
    executor,
    wasClosed: () => closed,
    manifest: () => manifest,
  };
}

function manifestFileFor(entries: readonly { name: string; sql: string }[]): string {
  return serializeMigrationManifest({
    version: 1,
    migrations: entries.map((entry) => ({
      name: entry.name,
      checksum: computeMigrationChecksum(entry.sql),
    })),
  });
}

function lastReport(lines: readonly string[]) {
  const last = lines.at(-1);
  expect(last).toBeDefined();
  return MigrationReportSchema.parse(JSON.parse(last!));
}

describe('runCli verify', () => {
  it('passes when the manifest matches the migration files', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      manifest: manifestFileFor([{ name: '0001_one.sql', sql: ONE }]),
    });

    const code = await runCli(['verify', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'verify', files: 1, recorded: 1 });
  });

  it('rejects an edited historical migration with a non-zero exit code', async () => {
    const test = harness({
      migrations: { '0001_one.sql': `${ONE} -- edited` },
      manifest: manifestFileFor([{ name: '0001_one.sql', sql: ONE }]),
    });

    const code = await runCli(['verify', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(1);
    expect(test.stderr.join('\n')).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(test.stderr.join('\n')).toContain('0001_one.sql');
    expect(test.stdout).toEqual([]);
  });

  it('rejects an unrecorded migration until the manifest is regenerated', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE, '0002_two.sql': TWO },
      manifest: manifestFileFor([{ name: '0001_one.sql', sql: ONE }]),
    });

    const code = await runCli(['verify', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(1);
    expect(test.stderr.join('\n')).toContain('0002_two.sql');
    expect(test.stderr.join('\n')).toContain('db:migrate:manifest');
  });
});

describe('runCli manifest', () => {
  it('records new migrations additively and then verifies clean', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE, '0002_two.sql': TWO },
      manifest: manifestFileFor([{ name: '0001_one.sql', sql: ONE }]),
    });

    const code = await runCli(['manifest', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(0);
    expect(lastReport(test.stdout)).toMatchObject({
      command: 'manifest',
      status: 'updated',
      added: ['0002_two.sql'],
      recorded: 2,
    });
    expect(test.manifest()).toContain('0002_two.sql');

    const verifyCode = await runCli(['verify', '--migrations', MIGRATIONS_DIR], test.deps);
    expect(verifyCode).toBe(0);
  });

  it('is a no-op when every migration is already recorded', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      manifest: manifestFileFor([{ name: '0001_one.sql', sql: ONE }]),
    });

    const code = await runCli(['manifest', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(0);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'manifest', status: 'up_to_date' });
  });

  it('refuses to rewrite an edited historical migration', async () => {
    const original = manifestFileFor([{ name: '0001_one.sql', sql: ONE }]);
    const test = harness({
      migrations: { '0001_one.sql': `${ONE} -- edited` },
      manifest: original,
    });

    const code = await runCli(['manifest', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(1);
    expect(test.stderr.join('\n')).toContain('MIGRATION_CHECKSUM_MISMATCH');
    expect(test.manifest()).toBe(original);
  });
});

describe('runCli status', () => {
  it('requires a database URL', async () => {
    const test = harness();
    const code = await runCli(['status', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(2);
    expect(test.stderr.join('\n')).toContain('DATABASE_URL');
  });

  it('reports pending migrations and fails with --check', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      env: { DATABASE_URL },
    });

    const code = await runCli(['status', '--check', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(1);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'status', status: 'pending' });
    expect(test.wasClosed()).toBe(true);
  });

  it('reports up to date when every migration is applied', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      applied: [{ name: '0001_one.sql', checksum: computeMigrationChecksum(ONE) }],
      env: { DATABASE_URL },
    });

    const code = await runCli(['status', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(0);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'status', status: 'up_to_date' });
  });

  it('never prints the connection string', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      env: { DATABASE_URL },
    });

    await runCli(['status', '--migrations', MIGRATIONS_DIR], test.deps);

    const output = [...test.stdout, ...test.stderr].join('\n');
    expect(output).not.toContain('sup3rsecret');
    expect(output).not.toContain('db.internal.example');
  });
});

describe('runCli up', () => {
  it('applies pending migrations against the database URL', async () => {
    const test = harness({
      migrations: { '0001_one.sql': ONE },
      env: { DATABASE_URL },
    });

    const code = await runCli(['up', '--migrations', MIGRATIONS_DIR], test.deps);

    expect(code).toBe(0);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'up', pending: [] });
    expect(test.executor.ledgerInserts).toHaveLength(1);
    expect(test.wasClosed()).toBe(true);
  });

  it('accepts an explicit --database-url override', async () => {
    const test = harness({ migrations: { '0001_one.sql': ONE } });

    const code = await runCli(
      ['up', '--database-url', DATABASE_URL, '--migrations', MIGRATIONS_DIR],
      test.deps,
    );

    expect(code).toBe(0);
    expect(lastReport(test.stdout)).toMatchObject({ command: 'up' });
  });
});

describe('runCli arguments', () => {
  it('rejects an unknown command with exit code 2', async () => {
    const test = harness();
    const code = await runCli(['drop-everything'], test.deps);
    expect(code).toBe(2);
    expect(test.stderr.join('\n')).toContain('Unknown command');
  });

  it('rejects an unknown option with exit code 2', async () => {
    const test = harness();
    const code = await runCli(['verify', '--force'], test.deps);
    expect(code).toBe(2);
    expect(test.stderr.join('\n')).toContain('Unknown option');
  });

  it('rejects a missing command with exit code 2', async () => {
    const test = harness();
    expect(await runCli([], test.deps)).toBe(2);
  });
});
