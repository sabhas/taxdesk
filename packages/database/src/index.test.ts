import { describe, expect, it, vi } from 'vitest';
import { createDatabaseClient } from './index.js';

vi.mock('postgres', () => {
  const mockClient = { end: vi.fn() };
  const mockPostgres = vi.fn(() => mockClient);
  return { default: mockPostgres };
});

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({ mockDb: true })),
}));

describe('createDatabaseClient', () => {
  it('requires a connection string', () => {
    expect(() => createDatabaseClient('')).toThrow('A PostgreSQL connection string is required.');
  });

  it('creates a database client from a connection string', () => {
    const db = createDatabaseClient('postgres://user:password@localhost:5432/taxdesk');
    expect(db).toEqual({ mockDb: true });
  });
});
