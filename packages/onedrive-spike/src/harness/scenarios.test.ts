import {
  OnedriveSpikeReportSchema,
  OnedriveSpikeScenarioResultSchema,
  ONEDRIVE_SPIKE_SCENARIOS,
  type OnedriveSpikeScenario,
  type OnedriveSpikeScenarioResult,
} from '@taxdesk/shared';
import { describe, expect, it } from 'vitest';
import { evaluateSpikeResults } from '../domain/spike-evaluation.js';
import { GraphRequestError } from '../graph/graph-client.js';
import { GraphTokenError } from '../graph/oauth.js';
import {
  SPIKE_CHUNKED_FILE_BYTES,
  parseNextExpectedRange,
  runSpikeScenarios,
  type ConsentRevocationObservation,
  type ScenarioDeps,
  type ScenarioDrive,
  type ScenarioTokens,
} from './scenarios.js';
import { makeTestFile, sha256Hex } from '../node/test-files.js';

interface StoredFile {
  readonly id: string;
  readonly name: string;
  readonly content: Uint8Array;
}

interface FakeDrive extends ScenarioDrive {
  readonly files: Map<string, StoredFile>;
  readonly deleted: string[];
  readonly events: string[];
}

interface FakeDriveOptions {
  readonly failUpload?: boolean;
  readonly corruptDownload?: boolean;
  readonly singleChunkSession?: boolean;
  readonly emptyResumeRange?: boolean;
  readonly unexpectedError?: boolean;
  /** Simulates OneDrive's lazy app-folder provisioning on the first write. */
  readonly provisioningMissOnFirstWrite?: boolean;
  readonly appRootAccessDenied?: boolean;
  readonly appRootNotAFolder?: boolean;
}

function createFakeDrive(options: FakeDriveOptions = {}): FakeDrive {
  const files = new Map<string, StoredFile>();
  const byName = new Map<string, string>();
  const sessions = new Map<string, { name: string; totalSize: number; received: Uint8Array }>();
  const deleted: string[] = [];
  const events: string[] = [];
  let sequence = 0;
  let writes = 0;

  const store = (name: string, content: Uint8Array): StoredFile => {
    const existingId = byName.get(name);
    const id = existingId ?? `item-${String(++sequence)}`;
    files.set(id, { id, name, content });
    byName.set(name, id);
    return files.get(id)!;
  };

  return {
    files,
    deleted,
    events,
    async putFile(name, content) {
      events.push('putFile');
      if (options.unexpectedError === true) {
        throw new Error('Bearer abcdefghijklmnopqrstuvwxyz0123456789');
      }
      if (options.provisioningMissOnFirstWrite === true && writes === 0) {
        writes += 1;
        throw new GraphRequestError(404, 'itemNotFound');
      }
      writes += 1;
      if (options.failUpload === true) {
        throw new GraphRequestError(507, 'quotaLimitReached');
      }
      const stored = store(name, content);
      return { id: stored.id, name: stored.name, size: stored.content.byteLength };
    },
    async createUploadSession(name) {
      events.push('createUploadSession');
      if (options.provisioningMissOnFirstWrite === true && writes === 0) {
        writes += 1;
        throw new GraphRequestError(404, 'itemNotFound');
      }
      writes += 1;
      const sessionId = `session-${String(++sequence)}`;
      sessions.set(sessionId, { name, totalSize: 0, received: new Uint8Array(0) });
      return `https://upload.example.com/${sessionId}`;
    },
    async getUploadSessionStatus(uploadUrl) {
      events.push('getUploadSessionStatus');
      const session = sessions.get(uploadUrl.split('/').pop() ?? '');
      if (session === undefined) {
        throw new GraphRequestError(404, 'itemNotFound');
      }
      if (options.emptyResumeRange === true) {
        return { nextExpectedRanges: [], expirationDateTime: undefined };
      }
      return {
        nextExpectedRanges: [`${String(session.received.byteLength)}-`],
        expirationDateTime: undefined,
      };
    },
    async uploadChunk(uploadUrl, chunk, rangeStart, totalSize) {
      events.push('uploadChunk');
      const sessionId = uploadUrl.split('/').pop() ?? '';
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new GraphRequestError(404, 'itemNotFound');
      }
      const received = new Uint8Array(rangeStart + chunk.byteLength);
      received.set(session.received.subarray(0, rangeStart));
      received.set(chunk, rangeStart);
      session.received = received;
      session.totalSize = totalSize;

      const complete = options.singleChunkSession === true || received.byteLength >= totalSize;
      if (!complete) {
        return { nextExpectedRanges: [`${String(received.byteLength)}-`], item: undefined };
      }
      const stored = store(session.name, received);
      return {
        nextExpectedRanges: undefined,
        item: { id: stored.id, name: stored.name, size: stored.content.byteLength },
      };
    },
    async getItemByPath(name) {
      events.push('getItemByPath');
      const id = byName.get(name);
      const stored = id === undefined ? undefined : files.get(id);
      if (stored === undefined) {
        throw new GraphRequestError(404, 'itemNotFound');
      }
      return { id: stored.id, name: stored.name, size: stored.content.byteLength };
    },
    async downloadItem(itemId) {
      events.push('downloadItem');
      const stored = files.get(itemId);
      if (stored === undefined) {
        throw new GraphRequestError(404, 'itemNotFound');
      }
      if (options.corruptDownload === true) {
        return new Uint8Array(stored.content.byteLength);
      }
      return stored.content;
    },
    async deleteItem(itemId) {
      events.push('deleteItem');
      deleted.push(itemId);
      files.delete(itemId);
    },
    async getAppRoot() {
      events.push('getAppRoot');
      if (options.appRootAccessDenied === true) {
        throw new GraphRequestError(403, 'accessDenied');
      }
      return {
        isFolder: options.appRootNotAFolder !== true,
        childCount: options.appRootNotAFolder === true ? undefined : 0,
      };
    },
  };
}

interface FakeTokensOptions {
  readonly hasRefreshToken?: boolean;
  readonly revocation?: ConsentRevocationObservation;
  readonly reconnected?: boolean;
  readonly refreshFails?: boolean;
}

function createFakeTokens(options: FakeTokensOptions = {}): ScenarioTokens {
  return {
    hasRefreshToken: () => options.hasRefreshToken ?? true,
    grantedScopes: () => ['Files.ReadWrite.AppFolder', 'offline_access'],
    accessTokenExpiresInSeconds: () => 3600,
    async refresh() {
      if (options.refreshFails === true) {
        throw new GraphTokenError('temporarily_unavailable', 503);
      }
      return { expiresInSeconds: 3599, refreshTokenRotated: true };
    },
    async observeConsentRevocation() {
      return (
        options.revocation ?? {
          status: 'revoked',
          errorCode: 'invalid_grant',
          httpStatus: 400,
          reconnectRequired: true,
        }
      );
    },
    async reconnect() {
      return options.reconnected ?? true;
    },
  };
}

function createDeps(
  drive: ScenarioDrive,
  tokens: ScenarioTokens,
  overrides: Partial<ScenarioDeps> = {},
): ScenarioDeps {
  let clock = 0;
  return {
    drive,
    tokens,
    sha256Hex,
    makeTestFile,
    now: () => {
      clock += 5;
      return clock;
    },
    delay: () => Promise.resolve(),
    runId: 'run123456',
    ...overrides,
  };
}

function byScenario(
  results: readonly OnedriveSpikeScenarioResult[],
  scenario: OnedriveSpikeScenario,
): OnedriveSpikeScenarioResult {
  const found = results.find((result) => result.scenario === scenario);
  if (found === undefined) {
    throw new Error(`missing result for ${scenario}`);
  }
  return found;
}

function expectSchemaValid(results: readonly OnedriveSpikeScenarioResult[]): void {
  for (const result of results) {
    expect(OnedriveSpikeScenarioResultSchema.safeParse(result).success).toBe(true);
  }
}

describe('parseNextExpectedRange', () => {
  it('extracts the start byte of a Graph range', () => {
    expect(parseNextExpectedRange('1310720-')).toBe(1_310_720);
    expect(parseNextExpectedRange('0-')).toBe(0);
    expect(parseNextExpectedRange(undefined)).toBeUndefined();
    expect(parseNextExpectedRange('not-a-range')).toBeUndefined();
  });
});

describe('runSpikeScenarios', () => {
  it('passes every required scenario and records the observed behaviour', async () => {
    const drive = createFakeDrive();
    const results = await runSpikeScenarios(createDeps(drive, createFakeTokens()));

    expect(results.map((result) => result.scenario)).toEqual([...ONEDRIVE_SPIKE_SCENARIOS]);
    expect(results.every((result) => result.status === 'passed')).toBe(true);
    expectSchemaValid(results);

    const consent = byScenario(results, 'consent');
    expect(consent.metrics).toMatchObject({
      'consent.refreshTokenIssued': true,
      'appRoot.resolved': true,
      'appRoot.childCount': 0,
    });

    const upload = byScenario(results, 'upload');
    expect(upload.metrics).toMatchObject({
      'upload.simpleUploadBytes': 1_048_576,
      'upload.simpleUploadRetries': 0,
      'upload.chunkedUploadBytes': SPIKE_CHUNKED_FILE_BYTES,
      'upload.chunkSizeBytes': 1_310_720,
      'upload.chunkCount': 4,
      'upload.sessionRetries': 0,
      'upload.simpleUploadLimitBytes': 4_194_304,
    });

    const interruption = byScenario(results, 'upload_interruption');
    expect(interruption.metrics).toMatchObject({
      'interruption.firstChunkBytes': 1_310_720,
      'interruption.resumedFromByte': 1_310_720,
      'interruption.resumedChunkCount': 3,
      'interruption.contentVerified': true,
    });

    const download = byScenario(results, 'download');
    expect(download.metrics).toMatchObject({ 'download.verifiedFiles': 2 });

    const revocation = byScenario(results, 'revoked_consent');
    expect(revocation.graphErrorCode).toBe('invalid_grant');
    expect(revocation.metrics).toMatchObject({
      'revocation.reconnectRequired': true,
      'reconnect.succeeded': true,
    });
  });

  it('produces a report that satisfies the committed contract', async () => {
    const results = await runSpikeScenarios(createDeps(createFakeDrive(), createFakeTokens()));
    const evaluation = evaluateSpikeResults(results);

    const report = OnedriveSpikeReportSchema.parse({
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
      results,
      outcome: evaluation.outcome,
      blockingDecision: evaluation.blockingDecision,
      notes: 'Synthetic test files only.',
    });

    expect(report.outcome).toBe('passed');
    expect(report.blockingDecision).toEqual({ raised: false });
    expect(JSON.stringify(report)).not.toMatch(/bearer|refresh_token|eyJ/iu);
  });

  it('deletes the synthetic files before the revocation scenario invalidates the grant', async () => {
    const drive = createFakeDrive();
    const results: OnedriveSpikeScenarioResult[] = [];
    const cleanupEvents: string[] = [];

    results.push(
      ...(await runSpikeScenarios(createDeps(drive, createFakeTokens()), {
        cleanup: async (itemIds) => {
          cleanupEvents.push(`cleanup:${String(itemIds.length)}`);
          for (const itemId of itemIds) {
            await drive.deleteItem(itemId);
          }
        },
      })),
    );

    expect(cleanupEvents).toEqual(['cleanup:3']);
    expect(drive.deleted).toHaveLength(3);
    expect(drive.files.size).toBe(0);
    expect(byScenario(results, 'revoked_consent').status).toBe('passed');
  });

  it('continues recording evidence when the simple upload is rejected', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ failUpload: true }), createFakeTokens()),
    );

    const upload = byScenario(results, 'upload');
    expect(upload.status).toBe('failed');
    expect(upload.httpStatus).toBe(507);
    expect(upload.graphErrorCode).toBe('quotaLimitReached');

    expect(byScenario(results, 'download').status).toBe('skipped');
    expect(byScenario(results, 'upload_interruption').status).toBe('passed');
    expect(evaluateSpikeResults(results).outcome).toBe('failed');
    expectSchemaValid(results);
  });

  it('fails the download scenario when stored bytes do not match the checksum', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ corruptDownload: true }), createFakeTokens()),
    );

    const download = byScenario(results, 'download');
    expect(download.status).toBe('failed');
    expect(download.detail).toContain('did not match');
    expect(download.metrics).toMatchObject({ 'download.mismatchedFiles': 2 });
  });

  it('fails the interruption scenario when the file fits in a single chunk', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ singleChunkSession: true }), createFakeTokens()),
    );

    const interruption = byScenario(results, 'upload_interruption');
    expect(interruption.status).toBe('failed');
    expect(interruption.detail).toContain('single chunk');
  });

  it('fails the interruption scenario when no resumable range is offered', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ emptyResumeRange: true }), createFakeTokens()),
    );

    const interruption = byScenario(results, 'upload_interruption');
    expect(interruption.status).toBe('failed');
    expect(interruption.detail).toContain('resumable byte range');
  });

  it('retries once when the first write hits an unprovisioned app folder', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ provisioningMissOnFirstWrite: true }), createFakeTokens()),
    );

    const upload = byScenario(results, 'upload');
    expect(upload.status).toBe('passed');
    expect(upload.metrics).toMatchObject({
      'upload.simpleUploadRetries': 1,
      'upload.sessionRetries': 0,
    });
    expect(upload.detail).toContain('uploaded');
  });

  it('still fails when the app folder stays unavailable after the retry', async () => {
    const drive = createFakeDrive();
    const failingDrive: ScenarioDrive = {
      ...drive,
      getAppRoot: drive.getAppRoot,
      putFile: () => Promise.reject(new GraphRequestError(404, 'itemNotFound')),
    };

    const results = await runSpikeScenarios(createDeps(failingDrive, createFakeTokens()));
    const upload = byScenario(results, 'upload');
    expect(upload.status).toBe('failed');
    expect(upload.httpStatus).toBe(404);
    expect(upload.graphErrorCode).toBe('itemNotFound');
  });

  it('fails consent when the app folder is not accessible to the app-folder scope', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ appRootAccessDenied: true }), createFakeTokens()),
    );

    const consent = byScenario(results, 'consent');
    expect(consent.status).toBe('failed');
    expect(consent.httpStatus).toBe(403);
    expect(consent.graphErrorCode).toBe('accessDenied');
  });

  it('fails consent when the app root is not a folder', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ appRootNotAFolder: true }), createFakeTokens()),
    );

    const consent = byScenario(results, 'consent');
    expect(consent.status).toBe('failed');
    expect(consent.detail).toContain('not as a folder');
  });

  it('fails consent when the app-folder scope was not granted', async () => {
    const tokens: ScenarioTokens = {
      ...createFakeTokens(),
      grantedScopes: () => ['offline_access'],
    };
    const results = await runSpikeScenarios(createDeps(createFakeDrive(), tokens));

    const consent = byScenario(results, 'consent');
    expect(consent.status).toBe('failed');
    expect(consent.detail).toContain('Files.ReadWrite.AppFolder');
  });

  it('fails consent when no refresh token was issued', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive(), createFakeTokens({ hasRefreshToken: false })),
    );

    const consent = byScenario(results, 'consent');
    expect(consent.status).toBe('failed');
    expect(consent.detail).toContain('offline_access');
  });

  it('records a failed refresh without aborting the run', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive(), createFakeTokens({ refreshFails: true })),
    );

    const refresh = byScenario(results, 'token_refresh');
    expect(refresh.status).toBe('failed');
    expect(refresh.graphErrorCode).toBe('temporarily_unavailable');
    expect(refresh.httpStatus).toBe(503);
    expect(byScenario(results, 'upload').status).toBe('passed');
  });

  it('fails when consent was never revoked', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive(), createFakeTokens({ revocation: { status: 'still_active' } })),
    );

    const revocation = byScenario(results, 'revoked_consent');
    expect(revocation.status).toBe('failed');
    expect(revocation.detail).toContain('had not been revoked');
    expect(evaluateSpikeResults(results).blockingDecision.raised).toBe(true);
  });

  it('skips revocation when the operator declines, leaving the outcome incomplete', async () => {
    const results = await runSpikeScenarios(
      createDeps(
        createFakeDrive(),
        createFakeTokens({
          revocation: {
            status: 'skipped',
            reason: 'Consent was not revoked at the Microsoft account consent page.',
          },
        }),
      ),
    );

    expect(byScenario(results, 'revoked_consent').status).toBe('skipped');
    const evaluation = evaluateSpikeResults(results);
    expect(evaluation.outcome).toBe('incomplete');
    expect(evaluation.blockingDecision.raised).toBe(true);
  });

  it('fails when a revocation failure is not reconnect-required', async () => {
    const results = await runSpikeScenarios(
      createDeps(
        createFakeDrive(),
        createFakeTokens({
          revocation: {
            status: 'revoked',
            errorCode: 'temporarily_unavailable',
            httpStatus: 503,
            reconnectRequired: false,
          },
        }),
      ),
    );

    const revocation = byScenario(results, 'revoked_consent');
    expect(revocation.status).toBe('failed');
    expect(revocation.graphErrorCode).toBe('temporarily_unavailable');
  });

  it('fails when delegated consent cannot be re-established', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive(), createFakeTokens({ reconnected: false })),
    );

    const revocation = byScenario(results, 'revoked_consent');
    expect(revocation.status).toBe('failed');
    expect(revocation.detail).toContain('could not be re-established');
  });

  it('withholds any observation that looks like a provider token', async () => {
    const results = await runSpikeScenarios(
      createDeps(createFakeDrive({ unexpectedError: true }), createFakeTokens()),
    );

    const upload = byScenario(results, 'upload');
    expect(upload.status).toBe('failed');
    expect(upload.detail).toContain('Detail withheld');
    expect(JSON.stringify(results)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expectSchemaValid(results);
  });
});
