import { describe, expect, it, vi } from 'vitest';
import { createJsonResponse } from '@taxdesk/test-utils';
import { loadHealth } from './health-client.js';

const health = {
  environment: 'production',
  releaseVersion: '2.0.0',
  requestId: 'req-health',
};

describe('loadHealth', () => {
  it('returns validated health data', async () => {
    const fetcher = vi.fn().mockResolvedValue(createJsonResponse(health));
    await expect(loadHealth(fetcher)).resolves.toEqual({
      status: 'success',
      health,
    });
  });

  it('returns a Problem Details request ID when the API fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      createJsonResponse(
        {
          type: 'https://taxdesk.app/problems/internal-error',
          title: 'Internal Server Error',
          status: 500,
          code: 'INTERNAL_ERROR',
          detail: 'The server could not complete the request. Please try again later.',
          requestId: 'req-problem',
        },
        { status: 500 },
      ),
    );
    await expect(loadHealth(fetcher)).resolves.toEqual({
      status: 'failure',
      requestId: 'req-problem',
    });
  });

  it('falls back to the response request ID when the error body is invalid', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        createJsonResponse(
          { error: 'Internal Server Error' },
          { status: 500, headers: { 'X-Request-Id': 'req-header' } },
        ),
      );
    await expect(loadHealth(fetcher)).resolves.toEqual({
      status: 'failure',
      requestId: 'req-header',
    });
  });

  it('returns a generic failure for network errors and invalid success payloads', async () => {
    await expect(loadHealth(vi.fn().mockRejectedValue(new Error('network down')))).resolves.toEqual(
      { status: 'failure' },
    );

    await expect(
      loadHealth(vi.fn().mockResolvedValue(createJsonResponse({ environment: 'local' }))),
    ).resolves.toEqual({ status: 'failure' });
  });
});
