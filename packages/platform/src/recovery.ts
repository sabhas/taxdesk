import { z } from 'zod';
import { EvidenceTimestampSchema, type CheckResult } from './contracts.js';

/**
 * Restore verification (TD-708). A recovery snapshot is a set of counts and
 * money totals; it is taken from the source before a backup and again from the
 * restored copy, and the two must agree. Integrity queries prove that case
 * status and invoice balances are internally consistent after the restore.
 * Nothing here selects a name, identifier, contact detail, or secret.
 */

export const RECOVERY_TABLES = [
  'users',
  'user_roles',
  'mfa_credentials',
  'clients',
  'client_contacts',
  'tax_cases',
  'case_status_history',
  'case_checklist_items',
  'documents',
  'invoices',
  'invoice_items',
  'payments',
  'payment_reversals',
  'audit_events',
  'import_batches',
  'import_batch_rows',
] as const;

export const RecoverySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('taxdesk.recovery-snapshot'),
    takenAt: EvidenceTimestampSchema,
    migrations: z.array(
      z.object({ name: z.string(), checksum: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
    ),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    money: z
      .object({
        finalizedInvoiceTotalMinor: z.number().int().nonnegative(),
        outstandingMinor: z.number().int().nonnegative(),
        paymentsMinor: z.number().int().nonnegative(),
        reversalsMinor: z.number().int().nonnegative(),
      })
      .strict(),
    caseStatus: z.record(z.string(), z.number().int().nonnegative()),
    integrity: z
      .object({
        firmBootstrapped: z.boolean(),
        activeAdministratorsWithMfa: z.number().int().nonnegative(),
        usersEnrolledWithoutCredential: z.number().int().nonnegative(),
        mfaKeyVersions: z.array(z.number().int().positive()),
        caseStatusMismatches: z.number().int().nonnegative(),
        invoiceBalanceMismatches: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type RecoverySnapshot = z.infer<typeof RecoverySnapshotSchema>;

/** Minimal query surface so tests can run the evaluation without PostgreSQL. */
export type QueryFn = (sql: string) => Promise<readonly Record<string, unknown>[]>;

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return 0;
}

export async function collectRecoverySnapshot(
  query: QueryFn,
  now: Date,
): Promise<RecoverySnapshot> {
  const migrations = (
    await query('SELECT name, checksum FROM taxdesk_migration_ledger ORDER BY name')
  ).map((row) => ({ name: String(row['name']), checksum: String(row['checksum']) }));
  const counts: Record<string, number> = {};
  for (const table of RECOVERY_TABLES) {
    const exists = await query(`SELECT to_regclass('${table}')::text AS name`);
    counts[table] =
      exists[0]?.['name'] == null
        ? 0
        : toInt((await query(`SELECT count(*)::bigint AS n FROM ${table}`))[0]?.['n']);
  }
  const [money] = await query(
    `SELECT
       (SELECT coalesce(sum(total_minor), 0) FROM invoices WHERE status = 'finalized') AS total,
       (SELECT coalesce(sum(outstanding_minor), 0) FROM invoices WHERE status = 'finalized') AS outstanding,
       (SELECT coalesce(sum(amount_minor), 0) FROM payments) AS payments,
       (SELECT coalesce(sum(amount_minor), 0) FROM payment_reversals) AS reversals`,
  );
  const caseStatus: Record<string, number> = {};
  for (const row of await query(
    `SELECT current_status_kind AS kind, count(*)::bigint AS n
     FROM tax_cases WHERE deleted_at IS NULL GROUP BY current_status_kind ORDER BY 1`,
  )) {
    caseStatus[String(row['kind'])] = toInt(row['n']);
  }
  const [integrity] = await query(
    `SELECT
       (SELECT count(*) FROM firm_settings WHERE bootstrap_completed_at IS NOT NULL) = 1 AS firm,
       (SELECT count(DISTINCT u.id) FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id AND r.key = 'administrator'
          WHERE u.status = 'active' AND u.mfa_enrolled_at IS NOT NULL) AS admins,
       (SELECT count(*) FROM users u
          WHERE u.mfa_enrolled_at IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM mfa_credentials m
            WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL)) AS orphans,
       (SELECT count(*) FROM tax_cases c
          LEFT JOIN case_status_history h ON h.id = c.current_status_history_id
          WHERE h.id IS NULL OR h.case_id <> c.id OR h.to_status_key <> c.current_status_key
             OR EXISTS (SELECT 1 FROM case_status_history later
                        WHERE later.case_id = c.id AND later.id > h.id)) AS case_mismatches,
       (SELECT count(*) FROM invoices v
          WHERE v.status <> 'draft' AND v.paid_minor <>
            (SELECT coalesce(sum(p.amount_minor), 0) FROM payments p WHERE p.invoice_id = v.id)
            - (SELECT coalesce(sum(x.amount_minor), 0) FROM payment_reversals x WHERE x.invoice_id = v.id)
       ) AS balance_mismatches`,
  );
  const keyVersions = (
    await query('SELECT DISTINCT key_version FROM mfa_credentials ORDER BY 1')
  ).map((row) => toInt(row['key_version']));
  return RecoverySnapshotSchema.parse({
    schemaVersion: 1,
    kind: 'taxdesk.recovery-snapshot',
    takenAt: now.toISOString(),
    migrations,
    counts,
    money: {
      finalizedInvoiceTotalMinor: toInt(money?.['total']),
      outstandingMinor: toInt(money?.['outstanding']),
      paymentsMinor: toInt(money?.['payments']),
      reversalsMinor: toInt(money?.['reversals']),
    },
    caseStatus,
    integrity: {
      firmBootstrapped: integrity?.['firm'] === true,
      activeAdministratorsWithMfa: toInt(integrity?.['admins']),
      usersEnrolledWithoutCredential: toInt(integrity?.['orphans']),
      mfaKeyVersions: keyVersions,
      caseStatusMismatches: toInt(integrity?.['case_mismatches']),
      invoiceBalanceMismatches: toInt(integrity?.['balance_mismatches']),
    },
  });
}

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

export const RECOVERY_TIME_OBJECTIVE_HOURS = 4;

/**
 * Evaluates a restored database: schema matches the committed migrations,
 * authentication can work (firm, administrator with MFA, credentials for every
 * enrolled user, the MFA key version the target environment holds), record
 * counts, case status, and balances match the source snapshot, and the time
 * since the incident started is within the four-hour RTO.
 */
export function evaluateRestore(input: {
  readonly restored: RecoverySnapshot;
  readonly expected: RecoverySnapshot | null;
  readonly committedMigrations: readonly { name: string; checksum: string }[];
  readonly availableMfaKeyVersions: readonly number[];
  readonly incidentStartedAt: Date | null;
  readonly now: Date;
}): { ok: boolean; checks: CheckResult[]; failed: string[]; recoveryMinutes: number | null } {
  const { restored, expected } = input;
  const ledger = new Map(restored.migrations.map((m) => [m.name, m.checksum]));
  const missing = input.committedMigrations.filter((m) => ledger.get(m.name) !== m.checksum);
  const checks: CheckResult[] = [
    check(
      'SCHEMA_MATCHES_RELEASE',
      missing.length === 0,
      missing.length === 0
        ? `All ${String(input.committedMigrations.length)} committed migrations are applied with matching checksums.`
        : `${String(missing.length)} committed migration(s) are missing or differ, first ${missing[0]?.name ?? ''}.`,
    ),
    check(
      'FIRM_BOOTSTRAPPED',
      restored.integrity.firmBootstrapped,
      'The firm settings row exists and bootstrap completed.',
    ),
    check(
      'ADMINISTRATOR_SIGN_IN_POSSIBLE',
      restored.integrity.activeAdministratorsWithMfa > 0,
      `${String(restored.integrity.activeAdministratorsWithMfa)} active administrator(s) with MFA.`,
    ),
    check(
      'MFA_CREDENTIALS_PRESENT',
      restored.integrity.usersEnrolledWithoutCredential === 0,
      `${String(restored.integrity.usersEnrolledWithoutCredential)} enrolled user(s) without a confirmed MFA credential.`,
    ),
    check(
      'MFA_KEY_AVAILABLE',
      restored.integrity.mfaKeyVersions.every((version) =>
        input.availableMfaKeyVersions.includes(version),
      ),
      `Stored MFA key versions ${restored.integrity.mfaKeyVersions.join(',') || 'none'}; target environment holds ${input.availableMfaKeyVersions.join(',') || 'none'}.`,
    ),
    check(
      'CASE_STATUS_CONSISTENT',
      restored.integrity.caseStatusMismatches === 0,
      `${String(restored.integrity.caseStatusMismatches)} case(s) whose status does not match their newest history row.`,
    ),
    check(
      'BALANCES_CONSISTENT',
      restored.integrity.invoiceBalanceMismatches === 0,
      `${String(restored.integrity.invoiceBalanceMismatches)} invoice(s) whose paid amount differs from payments minus reversals.`,
    ),
  ];
  if (expected !== null) {
    const countDiffs = Object.keys({ ...expected.counts, ...restored.counts }).filter(
      (table) => (expected.counts[table] ?? 0) !== (restored.counts[table] ?? 0),
    );
    checks.push(
      check(
        'RECORD_COUNTS_MATCH',
        countDiffs.length === 0,
        countDiffs.length === 0
          ? `Counts match the source snapshot for ${String(Object.keys(expected.counts).length)} tables.`
          : `Counts differ for ${countDiffs.join(', ')}.`,
      ),
    );
    const moneyKeys = Object.keys(expected.money) as (keyof RecoverySnapshot['money'])[];
    const moneyDiffs = moneyKeys.filter((key) => expected.money[key] !== restored.money[key]);
    checks.push(
      check(
        'FINANCIAL_TOTALS_MATCH',
        moneyDiffs.length === 0,
        moneyDiffs.length === 0
          ? 'Invoice, outstanding, payment, and reversal totals match the source.'
          : `Totals differ: ${moneyDiffs.join(', ')}.`,
      ),
    );
    const statusKinds = Object.keys({ ...expected.caseStatus, ...restored.caseStatus });
    const statusDiffs = statusKinds.filter(
      (kind) => (expected.caseStatus[kind] ?? 0) !== (restored.caseStatus[kind] ?? 0),
    );
    checks.push(
      check(
        'CASE_STATUS_COUNTS_MATCH',
        statusDiffs.length === 0,
        statusDiffs.length === 0
          ? 'Case counts by status match the source.'
          : `Case counts differ for ${statusDiffs.join(', ')}.`,
      ),
    );
  }
  let recoveryMinutes: number | null = null;
  if (input.incidentStartedAt !== null) {
    recoveryMinutes = Math.round(
      (input.now.getTime() - input.incidentStartedAt.getTime()) / 60_000,
    );
    checks.push(
      check(
        'WITHIN_RTO',
        recoveryMinutes >= 0 && recoveryMinutes <= RECOVERY_TIME_OBJECTIVE_HOURS * 60,
        `Recovered in ${String(recoveryMinutes)} minutes; objective ${String(RECOVERY_TIME_OBJECTIVE_HOURS * 60)}.`,
      ),
    );
  }
  return {
    ok: checks.every((entry) => entry.passed),
    checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    recoveryMinutes,
  };
}
