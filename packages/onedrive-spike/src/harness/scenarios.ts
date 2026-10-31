import {
  ONEDRIVE_SPIKE_REQUIRED_SCENARIOS,
  ONEDRIVE_SPIKE_SCOPES,
  containsSpikeSecret,
  type OnedriveSpikeScenario,
  type OnedriveSpikeScenarioResult,
  type OnedriveSpikeScenarioStatus,
  type OnedriveSpikeScope,
  type SpikeMetrics,
} from '@taxdesk/shared';
import {
  GRAPH_SIMPLE_UPLOAD_MAX_BYTES,
  GRAPH_UPLOAD_CHUNK_MULTIPLE_BYTES,
  GraphRequestError,
  type AppFolderDriveClient,
} from '../graph/graph-client.js';
import { GraphTokenError } from '../graph/oauth.js';

/**
 * The six TD-005 scenarios, written against injected ports so they can be
 * exercised deterministically in tests and executed against a real Personal
 * account by the CLI. A scenario never throws to the caller: a failure becomes a
 * recorded `failed` result so the rest of the run still produces evidence.
 */

/** Size of the single-request upload used to probe simple-upload behavior. */
export const SPIKE_SIMPLE_FILE_BYTES = 1024 * 1024;

/** Size of the chunked upload, large enough to require several chunks. */
export const SPIKE_CHUNKED_FILE_BYTES = 5 * 1024 * 1024;

export type ScenarioDrive = Pick<
  AppFolderDriveClient,
  | 'putFile'
  | 'getItemByPath'
  | 'createUploadSession'
  | 'getUploadSessionStatus'
  | 'uploadChunk'
  | 'downloadItem'
  | 'deleteItem'
  | 'getAppRoot'
>;

export type ConsentRevocationObservation =
  | {
      readonly status: 'revoked';
      readonly errorCode: string;
      readonly httpStatus: number;
      readonly reconnectRequired: boolean;
    }
  | { readonly status: 'still_active' }
  | { readonly status: 'skipped'; readonly reason: string };

export interface ScenarioTokens {
  hasRefreshToken(): boolean;
  grantedScopes(): readonly string[];
  accessTokenExpiresInSeconds(): number;
  refresh(): Promise<{ expiresInSeconds: number; refreshTokenRotated: boolean }>;
  observeConsentRevocation(): Promise<ConsentRevocationObservation>;
  reconnect(): Promise<boolean>;
}

export interface ScenarioDeps {
  readonly drive: ScenarioDrive;
  readonly tokens: ScenarioTokens;
  readonly sha256Hex: (bytes: Uint8Array) => string;
  readonly makeTestFile: (sizeBytes: number, seed: string) => Uint8Array;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly runId: string;
  readonly chunkSizeBytes?: number;
}

export interface SpikeRunOptions {
  /** Deletes the synthetic test files created during the run. */
  readonly cleanup?: (itemIds: readonly string[]) => Promise<void>;
}

interface UploadedFile {
  readonly name: string;
  readonly id: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ScenarioOutcome {
  readonly status: OnedriveSpikeScenarioStatus;
  readonly detail: string;
  readonly httpStatus?: number;
  readonly graphErrorCode?: string;
  readonly metrics?: SpikeMetrics;
}

interface SpikeState {
  readonly uploaded: UploadedFile[];
}

function defaultChunkSize(deps: ScenarioDeps): number {
  return deps.chunkSizeBytes ?? GRAPH_UPLOAD_CHUNK_MULTIPLE_BYTES * 4;
}

/**
 * OneDrive provisions the application folder lazily, so the very first write can
 * fail with `404 itemNotFound` even though the same path works moments later.
 * The spike resolves the app root during the consent scenario and still retries
 * once, recording how often a retry was needed instead of hiding it.
 */
export const APP_FOLDER_PROVISIONING_RETRY_DELAY_MS = 1500;

function isAppFolderProvisioningMiss(error: unknown): boolean {
  return (
    error instanceof GraphRequestError && error.httpStatus === 404 && error.code === 'itemNotFound'
  );
}

async function withAppFolderProvisioningRetry<T>(
  deps: ScenarioDeps,
  operation: () => Promise<T>,
): Promise<{ readonly value: T; readonly retries: number }> {
  try {
    return { value: await operation(), retries: 0 };
  } catch (error) {
    if (!isAppFolderProvisioningMiss(error)) {
      throw error;
    }
    await deps.delay(APP_FOLDER_PROVISIONING_RETRY_DELAY_MS);
    return { value: await operation(), retries: 1 };
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Guarantees a record stays schema-valid and secret-free even when a provider or
 * the runtime produces unexpected text.
 */
function sanitizeText(value: string): string {
  if (containsSpikeSecret(value)) {
    return 'Detail withheld: the observation contained a value that looks like a provider token or secret.';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'No detail recorded.';
  }
  return truncate(trimmed, 600);
}

function describeFailure(error: unknown): ScenarioOutcome {
  if (error instanceof GraphTokenError) {
    return {
      status: 'failed',
      detail: 'Microsoft identity rejected the token request.',
      graphErrorCode: sanitizeText(error.code),
      httpStatus: error.httpStatus,
    };
  }
  if (error instanceof GraphRequestError) {
    return {
      status: 'failed',
      detail: 'Microsoft Graph rejected the request.',
      graphErrorCode: sanitizeText(error.code),
      httpStatus: error.httpStatus,
    };
  }
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : '';
  return { status: 'failed', detail: sanitizeText(`${name}: ${message}`) };
}

async function runScenario(
  scenario: OnedriveSpikeScenario,
  deps: ScenarioDeps,
  execute: () => Promise<ScenarioOutcome>,
): Promise<OnedriveSpikeScenarioResult> {
  const startedAt = deps.now();
  const elapsed = (): number => Math.max(0, Math.round(deps.now() - startedAt));

  let outcome: ScenarioOutcome;
  try {
    outcome = await execute();
  } catch (error) {
    outcome = describeFailure(error);
  }

  const result: OnedriveSpikeScenarioResult = {
    scenario,
    status: outcome.status,
    durationMs: elapsed(),
    detail: sanitizeText(outcome.detail),
    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
    ...(outcome.graphErrorCode === undefined
      ? {}
      : { graphErrorCode: sanitizeText(outcome.graphErrorCode) }),
    ...(outcome.metrics === undefined ? {} : { metrics: outcome.metrics }),
  };
  return result;
}

/** Parses the start offset out of a Graph `nextExpectedRanges` entry. */
export function parseNextExpectedRange(entry: string | undefined): number | undefined {
  if (entry === undefined) {
    return undefined;
  }
  const match = /^(\d+)-/.exec(entry);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const start = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
}

async function uploadChunks(
  deps: ScenarioDeps,
  uploadUrl: string,
  content: Uint8Array,
  startOffset: number,
): Promise<{ chunks: number; chunkSize: number }> {
  const chunkSize = defaultChunkSize(deps);
  let offset = startOffset;
  let chunks = 0;

  while (offset < content.byteLength) {
    const chunk = content.subarray(offset, Math.min(offset + chunkSize, content.byteLength));
    const result = await deps.drive.uploadChunk(uploadUrl, chunk, offset, content.byteLength);
    chunks += 1;
    offset += chunk.byteLength;

    if (result.item !== undefined) {
      return { chunks, chunkSize };
    }
    const nextStart = parseNextExpectedRange(result.nextExpectedRanges?.[0]);
    if (nextStart !== undefined && nextStart > offset) {
      offset = nextStart;
    }
  }

  throw new Error('The upload session finished without returning a drive item.');
}

async function consentScenario(deps: ScenarioDeps): Promise<ScenarioOutcome> {
  const grantedScopes = deps.tokens.grantedScopes();
  const refreshTokenIssued = deps.tokens.hasRefreshToken();
  const scopeChecks: Readonly<Record<OnedriveSpikeScope, boolean>> = {
    offline_access: refreshTokenIssued,
    'Files.ReadWrite.AppFolder': grantedScopes.includes('Files.ReadWrite.AppFolder'),
  };
  const missing = ONEDRIVE_SPIKE_SCOPES.filter((scope) => !scopeChecks[scope]);

  if (missing.length > 0) {
    return {
      status: 'failed',
      detail: `Delegated consent did not grant: ${missing.join(', ')}.`,
      metrics: {
        'consent.missingScopeCount': missing.length,
        'consent.refreshTokenIssued': refreshTokenIssued,
      },
    };
  }

  const appRoot = await deps.drive.getAppRoot();
  if (!appRoot.isFolder) {
    return {
      status: 'failed',
      detail: 'The application folder resolved, but not as a folder.',
      metrics: { 'consent.refreshTokenIssued': refreshTokenIssued },
    };
  }

  return {
    status: 'passed',
    detail:
      'Delegated consent granted the app-folder scope with offline access, and the application folder resolved.',
    metrics: {
      'consent.requestedScopeCount': ONEDRIVE_SPIKE_SCOPES.length,
      'consent.grantedScopeCount': grantedScopes.length,
      // Microsoft does not echo `offline_access` in the granted scope list, so a
      // refresh token is the only proof that offline access was granted.
      'consent.refreshTokenIssued': refreshTokenIssued,
      'appRoot.resolved': true,
      ...(appRoot.childCount === undefined ? {} : { 'appRoot.childCount': appRoot.childCount }),
      'token.accessTokenExpiresInSeconds': deps.tokens.accessTokenExpiresInSeconds(),
    },
  };
}

async function tokenRefreshScenario(deps: ScenarioDeps): Promise<ScenarioOutcome> {
  const initialExpiresInSeconds = deps.tokens.accessTokenExpiresInSeconds();
  const refreshed = await deps.tokens.refresh();
  if (refreshed.expiresInSeconds <= 0) {
    return { status: 'failed', detail: 'The refreshed access token reported no lifetime.' };
  }
  return {
    status: 'passed',
    detail: `A refresh token produced a new access token valid for ${String(refreshed.expiresInSeconds)} seconds${
      refreshed.refreshTokenRotated
        ? ' and rotated the refresh token'
        : ' without rotating the refresh token'
    }.`,
    metrics: {
      'token.initialAccessTokenExpiresInSeconds': initialExpiresInSeconds,
      'token.refreshedAccessTokenExpiresInSeconds': refreshed.expiresInSeconds,
      'token.refreshTokenRotated': refreshed.refreshTokenRotated,
    },
  };
}

async function uploadScenario(deps: ScenarioDeps, state: SpikeState): Promise<ScenarioOutcome> {
  const smallName = `taxdesk-td005-${deps.runId}-simple.bin`;
  const smallContent = deps.makeTestFile(SPIKE_SIMPLE_FILE_BYTES, `${deps.runId}:simple`);
  const smallStartedAt = deps.now();
  const smallUpload = await withAppFolderProvisioningRetry(deps, () =>
    deps.drive.putFile(smallName, smallContent),
  );
  const smallItem = smallUpload.value;
  const smallDurationMs = Math.max(0, Math.round(deps.now() - smallStartedAt));

  if (smallItem.size !== smallContent.byteLength) {
    return {
      status: 'failed',
      detail: 'The single-request upload stored a different byte count than it was sent.',
    };
  }
  state.uploaded.push({
    name: smallItem.name,
    id: smallItem.id,
    sizeBytes: smallItem.size,
    sha256: deps.sha256Hex(smallContent),
  });

  const chunkedName = `taxdesk-td005-${deps.runId}-chunked.bin`;
  const chunkedContent = deps.makeTestFile(SPIKE_CHUNKED_FILE_BYTES, `${deps.runId}:chunked`);
  const chunkedStartedAt = deps.now();
  const session = await withAppFolderProvisioningRetry(deps, () =>
    deps.drive.createUploadSession(chunkedName),
  );
  const chunked = await uploadChunks(deps, session.value, chunkedContent, 0);
  const chunkedDurationMs = Math.max(0, Math.round(deps.now() - chunkedStartedAt));

  const chunkedItem = await deps.drive.getItemByPath(chunkedName);
  if (chunkedItem.size !== chunkedContent.byteLength) {
    return {
      status: 'failed',
      detail: 'The chunked upload stored a different byte count than it was sent.',
      metrics: { 'upload.chunkCount': chunked.chunks },
    };
  }

  state.uploaded.push({
    name: chunkedItem.name,
    id: chunkedItem.id,
    sizeBytes: chunkedItem.size,
    sha256: deps.sha256Hex(chunkedContent),
  });

  return {
    status: 'passed',
    detail: `A ${String(SPIKE_SIMPLE_FILE_BYTES)}-byte file uploaded in one request and a ${String(
      SPIKE_CHUNKED_FILE_BYTES,
    )}-byte file uploaded in ${String(chunked.chunks)} chunks of ${String(chunked.chunkSize)} bytes.`,
    metrics: {
      'upload.simpleUploadBytes': SPIKE_SIMPLE_FILE_BYTES,
      'upload.simpleUploadDurationMs': smallDurationMs,
      'upload.simpleUploadRetries': smallUpload.retries,
      'upload.simpleUploadLimitBytes': GRAPH_SIMPLE_UPLOAD_MAX_BYTES,
      'upload.chunkedUploadBytes': SPIKE_CHUNKED_FILE_BYTES,
      'upload.chunkedUploadDurationMs': chunkedDurationMs,
      'upload.chunkSizeBytes': chunked.chunkSize,
      'upload.chunkCount': chunked.chunks,
      'upload.sessionRetries': session.retries,
    },
  };
}

async function downloadScenario(deps: ScenarioDeps, state: SpikeState): Promise<ScenarioOutcome> {
  if (state.uploaded.length === 0) {
    return {
      status: 'skipped',
      detail:
        'No uploaded files were available to download because the upload scenario did not complete.',
    };
  }

  let totalBytes = 0;
  const mismatches: string[] = [];
  for (const file of state.uploaded) {
    const downloaded = await deps.drive.downloadItem(file.id);
    totalBytes += downloaded.byteLength;
    if (downloaded.byteLength !== file.sizeBytes || deps.sha256Hex(downloaded) !== file.sha256) {
      mismatches.push(file.name);
    }
  }

  if (mismatches.length > 0) {
    return {
      status: 'failed',
      detail: `Downloaded content did not match the uploaded bytes for ${String(mismatches.length)} file(s).`,
      metrics: { 'download.mismatchedFiles': mismatches.length },
    };
  }

  return {
    status: 'passed',
    detail: `Downloaded ${String(state.uploaded.length)} file(s) and matched every SHA-256 checksum.`,
    metrics: {
      'download.verifiedFiles': state.uploaded.length,
      'download.totalBytes': totalBytes,
    },
  };
}

async function uploadInterruptionScenario(
  deps: ScenarioDeps,
  state: SpikeState,
): Promise<ScenarioOutcome> {
  const name = `taxdesk-td005-${deps.runId}-resume.bin`;
  const content = deps.makeTestFile(SPIKE_CHUNKED_FILE_BYTES, `${deps.runId}:resume`);
  const chunkSize = defaultChunkSize(deps);

  const session = await withAppFolderProvisioningRetry(deps, () =>
    deps.drive.createUploadSession(name),
  );
  const uploadUrl = session.value;
  const firstChunk = content.subarray(0, Math.min(chunkSize, content.byteLength));
  const firstResult = await deps.drive.uploadChunk(uploadUrl, firstChunk, 0, content.byteLength);

  if (firstResult.item !== undefined) {
    return {
      status: 'failed',
      detail:
        'The upload session completed in a single chunk, so an interruption could not be observed.',
    };
  }

  // Simulate a dropped client: discard local progress and ask the provider what
  // it still expects before resuming.
  const status = await deps.drive.getUploadSessionStatus(uploadUrl);
  const resumedFrom = parseNextExpectedRange(status.nextExpectedRanges[0]);
  if (resumedFrom === undefined || resumedFrom === 0) {
    return {
      status: 'failed',
      detail: 'The interrupted upload session did not report a resumable byte range.',
    };
  }

  const resumed = await uploadChunks(deps, uploadUrl, content, resumedFrom);
  const item = await deps.drive.getItemByPath(name);
  const downloaded = await deps.drive.downloadItem(item.id);
  const expectedSha256 = deps.sha256Hex(content);
  if (deps.sha256Hex(downloaded) !== expectedSha256) {
    return {
      status: 'failed',
      detail: 'The resumed upload stored different content than the original file.',
      metrics: { 'interruption.resumedFromByte': resumedFrom },
    };
  }

  state.uploaded.push({
    name: item.name,
    id: item.id,
    sizeBytes: content.byteLength,
    sha256: expectedSha256,
  });

  return {
    status: 'passed',
    detail: `An interrupted upload session resumed from byte ${String(resumedFrom)} and stored the original ${String(
      content.byteLength,
    )}-byte content.`,
    metrics: {
      'interruption.firstChunkBytes': firstChunk.byteLength,
      'interruption.resumedFromByte': resumedFrom,
      'interruption.resumedChunkCount': resumed.chunks,
      'interruption.chunkSizeBytes': resumed.chunkSize,
      'interruption.totalBytes': content.byteLength,
      'interruption.contentVerified': true,
      'interruption.sessionRetries': session.retries,
    },
  };
}

async function revokedConsentScenario(deps: ScenarioDeps): Promise<ScenarioOutcome> {
  const observation = await deps.tokens.observeConsentRevocation();

  if (observation.status === 'skipped') {
    return { status: 'skipped', detail: observation.reason };
  }
  if (observation.status === 'still_active') {
    return {
      status: 'failed',
      detail:
        'A refresh still succeeded, so consent had not been revoked. Revoke the application at the Microsoft account consent page and re-run the scenario.',
    };
  }
  if (!observation.reconnectRequired) {
    return {
      status: 'failed',
      detail:
        'The revoked grant failed for a reason that the spike does not treat as reconnect-required.',
      graphErrorCode: observation.errorCode,
      httpStatus: observation.httpStatus,
    };
  }

  const reconnected = await deps.tokens.reconnect();
  if (!reconnected) {
    return {
      status: 'failed',
      detail: 'Delegated consent could not be re-established after revocation.',
      graphErrorCode: observation.errorCode,
      httpStatus: observation.httpStatus,
    };
  }

  return {
    status: 'passed',
    detail:
      'A refresh after revocation was rejected as reconnect-required, and a fresh authorization-code consent restored access.',
    graphErrorCode: observation.errorCode,
    httpStatus: observation.httpStatus,
    metrics: {
      'revocation.errorCode': observation.errorCode,
      'revocation.httpStatus': observation.httpStatus,
      'revocation.reconnectRequired': true,
      'reconnect.succeeded': true,
    },
  };
}

/**
 * Runs every required scenario in the documented order. Revocation runs last
 * because it invalidates the grant, and the synthetic files are deleted first so
 * a revoked grant cannot strand them in the account.
 */
export async function runSpikeScenarios(
  deps: ScenarioDeps,
  options: SpikeRunOptions = {},
): Promise<OnedriveSpikeScenarioResult[]> {
  const state: SpikeState = { uploaded: [] };
  const results: OnedriveSpikeScenarioResult[] = [];

  results.push(await runScenario('consent', deps, () => consentScenario(deps)));
  results.push(await runScenario('token_refresh', deps, () => tokenRefreshScenario(deps)));
  results.push(await runScenario('upload', deps, () => uploadScenario(deps, state)));
  results.push(await runScenario('download', deps, () => downloadScenario(deps, state)));
  results.push(
    await runScenario('upload_interruption', deps, () => uploadInterruptionScenario(deps, state)),
  );

  if (options.cleanup !== undefined) {
    try {
      await options.cleanup(state.uploaded.map((file) => file.id));
    } catch {
      // Cleanup is best effort: the files are synthetic and non-confidential, and
      // a cleanup failure must not hide the scenario evidence.
    }
  }

  results.push(await runScenario('revoked_consent', deps, () => revokedConsentScenario(deps)));

  const order = new Map(
    ONEDRIVE_SPIKE_REQUIRED_SCENARIOS.map((scenario, index) => [scenario, index]),
  );
  return [...results].sort(
    (left, right) => (order.get(left.scenario) ?? 0) - (order.get(right.scenario) ?? 0),
  );
}
