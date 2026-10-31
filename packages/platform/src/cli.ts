import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CheckReportSchema, PlatformPostureEvidenceSchema, type CheckResult } from './contracts.js';
import {
  collectDatabasePosture,
  type DatabasePostureOptions,
  type DatabasePostureReport,
} from './database-posture.js';
import { evaluateStagingConfig } from './config-posture.js';
import { evaluatePlatformPosture } from './posture.js';
import { scanRepository, type SecretScanResult } from './secret-scan.js';
import { runGateSelfTest } from './selftest.js';
import {
  runStagingSmoke,
  type StagingSmokeOptions,
  type StagingSmokeResult,
} from './staging-smoke.js';
import { evaluateRepositoryWorkflows, type WorkflowPolicyResult } from './workflow-policy.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const USAGE = `TaxDesk platform checks (TD-006)

Usage:
  platform secrets          Scan tracked files for committed secrets.
  platform workflows        Enforce the CI and deployment workflow security policy.
  platform config-posture   Verify the committed staging Hyperdrive and Pages config.
  platform selftest         Prove each gate rejects a deliberately failing input.
  platform staging-smoke    Verify the deployed staging Pages host.
  platform database-posture Verify staging TLS and least-privilege database role.
  platform backup-check     Validate staging recovery and alerting evidence.

Environment:
  STAGING_WEB_URL                    Base URL of the staging Pages deployment.
  RELEASE_VERSION                    Expected deployed commit SHA.
  DATABASE_URL                       Staging database connection string.
  PLATFORM_POSTURE_EVIDENCE_JSON     Posture evidence JSON (preferred in CI).
  PLATFORM_POSTURE_EVIDENCE_PATH     Path to a posture evidence JSON file.
`;

/** Injected dependencies keep the CLI testable without a network or database. */
export interface PlatformCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly scanRepository: (root: string) => Promise<SecretScanResult>;
  readonly evaluateRepositoryWorkflows: (root: string) => Promise<WorkflowPolicyResult>;
  readonly runStagingSmoke: (options: StagingSmokeOptions) => Promise<StagingSmokeResult>;
  readonly collectDatabasePosture: (
    connectionString: string,
    options?: DatabasePostureOptions,
  ) => Promise<DatabasePostureReport>;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly now: () => Date;
}

class UsageError extends Error {}

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseFlags(argv: readonly string[]): {
  command: string | undefined;
  options: ParsedOptions;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--') {
      continue;
    }
    if (argument === '--help') {
      flags.add('help');
      continue;
    }
    if (argument === '--allow-http') {
      flags.add('allow-http');
      continue;
    }
    if (argument === '--allow-insecure-local') {
      flags.add('allow-insecure-local');
      continue;
    }
    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`Option --${name} requires a value.`);
      }
      values.set(name, next);
      index += 1;
      continue;
    }
    if (command === undefined) {
      command = argument;
    } else {
      throw new UsageError(`Unexpected argument "${argument}".`);
    }
  }

  return { command, options: { values, flags } };
}

function readNumber(options: ParsedOptions, name: string): number | undefined {
  const raw = options.values.get(name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer.`);
  }
  return value;
}

function readValue(options: ParsedOptions, name: string): string | undefined {
  return options.values.get(name);
}

function emit(deps: PlatformCliDependencies, report: unknown): void {
  deps.stdout(JSON.stringify(report));
}

function report(check: string, ok: boolean, checks: readonly CheckResult[]): unknown {
  return CheckReportSchema.parse({
    check,
    ok,
    checks,
    failed: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
  });
}

async function commandSecrets(deps: PlatformCliDependencies): Promise<number> {
  const result = await deps.scanRepository(deps.cwd);
  emit(deps, result);
  return result.ok ? 0 : 1;
}

async function commandWorkflows(deps: PlatformCliDependencies): Promise<number> {
  const result = await deps.evaluateRepositoryWorkflows(deps.cwd);
  emit(deps, result);
  return result.ok ? 0 : 1;
}

async function commandConfigPosture(deps: PlatformCliDependencies): Promise<number> {
  const [apiWranglerToml, webWranglerToml, databaseClientSource] = await Promise.all([
    deps.readTextFile(join(deps.cwd, 'packages/api/wrangler.toml')),
    deps.readTextFile(join(deps.cwd, 'packages/web/wrangler.toml')),
    deps.readTextFile(join(deps.cwd, 'packages/database/src/index.ts')),
  ]);
  const result = evaluateStagingConfig({ apiWranglerToml, webWranglerToml, databaseClientSource });
  emit(deps, result);
  return result.ok ? 0 : 1;
}

function commandSelfTest(deps: PlatformCliDependencies): number {
  const result = runGateSelfTest();
  emit(deps, result);
  return result.ok ? 0 : 1;
}

async function commandStagingSmoke(
  deps: PlatformCliDependencies,
  options: ParsedOptions,
): Promise<number> {
  const baseUrl = readValue(options, 'url') ?? deps.env['STAGING_WEB_URL'];
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new UsageError('STAGING_WEB_URL or --url is required.');
  }
  const expectedReleaseVersion = readValue(options, 'release') ?? deps.env['RELEASE_VERSION'];
  const requestId = readValue(options, 'request-id');
  const result = await deps.runStagingSmoke({
    baseUrl,
    ...(expectedReleaseVersion === undefined || expectedReleaseVersion.length === 0
      ? {}
      : { expectedReleaseVersion }),
    ...(requestId === undefined ? {} : { requestId }),
    requireHttps: !options.flags.has('allow-http'),
  });
  emit(deps, result);
  return result.ok ? 0 : 1;
}

async function commandDatabasePosture(
  deps: PlatformCliDependencies,
  options: ParsedOptions,
): Promise<number> {
  const connectionString = readValue(options, 'database-url') ?? deps.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new UsageError('DATABASE_URL or --database-url is required.');
  }
  const result = await deps.collectDatabasePosture(connectionString, {
    allowInsecureLocal: options.flags.has('allow-insecure-local'),
  });
  emit(deps, { check: 'database-posture', ...result });
  return result.ok ? 0 : 1;
}

async function readEvidence(
  deps: PlatformCliDependencies,
  options: ParsedOptions,
): Promise<{ text: string } | { missing: true }> {
  const path = readValue(options, 'evidence') ?? deps.env['PLATFORM_POSTURE_EVIDENCE_PATH'];
  if (path !== undefined && path.length > 0) {
    return { text: await deps.readTextFile(path) };
  }
  const inline = deps.env['PLATFORM_POSTURE_EVIDENCE_JSON'];
  if (inline !== undefined && inline.trim().length > 0) {
    return { text: inline };
  }
  return { missing: true };
}

async function commandBackupCheck(
  deps: PlatformCliDependencies,
  options: ParsedOptions,
): Promise<number> {
  const evidence = await readEvidence(deps, options);
  if ('missing' in evidence) {
    emit(
      deps,
      report('platform-posture', false, [
        {
          id: 'EVIDENCE_MISSING',
          passed: false,
          detail: 'No posture evidence was supplied to the recovery gate.',
        },
      ]),
    );
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(evidence.text) as unknown;
  } catch {
    emit(
      deps,
      report('platform-posture', false, [
        {
          id: 'EVIDENCE_INVALID_JSON',
          passed: false,
          detail: 'Posture evidence is not valid JSON.',
        },
      ]),
    );
    return 1;
  }

  const parsedEvidence = PlatformPostureEvidenceSchema.safeParse(parsedJson);
  if (!parsedEvidence.success) {
    emit(deps, {
      check: 'platform-posture',
      ok: false,
      checks: [
        {
          id: 'EVIDENCE_INVALID',
          passed: false,
          detail: 'Posture evidence does not match the required contract.',
        },
      ],
      failed: ['EVIDENCE_INVALID'],
      issues: parsedEvidence.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    });
    return 1;
  }

  const maxExportAgeHours = readNumber(options, 'max-export-age-hours');
  const maxEvidenceAgeDays = readNumber(options, 'max-evidence-age-days');
  const maxPitrEvidenceAgeDays = readNumber(options, 'max-pitr-age-days');
  const maxAlertTestAgeDays = readNumber(options, 'max-alert-age-days');
  const evaluation = evaluatePlatformPosture(parsedEvidence.data, {
    now: deps.now(),
    ...(maxExportAgeHours === undefined ? {} : { maxExportAgeHours }),
    ...(maxEvidenceAgeDays === undefined ? {} : { maxEvidenceAgeDays }),
    ...(maxPitrEvidenceAgeDays === undefined ? {} : { maxPitrEvidenceAgeDays }),
    ...(maxAlertTestAgeDays === undefined ? {} : { maxAlertTestAgeDays }),
  });
  emit(deps, { check: 'platform-posture', ...evaluation });
  return evaluation.ok ? 0 : 1;
}

/**
 * Runs one CLI invocation and returns the process exit code: 0 success, 1 a
 * failed gate, 2 a usage error. The final stdout line is a JSON report unless a
 * usage error prevented a command from running.
 */
export async function runCli(
  argv: readonly string[],
  deps: PlatformCliDependencies,
): Promise<number> {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.options.flags.has('help') || parsed.command === 'help') {
    deps.stdout(USAGE.trimEnd());
    return 0;
  }

  if (parsed.command === undefined) {
    deps.stderr(USAGE.trimEnd());
    return 2;
  }

  try {
    switch (parsed.command) {
      case 'secrets':
        return await commandSecrets(deps);
      case 'workflows':
        return await commandWorkflows(deps);
      case 'config-posture':
        return await commandConfigPosture(deps);
      case 'selftest':
        return commandSelfTest(deps);
      case 'staging-smoke':
        return await commandStagingSmoke(deps, parsed.options);
      case 'database-posture':
        return await commandDatabasePosture(deps, parsed.options);
      case 'backup-check':
        return await commandBackupCheck(deps, parsed.options);
      default:
        deps.stderr(`Unknown command "${parsed.command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    // Never print the raw error: a driver error can include connection details.
    emit(deps, {
      check: parsed.command,
      ok: false,
      checks: [],
      failed: ['COMMAND_FAILED'],
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return 1;
  }
}

function defaultDependencies(): PlatformCliDependencies {
  return {
    env: process.env,
    cwd: REPOSITORY_ROOT,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    scanRepository: (root) => scanRepository(root),
    evaluateRepositoryWorkflows: (root) => evaluateRepositoryWorkflows(root),
    runStagingSmoke: (options) => runStagingSmoke(options),
    collectDatabasePosture: (connectionString, options) =>
      collectDatabasePosture(connectionString, options ?? {}),
    readTextFile: async (path) => await readFile(path, 'utf8'),
    now: () => new Date(),
  };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await runCli(process.argv.slice(2), defaultDependencies());
}
