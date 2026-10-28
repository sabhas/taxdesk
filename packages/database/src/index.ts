import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type Database = ReturnType<typeof createDatabaseClient>;

export function createDatabaseClient(connectionString: string) {
  if (!connectionString) {
    throw new Error('A PostgreSQL connection string is required.');
  }
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client);
}
