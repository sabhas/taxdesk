import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkflowViolation {
  readonly file: string;
  readonly ruleId: string;
  readonly message: string;
}

export interface WorkflowPolicyResult {
  readonly check: 'workflow-policy';
  readonly ok: boolean;
  readonly workflows: readonly string[];
  readonly violations: readonly WorkflowViolation[];
}

const WORKFLOW_DIRECTORY = '.github/workflows';

const REQUIRED_WORKFLOWS = [
  'ci.yml',
  'deploy-staging.yml',
  'platform-posture.yml',
  'backup-export.yml',
];

/** Scheduled jobs that alert an operator by opening an issue (TD-006, TD-707). */
const ALERTING_WORKFLOWS = new Set(['platform-posture.yml', 'backup-export.yml']);

const CI_REQUIRED_COMMANDS = [
  'pnpm install --frozen-lockfile',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm db:migrate:verify',
  'pnpm ci:secrets',
  'pnpm ci:config-posture',
  'pnpm build',
];

const WRITE_PERMISSION_PATTERN =
  /^\s+(?:actions|checks|contents|deployments|id-token|packages|pull-requests|security-events|statuses):\s*write\b/m;

const ISSUES_WRITE_PATTERN = /^\s+issues:\s*write\b/m;

const PINNED_ACTION_PATTERN = /^(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/;

function hasPullRequestTrigger(content: string): boolean {
  return /^\s{2,8}pull_request\s*:/m.test(content);
}

function hasEnvironment(content: string, name?: string): boolean {
  if (name === undefined) {
    return /^\s*environment:/m.test(content);
  }
  return new RegExp(`environment:\\s*\\n\\s+name:\\s*${name}\\b`).test(content);
}

function runsCommand(content: string, command: string): boolean {
  return content.split('\n').some((line) => {
    const match = /^\s*(?:-\s*)?run:\s*(.+)$/.exec(line);
    if (match?.[1] === undefined) {
      return false;
    }
    const run = match[1].trim();
    return run === command || run.startsWith(`${command} `);
  });
}

/** Like `runsCommand`, but also finds the command inside a multi-line `run: |` block. */
function invokesCommand(content: string, command: string): boolean {
  return (
    runsCommand(content, command) ||
    content.split('\n').some((line) => {
      const trimmed = line.trim();
      return trimmed === command || trimmed.startsWith(`${command} `);
    })
  );
}

function usesReferences(content: string): string[] {
  return [...content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)]
    .map((match) => match[1])
    .filter((reference): reference is string => reference !== undefined);
}

function violationsForWorkflow(file: string, content: string): WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  const add = (ruleId: string, message: string): void => {
    violations.push({ file, ruleId, message });
  };

  if (content.includes('pull_request_target')) {
    add('PR_TARGET_FORBIDDEN', 'pull_request_target is forbidden: it exposes repository secrets.');
  }

  if (!/^permissions:/m.test(content)) {
    add('PERMISSIONS_MISSING', 'Every workflow must declare top-level read-only permissions.');
  }

  if (WRITE_PERMISSION_PATTERN.test(content)) {
    add('WRITE_PERMISSION', 'Workflows must not request write permissions they do not need.');
  }

  if (
    ISSUES_WRITE_PATTERN.test(content) &&
    !(ALERTING_WORKFLOWS.has(file) && content.includes('gh issue create'))
  ) {
    add(
      'WRITE_PERMISSION',
      'Only the scheduled posture and backup alert workflows may request issues: write.',
    );
  }

  for (const reference of usesReferences(content)) {
    if (reference.startsWith('./') || reference.startsWith('docker://')) {
      continue;
    }
    const separator = reference.lastIndexOf('@');
    const ref = separator === -1 ? '' : reference.slice(separator + 1);
    if (!PINNED_ACTION_PATTERN.test(ref)) {
      add(
        'ACTION_NOT_PINNED',
        `Action "${reference}" must use a version tag or commit SHA, not a floating ref.`,
      );
    }
  }

  const hasSecrets = /\bsecrets\.[A-Za-z0-9_]+/.test(content);
  const pullRequestBuild = hasPullRequestTrigger(content);

  if (pullRequestBuild && hasEnvironment(content)) {
    add(
      'PR_ENVIRONMENT_FORBIDDEN',
      'A pull_request workflow must not enter a protected environment.',
    );
  }

  if (pullRequestBuild && hasSecrets) {
    add(
      'PR_SECRET_FORBIDDEN',
      'A pull_request workflow must not read repository or environment secrets.',
    );
  }

  if (!pullRequestBuild && hasSecrets && !hasEnvironment(content)) {
    add(
      'SECRETS_REQUIRE_ENVIRONMENT',
      'A workflow that reads secrets must run inside a protected environment.',
    );
  }

  if (/^\s{2}workflow_run\s*:/m.test(content)) {
    const guarded =
      /workflow_run\.event\s*==\s*'push'/.test(content) &&
      /workflow_run\.head_branch\s*==\s*'main'/.test(content) &&
      /workflow_run\.conclusion\s*==\s*'success'/.test(content);
    if (!guarded) {
      add(
        'WORKFLOW_RUN_UNGUARDED',
        'workflow_run deployments must require a successful push run on main.',
      );
    }
  }

  if (content.includes('inputs.ref') && !content.includes('[0-9a-f]{40}')) {
    add(
      'DEPLOY_REF_UNVALIDATED',
      'A manually supplied deployment ref must be validated as a full commit SHA.',
    );
  }

  return violations;
}

function workflowSpecificViolations(file: string, content: string): WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  const add = (ruleId: string, message: string): void => {
    violations.push({ file, ruleId, message });
  };

  if (file === 'ci.yml') {
    for (const command of CI_REQUIRED_COMMANDS) {
      if (!runsCommand(content, command)) {
        add('CI_STEP_MISSING', `Required CI command is missing: ${command}.`);
      }
    }
    if (hasEnvironment(content)) {
      add(
        'CI_ENVIRONMENT_FORBIDDEN',
        'The pull-request CI workflow must not enter an environment.',
      );
    }
    if (/\bsecrets\./.test(content)) {
      add(
        'CI_SECRET_FORBIDDEN',
        'The CI workflow must run without repository or environment secrets.',
      );
    }
  }

  if (file === 'deploy-staging.yml') {
    if (!hasEnvironment(content, 'staging')) {
      add('STAGING_ENVIRONMENT_MISSING', 'Staging deployment must run in the staging environment.');
    }
    for (const command of [
      'pnpm db:migrate',
      'pnpm db:migrate:status',
      'pnpm ci:config-posture',
      'pnpm ci:db-posture',
      'pnpm ci:backup-check',
      'pnpm deploy:api:staging',
      'pnpm deploy:web:staging',
      'pnpm ci:staging-smoke',
    ]) {
      if (!runsCommand(content, command)) {
        add('DEPLOY_STEP_MISSING', `Staging deployment step is missing: ${command}.`);
      }
    }
    if (content.includes('secrets.PRODUCTION')) {
      add('PRODUCTION_SECRET_IN_STAGING', 'The staging workflow must not read production secrets.');
    }
  }

  if (file === 'platform-posture.yml') {
    if (!/^\s{2}schedule\s*:/m.test(content)) {
      add('RECOVERY_SCHEDULE_MISSING', 'The platform posture check must run on a schedule.');
    }
    if (!runsCommand(content, 'pnpm ci:backup-check')) {
      add('BACKUP_CHECK_MISSING', 'The scheduled check must run the backup/posture gate.');
    }
    if (!content.includes('if: failure()')) {
      add('ALERT_STEP_MISSING', 'A failed check must run an operator alert step.');
    }
    if (!content.includes('gh issue create')) {
      add('ALERT_CHANNEL_MISSING', 'A failed check must open an operator-visible issue.');
    }
    if (!invokesCommand(content, 'pnpm ci:backup-verify')) {
      add(
        'EXPORT_VERIFY_MISSING',
        'The scheduled check must verify the latest independent export manifest.',
      );
    }
  }

  if (file === 'backup-export.yml') {
    if (!/^\s{2}schedule\s*:/m.test(content)) {
      add('BACKUP_SCHEDULE_MISSING', 'The independent export must run on a schedule.');
    }
    if (!hasEnvironment(content)) {
      add('BACKUP_ENVIRONMENT_MISSING', 'The export must run in a protected environment.');
    }
    if (!runsCommand(content, 'pnpm ops:backup-export')) {
      add('BACKUP_EXPORT_MISSING', 'The workflow must run the encrypted export.');
    }
    if (!content.includes('if: failure()') || !content.includes('gh issue create')) {
      add('ALERT_STEP_MISSING', 'A failed export must open an operator-visible issue.');
    }
    if (content.includes('secrets.PRODUCTION')) {
      add('PRODUCTION_SECRET_IN_STAGING', 'The staging export must not read production secrets.');
    }
  }

  return violations;
}

/** Evaluates one workflow file against the TaxDesk CI security policy. */
export function evaluateWorkflowPolicy(file: string, content: string): WorkflowViolation[] {
  return [...violationsForWorkflow(file, content), ...workflowSpecificViolations(file, content)];
}

/**
 * Evaluates every committed workflow and verifies that the required CI and
 * deployment workflows exist. This is the automated proof that pull-request
 * builds cannot read production secrets.
 */
export async function evaluateRepositoryWorkflows(root: string): Promise<WorkflowPolicyResult> {
  const directory = join(root, WORKFLOW_DIRECTORY);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return {
      check: 'workflow-policy',
      ok: false,
      workflows: [],
      violations: [
        {
          file: WORKFLOW_DIRECTORY,
          ruleId: 'WORKFLOWS_MISSING',
          message: 'No workflow directory exists.',
        },
      ],
    };
  }

  const workflows = entries
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort();
  const violations: WorkflowViolation[] = [];

  for (const required of REQUIRED_WORKFLOWS) {
    if (!workflows.includes(required)) {
      violations.push({
        file: WORKFLOW_DIRECTORY,
        ruleId: 'REQUIRED_WORKFLOW_MISSING',
        message: `Required workflow is missing: ${required}.`,
      });
    }
  }

  for (const workflow of workflows) {
    const content = await readFile(join(directory, workflow), 'utf8');
    violations.push(...evaluateWorkflowPolicy(workflow, content));
  }

  return {
    check: 'workflow-policy',
    ok: violations.length === 0,
    workflows,
    violations,
  };
}
