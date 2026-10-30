import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInfoSchema, HealthSchema } from '@taxdesk/shared';
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
  it('returns valid app info and a request ID', async () => {
    const response = await app.request('/api/v1/app-info');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    const body: unknown = await response.json();
    const parsed = AppInfoSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('TaxDesk API');
      expect(parsed.data.environment).toBe('development');
    }
  });

  it('returns a consistent JSON error for unknown routes', async () => {
    const response = await app.request('/api/v1/unknown');
    expect(response.status).toBe(404);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: 'Not Found' });
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
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
