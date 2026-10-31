import { describe, expect, it, vi } from 'vitest';
import {
  collectDatabasePosture,
  connectionRequiresTls,
  evaluateDatabasePosture,
  resolvePostureSslMode,
  type DatabasePrivilegeRow,
} from './database-posture.js';

function row(overrides: Partial<DatabasePrivilegeRow> = {}): DatabasePrivilegeRow {
  return {
    tls_in_use: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    owns_database: false,
    ...overrides,
  };
}

const CONNECTION = 'postgres://application:not-logged@db.internal:5432/taxdesk?sslmode=require';

describe('connectionRequiresTls', () => {
  it('requires TLS for require, verify, and unspecified modes', () => {
    expect(connectionRequiresTls('postgres://h/db?sslmode=require')).toBe(true);
    expect(connectionRequiresTls('postgres://h/db?sslmode=verify-full')).toBe(true);
    expect(connectionRequiresTls('postgres://h/db')).toBe(true);
  });

  it('rejects plaintext modes', () => {
    expect(connectionRequiresTls('postgres://db?sslmode=disable')).toBe(false);
    expect(connectionRequiresTls('postgres://db?sslmode=allow')).toBe(false);
  });
});

describe('resolveSslMode', () => {
  it('never downgrades by default, even for sslmode=disable', () => {
    expect(resolvePostureSslMode('postgres://h/db?sslmode=disable')).toBe('require');
  });

  it('allows plaintext only when a local inspection is explicitly requested', () => {
    expect(resolvePostureSslMode('postgres://h/db?sslmode=disable', true)).toBe(false);
  });
});

describe('evaluateDatabasePosture', () => {
  it('passes a TLS connection and a least-privilege role', () => {
    const report = evaluateDatabasePosture(row(), CONNECTION);
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
    expect(report.privileges).toMatchObject({
      tlsInUse: true,
      connectionRequiresTls: true,
      roleIsSuperuser: false,
      roleOwnsDatabase: false,
    });
  });

  it('fails when the session is not using TLS', () => {
    const report = evaluateDatabasePosture(row({ tls_in_use: false }), CONNECTION);
    expect(report.failed).toEqual(['DATABASE_TLS_IN_USE']);
  });

  it('fails when the connection permits plaintext', () => {
    const report = evaluateDatabasePosture(row(), 'postgres://db?sslmode=disable');
    expect(report.failed).toEqual(['DATABASE_TLS_ENFORCED']);
  });

  it.each([
    ['superuser', { rolsuper: true }],
    ['createdb', { rolcreatedb: true }],
    ['createrole', { rolcreaterole: true }],
    ['replication', { rolreplication: true }],
    ['bypassrls', { rolbypassrls: true }],
  ] as const)('fails when the role has the %s attribute', (_name, override) => {
    const report = evaluateDatabasePosture(row(override), CONNECTION);
    expect(report.failed).toEqual(['DATABASE_ROLE_LEAST_PRIVILEGE']);
  });

  it('fails when the application role owns the database', () => {
    const report = evaluateDatabasePosture(row({ owns_database: true }), CONNECTION);
    expect(report.failed).toEqual(['DATABASE_ROLE_NOT_OWNER']);
  });

  it('never includes connection details or role names in the report', () => {
    const report = evaluateDatabasePosture(row(), CONNECTION);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('not-logged');
    expect(serialized).not.toContain('postgres://');
  });
});

describe('collectDatabasePosture', () => {
  it('reads the live row with TLS required and evaluates it', async () => {
    const readRow = vi.fn().mockResolvedValue(row());
    const report = await collectDatabasePosture(CONNECTION, { readRow });
    expect(readRow).toHaveBeenCalledWith(CONNECTION, 'require');
    expect(report.ok).toBe(true);
  });

  it('uses plaintext only when local inspection is explicitly allowed', async () => {
    const readRow = vi.fn().mockResolvedValue(row({ tls_in_use: false }));
    const report = await collectDatabasePosture('postgres://db?sslmode=disable', {
      readRow,
      allowInsecureLocal: true,
    });
    expect(readRow).toHaveBeenCalledWith('postgres://db?sslmode=disable', false);
    expect(report.failed).toEqual(
      expect.arrayContaining(['DATABASE_TLS_IN_USE', 'DATABASE_TLS_ENFORCED']),
    );
  });

  it('fails closed when the query returns no row', async () => {
    const readRow = vi.fn().mockRejectedValue(new Error('query returned no rows'));
    await expect(collectDatabasePosture(CONNECTION, { readRow })).rejects.toThrow(
      'query returned no rows',
    );
  });
});
