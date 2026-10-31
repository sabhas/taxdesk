import type {
  CheckResult,
  PlatformPostureEvaluation,
  PlatformPostureEvidence,
  PostureEvaluationOptions,
} from './contracts.js';

const MS_PER_HOUR = 60 * 60 * 1000;

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

function ageHours(now: Date, timestamp: string): number {
  return (now.getTime() - new Date(timestamp).getTime()) / MS_PER_HOUR;
}

function ageDays(now: Date, timestamp: string): number {
  return ageHours(now, timestamp) / 24;
}

function formatAge(value: number, unit: 'hour' | 'day'): string {
  const rounded = Math.max(0, Number(value.toFixed(1)));
  return `${String(rounded)} ${unit}${rounded === 1 ? '' : 's'}`;
}

/**
 * Evaluates operator-recorded staging posture evidence against the controls
 * required before a deploy is allowed and by the scheduled recovery check.
 *
 * The function is intentionally total: every required control produces a
 * named check, so a failed run reports all gaps instead of only the first one.
 * No value is echoed from the evidence except durations and booleans.
 */
export function evaluatePlatformPosture(
  evidence: PlatformPostureEvidence,
  options: PostureEvaluationOptions,
): PlatformPostureEvaluation {
  const { now } = options;
  const maxEvidenceAgeDays = options.maxEvidenceAgeDays ?? 30;
  const maxPitrEvidenceAgeDays = options.maxPitrEvidenceAgeDays ?? 30;
  const maxAlertTestAgeDays = options.maxAlertTestAgeDays ?? 90;
  const maxExportAgeHours =
    options.maxExportAgeHours ?? Math.max(evidence.independentExports.cadenceHours * 2, 1);

  const evidenceAge = ageDays(now, evidence.recordedAt);
  const pitrAge = ageDays(now, evidence.pointInTimeRecovery.verifiedAt);
  const exportAge = ageHours(now, evidence.independentExports.lastSuccessAt);
  const alertAge = ageDays(now, evidence.alerting.testedAt);

  const checks: CheckResult[] = [
    check(
      'EVIDENCE_FRESH',
      evidenceAge <= maxEvidenceAgeDays && evidenceAge >= -0.25,
      evidenceAge < -0.25
        ? 'Evidence is timestamped in the future.'
        : `Evidence recorded ${formatAge(evidenceAge, 'day')} ago; limit ${String(maxEvidenceAgeDays)} days.`,
    ),
    check(
      'HYPERDRIVE_TLS_IN_USE',
      evidence.database.connectionUsesTls,
      evidence.database.connectionUsesTls
        ? 'The staging database connection uses TLS.'
        : 'The staging database connection does not use TLS.',
    ),
    check(
      'HYPERDRIVE_TLS_ENFORCED',
      evidence.database.tlsEnforcedByApplication,
      evidence.database.tlsEnforcedByApplication
        ? 'Application code requires TLS for database connections.'
        : 'Application code does not require TLS for database connections.',
    ),
    check(
      'DATABASE_ROLE_LEAST_PRIVILEGE',
      evidence.database.roleIsLeastPrivilege,
      evidence.database.roleIsLeastPrivilege
        ? 'The application role is least privilege.'
        : 'The application role has elevated privileges.',
    ),
    check(
      'DATABASE_ROLE_NOT_OWNER',
      !evidence.database.roleIsDatabaseOwner,
      evidence.database.roleIsDatabaseOwner
        ? 'The application role owns the database; use a separate owner.'
        : 'The application role does not own the database.',
    ),
    check(
      'PITR_ENABLED',
      evidence.pointInTimeRecovery.enabled,
      evidence.pointInTimeRecovery.enabled
        ? 'Point-in-time recovery is enabled.'
        : 'Point-in-time recovery is disabled.',
    ),
    check(
      'PITR_EVIDENCE_FRESH',
      pitrAge <= maxPitrEvidenceAgeDays && pitrAge >= -0.25,
      pitrAge < -0.25
        ? 'Point-in-time-recovery evidence is timestamped in the future.'
        : `Recovery coverage verified ${formatAge(pitrAge, 'day')} ago; limit ${String(maxPitrEvidenceAgeDays)} days.`,
    ),
    check(
      'INDEPENDENT_EXPORTS_ENABLED',
      evidence.independentExports.enabled,
      evidence.independentExports.enabled
        ? 'Independent exports are enabled.'
        : 'Independent exports are disabled.',
    ),
    check(
      'INDEPENDENT_EXPORTS_OUTSIDE_PROVIDER',
      evidence.independentExports.storedOutsideDatabaseProvider,
      evidence.independentExports.storedOutsideDatabaseProvider
        ? 'Independent exports are stored outside the database provider.'
        : 'Independent exports remain inside the database provider.',
    ),
    check(
      'INDEPENDENT_EXPORTS_ENCRYPTED',
      evidence.independentExports.encrypted,
      evidence.independentExports.encrypted
        ? 'Independent exports are encrypted.'
        : 'Independent exports are not encrypted.',
    ),
    check(
      'INDEPENDENT_EXPORT_FRESH',
      exportAge <= maxExportAgeHours && exportAge >= -0.25,
      exportAge < -0.25
        ? 'The latest independent export is timestamped in the future.'
        : `Latest independent export is ${formatAge(exportAge, 'hour')} old; limit ${String(maxExportAgeHours)} hours.`,
    ),
    check(
      'INDEPENDENT_EXPORT_RETENTION',
      evidence.independentExports.retentionDays * 24 >= evidence.independentExports.cadenceHours,
      evidence.independentExports.retentionDays * 24 >= evidence.independentExports.cadenceHours
        ? 'Export retention covers at least one export interval.'
        : 'Export retention is shorter than one export interval.',
    ),
    check(
      'ALERTING_CONFIGURED',
      evidence.alerting.configured,
      evidence.alerting.configured
        ? 'Backup-failure alerting is configured.'
        : 'Backup-failure alerting is not configured.',
    ),
    check(
      'ALERTING_TESTED',
      alertAge <= maxAlertTestAgeDays && alertAge >= -0.25,
      alertAge < -0.25
        ? 'The alerting test is timestamped in the future.'
        : `Alerting was tested ${formatAge(alertAge, 'day')} ago; limit ${String(maxAlertTestAgeDays)} days.`,
    ),
    check(
      'ALERTING_FAILURE_PROVEN',
      evidence.alerting.testFailureAlerted,
      evidence.alerting.testFailureAlerted
        ? 'A simulated failed backup check reached the operator.'
        : 'A failed backup check has not been proven to reach an operator.',
    ),
  ];

  const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  return { ok: failed.length === 0, checks, failed };
}
