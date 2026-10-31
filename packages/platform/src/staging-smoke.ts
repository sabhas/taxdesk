import { randomUUID } from 'node:crypto';
import { AppInfoSchema, HealthSchema, ProblemDetailsSchema } from '@taxdesk/shared';
import type { CheckResult } from './contracts.js';

export interface StagingSmokeOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestId?: string;
  readonly expectedReleaseVersion?: string;
  /** Defaults to true; localhost is exempt so the check can be exercised locally. */
  readonly requireHttps?: boolean;
}

export interface StagingSmokeResult {
  readonly check: 'staging-smoke';
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly failed: readonly string[];
  readonly releaseVersion?: string;
}

const SENSITIVE_MARKERS =
  /(?:postgres(?:ql)?:\/\/|password\s*[:=]|secret\s*[:=]|authorization:\s*bearer|api[_-]?key\s*[:=])/i;

interface FetchedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

async function get(
  fetchImpl: typeof fetch,
  url: string,
  requestId: string,
): Promise<FetchedResponse> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Request-Id': requestId,
    },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

/**
 * Verifies the deployed staging walking skeleton through the public Pages host.
 *
 * The check covers same-origin health, app info, the Problem Details error
 * contract, request-ID propagation, and a secret-free response body. It never
 * prints a response body: failures include only a check ID and a safe detail.
 */
export async function runStagingSmoke(options: StagingSmokeOptions): Promise<StagingSmokeResult> {
  const checks: CheckResult[] = [];
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    return {
      check: 'staging-smoke',
      ok: false,
      checks: [check('BASE_URL_VALID', false, 'STAGING_WEB_URL is not a valid URL.')],
      failed: ['BASE_URL_VALID'],
    };
  }

  const httpsOk =
    options.requireHttps === false || base.protocol === 'https:' || isLocalHost(base.hostname);
  checks.push(
    check(
      'BASE_URL_HTTPS',
      httpsOk,
      httpsOk ? 'The staging host uses HTTPS.' : 'The staging host must use HTTPS.',
    ),
  );

  if (!httpsOk) {
    const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
    return { check: 'staging-smoke', ok: false, checks, failed };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const requestId = options.requestId ?? `staging-smoke-${randomUUID()}`;
  const baseUrl = base.toString().replace(/\/$/, '');

  try {
    const healthResponse = await get(fetchImpl, `${baseUrl}/health`, requestId);
    checks.push(
      check(
        'HEALTH_STATUS',
        healthResponse.status === 200,
        healthResponse.status === 200 ? 'Health returned 200.' : 'Health did not return 200.',
      ),
    );
    checks.push(
      check(
        'HEALTH_CONTENT_TYPE',
        healthResponse.headers.get('content-type')?.startsWith('application/json') === true,
        'Health must return application/json.',
      ),
    );
    checks.push(
      check(
        'HEALTH_CACHE_CONTROL',
        healthResponse.headers.get('cache-control') === 'no-store',
        'Health must return Cache-Control: no-store.',
      ),
    );

    const healthBody = parseJson(healthResponse.text);
    const healthParsed = HealthSchema.safeParse(healthBody);
    checks.push(
      check(
        'HEALTH_CONTRACT',
        healthParsed.success,
        healthParsed.success ? 'Health matches the shared contract.' : 'Health payload is invalid.',
      ),
    );

    if (healthParsed.success) {
      checks.push(
        check(
          'HEALTH_ENVIRONMENT',
          healthParsed.data.environment === 'staging',
          healthParsed.data.environment === 'staging'
            ? 'Health reports the staging environment.'
            : 'Health does not report the staging environment.',
        ),
      );
      checks.push(
        check(
          'REQUEST_ID_ECHO',
          healthParsed.data.requestId === requestId &&
            healthResponse.headers.get('x-request-id') === requestId,
          'The request ID is echoed in the header and body.',
        ),
      );
      checks.push(
        check(
          'RELEASE_VERSION',
          options.expectedReleaseVersion === undefined ||
            healthParsed.data.releaseVersion === options.expectedReleaseVersion,
          options.expectedReleaseVersion === undefined
            ? 'No expected release version was supplied.'
            : 'Health reports the deployed commit.',
        ),
      );
    }

    checks.push(
      check(
        'HEALTH_SECRET_FREE',
        !SENSITIVE_MARKERS.test(healthResponse.text),
        'Health response contains no connection or secret markers.',
      ),
    );

    const appInfoResponse = await get(fetchImpl, `${baseUrl}/api/v1/app-info`, requestId);
    const appInfoParsed = AppInfoSchema.safeParse(parseJson(appInfoResponse.text));
    checks.push(
      check(
        'APP_INFO_STATUS',
        appInfoResponse.status === 200,
        appInfoResponse.status === 200 ? 'App info returned 200.' : 'App info did not return 200.',
      ),
    );
    checks.push(
      check(
        'APP_INFO_CONTRACT',
        appInfoParsed.success &&
          appInfoParsed.data.name === 'TaxDesk API' &&
          appInfoParsed.data.environment === 'staging',
        appInfoParsed.success && appInfoParsed.data.environment === 'staging'
          ? 'App info matches the staging contract.'
          : 'App info payload is invalid.',
      ),
    );
    checks.push(
      check(
        'APP_INFO_SECRET_FREE',
        !SENSITIVE_MARKERS.test(appInfoResponse.text),
        'App info response contains no connection or secret markers.',
      ),
    );

    const notFoundResponse = await get(
      fetchImpl,
      `${baseUrl}/api/v1/ci-smoke-not-found`,
      requestId,
    );
    const notFoundParsed = ProblemDetailsSchema.safeParse(parseJson(notFoundResponse.text));
    checks.push(
      check(
        'PROBLEM_DETAILS_STATUS',
        notFoundResponse.status === 404,
        notFoundResponse.status === 404
          ? 'Unknown routes return 404.'
          : 'Unknown routes did not return 404.',
      ),
    );
    checks.push(
      check(
        'PROBLEM_DETAILS_CONTENT_TYPE',
        notFoundResponse.headers.get('content-type')?.startsWith('application/problem+json') ===
          true,
        'Unknown routes must return application/problem+json.',
      ),
    );
    checks.push(
      check(
        'PROBLEM_DETAILS_CONTRACT',
        notFoundParsed.success && notFoundParsed.data.requestId === requestId,
        notFoundParsed.success && notFoundParsed.data.requestId === requestId
          ? 'Problem Details matches the shared contract and request ID.'
          : 'Problem Details payload or request ID is invalid.',
      ),
    );

    const releaseVersion = healthParsed.success ? healthParsed.data.releaseVersion : undefined;
    const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
    return {
      check: 'staging-smoke',
      ok: failed.length === 0,
      checks,
      failed,
      ...(releaseVersion === undefined ? {} : { releaseVersion }),
    };
  } catch {
    const failed = [
      ...checks.filter((entry) => !entry.passed).map((entry) => entry.id),
      'SMOKE_REQUEST_FAILED',
    ];
    return {
      check: 'staging-smoke',
      ok: false,
      checks: [
        ...checks,
        check('SMOKE_REQUEST_FAILED', false, 'The staging request did not complete.'),
      ],
      failed,
    };
  }
}
