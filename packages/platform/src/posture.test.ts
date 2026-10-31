import { describe, expect, it } from 'vitest';
import { PlatformPostureEvidenceSchema, type PlatformPostureEvidence } from './contracts.js';
import { evaluatePlatformPosture } from './posture.js';

const NOW = new Date('2026-11-04T12:00:00Z');

function evidence(): PlatformPostureEvidence {
  return {
    schemaVersion: 1,
    environment: 'staging',
    recordedAt: '2026-11-04T11:00:00Z',
    recordedBy: 'Platform operator',
    databaseProvider: 'managed-postgres',
    database: {
      connectionUsesTls: true,
      tlsEnforcedByApplication: true,
      roleIsLeastPrivilege: true,
      roleIsDatabaseOwner: false,
    },
    pointInTimeRecovery: {
      enabled: true,
      retentionDays: 7,
      verifiedAt: '2026-11-03T11:00:00Z',
      method: 'provider-console',
    },
    independentExports: {
      enabled: true,
      provider: 'independent-object-store',
      storedOutsideDatabaseProvider: true,
      encrypted: true,
      cadenceHours: 24,
      lastSuccessAt: '2026-11-04T10:00:00Z',
      retentionDays: 30,
    },
    alerting: {
      configured: true,
      channel: 'operations-issue-queue',
      testedAt: '2026-11-03T11:00:00Z',
      testFailureAlerted: true,
    },
  };
}

describe('PlatformPostureEvidenceSchema', () => {
  it('accepts a complete, secret-free staging record', () => {
    expect(PlatformPostureEvidenceSchema.safeParse(evidence()).success).toBe(true);
  });

  it('rejects unknown fields so infrastructure details cannot be added accidentally', () => {
    const parsed = PlatformPostureEvidenceSchema.safeParse({
      ...evidence(),
      connectionString: 'postgres://app:secret@db.internal:5432/taxdesk',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a record for a non-staging environment', () => {
    const parsed = PlatformPostureEvidenceSchema.safeParse({
      ...evidence(),
      environment: 'production',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid timestamp and a nonsensical retention period', () => {
    expect(
      PlatformPostureEvidenceSchema.safeParse({ ...evidence(), recordedAt: 'yesterday' }).success,
    ).toBe(false);
    const invalidRetention = validWith((value) => {
      value.independentExports.retentionDays = 0;
    });
    expect(PlatformPostureEvidenceSchema.safeParse(invalidRetention).success).toBe(false);
  });
});

function validWith(mutate: (value: PlatformPostureEvidence) => void): PlatformPostureEvidence {
  const value = evidence();
  mutate(value);
  return value;
}

function allPassed(result: ReturnType<typeof evaluatePlatformPosture>): string[] {
  return result.checks.filter((entry) => entry.passed).map((entry) => entry.id);
}

describe('evaluatePlatformPosture', () => {
  it('passes every required control for fresh, complete evidence', () => {
    const result = evaluatePlatformPosture(evidence(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(allPassed(result)).toContain('HYPERDRIVE_TLS_ENFORCED');
    expect(allPassed(result)).toContain('PITR_ENABLED');
    expect(allPassed(result)).toContain('ALERTING_FAILURE_PROVEN');
  });

  it('fails closed when TLS is absent or not enforced by application code', () => {
    const value = validWith((entry) => {
      entry.database.connectionUsesTls = false;
      entry.database.tlsEnforcedByApplication = false;
    });
    const result = evaluatePlatformPosture(value, { now: NOW });
    expect(result.failed).toEqual(
      expect.arrayContaining(['HYPERDRIVE_TLS_IN_USE', 'HYPERDRIVE_TLS_ENFORCED']),
    );
  });

  it('fails when the application role is elevated or owns the database', () => {
    const value = validWith((entry) => {
      entry.database.roleIsLeastPrivilege = false;
      entry.database.roleIsDatabaseOwner = true;
    });
    const result = evaluatePlatformPosture(value, { now: NOW });
    expect(result.failed).toEqual(
      expect.arrayContaining(['DATABASE_ROLE_LEAST_PRIVILEGE', 'DATABASE_ROLE_NOT_OWNER']),
    );
  });

  it('fails when point-in-time recovery is disabled or its evidence is stale', () => {
    const disabled = validWith((entry) => {
      entry.pointInTimeRecovery.enabled = false;
    });
    expect(evaluatePlatformPosture(disabled, { now: NOW }).failed).toContain('PITR_ENABLED');

    const stale = validWith((entry) => {
      entry.pointInTimeRecovery.verifiedAt = '2026-01-01T00:00:00Z';
    });
    expect(evaluatePlatformPosture(stale, { now: NOW }).failed).toContain('PITR_EVIDENCE_FRESH');
  });

  it('fails when independent exports stay inside the provider, are unencrypted, or are stale', () => {
    const value = validWith((entry) => {
      entry.independentExports.storedOutsideDatabaseProvider = false;
      entry.independentExports.encrypted = false;
      entry.independentExports.lastSuccessAt = '2026-10-01T00:00:00Z';
    });
    const result = evaluatePlatformPosture(value, { now: NOW });
    expect(result.failed).toEqual(
      expect.arrayContaining([
        'INDEPENDENT_EXPORTS_OUTSIDE_PROVIDER',
        'INDEPENDENT_EXPORTS_ENCRYPTED',
        'INDEPENDENT_EXPORT_FRESH',
      ]),
    );
  });

  it('fails when export retention is shorter than one export interval', () => {
    const value = validWith((entry) => {
      entry.independentExports.cadenceHours = 720;
      entry.independentExports.retentionDays = 1;
      // Keep the export fresh so only the retention check fails.
      entry.independentExports.lastSuccessAt = '2026-11-04T10:00:00Z';
    });
    const result = evaluatePlatformPosture(value, { now: NOW, maxExportAgeHours: 1000 });
    expect(result.failed).toContain('INDEPENDENT_EXPORT_RETENTION');
  });

  it('fails when alerting is missing, stale, or a failed check was never delivered', () => {
    const value = validWith((entry) => {
      entry.alerting.configured = false;
      entry.alerting.testedAt = '2025-01-01T00:00:00Z';
      entry.alerting.testFailureAlerted = false;
    });
    const result = evaluatePlatformPosture(value, { now: NOW });
    expect(result.failed).toEqual(
      expect.arrayContaining(['ALERTING_CONFIGURED', 'ALERTING_TESTED', 'ALERTING_FAILURE_PROVEN']),
    );
  });

  it('fails stale or future-dated evidence', () => {
    const stale = validWith((entry) => {
      entry.recordedAt = '2026-01-01T00:00:00Z';
    });
    expect(evaluatePlatformPosture(stale, { now: NOW }).failed).toContain('EVIDENCE_FRESH');

    const future = validWith((entry) => {
      entry.recordedAt = '2026-12-01T00:00:00Z';
    });
    expect(evaluatePlatformPosture(future, { now: NOW }).failed).toContain('EVIDENCE_FRESH');
  });
});
