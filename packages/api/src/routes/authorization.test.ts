import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import type { AppEnv } from '../types.js';
import {
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
} from '../testing/harness.js';

let counter = 0;

function appFor(harness: TestHarness): Hono<AppEnv> {
  return createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
}

async function call(
  app: Hono<AppEnv>,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    'X-Request-Id': `authz-${String(++counter)}`,
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.cookie !== undefined) {
    headers['Cookie'] = options.cookie;
  }
  return await app.request(
    path,
    {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
  );
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data as Record<string, unknown>;
}

const PASSWORD = 'correct horse battery staple';

const ROLE_MATRIX: readonly RoleKey[] = [
  'administrator',
  'manager',
  'consultant',
  'billing',
  'read_only',
];

describe('server-side permission enforcement', () => {
  it('rejects every protected route without a session', async () => {
    const harness = createTestHarness();
    const app = appFor(harness);
    for (const path of [
      '/api/v1/auth/session',
      '/api/v1/firm/settings',
      '/api/v1/admin/users',
      '/api/v1/admin/audit-events',
    ]) {
      const response = await call(app, path);
      expect(response.status).toBe(401);
      expect((await body(response))['code']).toBe('UNAUTHENTICATED');
    }
  });

  it('returns 401 SESSION_EXPIRED for an unknown or revoked cookie', async () => {
    const harness = createTestHarness();
    const app = appFor(harness);
    const response = await call(app, '/api/v1/auth/session', {
      cookie: '__Host-taxdesk_session=not-a-real-session-token',
    });
    expect(response.status).toBe(401);
    expect((await body(response))['code']).toBe('SESSION_EXPIRED');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('enforces the built-in role matrix on representative routes', async () => {
    for (const role of ROLE_MATRIX) {
      const harness = createTestHarness();
      await seedFirm(harness);
      const { user } = await seedUser(harness, {
        email: `${role}@example.test`,
        password: PASSWORD,
        role,
        mfaEnrolled: true,
      });
      const { cookie } = await sessionCookieFor(harness, user);
      const app = appFor(harness);

      const users = await call(app, '/api/v1/admin/users', { cookie });
      const audit = await call(app, '/api/v1/admin/audit-events', { cookie });
      const firmRead = await call(app, '/api/v1/firm/settings', { cookie });
      const firmWrite = await call(app, '/api/v1/firm/settings', {
        method: 'PATCH',
        cookie,
        headers: { 'If-Match': '"1"' },
        body: { firmName: 'Renamed Firm', timezone: 'Asia/Karachi' },
      });

      if (role === 'administrator') {
        expect(users.status).toBe(200);
        expect(audit.status).toBe(200);
        expect(firmWrite.status).toBe(200);
      } else {
        expect(users.status).toBe(403);
        expect((await body(users))['code']).toBe('FORBIDDEN');
        expect(audit.status).toBe(403);
        expect(firmWrite.status).toBe(403);
      }
      expect(firmRead.status).toBe(200);
    }
  });

  it('applies the self-or-permission ownership rule to user records', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const consultant = await seedUser(harness, {
      email: 'consultant@example.test',
      password: PASSWORD,
      role: 'consultant',
      mfaEnrolled: true,
    });
    const other = await seedUser(harness, {
      email: 'other-manager@example.test',
      password: PASSWORD,
      role: 'manager',
      mfaEnrolled: true,
    });
    const admin = await seedUser(harness, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'administrator',
      mfaEnrolled: true,
    });
    const consultantCookie = (await sessionCookieFor(harness, consultant.user)).cookie;
    const adminCookie = (await sessionCookieFor(harness, admin.user)).cookie;
    const app = appFor(harness);

    expect(
      (await call(app, `/api/v1/users/${consultant.user.id}`, { cookie: consultantCookie })).status,
    ).toBe(200);

    const guessed = await call(app, `/api/v1/users/${other.user.id}`, {
      cookie: consultantCookie,
    });
    expect(guessed.status).toBe(403);
    const guessedBody = await body(guessed);
    expect(guessedBody['code']).toBe('FORBIDDEN');
    expect(JSON.stringify(guessedBody)).not.toContain('other-manager@example.test');

    expect(
      (await call(app, `/api/v1/users/${other.user.id}`, { cookie: adminCookie })).status,
    ).toBe(200);
  });

  it('does not disclose a protected record through a nested route', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const billing = await seedUser(harness, {
      email: 'billing@example.test',
      password: PASSWORD,
      role: 'billing',
      mfaEnrolled: true,
    });
    const admin = await seedUser(harness, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'administrator',
      mfaEnrolled: true,
    });
    const app = appFor(harness);
    const cookie = (await sessionCookieFor(harness, billing.user)).cookie;
    const response = await call(app, `/api/v1/admin/users/${admin.user.id}/reset-link`, {
      method: 'POST',
      cookie,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(admin.user.email);
  });

  it('blocks a session created before MFA enrollment from permission routes', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      email: 'admin@example.test',
      password: PASSWORD,
      role: 'administrator',
    });
    const { cookie } = await sessionCookieFor(harness, user, { mfaVerified: false });
    const app = appFor(harness);
    const response = await call(app, '/api/v1/firm/settings', { cookie });
    expect(response.status).toBe(403);
    expect((await body(response))['code']).toBe('MFA_ENROLLMENT_REQUIRED');
  });
});
