import { z } from 'zod';

/**
 * Migration contracts.
 *
 * These Zod schemas validate the operational migration ledger, the committed
 * checksum manifest, and the CLI report. They deliberately live in
 * `@taxdesk/database` rather than `@taxdesk/shared`: migrations are an
 * operator/CI concern, not a public API or browser contract, so the schema must
 * never be pulled into the Worker or web bundles.
 */

/**
 * A migration file is named `<zero-padded version>_<snake_case name>.sql`.
 * The numeric prefix determines the single, forward-only apply order. Rejecting
 * names without a valid prefix prevents an accidental `initial.sql` from being
 * silently ignored by the runner.
 */
export const MIGRATION_FILE_PATTERN = /^\d{4,}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export const MigrationNameSchema = z
  .string()
  .max(120)
  .regex(
    MIGRATION_FILE_PATTERN,
    'Expected a migration file name such as `0003_add_client_search_index.sql`.',
  );

/** Lowercase SHA-256 hex digest of a migration file's normalized contents. */
export const MigrationChecksumSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 checksum.');

/** Name and checksum pair used by the committed manifest and CLI reports. */
export const MigrationFileSummarySchema = z
  .object({
    name: MigrationNameSchema,
    checksum: MigrationChecksumSchema,
  })
  .strict();

export type MigrationFileSummary = z.infer<typeof MigrationFileSummarySchema>;

/** A row read from `taxdesk_migration_ledger`, before ISO-8601 normalization. */
export const MigrationLedgerRowSchema = z
  .object({
    name: MigrationNameSchema,
    checksum: MigrationChecksumSchema,
    applied_at: z.coerce.date(),
    duration_ms: z.coerce.number().int().nonnegative(),
  })
  .strict();

export type MigrationLedgerRow = z.infer<typeof MigrationLedgerRowSchema>;

/** An applied migration as reported to operators and to the CLI. */
export const AppliedMigrationSchema = MigrationFileSummarySchema.extend({
  appliedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
}).strict();

export type AppliedMigration = z.infer<typeof AppliedMigrationSchema>;

/**
 * The committed checksum manifest. It is the reference that lets CI reject an
 * edited historical migration without a database connection. Adding an entry is
 * additive and reviewable; changing or removing an existing entry is refused by
 * `planManifestUpdate` because applied history is immutable.
 */
export const MigrationManifestSchema = z
  .object({
    version: z.literal(1),
    migrations: z.array(MigrationFileSummarySchema),
  })
  .strict();

export type MigrationManifest = z.infer<typeof MigrationManifestSchema>;

/** Plan of applied and pending migrations for the current database. */
export const MigrationPlanSchema = z
  .object({
    applied: z.array(AppliedMigrationSchema),
    pending: z.array(MigrationFileSummarySchema),
  })
  .strict();

export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/** Machine-readable report printed as the final line of every CLI command. */
export const MigrationReportSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('up'),
      applied: z.array(AppliedMigrationSchema),
      pending: z.array(MigrationFileSummarySchema),
    })
    .strict(),
  z
    .object({
      command: z.literal('status'),
      status: z.enum(['up_to_date', 'pending']),
      applied: z.array(AppliedMigrationSchema),
      pending: z.array(MigrationFileSummarySchema),
    })
    .strict(),
  z
    .object({
      command: z.literal('verify'),
      status: z.literal('ok'),
      files: z.number().int().nonnegative(),
      recorded: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      command: z.literal('manifest'),
      status: z.enum(['up_to_date', 'updated']),
      added: z.array(MigrationNameSchema),
      recorded: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type MigrationReport = z.infer<typeof MigrationReportSchema>;

/** Extracts the numeric version prefix from a validated migration file name. */
export function migrationVersion(name: string): number {
  const [prefix = ''] = name.split('_');
  return Number.parseInt(prefix, 10);
}
