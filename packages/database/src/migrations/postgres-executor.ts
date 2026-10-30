import postgres from 'postgres';

/** A parameter the migration runner may bind. Deliberately narrow. */
export type SqlParameter = string | number | boolean | Date | null;

/**
 * Minimal database port used by the migration runner.
 *
 * Keeping the runner behind this port makes checksum, ordering, locking, and
 * rollback behavior unit-testable without a live database, while the real
 * implementation below stays a thin wrapper over `postgres`.
 */
export interface SqlExecutor {
  /** Runs a SQL script that may contain multiple statements, with no parameters. */
  execute(script: string): Promise<void>;
  /** Runs a parameterized single statement and returns its rows. */
  query<TRow = Record<string, unknown>>(
    statement: string,
    params?: readonly SqlParameter[],
  ): Promise<TRow[]>;
  /** Runs `work` in a transaction on a single connection. */
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Executor that owns a connection and can be closed after a migration run. */
export interface MigrationDatabase extends SqlExecutor {
  close(): Promise<void>;
}

/**
 * Resolves the TLS mode for a migration connection.
 *
 * Staging and production must use TLS, so the default is `require`. A local
 * developer running an untrusted-throwaway database can opt out explicitly with
 * `sslmode=disable` in the connection string. Any other value keeps TLS on.
 */
export function resolveSslMode(connectionString: string): 'require' | false {
  try {
    return new URL(connectionString).searchParams.get('sslmode') === 'disable' ? false : 'require';
  } catch {
    return 'require';
  }
}

function wrapQueryable(queryable: postgres.ISql): Omit<SqlExecutor, 'transaction'> {
  return {
    async execute(script: string): Promise<void> {
      await queryable.unsafe(script).simple();
    },
    async query<TRow>(statement: string, params: readonly SqlParameter[] = []): Promise<TRow[]> {
      const rows = await queryable.unsafe<TRow[]>(statement, [...params]);
      return [...rows];
    },
  };
}

/**
 * Creates the PostgreSQL executor used by the migration CLI.
 *
 * `max: 1` pins the whole run to a single session so the session-level advisory
 * lock taken by the runner is guaranteed to be released by the same connection.
 * `prepare: false` keeps the connection compatible with Hyperdrive pooling, and
 * TLS is required unless the connection string explicitly disables it for a
 * local database.
 */
export function createPostgresExecutor(connectionString: string): MigrationDatabase {
  if (!connectionString) {
    throw new Error('A PostgreSQL connection string is required to run migrations.');
  }

  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    ssl: resolveSslMode(connectionString),
  });

  return {
    ...wrapQueryable(client),
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      // `begin` types its result as `UnwrapPromiseArray<T>`; the runner only ever
      // returns a plain value from `work`, so narrowing back to `T` is safe.
      const result = await client.begin(async (tx) => work(wrapQueryable(tx) as SqlExecutor));
      return result as T;
    },
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}
