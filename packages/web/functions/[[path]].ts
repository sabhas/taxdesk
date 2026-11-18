import { ProblemDetailsSchema, RequestIdSchema, type ProblemDetails } from '@taxdesk/shared';

interface ServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface PagesFunctionEnv {
  API?: ServiceFetcher;
}

export interface PagesFunctionContext<Env> {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}

const API_PREFIX = '/api/';
const HEALTH_PATH = '/health';
const HELP_PATH = '/help';
const SESSION_PATH = '/api/v1/auth/session';
const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Pages does not apply `_headers` to responses a Function returns, so help
 * responses set the application's headers themselves. A test keeps this list
 * identical to the `/*` rule in `public/_headers`.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; font-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function isWorkerPath(pathname: string): boolean {
  return pathname === HEALTH_PATH || pathname.startsWith(API_PREFIX);
}

function isHelpPath(pathname: string): boolean {
  return pathname === HELP_PATH || pathname.startsWith(`${HELP_PATH}/`);
}

/** Help is per-user content: never stored by a shared cache, revalidated each visit. */
function helpResponse(response: Response): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    result.headers.set(name, value);
  }
  result.headers.set('Cache-Control', 'private, no-cache');
  result.headers.set('Vary', 'Cookie');
  return result;
}

function helpUnavailable(): Response {
  return helpResponse(
    new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Help unavailable · TaxDesk</title></head>' +
        '<body><main><h1>Help is temporarily unavailable</h1>' +
        '<p>TaxDesk could not confirm your sign-in. Please try again in a moment.</p>' +
        '<p><a href="/">Back to TaxDesk</a></p></main></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '30' } },
    ),
  );
}

/**
 * TD-806: serves the staff help bundle only to a signed-in session. Each
 * request asks the API whether the session cookie is valid; the browser's
 * claim is never trusted. A signed-out visitor goes to sign-in, and the app
 * returns them to the requested help page afterwards (`returnTo`).
 */
async function serveHelp(context: PagesFunctionContext<PagesFunctionEnv>): Promise<Response> {
  const { request, env } = context;
  if (!env.API) {
    return helpUnavailable();
  }

  const headers = new Headers({ Accept: 'application/json' });
  const cookie = request.headers.get('Cookie');
  if (cookie !== null) {
    headers.set('Cookie', cookie);
  }
  let session: Response;
  try {
    session = await env.API.fetch(
      new Request(new URL(SESSION_PATH, request.url), { method: 'GET', headers }),
    );
  } catch {
    return helpUnavailable();
  }

  if (session.status === 401 || session.status === 403) {
    const url = new URL(request.url);
    const signIn = new URL('/', url);
    signIn.searchParams.set('returnTo', url.pathname + url.search);
    return helpResponse(
      new Response(null, { status: 303, headers: { Location: signIn.pathname + signIn.search } }),
    );
  }
  if (!session.ok) {
    return helpUnavailable();
  }

  return helpResponse(await context.next());
}

function missingBindingResponse(request: Request): Response {
  const candidate = request.headers.get(REQUEST_ID_HEADER)?.trim();
  const parsed = RequestIdSchema.safeParse(candidate);
  const requestId = parsed.success ? parsed.data : crypto.randomUUID();
  const body: ProblemDetails = ProblemDetailsSchema.parse({
    type: 'https://taxdesk.app/problems/service-unavailable',
    title: 'Service Unavailable',
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
    detail: 'The TaxDesk API is temporarily unavailable. Please try again later.',
    requestId,
  });

  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      'Content-Type': 'application/problem+json; charset=UTF-8',
      'Cache-Control': 'no-store',
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

/**
 * Cloudflare Pages Function that forwards same-origin `/health` and `/api/*`
 * requests to the environment's Hono Worker through the `API` service binding,
 * and serves `/help/` only to signed-in sessions. Static application routes
 * continue to be served by Pages via `next()`.
 */
export async function onRequest(
  context: PagesFunctionContext<PagesFunctionEnv>,
): Promise<Response> {
  const { pathname } = new URL(context.request.url);
  if (isHelpPath(pathname)) {
    return serveHelp(context);
  }
  if (!isWorkerPath(pathname)) {
    return context.next();
  }

  if (!context.env.API) {
    return missingBindingResponse(context.request);
  }

  return context.env.API.fetch(context.request);
}
