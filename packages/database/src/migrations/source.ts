import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeMigrationChecksum } from './checksum.js';
import { MigrationNameSchema, migrationVersion } from './contracts.js';
import { MigrationFileError } from './errors.js';

/** Where migration files are discovered and read from. */
export interface MigrationSource {
  list(): Promise<readonly string[]>;
  read(name: string): Promise<string>;
}

/** A discovered, validated, checksummed migration ready to apply. */
export interface MigrationFile {
  readonly name: string;
  readonly version: number;
  readonly checksum: string;
  readonly sql: string;
}

/** Reads migration files from a directory on disk. */
export class DirectoryMigrationSource implements MigrationSource {
  constructor(readonly directory: string) {}

  async list(): Promise<readonly string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((e) => e.name);
  }

  async read(name: string): Promise<string> {
    return await readFile(join(this.directory, name), 'utf8');
  }
}

/**
 * Loads every migration from a source in forward-only version order.
 *
 * Fails closed on anything ambiguous: an unversioned `.sql` file, a duplicate
 * version prefix, or an empty set of files when the source is unreadable. The
 * runner must never guess which database changes to apply.
 */
export async function loadMigrations(source: MigrationSource): Promise<MigrationFile[]> {
  const names = [...(await source.list())];
  const versions = new Map<number, string>();
  const files: MigrationFile[] = [];

  for (const name of names) {
    const parsedName = MigrationNameSchema.safeParse(name);
    if (!parsedName.success) {
      const reason = parsedName.error.issues[0]?.message ?? 'Unrecognized migration file.';
      throw new MigrationFileError(`Invalid migration file name "${name}": ${reason}`);
    }

    const version = migrationVersion(name);
    const duplicate = versions.get(version);
    if (duplicate !== undefined) {
      throw new MigrationFileError(
        `Duplicate migration version ${String(version)} in "${duplicate}" and "${name}". ` +
          'Give each migration its own version prefix.',
      );
    }
    versions.set(version, name);

    const sql = await source.read(name);
    files.push({ name, version, checksum: computeMigrationChecksum(sql), sql });
  }

  files.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  return files;
}
