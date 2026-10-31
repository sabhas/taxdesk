import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateRepositoryWorkflows, evaluateWorkflowPolicy } from './workflow-policy.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOW_DIRECTORY = join(REPOSITORY_ROOT, '.github/workflows');

function ruleIds(file: string, content: string): string[] {
  return evaluateWorkflowPolicy(file, content).map((violation) => violation.ruleId);
}

const SAFE_PULL_REQUEST_WORKFLOW = [
  'name: CI',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - run: pnpm test',
  '',
].join('\n');

describe('evaluateWorkflowPolicy', () => {
  it('accepts a read-only pull-request workflow with no secrets or environment', () => {
    expect(evaluateWorkflowPolicy('sample.yml', SAFE_PULL_REQUEST_WORKFLOW)).toEqual([]);
  });

  it('rejects pull_request_target', () => {
    expect(
      ruleIds(
        'bad.yml',
        SAFE_PULL_REQUEST_WORKFLOW.replace('pull_request:', 'pull_request_target:'),
      ),
    ).toContain('PR_TARGET_FORBIDDEN');
  });

  it('rejects a pull-request workflow that enters an environment', () => {
    const content = SAFE_PULL_REQUEST_WORKFLOW.replace(
      '    runs-on: ubuntu-latest',
      '    environment: production\n    runs-on: ubuntu-latest',
    );
    expect(ruleIds('bad.yml', content)).toContain('PR_ENVIRONMENT_FORBIDDEN');
  });

  it('rejects a pull-request workflow that reads secrets', () => {
    const content = SAFE_PULL_REQUEST_WORKFLOW.replace(
      '      - run: pnpm test',
      '      - run: pnpm test\n      - run: echo ${{ secrets.PRODUCTION_DATABASE_URL }}',
    );
    expect(ruleIds('bad.yml', content)).toContain('PR_SECRET_FORBIDDEN');
  });

  it('rejects missing permissions and write permissions', () => {
    const missing = SAFE_PULL_REQUEST_WORKFLOW.replace('permissions:\n  contents: read\n', '');
    expect(ruleIds('bad.yml', missing)).toContain('PERMISSIONS_MISSING');

    const write = SAFE_PULL_REQUEST_WORKFLOW.replace(
      '  contents: read',
      '  contents: read\n  packages: write',
    );
    expect(ruleIds('bad.yml', write)).toContain('WRITE_PERMISSION');
  });

  it('rejects floating action refs', () => {
    const content = SAFE_PULL_REQUEST_WORKFLOW.replace(
      'actions/checkout@v4',
      'actions/checkout@main',
    );
    expect(ruleIds('bad.yml', content)).toContain('ACTION_NOT_PINNED');
  });

  it('requires secrets to run inside a protected environment off pull requests', () => {
    const content = [
      'name: Deploy',
      'on:',
      '  push:',
      '    branches: [main]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ${{ secrets.STAGING_DATABASE_URL }}',
      '',
    ].join('\n');
    expect(ruleIds('bad.yml', content)).toContain('SECRETS_REQUIRE_ENVIRONMENT');
  });

  it('rejects an unguarded workflow_run deployment', () => {
    const content = [
      'name: Deploy',
      'on:',
      '  workflow_run:',
      '    workflows: [CI]',
      '    types: [completed]',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  deploy:',
      '    environment:',
      '      name: staging',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ${{ secrets.STAGING_DATABASE_URL }}',
      '',
    ].join('\n');
    expect(ruleIds('bad.yml', content)).toContain('WORKFLOW_RUN_UNGUARDED');
  });

  it('requires a manually supplied deploy ref to be a full commit SHA', () => {
    const content = [
      'name: Deploy',
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      ref:',
      '        required: false',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  deploy:',
      '    environment:',
      '      name: staging',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ${{ inputs.ref }} ${{ secrets.STAGING_DATABASE_URL }}',
      '',
    ].join('\n');
    expect(ruleIds('bad.yml', content)).toContain('DEPLOY_REF_UNVALIDATED');
  });
});

describe('committed workflows', () => {
  it('satisfy the CI and deployment security policy', async () => {
    const result = await evaluateRepositoryWorkflows(REPOSITORY_ROOT);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.workflows).toEqual(
      expect.arrayContaining(['ci.yml', 'deploy-staging.yml', 'platform-posture.yml']),
    );
  });

  it('run every required CI gate with no environment or secrets', async () => {
    const content = await readFile(join(WORKFLOW_DIRECTORY, 'ci.yml'), 'utf8');
    expect(content).toContain('pnpm install --frozen-lockfile');
    expect(content).toContain('pnpm typecheck');
    expect(content).toContain('pnpm lint');
    expect(content).toContain('pnpm test');
    expect(content).toContain('pnpm db:migrate:verify');
    expect(content).toContain('pnpm ci:secrets');
    expect(content).toContain('pnpm ci:config-posture');
    expect(content).toContain('pnpm build');
    expect(content).not.toContain('secrets.');
    expect(content).not.toContain('environment:');
  });

  it('deploy staging only from a successful main-branch push', async () => {
    const content = await readFile(join(WORKFLOW_DIRECTORY, 'deploy-staging.yml'), 'utf8');
    expect(content).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(content).toContain("github.event.workflow_run.event == 'push'");
    expect(content).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(content).toContain('environment:');
    expect(content).toContain('name: staging');
    expect(content).toContain('secrets.STAGING_DATABASE_URL');
    expect(content).not.toContain('secrets.PRODUCTION');
    expect(content).toContain('pnpm ci:config-posture');
    expect(content).toContain('pnpm deploy:api:staging');
    expect(content).toContain('pnpm deploy:web:staging');
  });

  it('alert an operator when the scheduled backup check fails', async () => {
    const content = await readFile(join(WORKFLOW_DIRECTORY, 'platform-posture.yml'), 'utf8');
    expect(content).toContain('schedule:');
    expect(content).toContain('pnpm ci:backup-check');
    expect(content).toContain('if: failure()');
    expect(content).toContain('gh issue create');
  });
});
