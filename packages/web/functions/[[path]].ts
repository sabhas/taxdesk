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
const REQUEST_ID_HEADER = 'X-Request-Id';

function isWorkerPath(pathname: string): boolean {
  return pathname === HEALTH_PATH || pathname.startsWith(API_PREFIX);
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
 * requests to the environment's Hono Worker through the `API` service binding.
 * Static application routes continue to be served by Pages via `next()`.
 */
export async function onRequest(
  context: PagesFunctionContext<PagesFunctionEnv>,
): Promise<Response> {
  const { pathname } = new URL(context.request.url);
  if (!isWorkerPath(pathname)) {
    return context.next();
  }

  if (!context.env.API) {
    return missingBindingResponse(context.request);
  }

  return context.env.API.fetch(context.request);
}
