import { describe, expect, it } from 'vitest';
import { createJsonResponse } from './index.js';

describe('createJsonResponse', () => {
  it('serializes JSON with the correct content type', async () => {
    const response = createJsonResponse({ ok: true });
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
