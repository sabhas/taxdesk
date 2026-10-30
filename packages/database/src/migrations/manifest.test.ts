import { describe, expect, it } from 'vitest';
import { computeMigrationChecksum } from './checksum.js';
import type { MigrationManifest } from './contracts.js';
import { MigrationChecksumError, MigrationHistoryError, MigrationManifestError } from './errors.js';
import {
  EMPTY_MIGRATION_MANIFEST,
  parseMigrationManifest,
  planManifestUpdate,
  serializeMigrationManifest,
  verifyMigrationManifest,
} from './manifest.js';
import { loadMigrations, type MigrationFile } from './source.js';
import { InMemoryMigrationSource } from './test-doubles.js';

async function files(entries: Record<string, string>): Promise<MigrationFile[]> {
  return await loadMigrations(new InMemoryMigrationSource(entries));
}

function manifestOf(entries: readonly { name: string; sql: string }[]): MigrationManifest {
  return {
    version: 1,
    migrations: entries.map((entry) => ({
      name: entry.name,
      checksum: computeMigrationChecksum(entry.sql),
    })),
  };
}

describe('parseMigrationManifest', () => {
  it('parses and round-trips a valid manifest', () => {
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    expect(parseMigrationManifest(serializeMigrationManifest(manifest))).toEqual(manifest);
  });

  it('rejects malformed JSON and invalid shapes', () => {
    expect(() => parseMigrationManifest('{')).toThrow(MigrationManifestError);
    expect(() => parseMigrationManifest('{"version":1,"migrations":"nope"}')).toThrow(
      MigrationManifestError,
    );
  });
});

describe('verifyMigrationManifest', () => {
  it('reports no additions when the manifest is in sync', async () => {
    const localFiles = await files({ '0001_one.sql': 'SELECT 1;' });
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    expect(verifyMigrationManifest(localFiles, manifest)).toEqual({
      files: 1,
      recorded: 1,
      added: [],
    });
  });

  it('reports a new, unrecorded migration as an addition', async () => {
    const localFiles = await files({
      '0001_one.sql': 'SELECT 1;',
      '0002_two.sql': 'SELECT 2;',
    });
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    expect(verifyMigrationManifest(localFiles, manifest).added).toEqual(['0002_two.sql']);
  });

  it('rejects an edited historical migration through checksums', async () => {
    const localFiles = await files({ '0001_one.sql': 'SELECT 1; -- edited' });
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);

    let error: unknown;
    try {
      verifyMigrationManifest(localFiles, manifest);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MigrationChecksumError);
    expect((error as MigrationChecksumError).migrationName).toBe('0001_one.sql');
    expect((error as MigrationChecksumError).message).toMatch(/forward-only/);
  });

  it('rejects a recorded migration whose file was deleted', async () => {
    const localFiles = await files({});
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    expect(() => verifyMigrationManifest(localFiles, manifest)).toThrow(MigrationHistoryError);
  });
});

describe('planManifestUpdate', () => {
  it('appends new migrations in version order without touching history', () => {
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    const localFiles = [
      {
        name: '0001_one.sql',
        checksum: computeMigrationChecksum('SELECT 1;'),
        version: 1,
        sql: '',
      },
      { name: '0002_two.sql', checksum: 'b'.repeat(64), version: 2, sql: '' },
      { name: '0003_three.sql', checksum: 'c'.repeat(64), version: 3, sql: '' },
    ];

    const update = planManifestUpdate(localFiles, manifest);
    expect(update.manifest.migrations.map((entry) => entry.name)).toEqual([
      '0001_one.sql',
      '0002_two.sql',
      '0003_three.sql',
    ]);
    expect(update.added.map((entry) => entry.name)).toEqual(['0002_two.sql', '0003_three.sql']);
    // The original manifest object is not mutated.
    expect(manifest.migrations).toHaveLength(1);
  });

  it('is a no-op when every file is already recorded', async () => {
    const localFiles = await files({ '0001_one.sql': 'SELECT 1;' });
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    const update = planManifestUpdate(localFiles, manifest);
    expect(update.added).toEqual([]);
    expect(update.manifest).toBe(manifest);
  });

  it('refuses to rewrite an edited historical migration', async () => {
    const localFiles = await files({ '0001_one.sql': 'SELECT 1; -- edited' });
    const manifest = manifestOf([{ name: '0001_one.sql', sql: 'SELECT 1;' }]);
    expect(() => planManifestUpdate(localFiles, manifest)).toThrow(MigrationChecksumError);
  });

  it('works from an empty manifest for the first migration', async () => {
    const localFiles = await files({ '0001_one.sql': 'SELECT 1;' });
    const update = planManifestUpdate(localFiles, EMPTY_MIGRATION_MANIFEST);
    expect(update.added.map((entry) => entry.name)).toEqual(['0001_one.sql']);
  });
});
