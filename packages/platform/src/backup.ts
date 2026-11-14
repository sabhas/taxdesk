import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { EvidenceTimestampSchema, SafeLabelSchema, type CheckResult } from './contracts.js';

/**
 * Independent encrypted database exports (TD-707).
 *
 * A `pg_dump` custom-format archive is encrypted with AES-256-GCM under
 * `BACKUP_ENCRYPTION_KEY` (a deployment secret held outside the database
 * provider) and written next to a manifest that records the outcome, the
 * source version, the artifact digest, and the retention period. The manifest
 * holds no host, database name, credential, or record content.
 */

const MAGIC = Buffer.from('TDBK', 'ascii');
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 2 + IV_BYTES + TAG_BYTES;

export class BackupKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupKeyError';
  }
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Decodes a base64url (or base64) 32-byte key. */
export function parseBackupKey(value: string | undefined): Buffer {
  if (value === undefined || value.trim().length === 0) {
    throw new BackupKeyError('BACKUP_ENCRYPTION_KEY is not set.');
  }
  const normalized = value.trim().replace(/-/gu, '+').replace(/_/gu, '/');
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32) {
    throw new BackupKeyError('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64url encoded.');
  }
  return key;
}

/** `TDBK` | format version | key version | IV | GCM tag | ciphertext. */
export function encryptBackup(plaintext: Buffer, key: Buffer, keyVersion = 1): Buffer {
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 255) {
    throw new BackupKeyError('The backup key version must be between 1 and 255.');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, keyVersion])]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, keyVersion]), iv, tag, ciphertext]);
}

export function backupKeyVersion(artifact: Buffer): number {
  if (artifact.length < HEADER_BYTES || !artifact.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFormatError('The file is not a TaxDesk encrypted backup.');
  }
  return artifact[MAGIC.length + 1] ?? 0;
}

/** Decrypts and authenticates an artifact; a wrong key or a changed byte fails. */
export function decryptBackup(artifact: Buffer, key: Buffer): Buffer {
  backupKeyVersion(artifact);
  const version = artifact[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new BackupFormatError('The backup format version is not supported.');
  }
  const header = artifact.subarray(0, MAGIC.length + 2);
  const ivStart = MAGIC.length + 2;
  const iv = artifact.subarray(ivStart, ivStart + IV_BYTES);
  const tag = artifact.subarray(ivStart + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(artifact.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new BackupFormatError('The backup could not be decrypted: wrong key or damaged file.');
  }
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const BACKUP_FAILURE_CODES = [
  'KEY_MISSING',
  'DATABASE_URL_MISSING',
  'DUMP_FAILED',
  'SOURCE_QUERY_FAILED',
  'ENCRYPTION_FAILED',
  'WRITE_FAILED',
] as const;

export const BackupManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('taxdesk.independent-export'),
    environment: z.enum(['development', 'staging', 'production']),
    status: z.enum(['succeeded', 'failed']),
    failureCode: z.enum(BACKUP_FAILURE_CODES).nullable(),
    startedAt: EvidenceTimestampSchema,
    finishedAt: EvidenceTimestampSchema,
    durationMs: z.number().int().nonnegative(),
    source: z
      .object({
        /** PostgreSQL `server_version_num`, e.g. 160004. */
        serverVersionNum: z.number().int().positive().nullable(),
        /** Newest applied migration file name, the schema version of the export. */
        migrationHead: z
          .string()
          .regex(/^\d{4}_[a-z0-9_]+\.sql$/u)
          .nullable(),
        migrationCount: z.number().int().nonnegative().nullable(),
        releaseVersion: SafeLabelSchema.nullable(),
      })
      .strict(),
    artifact: z
      .object({
        fileName: z.string().regex(/^taxdesk-[a-z]+-\d{8}T\d{6}Z\.dump\.enc$/u),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        format: z.literal('pg_dump-custom'),
        encryption: z.literal('AES-256-GCM'),
        keyVersion: z.number().int().min(1).max(255),
      })
      .strict()
      .nullable(),
    retention: z
      .object({
        days: z.number().int().min(1).max(3650),
        expiresAt: EvidenceTimestampSchema,
        storage: SafeLabelSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if ((manifest.status === 'succeeded') !== (manifest.artifact !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'A successful export has an artifact; a failed one has none.',
      });
    }
    if ((manifest.status === 'failed') !== (manifest.failureCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only a failed export has a failure code.',
      });
    }
  });

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** `2026-11-14T03:17:05.123Z` → `20261114T031705Z`. */
export function backupStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
}

export function backupFileName(environment: string, at: Date): string {
  return `taxdesk-${environment}-${backupStamp(at)}.dump.enc`;
}

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

/**
 * Checks the latest manifest from the independent store: the export
 * succeeded, is fresh, carries source and retention metadata, and (when the
 * artifact is supplied) its digest matches. Used by the scheduled posture job
 * to alert on missing or failed exports.
 */
export function evaluateBackupManifest(
  manifest: BackupManifest,
  options: {
    readonly now: Date;
    readonly maxAgeHours: number;
    readonly minRetentionDays: number;
    readonly expectedEnvironment?: string;
    readonly artifact?: Buffer;
  },
): { ok: boolean; checks: CheckResult[]; failed: string[] } {
  const ageHours = (options.now.getTime() - new Date(manifest.finishedAt).getTime()) / 3_600_000;
  const checks: CheckResult[] = [
    check(
      'EXPORT_SUCCEEDED',
      manifest.status === 'succeeded',
      manifest.status === 'succeeded'
        ? 'The latest independent export succeeded.'
        : `The latest independent export failed (${manifest.failureCode ?? 'UNKNOWN'}).`,
    ),
    check(
      'EXPORT_FRESH',
      ageHours >= -0.25 && ageHours <= options.maxAgeHours,
      ageHours < -0.25
        ? 'The latest export is timestamped in the future.'
        : `The latest export finished ${ageHours.toFixed(1)} hours ago; limit ${String(options.maxAgeHours)} hours.`,
    ),
    check(
      'EXPORT_ENCRYPTED',
      manifest.artifact?.encryption === 'AES-256-GCM',
      manifest.artifact === null
        ? 'No artifact was recorded.'
        : 'The export is encrypted with AES-256-GCM.',
    ),
    check(
      'SOURCE_VERSION_RECORDED',
      manifest.source.migrationHead !== null && manifest.source.serverVersionNum !== null,
      manifest.source.migrationHead === null
        ? 'The export does not record the source schema version.'
        : `Source schema ${manifest.source.migrationHead}.`,
    ),
    check(
      'RETENTION_RECORDED',
      manifest.retention.days >= options.minRetentionDays,
      `Retention ${String(manifest.retention.days)} days; minimum ${String(options.minRetentionDays)}.`,
    ),
  ];
  if (options.expectedEnvironment !== undefined) {
    checks.push(
      check(
        'EXPORT_ENVIRONMENT',
        manifest.environment === options.expectedEnvironment,
        `The manifest is for ${manifest.environment}.`,
      ),
    );
  }
  if (options.artifact !== undefined) {
    const digest = sha256Hex(options.artifact);
    checks.push(
      check(
        'ARTIFACT_DIGEST',
        manifest.artifact !== null &&
          digest === manifest.artifact.sha256 &&
          options.artifact.length === manifest.artifact.sizeBytes,
        'The artifact digest and size match the manifest.',
      ),
    );
  }
  return {
    ok: checks.every((entry) => entry.passed),
    checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
  };
}

/** libpq environment for a connection URL, so no credential appears in argv. */
export function libpqEnvironment(connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new BackupKeyError('DATABASE_URL must be a postgres:// URL.');
  }
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port.length === 0 ? '5432' : url.port,
    PGUSER: decodeURIComponent(url.username),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//u, '')),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'require',
  };
  if (url.password.length > 0) {
    env['PGPASSWORD'] = decodeURIComponent(url.password);
  }
  return env;
}
