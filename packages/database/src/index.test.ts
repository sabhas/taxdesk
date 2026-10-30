import { describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
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

  it('requires TLS and disables prepared statements for Hyperdrive pooling', () => {
    const connectionString = 'postgres://user:password@localhost:5432/taxdesk';
    createDatabaseClient(connectionString);
    expect(vi.mocked(postgres)).toHaveBeenCalledWith(connectionString, {
      prepare: false,
      ssl: 'require',
    });
  });
});
