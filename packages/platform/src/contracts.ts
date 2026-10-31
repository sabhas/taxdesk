import { z } from 'zod';

/**
 * Platform-operations contracts for TD-006.
 *
 * These schemas validate CI/operator evidence, not public API payloads. They
 * live in `@taxdesk/platform` (not `@taxdesk/shared`) for the same reason the
 * migration contracts live in `@taxdesk/database`: CI and recovery evidence must
 * never leak into the Worker or browser bundles.
 */

/** Short operator-facing label. Rejects control characters and very long values. */
export const SafeLabelSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 .,:;/_@+-]*$/);

/** UTC ISO-8601 timestamp. Evidence timestamps are always UTC. */
export const EvidenceTimestampSchema = z.string().datetime();

/**
 * Live database and Hyperdrive posture. Every field is a boolean observation
 * from either the deployed configuration or a database query; no credential or
 * host name is stored.
 */
export const DatabasePrivilegesSchema = z
  .object({
    tlsInUse: z.boolean(),
    connectionRequiresTls: z.boolean(),
    roleIsSuperuser: z.boolean(),
    roleCanCreateDatabases: z.boolean(),
    roleCanCreateRoles: z.boolean(),
    roleCanReplicate: z.boolean(),
    roleBypassesRowLevelSecurity: z.boolean(),
    roleOwnsDatabase: z.boolean(),
  })
  .strict();

export type DatabasePrivileges = z.infer<typeof DatabasePrivilegesSchema>;

/**
 * Staging platform posture evidence.
 *
 * The record is strict and deliberately contains no provider tokens, database
 * names, hostnames, or connection strings. An operator records it after
 * provisioning the staging database, then stores it in the protected `staging`
 * GitHub environment. The gate fails closed when the evidence is missing,
 * malformed, stale, or contradicts a required control.
 */
export const PlatformPostureEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.literal('staging'),
    recordedAt: EvidenceTimestampSchema,
    recordedBy: SafeLabelSchema,
    databaseProvider: SafeLabelSchema,
    database: z
      .object({
        connectionUsesTls: z.boolean(),
        tlsEnforcedByApplication: z.boolean(),
        roleIsLeastPrivilege: z.boolean(),
        roleIsDatabaseOwner: z.boolean(),
      })
      .strict(),
    pointInTimeRecovery: z
      .object({
        enabled: z.boolean(),
        retentionDays: z.number().int().min(1).max(365),
        verifiedAt: EvidenceTimestampSchema,
        method: SafeLabelSchema,
      })
      .strict(),
    independentExports: z
      .object({
        enabled: z.boolean(),
        provider: SafeLabelSchema,
        storedOutsideDatabaseProvider: z.boolean(),
        encrypted: z.boolean(),
        cadenceHours: z.number().int().min(1).max(720),
        lastSuccessAt: EvidenceTimestampSchema,
        retentionDays: z.number().int().min(1).max(3650),
      })
      .strict(),
    alerting: z
      .object({
        configured: z.boolean(),
        channel: SafeLabelSchema,
        testedAt: EvidenceTimestampSchema,
        testFailureAlerted: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type PlatformPostureEvidence = z.infer<typeof PlatformPostureEvidenceSchema>;

/** One named pass/fail check emitted by any platform gate. */
export const CheckResultSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    passed: z.boolean(),
    detail: z.string().min(1).max(300),
  })
  .strict();

export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Common machine-readable report shape printed by every platform CLI command. */
export const CheckReportSchema = z
  .object({
    check: z.string().min(1),
    ok: z.boolean(),
    checks: z.array(CheckResultSchema),
    failed: z.array(z.string()),
  })
  .strict();

export type CheckReport = z.infer<typeof CheckReportSchema>;

export interface PostureEvaluationOptions {
  /** Evaluation time. Injected so freshness checks are deterministic in tests. */
  readonly now: Date;
  /** Maximum accepted age of the recorded evidence. Defaults to 30 days. */
  readonly maxEvidenceAgeDays?: number;
  /** Maximum age of the latest independent export. Defaults to twice the export cadence. */
  readonly maxExportAgeHours?: number;
  /** Maximum age of the point-in-time-recovery verification. Defaults to 30 days. */
  readonly maxPitrEvidenceAgeDays?: number;
  /** Maximum age of the alerting test. Defaults to 90 days. */
  readonly maxAlertTestAgeDays?: number;
}

/** Result of evaluating a platform posture evidence record. */
export interface PlatformPostureEvaluation {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly failed: string[];
}
