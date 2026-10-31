import postgres from 'postgres';
import { z } from 'zod';
import {
  DatabasePrivilegesSchema,
  type CheckResult,
  type DatabasePrivileges,
} from './contracts.js';

/**
 * A row read from PostgreSQL. The query returns only booleans; no role name,
 * host, database name, or credential is selected or logged.
 */
export const DatabasePrivilegeRowSchema = z
  .object({
    tls_in_use: z.boolean().nullable(),
    rolsuper: z.boolean(),
    rolcreatedb: z.boolean(),
    rolcreaterole: z.boolean(),
    rolreplication: z.boolean(),
    rolbypassrls: z.boolean(),
    owns_database: z.boolean(),
  })
  .strict();

export type DatabasePrivilegeRow = z.infer<typeof DatabasePrivilegeRowSchema>;

export interface DatabasePostureReport {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly failed: string[];
  readonly privileges: DatabasePrivileges;
}

export interface DatabasePostureOptions {
  /** Allow `sslmode=disable` so an operator can inspect a local throwaway database. */
  readonly allowInsecureLocal?: boolean;
  /** Query injection used by tests; production uses the PostgreSQL query below. */
  readonly readRow?: (
    connectionString: string,
    ssl: 'require' | false,
  ) => Promise<DatabasePrivilegeRow>;
}

/**
 * Reports whether the connection string requires TLS.
 *
 * `disable` and `allow` explicitly permit plaintext; every other mode, including
 * an absent mode, is treated as requiring TLS because the application passes
 * `ssl: 'require'` to the PostgreSQL client.
 */
export function connectionRequiresTls(connectionString: string): boolean {
  try {
    const mode = new URL(connectionString).searchParams.get('sslmode');
    return mode !== 'disable' && mode !== 'allow';
  } catch {
    return true;
  }
}

/**
 * Resolves the TLS mode used by the posture check.
 *
 * Staging must never downgrade silently. `sslmode=disable` is honored only when
 * the caller explicitly opts into inspecting a local database.
 */
export function resolvePostureSslMode(
  connectionString: string,
  allowInsecureLocal = false,
): 'require' | false {
  return connectionRequiresTls(connectionString) || !allowInsecureLocal ? 'require' : false;
}

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

/** Evaluates a live database row against TLS and least-privilege requirements. */
export function evaluateDatabasePosture(
  row: DatabasePrivilegeRow,
  connectionString: string,
): DatabasePostureReport {
  const privileges: DatabasePrivileges = DatabasePrivilegesSchema.parse({
    tlsInUse: row.tls_in_use === true,
    connectionRequiresTls: connectionRequiresTls(connectionString),
    roleIsSuperuser: row.rolsuper,
    roleCanCreateDatabases: row.rolcreatedb,
    roleCanCreateRoles: row.rolcreaterole,
    roleCanReplicate: row.rolreplication,
    roleBypassesRowLevelSecurity: row.rolbypassrls,
    roleOwnsDatabase: row.owns_database,
  });

  const leastPrivilege =
    !privileges.roleIsSuperuser &&
    !privileges.roleCanCreateDatabases &&
    !privileges.roleCanCreateRoles &&
    !privileges.roleCanReplicate &&
    !privileges.roleBypassesRowLevelSecurity;

  const checks: CheckResult[] = [
    check(
      'DATABASE_TLS_IN_USE',
      privileges.tlsInUse,
      privileges.tlsInUse
        ? 'The database session is using TLS.'
        : 'The database session is not using TLS.',
    ),
    check(
      'DATABASE_TLS_ENFORCED',
      privileges.connectionRequiresTls,
      privileges.connectionRequiresTls
        ? 'The connection string requires TLS.'
        : 'The connection string permits plaintext.',
    ),
    check(
      'DATABASE_ROLE_LEAST_PRIVILEGE',
      leastPrivilege,
      leastPrivilege
        ? 'The application role has no elevated attributes.'
        : 'The application role has elevated attributes (superuser, createdb, createrole, replication, or bypassrls).',
    ),
    check(
      'DATABASE_ROLE_NOT_OWNER',
      !privileges.roleOwnsDatabase,
      privileges.roleOwnsDatabase
        ? 'The application role owns the database; use a separate owner role.'
        : 'The application role does not own the database.',
    ),
  ];

  const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  return { ok: failed.length === 0, checks, failed, privileges };
}

async function readDatabasePrivilegeRow(
  connectionString: string,
  ssl: 'require' | false,
): Promise<DatabasePrivilegeRow> {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    ssl,
    connect_timeout: 10,
    idle_timeout: 5,
  });

  try {
    const rows = await client.unsafe<DatabasePrivilegeRow[]>(`
      select
        (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as tls_in_use,
        r.rolsuper,
        r.rolcreatedb,
        r.rolcreaterole,
        r.rolreplication,
        r.rolbypassrls,
        (d.datdba = r.oid) as owns_database
      from pg_roles r
      join pg_database d on d.datname = current_database()
      where r.rolname = current_user
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('The database posture query returned no rows.');
    }
    return DatabasePrivilegeRowSchema.parse(row);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Reads and evaluates live staging database posture. The report never contains
 * the connection string, role name, host, or database name.
 */
export async function collectDatabasePosture(
  connectionString: string,
  options: DatabasePostureOptions = {},
): Promise<DatabasePostureReport> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the database posture check.');
  }
  const ssl = resolvePostureSslMode(connectionString, options.allowInsecureLocal ?? false);
  const readRow = options.readRow ?? readDatabasePrivilegeRow;
  const row = await readRow(connectionString, ssl);
  return evaluateDatabasePosture(row, connectionString);
}
