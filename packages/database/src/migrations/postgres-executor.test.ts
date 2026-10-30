import { describe, expect, it } from 'vitest';
import { createPostgresExecutor, resolveSslMode } from './postgres-executor.js';

describe('resolveSslMode', () => {
  it('requires TLS by default so staging and production cannot downgrade', () => {
    expect(resolveSslMode('postgres://app:secret@db.internal.example:5432/taxdesk')).toBe(
      'require',
    );
    expect(resolveSslMode('postgres://app:secret@db:5432/taxdesk?sslmode=require')).toBe('require');
    expect(resolveSslMode('postgres://app:secret@db:5432/taxdesk?sslmode=prefer')).toBe('require');
    expect(resolveSslMode('not-a-valid-url')).toBe('require');
  });

  it('only opts out for an explicit sslmode=disable', () => {
    expect(resolveSslMode('postgres://app:secret@localhost:5432/taxdesk?sslmode=disable')).toBe(
      false,
    );
  });
});

describe('createPostgresExecutor', () => {
  it('requires a connection string', () => {
    expect(() => createPostgresExecutor('')).toThrow(
      'A PostgreSQL connection string is required to run migrations.',
    );
  });
});
