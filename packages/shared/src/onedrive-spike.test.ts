import { describe, expect, it } from 'vitest';
import {
  ONEDRIVE_SPIKE_SCENARIOS,
  ONEDRIVE_SPIKE_SCOPES,
  OnedriveSpikeRedirectUriSchema,
  OnedriveSpikeReportSchema,
  OnedriveSpikeScenarioResultSchema,
  SpikeSafeTextSchema,
  containsSpikeSecret,
} from './onedrive-spike.js';

const validResult = {
  scenario: 'consent',
  status: 'passed',
  durationMs: 1200,
  httpStatus: 200,
  detail: 'Delegated consent completed for the app folder scope.',
  metrics: { 'token.accessTokenExpiresInSeconds': 3600 },
};

const validReport = {
  reportVersion: 1,
  story: 'TD-005',
  recordedAt: '2026-11-04T09:15:00.000Z',
  operator: 'release-engineer',
  environment: 'non-production',
  accountType: 'personal',
  tenant: 'consumers',
  applicationId: '8f2f2f3a-0b3c-4d5e-8f90-1a2b3c4d5e6f',
  redirectUri: 'http://localhost:8788/oauth/callback',
  requestedScopes: ['offline_access', 'Files.ReadWrite.AppFolder'],
  grantedScopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
  results: ONEDRIVE_SPIKE_SCENARIOS.map((scenario) => ({ ...validResult, scenario })),
  outcome: 'passed',
  blockingDecision: { raised: false },
};

describe('OneDrive spike scopes', () => {
  it('requests only the app-folder scope and offline access', () => {
    expect([...ONEDRIVE_SPIKE_SCOPES]).toEqual(['offline_access', 'Files.ReadWrite.AppFolder']);
  });

  it('never requests tenant-wide or whole-drive delegated permissions', () => {
    expect(ONEDRIVE_SPIKE_SCOPES).not.toContain('Files.ReadWrite');
    expect(ONEDRIVE_SPIKE_SCOPES).not.toContain('Files.ReadWrite.All');
    expect(ONEDRIVE_SPIKE_SCOPES).not.toContain('Files.Read.All');
    expect(ONEDRIVE_SPIKE_SCOPES).not.toContain('Sites.ReadWrite.All');
  });
});

describe('OnedriveSpikeRedirectUriSchema', () => {
  it('accepts a registered loopback callback', () => {
    expect(
      OnedriveSpikeRedirectUriSchema.safeParse('http://localhost:8788/oauth/callback').success,
    ).toBe(true);
    expect(
      OnedriveSpikeRedirectUriSchema.safeParse('http://127.0.0.1:8788/oauth/callback').success,
    ).toBe(true);
    expect(
      OnedriveSpikeRedirectUriSchema.safeParse('https://spike.example.com/oauth/callback').success,
    ).toBe(true);
  });

  it('rejects an unregistered path, insecure non-loopback host, or wildcard', () => {
    expect(OnedriveSpikeRedirectUriSchema.safeParse('http://localhost:8788/callback').success).toBe(
      false,
    );
    expect(
      OnedriveSpikeRedirectUriSchema.safeParse('http://taxdesk.example.com/oauth/callback').success,
    ).toBe(false);
    expect(
      OnedriveSpikeRedirectUriSchema.safeParse('https://example.com/oauth/callback?x=1').success,
    ).toBe(false);
  });
});

describe('SpikeSafeTextSchema', () => {
  it('accepts ordinary observation notes and digests', () => {
    expect(
      SpikeSafeTextSchema.safeParse('Upload session resumed from byte 1310720 after interruption.')
        .success,
    ).toBe(true);
    expect(
      SpikeSafeTextSchema.safeParse(
        'sha256 4f2a1c6f0d5c1b1a2f3e4d5c6b7a8f90112233445566778899aabbccddeeff00',
      ).success,
    ).toBe(true);
  });

  it('rejects bearer tokens, JWTs, OAuth field names, and long opaque values', () => {
    expect(containsSpikeSecret(`Bearer ${'a'.repeat(40)}`)).toBe(true);
    expect(containsSpikeSecret('eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ0YXhkZXNrIn0')).toBe(true);
    expect(containsSpikeSecret('refresh_token=abc')).toBe(true);
    expect(containsSpikeSecret('code_verifier=abc')).toBe(true);
    expect(SpikeSafeTextSchema.safeParse('client_secret rotated').success).toBe(false);
    expect(SpikeSafeTextSchema.safeParse('x'.repeat(120)).success).toBe(false);
  });
});

describe('OnedriveSpikeScenarioResultSchema', () => {
  it('accepts a recorded scenario result', () => {
    expect(OnedriveSpikeScenarioResultSchema.safeParse(validResult).success).toBe(true);
  });

  it('rejects an unknown scenario or status', () => {
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({ ...validResult, scenario: 'permissions' })
        .success,
    ).toBe(false);
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({ ...validResult, status: 'partial' }).success,
    ).toBe(false);
  });

  it('rejects extra fields so unvetted evidence cannot be appended', () => {
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({ ...validResult, responseBody: '{}' }).success,
    ).toBe(false);
  });

  it('rejects metrics that carry a provider token', () => {
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({
        ...validResult,
        metrics: { 'token.accessToken': 'a'.repeat(100) },
      }).success,
    ).toBe(false);
  });

  it('rejects a negative or fractional duration', () => {
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({ ...validResult, durationMs: -1 }).success,
    ).toBe(false);
    expect(
      OnedriveSpikeScenarioResultSchema.safeParse({ ...validResult, durationMs: 1.5 }).success,
    ).toBe(false);
  });
});

describe('OnedriveSpikeReportSchema', () => {
  it('accepts a complete pass record', () => {
    const parsed = OnedriveSpikeReportSchema.safeParse(validReport);
    expect(parsed.success).toBe(true);
  });

  it('accepts a raised blocking decision with a reason and required action', () => {
    const parsed = OnedriveSpikeReportSchema.safeParse({
      ...validReport,
      outcome: 'incomplete',
      blockingDecision: {
        raised: true,
        reason: 'Required scenarios not verified: revoked_consent.',
        requiredAction: 'Re-run the spike with the firm Microsoft account.',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a raised blocking decision without a required action', () => {
    const parsed = OnedriveSpikeReportSchema.safeParse({
      ...validReport,
      outcome: 'failed',
      blockingDecision: { raised: true, reason: 'Consent failed.' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-blocking record that carries a stale reason', () => {
    const parsed = OnedriveSpikeReportSchema.safeParse({
      ...validReport,
      blockingDecision: { raised: false, reason: 'Consent failed.' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate scenario results', () => {
    const parsed = OnedriveSpikeReportSchema.safeParse({
      ...validReport,
      results: [validResult, validResult],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-personal account, production environment, or unknown tenant', () => {
    expect(
      OnedriveSpikeReportSchema.safeParse({ ...validReport, accountType: 'work' }).success,
    ).toBe(false);
    expect(
      OnedriveSpikeReportSchema.safeParse({ ...validReport, environment: 'production' }).success,
    ).toBe(false);
    expect(OnedriveSpikeReportSchema.safeParse({ ...validReport, tenant: 'contoso' }).success).toBe(
      false,
    );
  });

  it('rejects an extra scope beyond the documented minimum', () => {
    expect(
      OnedriveSpikeReportSchema.safeParse({
        ...validReport,
        requestedScopes: ['offline_access', 'Files.ReadWrite.AppFolder', 'Files.ReadWrite.All'],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      OnedriveSpikeReportSchema.safeParse({ ...validReport, accessToken: 'redacted' }).success,
    ).toBe(false);
  });
});
