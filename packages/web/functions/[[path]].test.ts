import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsSchema } from '@taxdesk/shared';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECURITY_HEADERS,
  onRequest,
  type PagesFunctionContext,
  type PagesFunctionEnv,
} from './[[path]].js';

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

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('staff help gate (TD-806)', () => {
  function signedIn(status = 200) {
    return vi.fn().mockResolvedValue(new Response('{}', { status }));
  }

  it('serves help to a valid session and asks the API, not the browser', async () => {
    const fetch = signedIn();
    const requestContext = context(
      '/help/staff/clients.html',
      { API: { fetch } },
      { headers: { Cookie: '__Host-taxdesk_session=session-token' } },
    );

    const response = await onRequest(requestContext);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('static asset');
    expect(fetch).toHaveBeenCalledOnce();
    const check = fetch.mock.calls[0]?.[0] as Request;
    expect(check.method).toBe('GET');
    expect(check.url).toBe('https://taxdesk.example/api/v1/auth/session');
    expect(check.headers.get('Cookie')).toBe('__Host-taxdesk_session=session-token');
  });

  it('marks help responses private and applies the security headers', async () => {
    const requestContext = context('/help/', { API: { fetch: signedIn() } });

    const response = await onRequest(requestContext);

    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(response.headers.get('Vary')).toBe('Cookie');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it.each([401, 403])(
    'sends a %i session to sign-in with a return path and serves nothing',
    async (status) => {
      const requestContext = context('/help/staff/cases.html?x=1', {
        API: { fetch: signedIn(status) },
      });

      const response = await onRequest(requestContext);

      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe(
        '/?returnTo=%2Fhelp%2Fstaff%2Fcases.html%3Fx%3D1',
      );
      expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
      expect(requestContext.next).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['the API fails', { API: { fetch: signedIn(500) } }],
    ['the API cannot be reached', { API: { fetch: vi.fn().mockRejectedValue(new Error('down')) } }],
    ['the API binding is missing', {}],
  ])('fails closed with 503 when %s', async (_case, env: PagesFunctionEnv) => {
    const requestContext = context('/help', env);

    const response = await onRequest(requestContext);

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(requestContext.next).not.toHaveBeenCalled();
  });

  it('leaves paths that only start with "help" to Pages', async () => {
    const fetch = vi.fn();
    const requestContext = context('/helpful', { API: { fetch } });

    await onRequest(requestContext);

    expect(fetch).not.toHaveBeenCalled();
    expect(requestContext.next).toHaveBeenCalledOnce();
  });

  it('routes /help through the Function and matches the static security headers', () => {
    const routes = JSON.parse(readFileSync(join(PUBLIC_DIR, '_routes.json'), 'utf8')) as {
      include: string[];
    };
    expect(routes.include).toEqual(expect.arrayContaining(['/help', '/help/*']));

    const rule = readFileSync(join(PUBLIC_DIR, '_headers'), 'utf8');
    const headers = Object.fromEntries(
      rule
        .split('\n')
        .filter((line) => /^\s+\S/u.test(line))
        .map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
    expect(headers).toEqual(SECURITY_HEADERS);
  });
});
