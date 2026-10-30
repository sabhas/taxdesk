import {
  MigrationPlanSchema,
  migrationVersion,
  type AppliedMigration,
  type MigrationFileSummary,
  type MigrationPlan,
} from './contracts.js';
import {
  MigrationChecksumError,
  MigrationExecutionError,
  MigrationHistoryError,
} from './errors.js';
import { ensureMigrationLedger, readAppliedMigrations, recordMigration } from './ledger.js';
import type { SqlExecutor } from './postgres-executor.js';
import { loadMigrations, type MigrationFile, type MigrationSource } from './source.js';

/**
 * Fixed advisory-lock key for "TaxDesk migrations". A second runner starts only
 * after the first releases the lock, so two concurrent deploys cannot apply the
 * same migration twice.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 780314159;

export interface MigrationRunResult {
  /** Newly applied migrations, in the order they were applied. */
  readonly applied: readonly AppliedMigration[];
  /** Pending migrations after the run; empty unless a migration failed. */
  readonly pending: readonly MigrationFileSummary[];
}

export interface MigrationRunOptions {
  readonly executor: SqlExecutor;
  readonly source: MigrationSource;
  /** Injectable clock so tests can assert deterministic durations. */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

function summaryOf(file: MigrationFile): MigrationFileSummary {
  return { name: file.name, checksum: file.checksum };
}

/**
 * Reconciles applied history with the local migration files.
 *
 * Checksum drift and missing files mean history was edited; a pending file below
 * the latest applied version means history was reordered. All three fail closed
 * because a partially trusted history is worse than a stopped deploy.
 */
export function verifyMigrationHistory(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  const local = new Map(files.map((file) => [file.name, file.checksum]));
  const appliedNames = new Set(applied.map((entry) => entry.name));

  let highestAppliedVersion = 0;
  for (const entry of applied) {
    highestAppliedVersion = Math.max(highestAppliedVersion, migrationVersion(entry.name));

    const localChecksum = local.get(entry.name);
    if (localChecksum === undefined) {
      throw new MigrationHistoryError(
        `Migration "${entry.name}" is recorded as applied but missing from the migrations directory. ` +
          'Migrations are forward-only: restore the file or add a compensating migration instead of deleting it.',
      );
    }
    if (localChecksum !== entry.checksum) {
      throw new MigrationChecksumError(entry.name, entry.checksum, localChecksum);
    }
  }

  const outOfOrder = files.filter(
    (file) => !appliedNames.has(file.name) && file.version < highestAppliedVersion,
  );
  if (outOfOrder.length > 0) {
    const names = outOfOrder.map((file) => file.name).join(', ');
    throw new MigrationHistoryError(
      `Pending migration(s) ${names} have a lower version than the latest applied migration. ` +
        'Migrations are applied in version order; insert history with a new compensating migration instead.',
      'MIGRATION_HISTORY_OUT_OF_ORDER',
    );
  }
}

/** Reads the current applied/pending plan without writing to the database. */
export async function planMigrations(
  options: Pick<MigrationRunOptions, 'executor' | 'source'>,
): Promise<MigrationPlan> {
  const { executor, source } = options;
  const files = await loadMigrations(source);
  const applied = await readAppliedMigrations(executor);
  verifyMigrationHistory(files, applied);

  const appliedNames = new Set(applied.map((entry) => entry.name));
  const pending = files.filter((file) => !appliedNames.has(file.name)).map(summaryOf);

  return MigrationPlanSchema.parse({ applied, pending });
}

/**
 * Applies every pending migration in version order.
 *
 * The run takes a session advisory lock, bootstraps the ledger, verifies history,
 * then applies each pending file in its own transaction together with its ledger
 * row. A failure rolls back both the schema change and its ledger entry, so a
 * re-run is safe and never records a half-applied migration.
 */
export async function runMigrations(options: MigrationRunOptions): Promise<MigrationRunResult> {
  const { executor, source, now = Date.now, log = () => undefined } = options;

  await executor.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    await ensureMigrationLedger(executor);

    const files = await loadMigrations(source);
    const applied = await readAppliedMigrations(executor);
    verifyMigrationHistory(files, applied);

    const appliedNames = new Set(applied.map((entry) => entry.name));
    const pendingFiles = files.filter((file) => !appliedNames.has(file.name));
    const newlyApplied: AppliedMigration[] = [];

    for (const file of pendingFiles) {
      const startedAt = now();
      log(`Applying migration ${file.name}`);
      let entry: AppliedMigration = {
        name: file.name,
        checksum: file.checksum,
        appliedAt: new Date(startedAt).toISOString(),
        durationMs: 0,
      };

      try {
        await executor.transaction(async (transaction) => {
          await transaction.execute(file.sql);
          entry = { ...entry, durationMs: Math.max(0, now() - startedAt) };
          await recordMigration(transaction, entry);
        });
      } catch (error) {
        throw new MigrationExecutionError(file.name, error);
      }

      newlyApplied.push(entry);
    }

    return {
      applied: newlyApplied,
      pending: files
        .filter(
          (file) => !appliedNames.has(file.name) && !newlyApplied.some((e) => e.name === file.name),
        )
        .map(summaryOf),
    };
  } finally {
    // The lock is session-scoped, so a dead connection releases it too; never let
    // a release failure mask the original migration error.
    await executor
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
      .catch(() => undefined);
  }
}
