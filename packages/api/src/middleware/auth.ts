import type { Context, MiddlewareHandler } from 'hono';
import type { PermissionKey } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import {
  assertMfaReady,
  assertPermission,
  assertSelfOrPermission,
} from '../domain/auth/authorization.js';
import { serializeClearedSessionCookie, sessionTokenFromCookie } from '../transport/cookies.js';

/**
 * Every `/api/v1` route declares exactly one access policy. The policy is not
 * documentation: `protect()` turns it into the only guard on the route, and a
 * route-registry test fails if any route is registered without one.
 *
 * - `public`: reachable before sign-in (login, activation, MFA challenge).
 * - `session`: any signed-in session, including one that has not finished MFA
 *   enrollment (current session, logout, MFA enrollment).
 * - `self_service`: the caller's own account after MFA (disable MFA,
 *   regenerate recovery codes). No permission is needed to act on yourself.
 * - `permission`: MFA-verified session holding the named permission.
 * - `self_or_permission`: the path parameter names the caller, or the caller
 *   holds the named permission.
 */
export type RoutePolicy =
  | { readonly access: 'public' }
  | { readonly access: 'session' }
  | { readonly access: 'self_service' }
  | { readonly access: 'permission'; readonly permission: PermissionKey }
  | {
      readonly access: 'self_or_permission';
      readonly permission: PermissionKey;
      readonly param: string;
    };

export const ROUTE_POLICY = Symbol.for('taxdesk.routePolicy');

export type PolicyMiddleware = MiddlewareHandler<AppEnv> & {
  readonly [ROUTE_POLICY]: RoutePolicy;
};

/**
 * Resolves the opaque session cookie to the database-backed actor. The request
 * never supplies a role, permission, owner, or scope.
 */
async function authenticate(c: Context<AppEnv>): Promise<void> {
  const token = sessionTokenFromCookie(c.req.header('Cookie'));
  if (token === undefined) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  const actor = await c.get('dependencies').sessionService.validate(token);
  if (actor === null) {
    c.header('Set-Cookie', serializeClearedSessionCookie());
    throw new AuthError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.');
  }
  c.set('actor', actor);
  c.set('sessionToken', token);
}

/** Builds the single guard for a route from its declared access policy. */
export function protect(policy: RoutePolicy): PolicyMiddleware {
  const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (policy.access !== 'public') {
      await authenticate(c);
      if (policy.access !== 'session') {
        // MFA gate: no application route is reachable until enrollment and the
        // session's MFA verification are complete.
        const actor = c.get('actor');
        assertMfaReady(actor);
        if (policy.access === 'permission') {
          assertPermission(actor, policy.permission);
        } else if (policy.access === 'self_or_permission') {
          assertSelfOrPermission(actor, c.req.param(policy.param) ?? '', policy.permission);
        }
      }
    }
    await next();
  };
  return Object.assign(middleware, { [ROUTE_POLICY]: policy });
}

export function routePolicyOf(handler: unknown): RoutePolicy | undefined {
  if (typeof handler !== 'function') {
    return undefined;
  }
  return (handler as Partial<PolicyMiddleware>)[ROUTE_POLICY];
}
