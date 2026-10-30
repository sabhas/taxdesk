import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeMigrationChecksum, normalizeMigrationSql } from './checksum.js';

describe('computeMigrationChecksum', () => {
  it('produces the SHA-256 hex digest of the contents', () => {
    const sql = 'SELECT 1;\n';
    const expected = createHash('sha256').update(sql, 'utf8').digest('hex');
    expect(computeMigrationChecksum(sql)).toBe(expected);
    expect(computeMigrationChecksum(sql)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats CRLF and LF line endings as identical', () => {
    expect(computeMigrationChecksum('a\r\nb\r\n')).toBe(computeMigrationChecksum('a\nb\n'));
  });

  it('changes for any edit, including whitespace', () => {
    expect(computeMigrationChecksum('SELECT 1;')).not.toBe(computeMigrationChecksum('SELECT 2;'));
    expect(computeMigrationChecksum('SELECT 1;')).not.toBe(computeMigrationChecksum('SELECT 1; '));
    expect(computeMigrationChecksum('SELECT 1;')).not.toBe(
      computeMigrationChecksum('-- SELECT 1;'),
    );
  });

  it('normalizes only line endings', () => {
    expect(normalizeMigrationSql('a\r\nb')).toBe('a\nb');
    expect(normalizeMigrationSql('a\nb')).toBe('a\nb');
  });
});
