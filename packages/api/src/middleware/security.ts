import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Security headers for every API response. The CSP is deliberately restrictive:
 * the API returns JSON only and never needs scripts, frames, or forms.
 */
export const securityHeadersMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  if (new URL(c.req.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
};

/**
 * Origin check for state-changing requests. SameSite=Strict cookies are the
 * primary CSRF defense; this is the transport-level complement. Non-browser
 * clients without Origin/Sec-Fetch headers are allowed and still need a session.
 */
export const originCheckMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header('Origin');
  const site = c.req.header('Sec-Fetch-Site');
  const allowed = new Set<string>([
    new URL(c.req.url).origin,
    ...c.get('dependencies').authConfig.allowedOrigins,
  ]);

  if (origin !== undefined && !allowed.has(origin)) {
    throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  }
  if (site === 'cross-site' || site === 'same-site') {
    throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.');
  }

  await next();
};
