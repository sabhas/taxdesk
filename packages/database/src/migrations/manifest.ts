import {
  MigrationManifestSchema,
  type MigrationManifest,
  type MigrationFileSummary,
} from './contracts.js';
import { MigrationChecksumError, MigrationHistoryError, MigrationManifestError } from './errors.js';
import type { MigrationFile } from './source.js';

/** Manifest used before the first migration is recorded. */
export const EMPTY_MIGRATION_MANIFEST: MigrationManifest = { version: 1, migrations: [] };

/** Name of the committed manifest file inside the migrations directory. */
export const MIGRATION_MANIFEST_FILE = 'manifest.json';

export function parseMigrationManifest(json: string): MigrationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MigrationManifestError(
      `The migration manifest (${MIGRATION_MANIFEST_FILE}) is not valid JSON.`,
    );
  }

  const result = MigrationManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new MigrationManifestError(
      `The migration manifest (${MIGRATION_MANIFEST_FILE}) is invalid: ${detail}`,
    );
  }
  return result.data;
}

export function serializeMigrationManifest(manifest: MigrationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface ManifestVerification {
  readonly files: number;
  readonly recorded: number;
  /** Local migrations not yet recorded; empty means the manifest is in sync. */
  readonly added: readonly string[];
}

/**
 * Compares the local migration files with the committed checksum manifest.
 *
 * A mismatch means a historical migration was edited, and a manifest entry
 * without a local file means history was deleted. Both are hard failures: an
 * applied migration is immutable and can only be superseded by a new,
 * compensating forward migration.
 */
export function verifyMigrationManifest(
  files: readonly MigrationFile[],
  manifest: MigrationManifest,
): ManifestVerification {
  const local = new Map(files.map((file) => [file.name, file.checksum]));
  const recorded = new Map(manifest.migrations.map((entry) => [entry.name, entry.checksum]));

  for (const [name, checksum] of recorded) {
    const localChecksum = local.get(name);
    if (localChecksum === undefined) {
      throw new MigrationHistoryError(
        `Migration "${name}" is recorded in the manifest but missing from the migrations directory. ` +
          'Migrations are forward-only: restore the file or add a compensating migration instead of deleting it.',
      );
    }
    if (localChecksum !== checksum) {
      throw new MigrationChecksumError(name, checksum, localChecksum);
    }
  }

  const added = files.filter((file) => !recorded.has(file.name)).map((file) => file.name);
  return { files: files.length, recorded: recorded.size, added };
}

export interface ManifestUpdate {
  readonly manifest: MigrationManifest;
  readonly added: readonly MigrationFileSummary[];
}

/**
 * Adds newly discovered migrations to the manifest without ever rewriting or
 * removing an existing entry. `verifyMigrationManifest` runs first, so an edited
 * historical migration is refused even by the command that writes the manifest.
 */
export function planManifestUpdate(
  files: readonly MigrationFile[],
  manifest: MigrationManifest,
): ManifestUpdate {
  const verification = verifyMigrationManifest(files, manifest);
  if (verification.added.length === 0) {
    return { manifest, added: [] };
  }

  const appended = files
    .filter((file) => verification.added.includes(file.name))
    .map((file) => ({ name: file.name, checksum: file.checksum }));

  return {
    manifest: { version: 1, migrations: [...manifest.migrations, ...appended] },
    added: appended,
  };
}
