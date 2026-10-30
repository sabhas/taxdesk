import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MIGRATION_MANIFEST_FILE,
  parseMigrationManifest,
  verifyMigrationManifest,
} from './manifest.js';
import { DirectoryMigrationSource, loadMigrations } from './source.js';

/**
 * Guards the real migrations directory. This test runs as part of `pnpm test`,
 * which is the quality gate CI executes, so an edited historical migration or an
 * unrecorded new migration fails the build without needing a database.
 */
const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function loadCommitted() {
  const files = await loadMigrations(new DirectoryMigrationSource(migrationsDirectory));
  const manifest = parseMigrationManifest(
    await readFile(join(migrationsDirectory, MIGRATION_MANIFEST_FILE), 'utf8'),
  );
  return { files, manifest };
}

describe('committed migrations', () => {
  it('records every committed migration in the checksum manifest', async () => {
    const { files, manifest } = await loadCommitted();
    const verification = verifyMigrationManifest(files, manifest);

    expect(files.length).toBeGreaterThan(0);
    expect(verification.added).toEqual([]);
    expect(verification.recorded).toBe(files.length);
  });

  it('starts with a valid, checksummed baseline migration', async () => {
    const { files } = await loadCommitted();
    const baseline = files[0];

    expect(baseline?.name).toBe('0001_initial_baseline.sql');
    expect(baseline?.version).toBe(1);
    expect(baseline?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
