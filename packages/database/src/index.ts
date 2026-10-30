import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type Database = ReturnType<typeof createDatabaseClient>;

/**
 * Creates the PostgreSQL client used by repositories.
 *
 * The connection string comes from a Cloudflare Hyperdrive binding, which
 * pools connections and requires TLS to the managed database. `ssl: 'require'`
 * keeps that guarantee explicit in application code, and `prepare: false`
 * keeps the client compatible with Hyperdrive's connection pooling proxy.
 */
export function createDatabaseClient(connectionString: string) {
  if (!connectionString) {
    throw new Error('A PostgreSQL connection string is required.');
  }
  const client = postgres(connectionString, { prepare: false, ssl: 'require' });
  return drizzle(client);
}
