import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
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

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(app: Hono<AppEnv>, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'X-Request-Id': `lifecycle-${String(++counter)}`,
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
const NEW_PASSWORD = 'another correct horse battery';

async function adminSession(harness: TestHarness) {
  const admin = await seedUser(harness, {
    email: 'admin@example.test',
    password: PASSWORD,
    role: 'administrator',
    mfaEnrolled: true,
  });
  const { cookie } = await sessionCookieFor(harness, admin.user);
  return { admin, cookie };
}

describe('administrator user lifecycle', () => {
  it('invites a user with a one-time 30-minute activation link', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { cookie } = await adminSession(harness);
    const app = appFor(harness);

    const invitation = await call(app, '/api/v1/admin/users/invitations', {
      method: 'POST',
      cookie,
      body: { email: 'consultant@example.test', displayName: 'New Consultant', role: 'consultant' },
    });
    expect(invitation.status).toBe(200);
    const invitationBody = await body(invitation);
    const activationUrl = invitationBody['activationUrl'] as string;
    expect(activationUrl.startsWith('https://taxdesk.test/activate?token=')).toBe(true);
    const expiresAt = new Date(invitationBody['expiresAt'] as string).getTime();
    expect(expiresAt - harness.now().getTime()).toBe(30 * 60 * 1000);

    const duplicate = await call(app, '/api/v1/admin/users/invitations', {
      method: 'POST',
      cookie,
      body: { email: 'consultant@example.test', displayName: 'Again', role: 'consultant' },
    });
    expect(duplicate.status).toBe(409);
    expect((await body(duplicate))['code']).toBe('EMAIL_IN_USE');

    const token = new URL(activationUrl).searchParams.get('token') ?? '';
    const activated = await call(app, '/api/v1/auth/activate', {
      method: 'POST',
      body: { token, password: NEW_PASSWORD },
    });
    expect(activated.status).toBe(200);
    expect((await body(activated))['status']).toBe('activated');

    const reused = await call(app, '/api/v1/auth/activate', {
      method: 'POST',
      body: { token, password: NEW_PASSWORD },
    });
    expect(reused.status).toBe(401);
    expect((await body(reused))['code']).toBe('ACTIVATION_TOKEN_INVALID');

    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'consultant@example.test', password: NEW_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await body(login))['status']).toBe('mfa_enrollment_required');
  });

  it('issues a one-time password reset link that rotates the password and revokes sessions', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { cookie } = await adminSession(harness);
    const target = await seedUser(harness, {
      email: 'target@example.test',
      password: PASSWORD,
      role: 'manager',
      mfaEnrolled: true,
    });
    const targetSession = (await sessionCookieFor(harness, target.user)).cookie;
    const app = appFor(harness);

    const link = await call(app, `/api/v1/admin/users/${target.user.id}/reset-link`, {
      method: 'POST',
      cookie,
      body: {},
    });
    expect(link.status).toBe(200);
    const token =
      new URL((await body(link))['activationUrl'] as string).searchParams.get('token') ?? '';

    const reset = await call(app, '/api/v1/auth/activate', {
      method: 'POST',
      body: { token, password: NEW_PASSWORD },
    });
    expect(reset.status).toBe(200);

    expect((await call(app, '/api/v1/auth/session', { cookie: targetSession })).status).toBe(401);

    const oldPassword = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'target@example.test', password: PASSWORD },
    });
    expect(oldPassword.status).toBe(401);
    const newPassword = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'target@example.test', password: NEW_PASSWORD },
    });
    expect(newPassword.status).toBe(200);
  });

  it('uses ETags for user updates and revokes sessions on role and status changes', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { cookie } = await adminSession(harness);
    const target = await seedUser(harness, {
      email: 'target@example.test',
      password: PASSWORD,
      role: 'manager',
      mfaEnrolled: true,
    });
    const targetSession = (await sessionCookieFor(harness, target.user)).cookie;
    const app = appFor(harness);
    const current = await harness.repositories.users.findById(target.user.id);

    const missing = await call(app, `/api/v1/admin/users/${target.user.id}`, {
      method: 'PATCH',
      cookie,
      body: { role: 'consultant' },
    });
    expect(missing.status).toBe(428);
    expect((await body(missing))['code']).toBe('PRECONDITION_REQUIRED');

    const stale = await call(app, `/api/v1/admin/users/${target.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': '"99"' },
      body: { role: 'consultant' },
    });
    expect(stale.status).toBe(412);
    expect((await body(stale))['code']).toBe('PRECONDITION_FAILED');

    const updated = await call(app, `/api/v1/admin/users/${target.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': `"${String(current?.version ?? 1)}"` },
      body: { role: 'consultant' },
    });
    expect(updated.status).toBe(200);
    expect((await body(updated))['roles']).toEqual(['consultant']);
    expect(updated.headers.get('ETag')).toBe(`"${String((current?.version ?? 1) + 1)}"`);
    expect((await call(app, '/api/v1/auth/session', { cookie: targetSession })).status).toBe(401);
  });

  it('deactivates and reactivates a user while preserving audit history', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { cookie } = await adminSession(harness);
    const target = await seedUser(harness, {
      email: 'target@example.test',
      password: PASSWORD,
      role: 'manager',
      mfaEnrolled: true,
    });
    const targetSession = (await sessionCookieFor(harness, target.user)).cookie;
    const app = appFor(harness);
    const current = await harness.repositories.users.findById(target.user.id);

    const deactivated = await call(app, `/api/v1/admin/users/${target.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': `"${String(current?.version ?? 1)}"` },
      body: { status: 'deactivated' },
    });
    expect(deactivated.status).toBe(200);
    expect((await body(deactivated))['status']).toBe('deactivated');
    expect((await call(app, '/api/v1/auth/session', { cookie: targetSession })).status).toBe(401);

    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'target@example.test', password: PASSWORD },
    });
    expect(login.status).toBe(401);
    expect((await body(login))['detail']).toBe('The email or password is incorrect.');

    const resetForDeactivated = await call(
      app,
      `/api/v1/admin/users/${target.user.id}/reset-link`,
      { method: 'POST', cookie, body: {} },
    );
    expect(resetForDeactivated.status).toBe(409);

    const afterDeactivation = await harness.repositories.users.findById(target.user.id);
    const reactivated = await call(app, `/api/v1/admin/users/${target.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': `"${String(afterDeactivation?.version ?? 1)}"` },
      body: { status: 'active' },
    });
    expect(reactivated.status).toBe(200);
    expect((await body(reactivated))['status']).toBe('active');

    const audit = await call(app, '/api/v1/admin/audit-events?limit=50', { cookie });
    const actions = ((await body(audit))['events'] as { action: string; entityId: string }[]).map(
      (event) => `${event.action}:${event.entityId}`,
    );
    expect(actions).toContain(`user.deactivated:${target.user.id}`);
    expect(actions).toContain(`user.reactivated:${target.user.id}`);
  });

  it('prevents self-deactivation and removing the last administrator', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { admin, cookie } = await adminSession(harness);
    const app = appFor(harness);
    const current = await harness.repositories.users.findById(admin.user.id);

    const self = await call(app, `/api/v1/admin/users/${admin.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': `"${String(current?.version ?? 1)}"` },
      body: { status: 'deactivated' },
    });
    expect(self.status).toBe(403);

    const lastAdmin = await call(app, `/api/v1/admin/users/${admin.user.id}`, {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': `"${String(current?.version ?? 1)}"` },
      body: { role: 'manager' },
    });
    expect(lastAdmin.status).toBe(409);
    expect((await body(lastAdmin))['code']).toBe('CONFLICT');
  });
});

describe('firm settings', () => {
  it('requires a matching ETag and audits the change', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { cookie } = await adminSession(harness);
    const app = appFor(harness);

    const read = await call(app, '/api/v1/firm/settings', { cookie });
    expect(read.status).toBe(200);
    expect(read.headers.get('ETag')).toBe('"1"');

    const missing = await call(app, '/api/v1/firm/settings', {
      method: 'PATCH',
      cookie,
      body: { firmName: 'New Name', timezone: 'Asia/Karachi' },
    });
    expect(missing.status).toBe(428);

    const stale = await call(app, '/api/v1/firm/settings', {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': '"99"' },
      body: { firmName: 'New Name', timezone: 'Asia/Karachi' },
    });
    expect(stale.status).toBe(412);

    const invalidTimezone = await call(app, '/api/v1/firm/settings', {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': '"1"' },
      body: { firmName: 'New Name', timezone: 'Not/AZone' },
    });
    expect(invalidTimezone.status).toBe(400);

    const updated = await call(app, '/api/v1/firm/settings', {
      method: 'PATCH',
      cookie,
      headers: { 'If-Match': '"1"' },
      body: { firmName: 'New Name', timezone: 'Asia/Karachi' },
    });
    expect(updated.status).toBe(200);
    expect((await body(updated))['firmName']).toBe('New Name');
    expect(updated.headers.get('ETag')).toBe('"2"');

    const audit = await call(app, '/api/v1/admin/audit-events', { cookie });
    const actions = ((await body(audit))['events'] as { action: string }[]).map(
      (event) => event.action,
    );
    expect(actions).toContain('firm.settings_updated');
  });
});
