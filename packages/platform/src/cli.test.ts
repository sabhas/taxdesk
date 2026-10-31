import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runCli, type PlatformCliDependencies } from './cli.js';
import type { DatabasePrivileges, PlatformPostureEvidence } from './contracts.js';
import type { DatabasePostureReport } from './database-posture.js';
import type { SecretScanResult } from './secret-scan.js';
import type { StagingSmokeResult } from './staging-smoke.js';
import type { WorkflowPolicyResult } from './workflow-policy.js';

function posture(): DatabasePostureReport {
  const privileges: DatabasePrivileges = {
    tlsInUse: true,
    connectionRequiresTls: true,
    roleIsSuperuser: false,
    roleCanCreateDatabases: false,
    roleCanCreateRoles: false,
    roleCanReplicate: false,
    roleBypassesRowLevelSecurity: false,
    roleOwnsDatabase: false,
  };
  return { ok: true, checks: [], failed: [], privileges };
}

function healthySmoke(): StagingSmokeResult {
  return { check: 'staging-smoke', ok: true, checks: [], failed: [], releaseVersion: 'abc123' };
}

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

function dependencies(overrides: Partial<PlatformCliDependencies> = {}): PlatformCliDependencies {
  const secretResult: SecretScanResult = {
    check: 'secret-scan',
    ok: true,
    scannedFiles: 1,
    findings: [],
  };
  const workflowResult: WorkflowPolicyResult = {
    check: 'workflow-policy',
    ok: true,
    workflows: [],
    violations: [],
  };
  return {
    env: {},
    cwd: '/repo',
    stdout: vi.fn(),
    stderr: vi.fn(),
    scanRepository: vi.fn(async (): Promise<SecretScanResult> => secretResult),
    evaluateRepositoryWorkflows: vi.fn(async (): Promise<WorkflowPolicyResult> => workflowResult),
    runStagingSmoke: vi.fn(async () => healthySmoke()),
    collectDatabasePosture: vi.fn(async () => posture()),
    readTextFile: vi.fn(async () => JSON.stringify(evidence())),
    now: () => new Date('2026-11-04T12:00:00Z'),
    ...overrides,
  };
}

type LineMock = Mock<(line: string) => void>;

interface Captured {
  readonly deps: PlatformCliDependencies;
  readonly stdout: LineMock;
  readonly stderr: LineMock;
}

function capture(overrides: Partial<PlatformCliDependencies> = {}): Captured {
  const stdout = vi.fn<(line: string) => void>();
  const stderr = vi.fn<(line: string) => void>();
  const deps = dependencies({ stdout, stderr, ...overrides });
  return { deps, stdout, stderr };
}

function lastJson(stdout: LineMock): unknown {
  const line = stdout.mock.calls.at(-1)?.[0] ?? '';
  return JSON.parse(line) as unknown;
}

describe('runCli', () => {
  it('requires a command', async () => {
    const { deps, stderr } = capture();
    expect(await runCli([], deps)).toBe(2);
    expect(stderr).toHaveBeenCalled();
  });

  it('rejects an unknown command', async () => {
    const { deps, stderr } = capture();
    expect(await runCli(['nope'], deps)).toBe(2);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('Unknown command');
  });

  it('prints usage for --help', async () => {
    const { deps, stdout } = capture();
    expect(await runCli(['--help'], deps)).toBe(0);
    expect(String(stdout.mock.calls[0]?.[0])).toContain('TaxDesk platform checks');
  });

  it('runs the secret scan and fails on findings', async () => {
    const { deps, stdout } = capture({
      scanRepository: vi.fn(async (): Promise<SecretScanResult> => ({
        check: 'secret-scan',
        ok: false,
        scannedFiles: 3,
        findings: [{ path: '.env', line: 1, ruleId: 'ENV_FILE' }],
      })),
    });
    expect(await runCli(['secrets'], deps)).toBe(1);
    expect(lastJson(stdout)).toMatchObject({ check: 'secret-scan', ok: false });
  });

  it('runs the workflow policy gate', async () => {
    const { deps } = capture({
      evaluateRepositoryWorkflows: vi.fn(async (): Promise<WorkflowPolicyResult> => ({
        check: 'workflow-policy',
        ok: true,
        workflows: ['ci.yml'],
        violations: [],
      })),
    });
    expect(await runCli(['workflows'], deps)).toBe(0);
  });

  it('verifies the committed staging configuration', async () => {
    const readTextFile = vi.fn(async (path: string) => {
      if (path.endsWith('packages/api/wrangler.toml')) {
        return [
          '[env.staging]',
          'name = "taxdesk-api-staging"',
          '',
          '[[env.staging.hyperdrive]]',
          'binding = "HYPERDRIVE"',
          'id = "0123456789abcdef0123456789abcdef"',
          '',
        ].join('\n');
      }
      if (path.endsWith('packages/web/wrangler.toml')) {
        return [
          '[env.preview]',
          '[[env.preview.services]]',
          'binding = "API"',
          'service = "taxdesk-api-staging"',
          '',
        ].join('\n');
      }
      return "postgres(connectionString, { prepare: false, ssl: 'require' });";
    });
    const { deps, stdout } = capture({ readTextFile });
    expect(await runCli(['config-posture'], deps)).toBe(0);
    expect(lastJson(stdout)).toMatchObject({ check: 'config-posture', ok: true });
  });

  it('proves each gate rejects a deliberately failing input', async () => {
    const { deps, stdout } = capture();
    expect(await runCli(['selftest'], deps)).toBe(0);
    expect(lastJson(stdout)).toMatchObject({ check: 'gate-selftest', ok: true });
  });

  it('requires a staging URL for the smoke check', async () => {
    const { deps } = capture();
    expect(await runCli(['staging-smoke'], deps)).toBe(2);
  });

  it('passes the staging URL and release version to the smoke check', async () => {
    const runStagingSmoke = vi.fn(async () => healthySmoke());
    const { deps, stdout } = capture({ runStagingSmoke });
    expect(
      await runCli(
        ['staging-smoke', '--url', 'https://staging.example.test', '--release', 'abc123'],
        deps,
      ),
    ).toBe(0);
    expect(runStagingSmoke).toHaveBeenCalledWith({
      baseUrl: 'https://staging.example.test',
      expectedReleaseVersion: 'abc123',
      requireHttps: true,
    });
    expect(lastJson(stdout)).toMatchObject({ check: 'staging-smoke', ok: true });
  });

  it('requires DATABASE_URL for the database posture check', async () => {
    const { deps } = capture();
    expect(await runCli(['database-posture'], deps)).toBe(2);
  });

  it('evaluates database posture with the supplied connection string', async () => {
    const collectDatabasePosture = vi.fn(async () => posture());
    const { deps, stdout } = capture({ collectDatabasePosture });
    expect(
      await runCli(['database-posture', '--database-url', 'postgres://h/db?sslmode=require'], deps),
    ).toBe(0);
    expect(collectDatabasePosture).toHaveBeenCalledWith('postgres://h/db?sslmode=require', {
      allowInsecureLocal: false,
    });
    expect(lastJson(stdout)).toMatchObject({ check: 'database-posture', ok: true });
  });

  it('fails closed when recovery evidence is missing', async () => {
    const { deps, stdout } = capture({ env: {} });
    expect(await runCli(['backup-check'], deps)).toBe(1);
    expect(lastJson(stdout)).toMatchObject({
      check: 'platform-posture',
      ok: false,
      failed: ['EVIDENCE_MISSING'],
    });
  });

  it('rejects invalid JSON evidence without echoing it', async () => {
    const { deps, stdout } = capture({
      readTextFile: vi.fn(async () => '{not-json'),
    });
    expect(await runCli(['backup-check', '--evidence', 'evidence.json'], deps)).toBe(1);
    expect(lastJson(stdout)).toMatchObject({ failed: ['EVIDENCE_INVALID_JSON'] });
    expect(JSON.stringify(stdout.mock.calls)).not.toContain('postgres://user:secret');
  });

  it('rejects evidence that does not match the contract and lists only field paths', async () => {
    const { deps, stdout } = capture({
      readTextFile: vi.fn(async () => JSON.stringify({ ...evidence(), environment: 'production' })),
    });
    expect(await runCli(['backup-check', '--evidence', 'evidence.json'], deps)).toBe(1);
    const output = lastJson(stdout) as { failed: string[]; issues: { path: string }[] };
    expect(output.failed).toEqual(['EVIDENCE_INVALID']);
    expect(output.issues.some((issue) => issue.path === 'environment')).toBe(true);
  });

  it('passes fresh, complete recovery evidence', async () => {
    const { deps } = capture();
    expect(await runCli(['backup-check', '--evidence', 'evidence.json'], deps)).toBe(0);
  });

  it('fails stale or incomplete recovery evidence', async () => {
    const stale = evidence();
    stale.independentExports.lastSuccessAt = '2026-10-01T00:00:00Z';
    const { deps, stdout } = capture({
      readTextFile: vi.fn(async () => JSON.stringify(stale)),
    });
    expect(await runCli(['backup-check', '--evidence', 'evidence.json'], deps)).toBe(1);
    expect(lastJson(stdout)).toMatchObject({ ok: false });
  });
});
