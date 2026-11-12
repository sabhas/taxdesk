import { StorageProviderError, type StorageProviderErrorKind } from '../provider.js';

/**
 * Shared HTTP plumbing for the OneDrive adapter. Every failure is reduced to a
 * `StorageProviderError` with a fixed, safe message: provider response bodies,
 * request URLs (upload-session URLs are pre-authenticated secrets), and tokens
 * are never copied into errors or logs.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function readJsonBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function readJson(response: Response): Promise<unknown> {
  return readJsonBody(await response.text());
}

/** The Graph error code (`{ error: { code } }`) or identity error (`{ error: "x" }`). */
export function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
    return null;
  }
  const { error } = payload;
  if (typeof error === 'string' && error.length > 0 && error.length <= 120) {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && code.length > 0 && code.length <= 120) {
      return code;
    }
  }
  return null;
}

/** Parses `Retry-After` as delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

const SAFE_MESSAGES: Readonly<Record<StorageProviderErrorKind, string>> = {
  reconnect_required: 'OneDrive consent is no longer valid; an administrator must reconnect.',
  unauthorized: 'OneDrive rejected the access token.',
  unavailable: 'OneDrive is temporarily unavailable.',
  rate_limited: 'OneDrive is throttling requests.',
  not_found: 'The OneDrive item or upload session was not found.',
  conflict: 'OneDrive reported a conflict.',
  rejected: 'OneDrive rejected the request.',
  not_configured: 'The OneDrive application is not configured correctly.',
};

export function providerError(
  kind: StorageProviderErrorKind,
  options: { readonly retryAfterSeconds?: number; readonly expectedOffset?: number } = {},
): StorageProviderError {
  const clean: { retryAfterSeconds?: number; expectedOffset?: number } = {};
  if (options.retryAfterSeconds !== undefined) {
    clean.retryAfterSeconds = options.retryAfterSeconds;
  }
  if (options.expectedOffset !== undefined) {
    clean.expectedOffset = options.expectedOffset;
  }
  return new StorageProviderError(kind, SAFE_MESSAGES[kind], clean);
}

/** Maps a Graph (non-token) HTTP status onto an error kind. */
export function kindForGraphStatus(status: number): StorageProviderErrorKind {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'rejected';
  }
  if (status === 404 || status === 410) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'unavailable';
  }
  return 'rejected';
}

export function errorForResponse(
  response: Response,
  now: Date,
  kind: StorageProviderErrorKind = kindForGraphStatus(response.status),
): StorageProviderError {
  const retryAfter =
    kind === 'rate_limited' || kind === 'unavailable'
      ? parseRetryAfter(response.headers.get('Retry-After'), now)
      : undefined;
  return providerError(kind, retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter });
}

/**
 * Runs `fetch` and turns network failures and timeouts into `unavailable`.
 * `timeoutMs: null` disables the timeout (streaming downloads).
 */
export async function safeFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number | null,
): Promise<Response> {
  const signal =
    timeoutMs === null || typeof AbortSignal.timeout !== 'function'
      ? undefined
      : AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, signal === undefined ? init : { ...init, signal });
  } catch {
    throw providerError('unavailable');
  }
}

/** Discards a response body so the connection can be reused. */
export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do; the body is not needed.
  }
}
