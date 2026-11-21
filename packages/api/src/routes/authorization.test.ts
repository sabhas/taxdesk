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
        username: role,
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

  it('enforces the role matrix on client group routes (TD-207)', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const app = appFor(harness);
    const cookies = {} as Record<RoleKey, string>;
    for (const role of ROLE_MATRIX) {
      const { user } = await seedUser(harness, {
        username: `group-${role.replace('_', '-')}`,
        password: PASSWORD,
        role,
        mfaEnrolled: true,
      });
      cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    }
    const createClient = async (legalName: string, cnic: string) => {
      const response = await call(app, '/api/v1/clients', {
        method: 'POST',
        cookie: cookies.administrator,
        body: { type: 'individual', legalName, cnic, contacts: [], assignedManagerUserId: null },
      });
      expect(response.status).toBe(201);
      return await body(response);
    };
    const head = await createClient('Matrix Group Head', '35202-7000001-1');
    const member = await createClient('Matrix Group Member', '35202-7000002-1');
    const headId = String(head['id']);
    const memberId = String(member['id']);

    const expected: Record<RoleKey, { totals: number; groupList: number; setParent: number }> = {
      administrator: { totals: 200, groupList: 200, setParent: 200 },
      manager: { totals: 200, groupList: 200, setParent: 200 },
      // A consultant lacks billing.read, cannot see an unassigned head, and lacks clients.manage.
      consultant: { totals: 403, groupList: 403, setParent: 403 },
      billing: { totals: 200, groupList: 200, setParent: 403 },
      read_only: { totals: 200, groupList: 200, setParent: 403 },
    };
    for (const role of ROLE_MATRIX) {
      const cookie = cookies[role];
      const totals = await call(app, `/api/v1/invoices/group-totals?group=${headId}`, { cookie });
      expect(totals.status, `${role} group totals`).toBe(expected[role].totals);
      const groupList = await call(app, `/api/v1/clients?group=${headId}`, { cookie });
      expect(groupList.status, `${role} group list`).toBe(expected[role].groupList);
      const current = await body(
        await call(app, `/api/v1/clients/${memberId}`, { cookie: cookies.administrator }),
      );
      const setParent = await call(app, `/api/v1/clients/${memberId}`, {
        method: 'PATCH',
        cookie,
        headers: { 'If-Match': `"${String(current['version'])}"` },
        body: {
          type: 'individual',
          legalName: 'Matrix Group Member',
          contacts: [],
          notes: '',
          assignedManagerUserId: null,
          parentClientId: current['parentClient'] === null ? headId : null,
        },
      });
      expect(setParent.status, `${role} set parent`).toBe(expected[role].setParent);
    }
  });

  it('enforces the role matrix on combined group invoice routes (TD-511)', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const app = appFor(harness);
    const cookies = {} as Record<RoleKey, string>;
    for (const role of ROLE_MATRIX) {
      const { user } = await seedUser(harness, {
        username: `combined-${role.replace('_', '-')}`,
        password: PASSWORD,
        role,
        mfaEnrolled: true,
      });
      cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    }
    const createClient = async (legalName: string, cnic: string, parentClientId?: string) => {
      const response = await call(app, '/api/v1/clients', {
        method: 'POST',
        cookie: cookies.administrator,
        body: {
          type: 'individual',
          legalName,
          cnic,
          contacts: [],
          assignedManagerUserId: null,
          ...(parentClientId === undefined ? {} : { parentClientId }),
        },
      });
      expect(response.status).toBe(201);
      return String((await body(response))['id']);
    };
    const headId = await createClient('Matrix Combined Head', '35202-7100001-1');
    const memberId = await createClient('Matrix Combined Member', '35202-7100002-1', headId);

    const expected: Record<
      RoleKey,
      { create: number; read: number; billableCases: number; save: number }
    > = {
      administrator: { create: 201, read: 200, billableCases: 200, save: 200 },
      // A manager reads billing but holds no billing.manage.
      manager: { create: 403, read: 200, billableCases: 403, save: 403 },
      consultant: { create: 403, read: 403, billableCases: 403, save: 403 },
      billing: { create: 201, read: 200, billableCases: 200, save: 200 },
      read_only: { create: 403, read: 200, billableCases: 403, save: 403 },
    };
    for (const role of ROLE_MATRIX) {
      const cookie = cookies[role];
      const create = await call(app, '/api/v1/invoices', {
        method: 'POST',
        cookie,
        body: { clientId: headId, billingMode: 'combined' },
      });
      expect(create.status, `${role} create combined`).toBe(expected[role].create);

      // Every role then works against a draft the administrator created.
      const draft = await body(
        await call(app, '/api/v1/invoices', {
          method: 'POST',
          cookie: cookies.administrator,
          body: { clientId: headId, billingMode: 'combined' },
        }),
      );
      const invoiceId = String(draft['id']);
      const read = await call(app, `/api/v1/invoices/${invoiceId}`, { cookie });
      expect(read.status, `${role} read combined`).toBe(expected[role].read);
      const billableCases = await call(
        app,
        `/api/v1/invoices/${invoiceId}/billable-cases?clientId=${memberId}`,
        { cookie },
      );
      expect(billableCases.status, `${role} billable cases`).toBe(expected[role].billableCases);
      const save = await call(app, `/api/v1/invoices/${invoiceId}`, {
        method: 'PATCH',
        cookie,
        headers: { 'If-Match': '"1"' },
        body: {
          items: [
            {
              description: 'Member filing',
              quantity: 1,
              unitAmountMinor: 1_000,
              clientId: memberId,
            },
          ],
          discountMinor: 0,
          issueDate: null,
          dueDate: null,
          notes: '',
        },
      });
      expect(save.status, `${role} save combined lines`).toBe(expected[role].save);
    }
  });

  it('applies the self-or-permission ownership rule to user records', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const consultant = await seedUser(harness, {
      username: 'consultant',
      password: PASSWORD,
      role: 'consultant',
      mfaEnrolled: true,
    });
    const other = await seedUser(harness, {
      username: 'other-manager',
      password: PASSWORD,
      role: 'manager',
      mfaEnrolled: true,
    });
    const admin = await seedUser(harness, {
      username: 'admin',
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
    expect(JSON.stringify(guessedBody)).not.toContain('other-manager');

    expect(
      (await call(app, `/api/v1/users/${other.user.id}`, { cookie: adminCookie })).status,
    ).toBe(200);
  });

  it('does not disclose a protected record through a nested route', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const billing = await seedUser(harness, {
      username: 'billing',
      password: PASSWORD,
      role: 'billing',
      mfaEnrolled: true,
    });
    const admin = await seedUser(harness, {
      username: 'admin',
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
    expect(await response.text()).not.toContain(admin.user.username);
  });

  it('blocks a session created before MFA enrollment from permission routes', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      username: 'admin',
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
