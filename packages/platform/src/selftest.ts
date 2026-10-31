import type { PlatformPostureEvidence } from './contracts.js';
import { evaluatePlatformPosture } from './posture.js';
import { scanText } from './secret-scan.js';
import { evaluateWorkflowPolicy } from './workflow-policy.js';

export interface GateSelfTestCase {
  readonly id: string;
  readonly rejected: boolean;
}

export interface GateSelfTestResult {
  readonly check: 'gate-selftest';
  readonly ok: boolean;
  readonly cases: readonly GateSelfTestCase[];
  readonly failed: readonly string[];
}

function validEvidence(): PlatformPostureEvidence {
  return {
    schemaVersion: 1,
    environment: 'staging',
    recordedAt: '2026-11-04T11:00:00Z',
    recordedBy: 'CI selftest',
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

/**
 * Proves that each gate rejects a deliberately failing input. CI runs this so
 * the "CI blocks a deliberately failing check" exit criterion is demonstrated
 * on every build, not only during a manual test.
 */
export function runGateSelfTest(): GateSelfTestResult {
  const fakeAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const secretRejected = scanText('fixture.txt', `aws_access_key_id = "${fakeAwsKey}"`).length > 0;

  const badWorkflow = [
    'name: Unsafe',
    'on:',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  deploy:',
    '    environment: production',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo "${{ secrets.PRODUCTION_DATABASE_URL }}"',
    '',
  ].join('\n');
  const workflowRejected = evaluateWorkflowPolicy('unsafe.yml', badWorkflow).length > 0;

  const valid = validEvidence();
  const failingEvidence: PlatformPostureEvidence = {
    ...valid,
    pointInTimeRecovery: { ...valid.pointInTimeRecovery, enabled: false },
    independentExports: {
      ...valid.independentExports,
      storedOutsideDatabaseProvider: false,
      lastSuccessAt: '2026-10-01T00:00:00Z',
    },
    alerting: { ...valid.alerting, testFailureAlerted: false },
  };
  const postureRejected = !evaluatePlatformPosture(failingEvidence, {
    now: new Date('2026-11-04T12:00:00Z'),
  }).ok;

  const cases: GateSelfTestCase[] = [
    { id: 'SECRET_PATTERN_REJECTED', rejected: secretRejected },
    { id: 'UNSAFE_WORKFLOW_REJECTED', rejected: workflowRejected },
    { id: 'FAILING_POSTURE_REJECTED', rejected: postureRejected },
  ];
  const failed = cases.filter((entry) => !entry.rejected).map((entry) => entry.id);
  return { check: 'gate-selftest', ok: failed.length === 0, cases, failed };
}
