import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoSchema, HealthSchema, ProblemDetailsSchema } from '@taxdesk/shared';
import type { ApiBindings } from './config.js';
import app from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function bindings(overrides: Partial<ApiBindings> = {}): ApiBindings {
  return {
    ENVIRONMENT: 'development',
    RELEASE_VERSION: '0.0.0',
    ...overrides,
  };
}

describe('GET /api/v1/app-info', () => {
  it('reports the deployed environment and release version, never a default', async () => {
    const response = await app.request(
      '/api/v1/app-info',
      undefined,
      bindings({ ENVIRONMENT: 'staging', RELEASE_VERSION: '1.2.3' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();

    // Regression: the route once built AppInfoService with default arguments, so
    // deployed staging answered environment "development" and version "0.0.0".
    // The staging smoke check caught it; this test keeps it caught locally.
    const parsed = AppInfoSchema.parse(await response.json());
    expect(parsed).toEqual({ name: 'TaxDesk API', version: '1.2.3', environment: 'staging' });
  });

  it('fails closed without leaking bindings when configuration is invalid', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app.request(
      '/api/v1/app-info',
      undefined,
      bindings({ ENVIRONMENT: 'local' as never }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('local');
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('returns a Problem Details response for unknown routes', async () => {
    const response = await app.request('/api/v1/unknown');
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json; charset=UTF-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body: unknown = await response.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Not Found',
      });
      expect(parsed.data.requestId).toBe(response.headers.get('X-Request-Id'));
    }
  });

  it('returns a safe Problem Details response for unhandled failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app.request(
      '/health',
      undefined,
      bindings({ ENVIRONMENT: 'local' as never }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json; charset=UTF-8');

    const rawBody = await response.text();
    expect(rawBody).toContain('INTERNAL_ERROR');
    expect(rawBody).not.toContain('local');
    expect(rawBody).not.toContain('db.internal');
    expect(rawBody).not.toContain('supersecret');

    const parsed = ProblemDetailsSchema.safeParse(JSON.parse(rawBody));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.requestId).toBe(response.headers.get('X-Request-Id'));
    }

    expect(errorSpy).toHaveBeenCalledOnce();
    const logLine = String(errorSpy.mock.calls[0]?.[0]);
    expect(logLine).toContain('api.unhandled_error');
    expect(logLine).not.toContain('supersecret');
    expect(logLine).not.toContain('db.internal');
  });
});

describe('GET /health', () => {
  it('returns environment, release version, and request ID only', async () => {
    const response = await app.request(
      '/health',
      undefined,
      bindings({ ENVIRONMENT: 'staging', RELEASE_VERSION: '1.2.3' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body: unknown = await response.json();
    const parsed = HealthSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([
        'environment',
        'releaseVersion',
        'requestId',
      ]);
      expect(parsed.data.environment).toBe('staging');
      expect(parsed.data.releaseVersion).toBe('1.2.3');
      expect(parsed.data.requestId).toBe(response.headers.get('X-Request-Id'));
    }
  });

  it('echoes a caller-supplied request ID', async () => {
    const response = await app.request(
      '/health',
      { headers: { 'X-Request-Id': 'req-supplied' } },
      bindings(),
    );
    const body = HealthSchema.parse(await response.json());
    expect(body.requestId).toBe('req-supplied');
    expect(response.headers.get('X-Request-Id')).toBe('req-supplied');
  });

  it('replaces an unsafe caller-supplied request ID', async () => {
    const response = await app.request(
      '/health',
      { headers: { 'X-Request-Id': 'bad value' } },
      bindings(),
    );
    const body = HealthSchema.parse(await response.json());
    expect(body.requestId).not.toBe('bad value');
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  });

  it('never reveals secrets, database names, or infrastructure addresses', async () => {
    const response = await app.request(
      '/health',
      undefined,
      bindings({
        ENVIRONMENT: 'production',
        RELEASE_VERSION: '9.9.9',
        DATABASE_URL: 'postgres://app:supersecret@db.internal.example:5432/taxdesk_production',
        HYPERDRIVE: {
          connectionString:
            'postgres://app:supersecret@db.internal.example:5432/taxdesk_production',
        },
        ONEDRIVE_CLIENT_SECRET: 'graph-client-secret-value',
      }),
    );

    const rawBody = await response.text();
    expect(rawBody).not.toContain('supersecret');
    expect(rawBody).not.toContain('taxdesk_production');
    expect(rawBody).not.toContain('db.internal.example');
    expect(rawBody).not.toContain('graph-client-secret-value');
    expect(rawBody).not.toContain('ONEDRIVE_CLIENT_SECRET');

    const body: unknown = JSON.parse(rawBody);
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
      'environment',
      'releaseVersion',
      'requestId',
    ]);
    expect(HealthSchema.safeParse(body).success).toBe(true);
  });

  it('fails closed without leaking configuration when bindings are invalid', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app.request(
      '/health',
      undefined,
      bindings({ ENVIRONMENT: 'local' as never }),
    );
    expect(response.status).toBe(500);
    const rawBody = await response.text();
    expect(rawBody).toContain('Internal Server Error');
    expect(rawBody).not.toContain('local');
    expect(rawBody).not.toContain('db.internal');
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
