import { describe, expect, it } from 'vitest';
import {
  AppliedMigrationSchema,
  MigrationChecksumSchema,
  MigrationLedgerRowSchema,
  MigrationManifestSchema,
  MigrationNameSchema,
  MigrationReportSchema,
  migrationVersion,
} from './contracts.js';

const CHECKSUM = 'a'.repeat(64);

describe('MigrationNameSchema', () => {
  it('accepts zero-padded snake_case SQL files', () => {
    for (const name of ['0001_initial_baseline.sql', '0012_add_client_search_index.sql']) {
      expect(MigrationNameSchema.safeParse(name).success).toBe(true);
      expect(migrationVersion(name)).toBe(Number.parseInt(name.slice(0, 4), 10));
    }
  });

  it('rejects names that would be ambiguous or unversioned', () => {
    const invalid = [
      'initial.sql',
      '0001-initial.sql',
      '0001_Initial.sql',
      '0001_initial.SQL',
      '1_initial.sql',
      '0001_.sql',
      '../0001_escape.sql',
      '0001_initial.sql.bak',
      '',
    ];
    for (const name of invalid) {
      expect(MigrationNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe('MigrationChecksumSchema', () => {
  it('accepts lowercase SHA-256 hex only', () => {
    expect(MigrationChecksumSchema.safeParse(CHECKSUM).success).toBe(true);
    expect(MigrationChecksumSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(MigrationChecksumSchema.safeParse('abc123').success).toBe(false);
  });
});

describe('MigrationLedgerRowSchema', () => {
  it('coerces database timestamps and integer durations', () => {
    const parsed = MigrationLedgerRowSchema.parse({
      name: '0001_initial_baseline.sql',
      checksum: CHECKSUM,
      applied_at: '2026-01-02T03:04:05.000Z',
      duration_ms: '12',
    });
    expect(parsed.applied_at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(parsed.duration_ms).toBe(12);
  });

  it('rejects unknown columns and negative durations', () => {
    const base = {
      name: '0001_initial_baseline.sql',
      checksum: CHECKSUM,
      applied_at: new Date(),
      duration_ms: 1,
    };
    expect(MigrationLedgerRowSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(MigrationLedgerRowSchema.safeParse({ ...base, duration_ms: -1 }).success).toBe(false);
    expect(MigrationLedgerRowSchema.safeParse({ ...base, checksum: 'nope' }).success).toBe(false);
  });
});

describe('AppliedMigrationSchema', () => {
  it('requires an ISO-8601 UTC timestamp', () => {
    const valid = {
      name: '0001_initial_baseline.sql',
      checksum: CHECKSUM,
      appliedAt: '2026-01-02T03:04:05.000Z',
      durationMs: 0,
    };
    expect(AppliedMigrationSchema.safeParse(valid).success).toBe(true);
    expect(AppliedMigrationSchema.safeParse({ ...valid, appliedAt: '2026-01-02' }).success).toBe(
      false,
    );
    expect(AppliedMigrationSchema.safeParse({ ...valid, durationMs: 1.5 }).success).toBe(false);
  });
});

describe('MigrationManifestSchema', () => {
  it('accepts the strict version 1 manifest shape', () => {
    const parsed = MigrationManifestSchema.parse({
      version: 1,
      migrations: [{ name: '0001_initial_baseline.sql', checksum: CHECKSUM }],
    });
    expect(parsed.migrations).toHaveLength(1);
  });

  it('rejects an unknown version or unknown keys', () => {
    expect(MigrationManifestSchema.safeParse({ version: 2, migrations: [] }).success).toBe(false);
    expect(
      MigrationManifestSchema.safeParse({ version: 1, migrations: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe('MigrationReportSchema', () => {
  it('accepts a status report and rejects a mismatched command', () => {
    expect(
      MigrationReportSchema.safeParse({
        command: 'status',
        status: 'pending',
        applied: [],
        pending: [{ name: '0002_next.sql', checksum: CHECKSUM }],
      }).success,
    ).toBe(true);

    expect(
      MigrationReportSchema.safeParse({
        command: 'status',
        status: 'pending',
        applied: [],
        pending: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
