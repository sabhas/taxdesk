import { describe, expect, it } from 'vitest';
import { importTemplate, parseCsv } from '@taxdesk/shared';
import {
  BackupManifestSchema,
  decryptBackup,
  encryptBackup,
  evaluateBackupManifest,
  libpqEnvironment,
  parseBackupKey,
  sha256Hex,
  type BackupManifest,
} from './backup.js';
import { runOpsCli, type OpsDependencies } from './ops-cli.js';
import { evaluateRestore, type RecoverySnapshot } from './recovery.js';
import { generateSampleImport } from './sample-import.js';

const KEY = Buffer.alloc(32, 9).toString('base64url');
const NOW = new Date('2026-11-14T03:00:00.000Z');
// Synthetic connection string for a fake dependency; never dialled.
const FAKE_DATABASE_URL =
  'postgres://backup_reader:example-pass@db.example.test:5432/taxdesk_staging';

function fakeDeps(overrides: Partial<OpsDependencies> = {}) {
  const files = new Map<string, Buffer>();
  const out: string[] = [];
  const err: string[] = [];
  let dumpEnv: Record<string, string> | null = null;
  const deps: OpsDependencies = {
    env: {
      DATABASE_URL: FAKE_DATABASE_URL,
      BACKUP_ENCRYPTION_KEY: KEY,
      RELEASE_VERSION: 'abc1234',
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => NOW,
    dump: (env) => {
      dumpEnv = env;
      return Promise.resolve(Buffer.from('PGDMP synthetic archive'));
    },
    withDatabase: async (_url, work) =>
      await work((sql) =>
        Promise.resolve(
          sql.includes('server_version_num')
            ? [{ v: 160004 }]
            : [{ head: '0010_data_import.sql', n: 10 }],
        ),
      ),
    readFile: (path) => {
      const file = files.get(path);
      return file === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(file);
    },
    writeFile: (path, data) => {
      files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data));
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    repositoryRoot: '/repo',
    ...overrides,
  };
  return { deps, files, out, err, dumpEnv: () => dumpEnv };
}

function lastReport(out: string[]): Record<string, unknown> {
  return JSON.parse(out.at(-1) ?? '{}') as Record<string, unknown>;
}

describe('backup encryption', () => {
  it('round-trips and rejects a wrong key or a changed byte', () => {
    const key = parseBackupKey(KEY);
    const plaintext = Buffer.from('synthetic archive bytes');
    const sealed = encryptBackup(plaintext, key, 2);
    expect(sealed.subarray(0, 4).toString('ascii')).toBe('TDBK');
    expect(sealed.includes(plaintext)).toBe(false);
    expect(decryptBackup(sealed, key).equals(plaintext)).toBe(true);
    expect(() => decryptBackup(sealed, Buffer.alloc(32, 1))).toThrow(/wrong key or damaged/u);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decryptBackup(tampered, key)).toThrow(/wrong key or damaged/u);
    expect(() => parseBackupKey('short')).toThrow(/32 bytes/u);
    expect(() => parseBackupKey(undefined)).toThrow(/not set/u);
  });

  it('passes credentials to pg_dump through the libpq environment, not argv', () => {
    expect(libpqEnvironment(FAKE_DATABASE_URL)).toEqual({
      PGHOST: 'db.example.test',
      PGPORT: '5432',
      PGUSER: 'backup_reader',
      PGPASSWORD: 'example-pass',
      PGDATABASE: 'taxdesk_staging',
      PGSSLMODE: 'require',
    });
  });
});

describe('ops backup-export', () => {
  it('writes an encrypted artifact and a manifest with source and retention metadata', async () => {
    const { deps, files, out, dumpEnv } = fakeDeps();
    const code = await runOpsCli(
      ['backup-export', '--out', '/exports', '--retention-days', '35'],
      deps,
    );
    expect(code).toBe(0);
    const artifact = files.get('/exports/taxdesk-staging-20261114T030000Z.dump.enc');
    expect(artifact).toBeDefined();
    expect(decryptBackup(artifact!, parseBackupKey(KEY)).toString()).toBe(
      'PGDMP synthetic archive',
    );
    const manifest = BackupManifestSchema.parse(
      JSON.parse(files.get('/exports/latest.manifest.json')!.toString()),
    );
    expect(manifest).toMatchObject({
      status: 'succeeded',
      environment: 'staging',
      source: {
        serverVersionNum: 160004,
        migrationHead: '0010_data_import.sql',
        migrationCount: 10,
        releaseVersion: 'abc1234',
      },
      artifact: {
        sha256: sha256Hex(artifact!),
        sizeBytes: artifact!.length,
        encryption: 'AES-256-GCM',
      },
      retention: { days: 35, expiresAt: '2026-12-19T03:00:00.000Z' },
    });
    expect(files.has('/exports/taxdesk-staging-20261114T030000Z.manifest.json')).toBe(true);
    expect(dumpEnv()?.['PGPASSWORD']).toBe('example-pass');
    const printed = out.join('\n');
    expect(printed).not.toContain('example-pass');
    expect(printed).not.toContain('db.example.test');
    expect(printed).not.toContain(KEY);
  });

  it('records a failed export with a failure code and exits non-zero', async () => {
    const { deps, files, out } = fakeDeps({
      dump: () => Promise.reject(new Error('pg_dump exited with 1')),
    });
    expect(await runOpsCli(['backup-export', '--out', '/exports'], deps)).toBe(1);
    const manifest = JSON.parse(
      files.get('/exports/latest.manifest.json')!.toString(),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      status: 'failed',
      failureCode: 'DUMP_FAILED',
      artifact: null,
    });
    expect(lastReport(out)['ok']).toBe(false);

    const noKey = fakeDeps({ env: { DATABASE_URL: FAKE_DATABASE_URL } });
    expect(await runOpsCli(['backup-export', '--out', '/exports'], noKey.deps)).toBe(1);
    expect(JSON.parse(noKey.files.get('/exports/latest.manifest.json')!.toString())).toMatchObject({
      failureCode: 'KEY_MISSING',
    });
  });
});

describe('ops backup-verify', () => {
  async function exported() {
    const context = fakeDeps();
    await runOpsCli(['backup-export', '--out', '/exports'], context.deps);
    return context;
  }

  it('passes for a fresh, successful, encrypted export with a matching artifact', async () => {
    const { deps, out } = await exported();
    const code = await runOpsCli(
      [
        'backup-verify',
        '--manifest',
        '/exports/latest.manifest.json',
        '--artifact',
        '/exports/taxdesk-staging-20261114T030000Z.dump.enc',
        '--environment',
        'staging',
      ],
      deps,
    );
    expect(code).toBe(0);
    expect(lastReport(out)['failed']).toEqual([]);
  });

  it('fails a stale, failed, altered, or missing export so the scheduled job alerts', async () => {
    const stale = await exported();
    const later = { ...stale.deps, now: () => new Date(NOW.getTime() + 31 * 3_600_000) };
    expect(
      await runOpsCli(['backup-verify', '--manifest', '/exports/latest.manifest.json'], later),
    ).toBe(1);
    expect(lastReport(stale.out)['failed']).toEqual(['EXPORT_FRESH']);

    const altered = await exported();
    const artifactPath = '/exports/taxdesk-staging-20261114T030000Z.dump.enc';
    const bytes = Buffer.from(altered.files.get(artifactPath)!);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    altered.files.set(artifactPath, bytes);
    await runOpsCli(
      ['backup-verify', '--manifest', '/exports/latest.manifest.json', '--artifact', artifactPath],
      altered.deps,
    );
    expect(lastReport(altered.out)['failed']).toEqual(['ARTIFACT_DIGEST']);

    const missing = fakeDeps();
    expect(await runOpsCli(['backup-verify', '--manifest', '/nowhere.json'], missing.deps)).toBe(1);
    expect(lastReport(missing.out)['failed']).toEqual(['MANIFEST_INVALID']);

    const failedManifest = BackupManifestSchema.parse({
      schemaVersion: 1,
      kind: 'taxdesk.independent-export',
      environment: 'staging',
      status: 'failed',
      failureCode: 'DUMP_FAILED',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      durationMs: 0,
      source: {
        serverVersionNum: null,
        migrationHead: null,
        migrationCount: null,
        releaseVersion: null,
      },
      artifact: null,
      retention: { days: 35, expiresAt: NOW.toISOString(), storage: 'r2' },
    });
    const evaluation = evaluateBackupManifest(failedManifest, {
      now: NOW,
      maxAgeHours: 30,
      minRetentionDays: 30,
    });
    expect(evaluation.failed).toEqual([
      'EXPORT_SUCCEEDED',
      'EXPORT_ENCRYPTED',
      'SOURCE_VERSION_RECORDED',
    ]);
  });
});

function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    schemaVersion: 1,
    kind: 'taxdesk.recovery-snapshot',
    takenAt: NOW.toISOString(),
    migrations: [{ name: '0001_initial_baseline.sql', checksum: 'a'.repeat(64) }],
    counts: { clients: 10, tax_cases: 4, invoices: 3 },
    money: {
      finalizedInvoiceTotalMinor: 500,
      outstandingMinor: 200,
      paymentsMinor: 300,
      reversalsMinor: 0,
    },
    caseStatus: { open: 3, filed: 1 },
    integrity: {
      firmBootstrapped: true,
      activeAdministratorsWithMfa: 1,
      usersEnrolledWithoutCredential: 0,
      mfaKeyVersions: [1],
      caseStatusMismatches: 0,
      invoiceBalanceMismatches: 0,
    },
    ...overrides,
  };
}

describe('restore verification', () => {
  const committed = [{ name: '0001_initial_baseline.sql', checksum: 'a'.repeat(64) }];

  it('passes when the restore matches the release, the source, and the RTO', () => {
    const result = evaluateRestore({
      restored: snapshot(),
      expected: snapshot(),
      committedMigrations: committed,
      availableMfaKeyVersions: [1],
      incidentStartedAt: new Date(NOW.getTime() - 95 * 60_000),
      now: NOW,
    });
    expect(result.failed).toEqual([]);
    expect(result.recoveryMinutes).toBe(95);
  });

  it('names every failed control', () => {
    const result = evaluateRestore({
      restored: snapshot({
        migrations: [],
        counts: { clients: 9, tax_cases: 4, invoices: 3 },
        money: {
          finalizedInvoiceTotalMinor: 500,
          outstandingMinor: 100,
          paymentsMinor: 400,
          reversalsMinor: 0,
        },
        caseStatus: { open: 4 },
        integrity: {
          firmBootstrapped: false,
          activeAdministratorsWithMfa: 0,
          usersEnrolledWithoutCredential: 2,
          mfaKeyVersions: [2],
          caseStatusMismatches: 1,
          invoiceBalanceMismatches: 1,
        },
      }),
      expected: snapshot(),
      committedMigrations: committed,
      availableMfaKeyVersions: [1],
      incidentStartedAt: new Date(NOW.getTime() - 5 * 3_600_000),
      now: NOW,
    });
    expect(result.failed).toEqual([
      'SCHEMA_MATCHES_RELEASE',
      'FIRM_BOOTSTRAPPED',
      'ADMINISTRATOR_SIGN_IN_POSSIBLE',
      'MFA_CREDENTIALS_PRESENT',
      'MFA_KEY_AVAILABLE',
      'CASE_STATUS_CONSISTENT',
      'BALANCES_CONSISTENT',
      'RECORD_COUNTS_MATCH',
      'FINANCIAL_TOTALS_MATCH',
      'CASE_STATUS_COUNTS_MATCH',
      'WITHIN_RTO',
    ]);
  });
});

describe('sample import generator', () => {
  it('is deterministic, matches the templates, and uses only synthetic values', () => {
    const options = {
      clients: 50,
      casesPerClient: 0.6,
      balanceShare: 0.4,
      seed: 7,
      service: 'Income tax return',
      taxYear: 2026,
      asOfDate: '2026-06-30',
      withExceptions: true,
    } as const;
    const first = generateSampleImport(options);
    expect(generateSampleImport(options)).toEqual(first);
    for (const [template, content] of Object.entries(first.files)) {
      const parsed = parseCsv(content);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.rows[0]).toEqual(
        importTemplate(template as 'clients.v1').columns.map((column) => column.name),
      );
    }
    const clients = first.files['clients.v1'];
    for (const match of clients.matchAll(/\b(\d{5})-\d{7}-\d\b/gu)) {
      expect(match[1]).toBe('00000');
    }
    for (const match of clients.matchAll(/@([a-z.]+)/gu)) {
      expect(match[1]).toBe('example.test');
    }
    expect(first.sourceTotals.clients).toBe(50);
    expect(first.sourceTotals.exceptionRows).toBe(3);
    expect(first.files['cases.v1'].trim().split('\r\n')).toHaveLength(
      first.sourceTotals.activeCases + 1,
    );
    expect(first.sourceTotals.openingBalanceMinor).toBeGreaterThan(0);
  });
});
