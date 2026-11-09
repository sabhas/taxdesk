import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { ROLE_KEYS, roleHasPermission, type RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import { routePolicyOf, type RoutePolicy } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';
import {
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
} from '../testing/harness.js';

/**
 * Routes outside the identity model on purpose: walking-skeleton health and
 * deployment metadata that never touch firm records.
 */
const INFRASTRUCTURE_ROUTES = new Set(['GET /health', 'GET /api/v1/app-info']);

interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly policy: RoutePolicy | undefined;
}

function declaredRoutes(app: Hono<AppEnv>): DeclaredRoute[] {
  const byRoute = new Map<string, DeclaredRoute>();
  for (const route of app.routes) {
    if (route.method === 'ALL') {
      continue; // app-wide middleware such as request IDs and security headers
    }
    const key = `${route.method} ${route.path}`;
    const existing = byRoute.get(key);
    const policy = routePolicyOf(route.handler) ?? existing?.policy;
    byRoute.set(key, { method: route.method, path: route.path, policy });
  }
  return [...byRoute.values()];
}

let counter = 0;
const PASSWORD = 'correct horse battery staple';

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  cookie: string | undefined,
): Promise<{ status: number; code: unknown }> {
  const headers: Record<string, string> = {
    'X-Request-Id': `policy-${String(++counter)}`,
    'Content-Type': 'application/json',
    'If-Match': '"1"',
  };
  if (cookie !== undefined) {
    headers['Cookie'] = cookie;
  }
  const response = await app.request(
    path,
    { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) },
    { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
  );
  const text = await response.text();
  let code: unknown;
  try {
    code = (JSON.parse(text) as Record<string, unknown>)['code'];
  } catch {
    code = undefined;
  }
  return { status: response.status, code };
}

function appFor(harness: TestHarness): Hono<AppEnv> {
  return createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
}

function concrete(path: string, userId: string): string {
  return path.replace(':userId', userId);
}

describe('route permission declarations', () => {
  it('declares exactly one access policy on every API route', () => {
    const routes = declaredRoutes(createApp());
    const undeclared = routes
      .filter((route) => !INFRASTRUCTURE_ROUTES.has(`${route.method} ${route.path}`))
      .filter((route) => route.policy === undefined)
      .map((route) => `${route.method} ${route.path}`);
    expect(undeclared).toEqual([]);
    expect(routes.length).toBeGreaterThan(INFRASTRUCTURE_ROUTES.size);
  });

  it('exposes no public registration or user-creation route', () => {
    const publicRoutes = declaredRoutes(createApp())
      .filter((route) => route.policy?.access === 'public')
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(publicRoutes).toEqual([
      'POST /api/v1/auth/activate',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/mfa/challenge',
      'POST /api/v1/auth/mfa/recovery',
    ]);
  });

  it('rejects every non-public route without a session', async () => {
    const harness = createTestHarness();
    const app = appFor(harness);
    for (const route of declaredRoutes(app)) {
      if (route.policy === undefined || route.policy.access === 'public') {
        continue;
      }
      const result = await call(app, route.method, concrete(route.path, 'x'), undefined);
      expect(result, `${route.method} ${route.path}`).toEqual({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('blocks every MFA-gated route for a session that has not enrolled MFA', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      email: 'pending@example.test',
      password: PASSWORD,
      role: 'administrator',
    });
    const { cookie } = await sessionCookieFor(harness, user);
    const app = appFor(harness);
    for (const route of declaredRoutes(app)) {
      const access = route.policy?.access;
      if (access === undefined || access === 'public' || access === 'session') {
        continue;
      }
      const result = await call(app, route.method, concrete(route.path, user.id), cookie);
      expect(result, `${route.method} ${route.path}`).toEqual({
        status: 403,
        code: 'MFA_ENROLLMENT_REQUIRED',
      });
    }
  });

  it.each(ROLE_KEYS)(
    'enforces every declared permission for the %s role',
    async (role: RoleKey) => {
      const harness = createTestHarness();
      await seedFirm(harness);
      const { user } = await seedUser(harness, {
        email: `${role}@example.test`,
        password: PASSWORD,
        role,
        mfaEnrolled: true,
      });
      const { user: other } = await seedUser(harness, {
        email: `other-${role}@example.test`,
        password: PASSWORD,
        role: 'consultant',
      });
      const app = appFor(harness);

      for (const route of declaredRoutes(app)) {
        const policy = route.policy;
        if (policy === undefined) {
          continue;
        }
        const label = `${role}: ${route.method} ${route.path}`;
        // Fresh session per call: some allowed calls (logout, user updates)
        // legitimately revoke the session they ran on.
        const { cookie } = await sessionCookieFor(harness, user);

        if (policy.access === 'permission') {
          const result = await call(app, route.method, concrete(route.path, other.id), cookie);
          if (roleHasPermission(role, policy.permission)) {
            expect(result.status, label).not.toBe(401);
            expect(result.code, label).not.toBe('FORBIDDEN');
          } else {
            expect(result, label).toEqual({ status: 403, code: 'FORBIDDEN' });
          }
        } else if (policy.access === 'self_or_permission') {
          const self = await call(app, route.method, concrete(route.path, user.id), cookie);
          expect(self.status, `${label} (self)`).toBe(200);
          const others = await call(app, route.method, concrete(route.path, other.id), cookie);
          if (roleHasPermission(role, policy.permission)) {
            expect(others.status, `${label} (other)`).toBe(200);
          } else {
            expect(others, `${label} (other)`).toEqual({ status: 403, code: 'FORBIDDEN' });
          }
        } else if (policy.access !== 'public') {
          const result = await call(app, route.method, concrete(route.path, user.id), cookie);
          expect(result.status, label).not.toBe(401);
          expect(result.code, label).not.toBe('FORBIDDEN');
        }
      }
    },
  );
});
