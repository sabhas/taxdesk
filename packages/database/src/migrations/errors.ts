/**
 * Migration-specific error types.
 *
 * Messages name the affected migration only. They never embed SQL text,
 * connection strings, or credentials, so they are safe to print in CI and
 * operator logs.
 */

export type MigrationErrorCode =
  | 'MIGRATION_FILE_INVALID'
  | 'MIGRATION_HISTORY_INCOMPLETE'
  | 'MIGRATION_HISTORY_OUT_OF_ORDER'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_MANIFEST_INVALID'
  | 'MIGRATION_MANIFEST_INCOMPLETE'
  | 'MIGRATION_EXECUTION_FAILED';

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly code: MigrationErrorCode,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** A migration file name, ordering, or version is not valid. */
export class MigrationFileError extends MigrationError {
  constructor(message: string) {
    super(message, 'MIGRATION_FILE_INVALID');
    this.name = 'MigrationFileError';
  }
}

/** Applied history cannot be reconciled with the local migration files. */
export class MigrationHistoryError extends MigrationError {
  constructor(message: string, code: MigrationErrorCode = 'MIGRATION_HISTORY_INCOMPLETE') {
    super(message, code);
    this.name = 'MigrationHistoryError';
  }
}

/**
 * A migration that was already applied (or recorded in the manifest) no longer
 * matches its checksum, which means history was edited.
 */
export class MigrationChecksumError extends MigrationError {
  constructor(
    readonly migrationName: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `Migration "${migrationName}" has changed since it was recorded ` +
        `(expected ${short(expectedChecksum)}, found ${short(actualChecksum)}). ` +
        'Migrations are forward-only: add a new compensating migration instead of editing history.',
      'MIGRATION_CHECKSUM_MISMATCH',
    );
    this.name = 'MigrationChecksumError';
  }
}

/** The committed manifest is missing an entry or is otherwise unusable. */
export class MigrationManifestError extends MigrationError {
  constructor(message: string, code: MigrationErrorCode = 'MIGRATION_MANIFEST_INVALID') {
    super(message, code);
    this.name = 'MigrationManifestError';
  }
}

/** A migration's SQL failed; the transaction for that file was rolled back. */
export class MigrationExecutionError extends MigrationError {
  constructor(
    readonly migrationName: string,
    readonly reason: unknown,
  ) {
    super(
      `Migration "${migrationName}" failed and was rolled back: ${describe(reason)}`,
      'MIGRATION_EXECUTION_FAILED',
    );
    this.name = 'MigrationExecutionError';
  }
}

function short(checksum: string): string {
  return checksum.slice(0, 12);
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
