import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// The migration runner is exposed as `@taxdesk/database/migrations`, not from
// this entry point: it uses Node-only `fs`/`crypto` APIs that must not leak into
// the Worker-facing client.

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

/** A single row returned by a repository query. */
export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  query<Row extends SqlRow>(text: string, parameters?: readonly unknown[]): Promise<Row[]>;
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqlExecutorOptions {
  /**
   * Defaults to `true`. Only local, disposable databases may pass `false`;
   * production and staging always use TLS, matching `createDatabaseClient`.
   */
  readonly requireTls?: boolean;
  readonly maxConnections?: number;
}

function wrap(client: postgres.Sql): SqlExecutor {
  const make = (
    source: postgres.Sql | postgres.TransactionSql<Record<string, never>>,
    isRoot: boolean,
  ): SqlExecutor => ({
    query: async <Row extends SqlRow>(
      text: string,
      parameters: readonly unknown[] = [],
    ): Promise<Row[]> => {
      return await source.unsafe<Row[]>(text, parameters as never[]);
    },
    transaction: async <T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> => {
      if (!isRoot) {
        throw new Error('Nested transactions are not supported; use the outer transaction.');
      }
      const result = await client.begin(
        async (transaction) => await work(make(transaction, false)),
      );
      return result as T;
    },
    close: async () => {
      if (isRoot) {
        await client.end({ timeout: 5 });
      }
    },
  });
  return make(client, true);
}

/**
 * Creates the request-scoped SQL executor used by repositories. The Worker
 * creates one per API request and closes it afterwards; Hyperdrive owns the
 * cross-request pooling.
 */
export function createSqlExecutor(
  connectionString: string,
  options: SqlExecutorOptions = {},
): SqlExecutor {
  if (!connectionString) {
    throw new Error('A PostgreSQL connection string is required.');
  }
  const client = postgres(connectionString, {
    prepare: false,
    ssl: options.requireTls === false ? false : 'require',
    max: options.maxConnections ?? 5,
  });
  return wrap(client);
}
