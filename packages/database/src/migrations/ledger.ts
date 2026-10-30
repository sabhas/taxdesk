import {
  AppliedMigrationSchema,
  MigrationLedgerRowSchema,
  type AppliedMigration,
} from './contracts.js';
import type { SqlExecutor } from './postgres-executor.js';

/** Operational ledger that records every applied migration. */
export const MIGRATION_LEDGER_TABLE = 'taxdesk_migration_ledger';

/**
 * Idempotent bootstrap for the migration ledger.
 *
 * The ledger itself is deliberately not a versioned migration: it has to exist
 * before any migration can be recorded. Every run executes this `IF NOT EXISTS`
 * statement, so a clean database self-initializes on first use.
 *
 * `applied_by` defaults to the database role, and the checksum constraint
 * rejects a row that was not written by the runner.
 */
export const MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0,
  applied_by text NOT NULL DEFAULT current_user,
  CONSTRAINT ${MIGRATION_LEDGER_TABLE}_checksum_sha256 CHECK (checksum ~ '^[0-9a-f]{64}$')
)`;

export async function ensureMigrationLedger(executor: SqlExecutor): Promise<void> {
  await executor.execute(MIGRATION_LEDGER_DDL);
}

export async function migrationLedgerExists(executor: SqlExecutor): Promise<boolean> {
  const rows = await executor.query<{ table_name: string | null }>(
    'SELECT to_regclass($1)::text AS table_name',
    [MIGRATION_LEDGER_TABLE],
  );
  return rows[0]?.table_name != null;
}

/**
 * Reads applied migrations in version order. A database whose ledger has not
 * been bootstrapped yet reports no applied migrations rather than failing, so
 * `status` stays read-only against a clean database.
 */
export async function readAppliedMigrations(executor: SqlExecutor): Promise<AppliedMigration[]> {
  if (!(await migrationLedgerExists(executor))) {
    return [];
  }

  const rows = await executor.query(
    `SELECT name, checksum, applied_at, duration_ms FROM ${MIGRATION_LEDGER_TABLE} ORDER BY name`,
  );

  return rows.map((row) => {
    const parsed = MigrationLedgerRowSchema.parse(row);
    return AppliedMigrationSchema.parse({
      name: parsed.name,
      checksum: parsed.checksum,
      appliedAt: parsed.applied_at.toISOString(),
      durationMs: parsed.duration_ms,
    });
  });
}

export async function recordMigration(
  executor: SqlExecutor,
  entry: AppliedMigration,
): Promise<void> {
  await executor.query(
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (name, checksum, applied_at, duration_ms) VALUES ($1, $2, $3, $4)`,
    [entry.name, entry.checksum, new Date(entry.appliedAt), entry.durationMs],
  );
}
