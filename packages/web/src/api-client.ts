import { ProblemDetailsSchema, type FieldError } from '@taxdesk/shared';

export const SESSION_EXPIRED_EVENT = 'taxdesk:session-expired';

/**
 * Only a missing or expired session ends the signed-in state. Other 401s on a
 * session-scoped call (a wrong password or MFA code while confirming a
 * sensitive change) are form errors and must not sign the user out.
 */
const SESSION_ENDING_CODES = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED']);

function endsSession(status: number, code: string): boolean {
  return status === 401 && SESSION_ENDING_CODES.has(code);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly fieldErrors: readonly FieldError[];

  constructor(input: {
    status: number;
    code: string;
    message: string;
    requestId?: string | undefined;
    fieldErrors?: readonly FieldError[] | undefined;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.fieldErrors = input.fieldErrors ?? [];
  }
}

export interface Contract<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly ifMatch?: number;
  readonly sessionScoped?: boolean;
  readonly signal?: AbortSignal;
  /**
   * A caller-chosen request ID. Idempotent commands (starting an upload) reuse
   * one ID across retries so the server returns the same result.
   */
  readonly requestId?: string;
  /** Raw bytes sent as `application/octet-stream` instead of a JSON body. */
  readonly rawBody?: Blob;
}

function requestHeaders(method: string, options: ApiRequestOptions): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.rawBody !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (MUTATING_METHODS.has(method)) {
    headers['X-Request-Id'] = options.requestId ?? newRequestId();
  }
  if (options.ifMatch !== undefined) {
    headers['If-Match'] = `"${String(options.ifMatch)}"`;
  }
  return headers;
}

function requestBody(options: ApiRequestOptions): { body?: BodyInit } {
  if (options.rawBody !== undefined) {
    return { body: options.rawBody };
  }
  return options.body === undefined ? {} : { body: JSON.stringify(options.body) };
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function newRequestId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- test/jsdom runtimes may omit Web Crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- test/jsdom runtimes may omit Web Crypto
  if (cryptoApi !== undefined) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `request-${String(Date.now())}-${String(Math.random()).slice(2, 10)}`;
}

function notifySessionExpired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Same-origin API call with contract validation. Only public Problem Details
 * fields are surfaced; a malformed response collapses to a friendly error with
 * the request reference ID when one is available.
 */
export async function apiRequest<T>(
  path: string,
  schema: Contract<T>,
  options: ApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = requestHeaders(method, options);

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...requestBody(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'We could not reach TaxDesk. Check your connection and try again.',
    });
  }

  const data = await readResponseBody(response);
  if (!response.ok) {
    const problem = ProblemDetailsSchema.safeParse(data);
    const code = problem.success ? problem.data.code : 'REQUEST_FAILED';
    const requestId = problem.success
      ? problem.data.requestId
      : (response.headers.get('X-Request-Id') ?? undefined);
    if (options.sessionScoped === true && endsSession(response.status, code)) {
      notifySessionExpired();
    }
    throw new ApiError({
      status: response.status,
      code,
      message: problem.success
        ? problem.data.detail
        : 'The request could not be completed. Please try again.',
      ...(requestId === undefined ? {} : { requestId }),
      ...(problem.success && problem.data.errors !== undefined
        ? { fieldErrors: problem.data.errors }
        : {}),
    });
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError({
      status: response.status,
      code: 'INVALID_RESPONSE',
      message: 'TaxDesk returned an unexpected response. Please try again.',
      ...(response.headers.get('X-Request-Id') === null
        ? {}
        : { requestId: response.headers.get('X-Request-Id') ?? undefined }),
    });
  }
  return parsed.data;
}

export async function apiRequestVoid(path: string, options: ApiRequestOptions = {}): Promise<void> {
  const method = options.method ?? 'POST';
  const headers = requestHeaders(method, options);

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...requestBody(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'We could not reach TaxDesk. Check your connection and try again.',
    });
  }

  if (response.ok) {
    return;
  }
  const data = await readResponseBody(response);
  const problem = ProblemDetailsSchema.safeParse(data);
  if (
    options.sessionScoped === true &&
    endsSession(response.status, problem.success ? problem.data.code : 'REQUEST_FAILED')
  ) {
    notifySessionExpired();
  }
  const requestId = problem.success
    ? problem.data.requestId
    : (response.headers.get('X-Request-Id') ?? undefined);
  throw new ApiError({
    status: response.status,
    code: problem.success ? problem.data.code : 'REQUEST_FAILED',
    message: problem.success
      ? problem.data.detail
      : 'The request could not be completed. Please try again.',
    ...(requestId === undefined ? {} : { requestId }),
  });
}
