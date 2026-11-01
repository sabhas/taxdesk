import { describe, expect, it } from 'vitest';
import { runStagingSmoke } from './staging-smoke.js';

const REQUEST_ID = 'staging-smoke-test';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockFetch(handler: (url: URL) => Response | Promise<Response>): typeof fetch {
  return (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(new URL(url)));
  };
}

function healthBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    environment: 'staging',
    releaseVersion: 'abc123',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function appInfoBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: 'TaxDesk API',
    version: '0.1.0',
    environment: 'staging',
    ...overrides,
  };
}

function problemDetailsBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'https://taxdesk.app/problems/not-found',
    title: 'Not Found',
    status: 404,
    code: 'NOT_FOUND',
    detail: 'The requested resource was not found.',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function healthyFetch(): typeof fetch {
  return mockFetch((url) => {
    if (url.pathname === '/health') {
      return json(healthBody(), 200, {
        'Cache-Control': 'no-store',
        'X-Request-Id': REQUEST_ID,
      });
    }
    if (url.pathname === '/api/v1/app-info') {
      return json(appInfoBody());
    }
    return json(problemDetailsBody(), 404, {
      'Content-Type': 'application/problem+json',
      'X-Request-Id': REQUEST_ID,
    });
  });
}

describe('runStagingSmoke', () => {
  it('passes a healthy staging deployment', async () => {
    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl: healthyFetch(),
      requestId: REQUEST_ID,
      expectedReleaseVersion: 'abc123',
    });
    expect(result.ok).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.releaseVersion).toBe('abc123');
  });

  it('fails when health reports another environment', async () => {
    const fetchImpl = mockFetch((url) =>
      url.pathname === '/health'
        ? json(healthBody({ environment: 'production' }), 200, {
            'Cache-Control': 'no-store',
            'X-Request-Id': REQUEST_ID,
          })
        : json({}),
    );
    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
      requestId: REQUEST_ID,
    });
    expect(result.failed).toContain('HEALTH_ENVIRONMENT');
  });

  it('fails when health leaks a connection string or secret marker', async () => {
    const fetchImpl = mockFetch((url) =>
      url.pathname === '/health'
        ? json(healthBody({ database: 'postgres://user:password@db.internal:5432/taxdesk' }), 200, {
            'Cache-Control': 'no-store',
            'X-Request-Id': REQUEST_ID,
          })
        : json({}),
    );
    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
      requestId: REQUEST_ID,
    });
    expect(result.failed).toContain('HEALTH_SECRET_FREE');
  });

  it('fails when the request ID is not echoed', async () => {
    const fetchImpl = mockFetch((url) =>
      url.pathname === '/health'
        ? json(healthBody({ requestId: 'different-id' }), 200, {
            'Cache-Control': 'no-store',
            'X-Request-Id': 'different-id',
          })
        : json({}),
    );
    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
      requestId: REQUEST_ID,
    });
    expect(result.failed).toContain('REQUEST_ID_ECHO');
  });

  it('fails when an unknown route does not return Problem Details', async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === '/health') {
        return json(healthBody(), 200, {
          'Cache-Control': 'no-store',
          'X-Request-Id': REQUEST_ID,
        });
      }
      if (url.pathname === '/api/v1/app-info') {
        return json(appInfoBody());
      }
      return json({ message: 'not found' }, 404, { 'X-Request-Id': REQUEST_ID });
    });
    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
      requestId: REQUEST_ID,
    });
    expect(result.failed).toEqual(
      expect.arrayContaining(['PROBLEM_DETAILS_CONTENT_TYPE', 'PROBLEM_DETAILS_CONTRACT']),
    );
  });

  it('names the app-info mismatch instead of reporting a generic invalid payload', async () => {
    const fetchImpl = mockFetch((url) => {
      if (url.pathname === '/health') {
        return json(healthBody(), 200, {
          'Cache-Control': 'no-store',
          'X-Request-Id': REQUEST_ID,
        });
      }
      if (url.pathname === '/api/v1/app-info') {
        // A deployed-but-miswired route: valid contract, wrong environment.
        return json(appInfoBody({ environment: 'development' }));
      }
      return json(problemDetailsBody(), 404, {
        'Content-Type': 'application/problem+json',
        'X-Request-Id': REQUEST_ID,
      });
    });

    const result = await runStagingSmoke({
      baseUrl: 'http://localhost:8787',
      fetchImpl,
      requestId: REQUEST_ID,
    });

    expect(result.failed).toEqual(['APP_INFO_CONTRACT']);
    const appInfoCheck = result.checks.find((entry) => entry.id === 'APP_INFO_CONTRACT');
    expect(appInfoCheck?.detail).toContain('development');
    expect(appInfoCheck?.detail).toContain('staging');
  });

  it('rejects a non-local plaintext base URL', async () => {
    const result = await runStagingSmoke({
      baseUrl: 'http://staging.example.test',
      fetchImpl: healthyFetch(),
      requestId: REQUEST_ID,
    });
    expect(result.failed).toEqual(['BASE_URL_HTTPS']);
  });

  it('fails safely when the request throws', async () => {
    const fetchImpl = (() => Promise.reject(new Error('connection refused'))) as typeof fetch;
    const result = await runStagingSmoke({
      baseUrl: 'https://staging.example.test',
      fetchImpl,
      requestId: REQUEST_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.failed).toContain('SMOKE_REQUEST_FAILED');
    expect(JSON.stringify(result)).not.toContain('connection refused');
  });
});
