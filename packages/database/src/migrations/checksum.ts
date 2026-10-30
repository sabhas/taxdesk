import { createHash } from 'node:crypto';

/**
 * Normalizes line endings before hashing. A Windows checkout with CRLF endings
 * must not look like an edited migration.
 */
export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

/**
 * Computes the SHA-256 checksum of a migration's contents. Every other
 * difference (whitespace, comments, statements) changes the checksum on
 * purpose: an applied migration's bytes are immutable history.
 */
export function computeMigrationChecksum(sql: string): string {
  return createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex');
}
