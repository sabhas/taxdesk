import { describe, expect, it } from 'vitest';
import { computeMigrationChecksum } from './checksum.js';
import {
  MigrationChecksumError,
  MigrationExecutionError,
  MigrationHistoryError,
} from './errors.js';
import { MIGRATION_LEDGER_DDL } from './ledger.js';
import { planMigrations, runMigrations } from './runner.js';
import { FakeSqlExecutor, InMemoryMigrationSource } from './test-doubles.js';

const ONE = 'SELECT 1;';
const TWO = 'SELECT 2;';
const THREE = 'SELECT 3;';

function ledgerRow(name: string, sql: string) {
  return { name, checksum: computeMigrationChecksum(sql) };
}

function migrationScripts(executor: FakeSqlExecutor): string[] {
  return executor.executedScripts.filter(
    (script) => !script.includes('CREATE TABLE IF NOT EXISTS'),
  );
}

describe('runMigrations', () => {
  it('applies pending migrations in version order and records each in the ledger', async () => {
    const executor = new FakeSqlExecutor({ ledgerExists: false });
    const source = new InMemoryMigrationSource({
      '0002_two.sql': TWO,
      '0001_one.sql': ONE,
    });

    let clock = 0;
    const result = await runMigrations({ executor, source, now: () => (clock += 100) });

    expect(result.applied.map((entry) => entry.name)).toEqual(['0001_one.sql', '0002_two.sql']);
    expect(result.pending).toEqual([]);
    expect(executor.transactionCount).toBe(2);
    expect(migrationScripts(executor)).toEqual([ONE, TWO]);

    expect(executor.ledgerInserts).toEqual([
      ['0001_one.sql', computeMigrationChecksum(ONE), expect.any(Date), 100],
      ['0002_two.sql', computeMigrationChecksum(TWO), expect.any(Date), 100],
    ]);
  });

  it('bootstraps the ledger once and releases the advisory lock', async () => {
    const executor = new FakeSqlExecutor({ ledgerExists: false });
    const source = new InMemoryMigrationSource({ '0001_one.sql': ONE });

    await runMigrations({ executor, source });

    expect(executor.executedScripts[0]).toBe(MIGRATION_LEDGER_DDL);
    expect(executor.queries[0]?.statement).toContain('pg_advisory_lock');
    expect(executor.queries.at(-1)?.statement).toContain('pg_advisory_unlock');
  });

  it('is idempotent: a second run applies nothing', async () => {
    const executor = new FakeSqlExecutor({ ledgerExists: false });
    const source = new InMemoryMigrationSource({ '0001_one.sql': ONE });

    await runMigrations({ executor, source });
    const firstRunInserts = executor.ledgerInserts.length;
    const firstRunTransactions = executor.transactionCount;

    const secondRun = await runMigrations({ executor, source });

    expect(secondRun.applied).toEqual([]);
    expect(secondRun.pending).toEqual([]);
    expect(executor.ledgerInserts.length).toBe(firstRunInserts);
    expect(executor.transactionCount).toBe(firstRunTransactions);
  });

  it('fails closed on checksum drift without applying anything', async () => {
    const executor = new FakeSqlExecutor({
      applied: [{ name: '0001_one.sql', checksum: 'f'.repeat(64) }],
    });
    const source = new InMemoryMigrationSource({ '0001_one.sql': ONE, '0002_two.sql': TWO });

    await expect(runMigrations({ executor, source })).rejects.toBeInstanceOf(
      MigrationChecksumError,
    );
    expect(executor.transactionCount).toBe(0);
    expect(executor.ledgerInserts).toEqual([]);
    expect(executor.queries.at(-1)?.statement).toContain('pg_advisory_unlock');
  });

  it('rejects an applied migration whose file is missing locally', async () => {
    const executor = new FakeSqlExecutor({ applied: [ledgerRow('0001_one.sql', ONE)] });
    const source = new InMemoryMigrationSource({});

    await expect(runMigrations({ executor, source })).rejects.toBeInstanceOf(MigrationHistoryError);
    expect(executor.ledgerInserts).toEqual([]);
  });

  it('rejects a pending migration below the latest applied version', async () => {
    const executor = new FakeSqlExecutor({ applied: [ledgerRow('0003_three.sql', THREE)] });
    const source = new InMemoryMigrationSource({
      '0003_three.sql': THREE,
      '0002_two.sql': TWO,
    });

    let error: unknown;
    try {
      await runMigrations({ executor, source });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MigrationHistoryError);
    expect((error as MigrationHistoryError).code).toBe('MIGRATION_HISTORY_OUT_OF_ORDER');
    expect(executor.ledgerInserts).toEqual([]);
  });

  it('rolls back a failed migration, records nothing for it, and stops applying later files', async () => {
    const executor = new FakeSqlExecutor({ ledgerExists: false, failOn: 'BOOM' });
    const source = new InMemoryMigrationSource({
      '0001_one.sql': ONE,
      '0002_boom.sql': 'BOOM;',
      '0003_three.sql': THREE,
    });

    let error: unknown;
    try {
      await runMigrations({ executor, source });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MigrationExecutionError);
    expect((error as MigrationExecutionError).migrationName).toBe('0002_boom.sql');
    expect((error as MigrationExecutionError).message).toMatch(/synthetic migration failure/);
    expect(executor.ledgerInserts.map((params) => params[0])).toEqual(['0001_one.sql']);
    expect(migrationScripts(executor)).not.toContain(THREE);
    expect(executor.queries.at(-1)?.statement).toContain('pg_advisory_unlock');
  });
});

describe('planMigrations', () => {
  it('reports applied and pending migrations without writing', async () => {
    const executor = new FakeSqlExecutor({ applied: [ledgerRow('0001_one.sql', ONE)] });
    const source = new InMemoryMigrationSource({ '0001_one.sql': ONE, '0002_two.sql': TWO });

    const plan = await planMigrations({ executor, source });

    expect(plan.applied.map((entry) => entry.name)).toEqual(['0001_one.sql']);
    expect(plan.pending.map((entry) => entry.name)).toEqual(['0002_two.sql']);
    expect(executor.executedScripts).toEqual([]);
    expect(executor.ledgerInserts).toEqual([]);
    expect(executor.queries.some((query) => query.statement.includes('pg_advisory_lock'))).toBe(
      false,
    );
  });

  it('treats a database without a ledger as having no applied migrations', async () => {
    const executor = new FakeSqlExecutor({ ledgerExists: false });
    const source = new InMemoryMigrationSource({ '0001_one.sql': ONE });

    const plan = await planMigrations({ executor, source });

    expect(plan.applied).toEqual([]);
    expect(plan.pending.map((entry) => entry.name)).toEqual(['0001_one.sql']);
  });
});
