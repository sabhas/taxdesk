import { describe, expect, it } from 'vitest';
import { AppInfoSchema } from '@taxdesk/shared';
import app from './index.js';

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
