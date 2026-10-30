import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeMigrationChecksum } from './checksum.js';
import { MigrationFileError } from './errors.js';
import { DirectoryMigrationSource, loadMigrations } from './source.js';
import { InMemoryMigrationSource } from './test-doubles.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'taxdesk-migrations-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('loadMigrations', () => {
  it('orders migrations by numeric version, not lexicographically', async () => {
    const source = new InMemoryMigrationSource({
      '0010_ten.sql': 'SELECT 10;',
      '0002_two.sql': 'SELECT 2;',
      '0001_one.sql': 'SELECT 1;',
    });

    const files = await loadMigrations(source);
    expect(files.map((file) => file.name)).toEqual([
      '0001_one.sql',
      '0002_two.sql',
      '0010_ten.sql',
    ]);
    expect(files.map((file) => file.version)).toEqual([1, 2, 10]);
    expect(files[0]?.checksum).toBe(computeMigrationChecksum('SELECT 1;'));
  });

  it('fails closed on an unversioned or malformed SQL file', async () => {
    const source = new InMemoryMigrationSource({ 'initial.sql': 'SELECT 1;' });
    await expect(loadMigrations(source)).rejects.toBeInstanceOf(MigrationFileError);
    await expect(loadMigrations(source)).rejects.toThrow(/initial\.sql/);
  });

  it('rejects two migrations that share a version prefix', async () => {
    const source = new InMemoryMigrationSource({
      '0001_first.sql': 'SELECT 1;',
      '0001_second.sql': 'SELECT 2;',
    });
    await expect(loadMigrations(source)).rejects.toThrow(/Duplicate migration version 1/);
  });

  it('returns an empty list for an empty directory', async () => {
    await expect(loadMigrations(new InMemoryMigrationSource({}))).resolves.toEqual([]);
  });
});

describe('DirectoryMigrationSource', () => {
  it('reads only .sql files from the directory', async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;', 'utf8');
    await writeFile(join(directory, 'README.md'), 'not a migration', 'utf8');
    await writeFile(join(directory, 'notes.txt'), 'not a migration', 'utf8');

    const source = new DirectoryMigrationSource(directory);
    expect(await source.list()).toEqual(['0001_first.sql']);
    expect(await source.read('0001_first.sql')).toBe('SELECT 1;');

    const files = await loadMigrations(source);
    expect(files.map((file) => file.name)).toEqual(['0001_first.sql']);
  });
});
