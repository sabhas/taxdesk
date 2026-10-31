import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsSchema } from '@taxdesk/shared';
import { onRequest, type PagesFunctionContext, type PagesFunctionEnv } from './[[path]].js';

function context(
  path: string,
  env: PagesFunctionEnv,
  init?: RequestInit,
): PagesFunctionContext<PagesFunctionEnv> {
  return {
    request: new Request(`https://taxdesk.example${path}`, init),
    env,
    next: vi.fn().mockResolvedValue(new Response('static asset')),
  };
}

describe('Pages API proxy', () => {
  it.each(['/api/v1/app-info', '/api/v1/clients?limit=25', '/health'])(
    'forwards %s to the bound Hono Worker',
    async (path) => {
      const workerResponse = new Response('worker response');
      const fetch = vi.fn().mockResolvedValue(workerResponse);
      const requestContext = context(
        path,
        { API: { fetch } },
        { headers: { 'X-Request-Id': 'req-1' } },
      );

      const response = await onRequest(requestContext);

      expect(response).toBe(workerResponse);
      expect(fetch).toHaveBeenCalledOnce();
      const forwarded = fetch.mock.calls[0]?.[0] as Request;
      expect(forwarded.url).toBe(`https://taxdesk.example${path}`);
      expect(forwarded.headers.get('X-Request-Id')).toBe('req-1');
    },
  );

  it('preserves the method and body for API requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const requestContext = context(
      '/api/v1/example',
      { API: { fetch } },
      {
        method: 'POST',
        body: JSON.stringify({ value: true }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    await onRequest(requestContext);

    const forwarded = fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.method).toBe('POST');
    await expect(forwarded.text()).resolves.toBe('{"value":true}');
  });

  it('leaves static application routes to Pages', async () => {
    const fetch = vi.fn();
    const requestContext = context('/cases', { API: { fetch } });

    const response = await onRequest(requestContext);

    expect(fetch).not.toHaveBeenCalled();
    expect(requestContext.next).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe('static asset');
  });

  it('returns safe Problem Details when the API service binding is missing', async () => {
    const requestContext = context('/health', {}, { headers: { 'X-Request-Id': 'req-missing' } });

    const response = await onRequest(requestContext);

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json; charset=UTF-8');
    expect(response.headers.get('X-Request-Id')).toBe('req-missing');
    const body: unknown = await response.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        requestId: 'req-missing',
      });
    }
  });
});
