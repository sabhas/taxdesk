/**
 * Deterministic test doubles for the migration runner.
 *
 * This file is excluded from the package build (`tsconfig.build.json`) and is
 * imported only by migration tests. It lets the runner's ordering, checksum,
 * locking, and rollback behavior be asserted without a live database.
 */
import { MIGRATION_LEDGER_TABLE } from './ledger.js';
import type { SqlExecutor, SqlParameter } from './postgres-executor.js';
import type { MigrationSource } from './source.js';

export interface LedgerRowFixture {
  readonly name: string;
  readonly checksum: string;
  readonly applied_at?: Date;
  readonly duration_ms?: number;
}

export interface FakeSqlExecutorOptions {
  readonly applied?: readonly LedgerRowFixture[];
  /** Whether `to_regclass` reports the ledger as present. */
  readonly ledgerExists?: boolean;
  /** Simulate a failing migration when a script contains this text. */
  readonly failOn?: string;
}

export interface RecordedQuery {
  readonly statement: string;
  readonly params: readonly SqlParameter[];
}

export class FakeSqlExecutor implements SqlExecutor {
  readonly queries: RecordedQuery[] = [];
  readonly executedScripts: string[] = [];
  readonly ledgerInserts: SqlParameter[][] = [];
  transactionCount = 0;
  ledgerExists: boolean;

  private readonly appliedRows: LedgerRowFixture[];
  private readonly failOn: string | undefined;

  constructor(options: FakeSqlExecutorOptions = {}) {
    this.appliedRows = [...(options.applied ?? [])];
    this.ledgerExists = options.ledgerExists ?? true;
    this.failOn = options.failOn;
  }

  execute(script: string): Promise<void> {
    this.executedScripts.push(script);
    if (script.includes(`CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE}`)) {
      this.ledgerExists = true;
    }
    if (this.failOn !== undefined && script.includes(this.failOn)) {
      throw new Error('synthetic migration failure');
    }
    return Promise.resolve();
  }

  query<TRow = Record<string, unknown>>(
    statement: string,
    params: readonly SqlParameter[] = [],
  ): Promise<TRow[]> {
    this.queries.push({ statement, params: [...params] });

    if (statement.includes('pg_advisory')) {
      return Promise.resolve([]);
    }
    if (statement.includes('to_regclass')) {
      return Promise.resolve([
        { table_name: this.ledgerExists ? MIGRATION_LEDGER_TABLE : null },
      ] as unknown as TRow[]);
    }
    if (statement.includes(`INSERT INTO ${MIGRATION_LEDGER_TABLE}`)) {
      this.ledgerInserts.push([...params]);
      const [name, checksum, appliedAt, durationMs] = params;
      if (
        typeof name === 'string' &&
        typeof checksum === 'string' &&
        appliedAt instanceof Date &&
        typeof durationMs === 'number'
      ) {
        this.appliedRows.push({
          name,
          checksum,
          applied_at: appliedAt,
          duration_ms: durationMs,
        });
      }
      return Promise.resolve([]);
    }
    if (statement.includes(`FROM ${MIGRATION_LEDGER_TABLE}`)) {
      return Promise.resolve(
        this.appliedRows.map((row) => ({
          name: row.name,
          checksum: row.checksum,
          applied_at: row.applied_at ?? new Date('2026-01-01T00:00:00.000Z'),
          duration_ms: row.duration_ms ?? 0,
        })) as unknown as TRow[],
      );
    }
    return Promise.resolve([]);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return await work(this);
  }
}

export class InMemoryMigrationSource implements MigrationSource {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  read(name: string): Promise<string> {
    const sql = this.files.get(name);
    if (sql === undefined) {
      throw new Error(`No such migration fixture: ${name}`);
    }
    return Promise.resolve(sql);
  }
}
