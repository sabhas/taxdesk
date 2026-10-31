import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanFiles, scanText } from './secret-scan.js';

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'taxdesk-platform-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('scanText', () => {
  it('detects each high-confidence credential pattern without printing the value', () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const githubToken = ['ghp', '_', 'A'.repeat(36)].join('');
    const slackToken = ['xoxb', '-', '1234567890', 'abc'].join('');
    const googleKey = ['AIza', 'A'.repeat(35)].join('');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJl'].join('.');
    const privateKey = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
    const clientSecret = ['client_secret = "', 's'.repeat(24), '"'].join('');

    const findings = scanText(
      'fixture.txt',
      [awsKey, githubToken, slackToken, googleKey, jwt, privateKey, clientSecret].join('\n'),
    );
    expect(new Set(findings.map((finding) => finding.ruleId))).toEqual(
      new Set([
        'AWS_ACCESS_KEY_ID',
        'GITHUB_TOKEN',
        'SLACK_TOKEN',
        'GOOGLE_API_KEY',
        'JWT',
        'PRIVATE_KEY_BLOCK',
        'GENERIC_SECRET_ASSIGNMENT',
      ]),
    );
    expect(findings.map((finding) => finding.path)).toEqual(findings.map(() => 'fixture.txt'));
    expect(JSON.stringify(findings)).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('ignores documented placeholders', () => {
    const text = [
      'client_secret = "REPLACE_WITH_CLIENT_SECRET"',
      'password: "YOUR_PASSWORD_HERE"',
      'api_key = "<API_KEY>"',
    ].join('\n');
    expect(scanText('example.md', text)).toEqual([]);
  });

  it('reports a line number for a finding', () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const findings = scanText('fixture.txt', `line one\nline two\n${awsKey}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });
});

describe('scanFiles', () => {
  it('flags forbidden credential files even when they contain no token pattern', async () => {
    const directory = await makeTempDir();
    await writeFile(join(directory, '.env'), 'SAFE_LOOKING=true\n', 'utf8');
    await writeFile(join(directory, '.dev.vars'), '# empty\n', 'utf8');
    await writeFile(join(directory, 'deploy.pem'), 'not a real key\n', 'utf8');
    await writeFile(join(directory, '.env.example'), 'DATABASE_URL=<placeholder>\n', 'utf8');
    await writeFile(join(directory, 'README.md'), '# Fixture\n', 'utf8');

    const result = await scanFiles(directory, [
      '.env.example',
      '.env',
      '.dev.vars',
      'README.md',
      'deploy.pem',
      '.wrangler/state/x.json',
    ]);
    expect(result.ok).toBe(false);
    expect(
      result.findings.map((finding) => ({ path: finding.path, ruleId: finding.ruleId })),
    ).toEqual([
      { path: '.dev.vars', ruleId: 'DEV_VARS_FILE' },
      { path: '.env', ruleId: 'ENV_FILE' },
      { path: '.wrangler/state/x.json', ruleId: 'WRANGLER_STATE' },
      { path: 'deploy.pem', ruleId: 'PRIVATE_KEY_FILE' },
    ]);
    expect(result.scannedFiles).toBe(2);
  });

  it('skips lockfiles, build output, and vendored dependencies', async () => {
    const directory = await makeTempDir();
    await writeFile(join(directory, 'index.ts'), 'export const ok = true;\n', 'utf8');
    const result = await scanFiles(directory, [
      'pnpm-lock.yaml',
      'node_modules/pkg/index.js',
      'dist/bundle.js',
      'index.ts',
    ]);
    expect(result.ok).toBe(true);
    expect(result.scannedFiles).toBe(1);
  });

  it('ignores binary files and deduplicates repeated findings', async () => {
    const directory = await makeTempDir();
    await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    await writeFile(join(directory, 'a.txt'), `${awsKey} ${awsKey}\n`, 'utf8');
    const result = await scanFiles(directory, ['binary.bin', 'a.txt']);
    expect(result.scannedFiles).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe('AWS_ACCESS_KEY_ID');
  });
});
