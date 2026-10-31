import type { MiddlewareHandler } from 'hono';
import { RequestIdSchema } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Keeps a well-formed caller-supplied request ID so clients can correlate
 * support reports, and replaces anything else with a fresh UUID. The value is
 * bounded before it reaches response headers, error bodies, or logs.
 */
export function resolveRequestId(
  candidate: string | undefined,
  generate: () => string = () => crypto.randomUUID(),
): string {
  const parsed = RequestIdSchema.safeParse(candidate?.trim());
  return parsed.success ? parsed.data : generate();
}

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set('requestId', requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  await next();
};
