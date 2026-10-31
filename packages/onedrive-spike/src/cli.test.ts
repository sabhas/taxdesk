import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError, defaultReportPath, resolveCliOptions } from './cli.js';

const CLIENT_ID = 'a71adcc8-d925-475a-ad09-b42ea1c10b6e';

describe('defaultReportPath', () => {
  it('anchors the evidence file at the repository root, not the package folder', () => {
    const reportPath = defaultReportPath();

    expect(isAbsolute(reportPath)).toBe(true);
    expect(
      reportPath.endsWith(join('docs', 'product', 'evidence', 'td-005-onedrive-spike-report.json')),
    ).toBe(true);
    // Regression: `pnpm --filter` runs the CLI from the package directory, so a
    // cwd-relative default wrote the report to packages/onedrive-spike/docs/
    // and nobody reviewing the story found it. vitest also runs from the package.
    expect(reportPath.startsWith(process.cwd())).toBe(false);
    expect(reportPath).not.toContain(join('packages', 'onedrive-spike'));
  });
});

describe('resolveCliOptions', () => {
  it('applies the documented defaults', () => {
    const options = resolveCliOptions(['--client-id', CLIENT_ID]);

    expect(options?.clientId).toBe(CLIENT_ID);
    expect(options?.host).toBe('localhost');
    expect(options?.port).toBe(8788);
    expect(options?.skipRevocationCheck).toBe(false);
    expect(options?.reportPath).toBe(defaultReportPath());
    expect(options?.runId).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns no options when help is requested', () => {
    expect(resolveCliOptions(['--help'])).toBeUndefined();
    expect(resolveCliOptions(['-h'])).toBeUndefined();
  });

  it('accepts an explicit report path and callback port', () => {
    const options = resolveCliOptions([
      '--client-id',
      CLIENT_ID,
      '--report',
      '/tmp/report.json',
      '--port',
      '9000',
      '--operator',
      'release-engineer',
      '--skip-revocation-check',
    ]);

    expect(options?.reportPath).toBe('/tmp/report.json');
    expect(options?.port).toBe(9000);
    expect(options?.operator).toBe('release-engineer');
    expect(options?.skipRevocationCheck).toBe(true);
  });

  it('rejects an unknown or positional argument with a usage error', () => {
    expect(() => resolveCliOptions(['--bogus'])).toThrow(UsageError);
    expect(() => resolveCliOptions(['stray-value'])).toThrow(UsageError);
  });

  it('rejects a client id that is not a UUID', () => {
    // The Directory (tenant) ID and Object ID are the same shape, so a wrong copy
    // must still be reported clearly rather than failing later against Microsoft.
    expect(() => resolveCliOptions(['--client-id', 'not-a-uuid'])).toThrow(UsageError);
    expect(() => resolveCliOptions([])).toThrow(UsageError);
  });

  it('rejects a port outside the usable range', () => {
    expect(() => resolveCliOptions(['--client-id', CLIENT_ID, '--port', '80'])).toThrow(UsageError);
    expect(() => resolveCliOptions(['--client-id', CLIENT_ID, '--port', 'abc'])).toThrow(
      UsageError,
    );
  });

  it('rejects a callback host that would produce an invalid redirect URI', () => {
    expect(() =>
      resolveCliOptions(['--client-id', CLIENT_ID, '--host', 'taxdesk.example.com']),
    ).toThrow(UsageError);
  });
});
