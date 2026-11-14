import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  BackupManifestSchema,
  backupFileName,
  backupKeyVersion,
  decryptBackup,
  encryptBackup,
  evaluateBackupManifest,
  libpqEnvironment,
  parseBackupKey,
  sha256Hex,
  type BackupManifest,
} from './backup.js';
import {
  RecoverySnapshotSchema,
  collectRecoverySnapshot,
  evaluateRestore,
  type QueryFn,
  type RecoverySnapshot,
} from './recovery.js';
import { generateSampleImport } from './sample-import.js';

/**
 * Recovery and migration operations (TD-706–TD-708). Every command prints one
 * JSON report line; none prints a connection string, credential, key, or
 * record content.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const USAGE = `TaxDesk operations (Epic 7)

Usage:
  ops backup-export     --out <dir> [--environment staging] [--retention-days 35]
                        [--storage <label>] [--key-version 1]
                        pg_dump DATABASE_URL, encrypt with BACKUP_ENCRYPTION_KEY, and write
                        <file>.dump.enc plus <file>.manifest.json and latest.manifest.json.
  ops backup-decrypt    --in <file.dump.enc> --out <file.dump>
                        Decrypt and authenticate an export for pg_restore.
  ops backup-verify     --manifest <path> [--artifact <path>] [--max-age-hours 30]
                        [--min-retention-days 30] [--environment staging]
                        Fail when the latest export is missing, failed, stale, or altered.
  ops recovery-snapshot --out <path>
                        Record counts, money totals, and integrity of DATABASE_URL.
  ops restore-verify    [--expected <snapshot.json>] [--incident-start <ISO time>]
                        [--mfa-key-versions 1] [--out <evidence.json>]
                        Verify a restored DATABASE_URL against the release and the source.
  ops sample-import     --out <dir> [--clients 500] [--seed 7] [--service <name>]
                        [--tax-year 2026] [--as-of 2026-06-30] [--with-exceptions]
                        Write synthetic, production-shaped import files for a rehearsal.

Environment:
  DATABASE_URL            Database to export, snapshot, or verify.
  BACKUP_ENCRYPTION_KEY   base64url 32-byte key; never stored with the export.
  RELEASE_VERSION         Optional release recorded in the manifest.
`;

class UsageError extends Error {}

interface Options {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

const BOOLEAN_FLAGS = new Set(['with-exceptions']);

function parse(argv: readonly string[]): { command: string | undefined; options: Options } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--') continue;
    if (argument === '--help') {
      flags.add('help');
    } else if (argument.startsWith('--') && BOOLEAN_FLAGS.has(argument.slice(2))) {
      flags.add(argument.slice(2));
    } else if (argument.startsWith('--')) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`Option ${argument} requires a value.`);
      }
      values.set(argument.slice(2), next);
      index += 1;
    } else if (command === undefined) {
      command = argument;
    } else {
      throw new UsageError(`Unexpected argument "${argument}".`);
    }
  }
  return { command, options: { values, flags } };
}

function required(options: Options, name: string): string {
  const value = options.values.get(name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`--${name} is required.`);
  }
  return value;
}

function positiveInt(options: Options, name: string, fallback: number): number {
  const raw = options.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer.`);
  }
  return value;
}

export interface OpsDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  /** Runs `pg_dump` against the libpq environment and returns the archive. */
  readonly dump: (env: Record<string, string>) => Promise<Buffer>;
  readonly withDatabase: <T>(
    connectionString: string,
    work: (query: QueryFn) => Promise<T>,
  ) => Promise<T>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly writeFile: (path: string, data: Buffer | string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly repositoryRoot: string;
}

function emit(deps: OpsDependencies, value: unknown): void {
  deps.stdout(JSON.stringify(value));
}

function databaseUrl(deps: OpsDependencies): string {
  const value = deps.env['DATABASE_URL'];
  if (value === undefined || value.length === 0) {
    throw new UsageError('DATABASE_URL is required.');
  }
  return value;
}

async function backupExport(deps: OpsDependencies, options: Options): Promise<number> {
  const outDir = required(options, 'out');
  const environment = options.values.get('environment') ?? 'staging';
  if (!['development', 'staging', 'production'].includes(environment)) {
    throw new UsageError('--environment must be development, staging, or production.');
  }
  const retentionDays = positiveInt(options, 'retention-days', 35);
  const keyVersion = positiveInt(options, 'key-version', 1);
  const storage = options.values.get('storage') ?? 'independent object storage';
  const startedAt = deps.now();
  const release = deps.env['RELEASE_VERSION'];
  const fileName = backupFileName(environment, startedAt);
  const base: Omit<
    BackupManifest,
    'status' | 'failureCode' | 'finishedAt' | 'durationMs' | 'artifact' | 'source'
  > = {
    schemaVersion: 1,
    kind: 'taxdesk.independent-export',
    environment: environment as BackupManifest['environment'],
    startedAt: startedAt.toISOString(),
    retention: {
      days: retentionDays,
      expiresAt: new Date(startedAt.getTime() + retentionDays * 86_400_000).toISOString(),
      storage,
    },
  };
  let source: BackupManifest['source'] = {
    serverVersionNum: null,
    migrationHead: null,
    migrationCount: null,
    releaseVersion:
      release !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(release) ? release : null,
  };
  const finish = async (
    status: 'succeeded' | 'failed',
    failureCode: BackupManifest['failureCode'],
    artifact: BackupManifest['artifact'],
  ): Promise<number> => {
    const finishedAt = deps.now();
    const manifest = BackupManifestSchema.parse({
      ...base,
      status,
      failureCode,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      source,
      artifact,
    });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    await deps.mkdir(outDir);
    await deps.writeFile(join(outDir, fileName.replace(/\.dump\.enc$/u, '.manifest.json')), text);
    await deps.writeFile(join(outDir, 'latest.manifest.json'), text);
    emit(deps, { check: 'backup-export', ok: status === 'succeeded', manifest });
    return status === 'succeeded' ? 0 : 1;
  };

  let key: Buffer;
  try {
    key = parseBackupKey(deps.env['BACKUP_ENCRYPTION_KEY']);
  } catch {
    return await finish('failed', 'KEY_MISSING', null);
  }
  const url = deps.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    return await finish('failed', 'DATABASE_URL_MISSING', null);
  }
  try {
    source = await deps.withDatabase(url, async (query) => {
      const [version] = await query("SELECT current_setting('server_version_num')::int AS v");
      const [ledger] = await query(
        'SELECT max(name) AS head, count(*)::int AS n FROM taxdesk_migration_ledger',
      );
      return {
        ...source,
        serverVersionNum: Number(version?.['v'] ?? 0) || null,
        migrationHead: typeof ledger?.['head'] === 'string' ? ledger['head'] : null,
        migrationCount: Number(ledger?.['n'] ?? 0),
      };
    });
  } catch {
    return await finish('failed', 'SOURCE_QUERY_FAILED', null);
  }
  let archive: Buffer;
  try {
    archive = await deps.dump(libpqEnvironment(url));
  } catch {
    return await finish('failed', 'DUMP_FAILED', null);
  }
  let encrypted: Buffer;
  try {
    encrypted = encryptBackup(archive, key, keyVersion);
  } catch {
    return await finish('failed', 'ENCRYPTION_FAILED', null);
  }
  try {
    await deps.mkdir(outDir);
    await deps.writeFile(join(outDir, fileName), encrypted);
  } catch {
    return await finish('failed', 'WRITE_FAILED', null);
  }
  return await finish('succeeded', null, {
    fileName,
    sizeBytes: encrypted.length,
    sha256: sha256Hex(encrypted),
    format: 'pg_dump-custom',
    encryption: 'AES-256-GCM',
    keyVersion,
  });
}

async function backupDecrypt(deps: OpsDependencies, options: Options): Promise<number> {
  const input = required(options, 'in');
  const output = required(options, 'out');
  const key = parseBackupKey(deps.env['BACKUP_ENCRYPTION_KEY']);
  const artifact = await deps.readFile(input);
  const plaintext = decryptBackup(artifact, key);
  await deps.writeFile(output, plaintext);
  emit(deps, {
    check: 'backup-decrypt',
    ok: true,
    keyVersion: backupKeyVersion(artifact),
    sha256: sha256Hex(artifact),
    sizeBytes: plaintext.length,
  });
  return 0;
}

async function backupVerify(deps: OpsDependencies, options: Options): Promise<number> {
  const path = required(options, 'manifest');
  let manifest: BackupManifest;
  try {
    manifest = BackupManifestSchema.parse(JSON.parse((await deps.readFile(path)).toString('utf8')));
  } catch {
    emit(deps, {
      check: 'backup-verify',
      ok: false,
      checks: [
        {
          id: 'MANIFEST_INVALID',
          passed: false,
          detail: 'The latest export manifest is missing or invalid.',
        },
      ],
      failed: ['MANIFEST_INVALID'],
    });
    return 1;
  }
  const artifactPath = options.values.get('artifact');
  const environment = options.values.get('environment');
  const result = evaluateBackupManifest(manifest, {
    now: deps.now(),
    maxAgeHours: positiveInt(options, 'max-age-hours', 30),
    minRetentionDays: positiveInt(options, 'min-retention-days', 30),
    ...(environment === undefined ? {} : { expectedEnvironment: environment }),
    ...(artifactPath === undefined ? {} : { artifact: await deps.readFile(artifactPath) }),
  });
  emit(deps, { check: 'backup-verify', ...result });
  return result.ok ? 0 : 1;
}

async function recoverySnapshot(deps: OpsDependencies, options: Options): Promise<number> {
  const out = required(options, 'out');
  const snapshot = await deps.withDatabase(
    databaseUrl(deps),
    async (query) => await collectRecoverySnapshot(query, deps.now()),
  );
  await deps.writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  emit(deps, {
    check: 'recovery-snapshot',
    ok: true,
    counts: snapshot.counts,
    money: snapshot.money,
  });
  return 0;
}

async function restoreVerify(deps: OpsDependencies, options: Options): Promise<number> {
  const expectedPath = options.values.get('expected');
  let expected: RecoverySnapshot | null = null;
  if (expectedPath !== undefined) {
    expected = RecoverySnapshotSchema.parse(
      JSON.parse((await deps.readFile(expectedPath)).toString('utf8')),
    );
  }
  const incident = options.values.get('incident-start');
  const incidentStartedAt = incident === undefined ? null : new Date(incident);
  if (incidentStartedAt !== null && Number.isNaN(incidentStartedAt.getTime())) {
    throw new UsageError('--incident-start must be an ISO-8601 time.');
  }
  const mfaKeyVersions = (options.values.get('mfa-key-versions') ?? '1')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  const manifest = JSON.parse(
    (
      await deps.readFile(join(deps.repositoryRoot, 'packages/database/migrations/manifest.json'))
    ).toString('utf8'),
  ) as { migrations: { name: string; checksum: string }[] };
  const restored = await deps.withDatabase(
    databaseUrl(deps),
    async (query) => await collectRecoverySnapshot(query, deps.now()),
  );
  const result = evaluateRestore({
    restored,
    expected,
    committedMigrations: manifest.migrations,
    availableMfaKeyVersions: mfaKeyVersions,
    incidentStartedAt,
    now: deps.now(),
  });
  const evidence = {
    check: 'restore-verify',
    ...result,
    verifiedAt: deps.now().toISOString(),
    incidentStartedAt: incidentStartedAt?.toISOString() ?? null,
    restored: { counts: restored.counts, money: restored.money, caseStatus: restored.caseStatus },
  };
  const out = options.values.get('out');
  if (out !== undefined) {
    await deps.writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  emit(deps, evidence);
  return result.ok ? 0 : 1;
}

async function sampleImport(deps: OpsDependencies, options: Options): Promise<number> {
  const outDir = required(options, 'out');
  const asOf = options.values.get('as-of') ?? '2026-06-30';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) {
    throw new UsageError('--as-of must be YYYY-MM-DD.');
  }
  const sample = generateSampleImport({
    clients: positiveInt(options, 'clients', 500),
    casesPerClient: 0.6,
    balanceShare: 0.4,
    seed: positiveInt(options, 'seed', 7),
    service: options.values.get('service') ?? 'Income tax return',
    taxYear: positiveInt(options, 'tax-year', 2026),
    asOfDate: asOf,
    withExceptions: options.flags.has('with-exceptions'),
  });
  await deps.mkdir(outDir);
  for (const [template, content] of Object.entries(sample.files)) {
    await deps.writeFile(join(outDir, `${template.replace('.', '-')}.csv`), content);
  }
  await deps.writeFile(
    join(outDir, 'source-totals.json'),
    `${JSON.stringify(sample.sourceTotals, null, 2)}\n`,
  );
  emit(deps, { check: 'sample-import', ok: true, ...sample.sourceTotals });
  return 0;
}

export async function runOpsCli(argv: readonly string[], deps: OpsDependencies): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (
    parsed.options.flags.has('help') ||
    parsed.command === undefined ||
    parsed.command === 'help'
  ) {
    deps.stdout(USAGE.trimEnd());
    return parsed.command === undefined && !parsed.options.flags.has('help') ? 2 : 0;
  }
  try {
    switch (parsed.command) {
      case 'backup-export':
        return await backupExport(deps, parsed.options);
      case 'backup-decrypt':
        return await backupDecrypt(deps, parsed.options);
      case 'backup-verify':
        return await backupVerify(deps, parsed.options);
      case 'recovery-snapshot':
        return await recoverySnapshot(deps, parsed.options);
      case 'restore-verify':
        return await restoreVerify(deps, parsed.options);
      case 'sample-import':
        return await sampleImport(deps, parsed.options);
      default:
        deps.stderr(`Unknown command "${parsed.command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    // Never print the raw error: driver errors can include connection details.
    emit(deps, {
      check: parsed.command,
      ok: false,
      failed: ['COMMAND_FAILED'],
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return 1;
  }
}

function runPgDump(env: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`pg_dump exited with ${String(code)}`));
    });
  });
}

function defaultDependencies(): OpsDependencies {
  return {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    dump: runPgDump,
    withDatabase: async (connectionString, work) => {
      const mode = new URL(connectionString).searchParams.get('sslmode');
      const sql = postgres(connectionString, {
        max: 1,
        ssl: mode === 'disable' ? false : 'require',
        onnotice: () => undefined,
      });
      try {
        return await work(async (text) => (await sql.unsafe(text)) as Record<string, unknown>[]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    readFile: async (path) => await readFile(path),
    writeFile: async (path, data) => {
      await writeFile(path, data, typeof data === 'string' ? 'utf8' : undefined);
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    repositoryRoot: REPOSITORY_ROOT,
  };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runOpsCli(process.argv.slice(2), defaultDependencies());
}
