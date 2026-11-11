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
  type TestHarnessOptions,
} from '../testing/harness.js';

let counter = 0;
const PASSWORD = 'correct horse battery staple';
const CNIC = '35202-1234567-1';
const CNIC_DIGITS = '3520212345671';
const NTN = '7654321-0';

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie: string;
  ifMatch?: string;
}

interface Called {
  status: number;
  etag: string | null;
  data: Record<string, unknown>;
  text: string;
}

let tick: (() => void) | null = null;

async function call(app: Hono<AppEnv>, path: string, options: CallOptions): Promise<Called> {
  // Separate requests happen at separate instants; keeps UUIDv7 event order stable.
  tick?.();
  const headers: Record<string, string> = {
    'X-Request-Id': `clients-${String(++counter)}`,
    Cookie: options.cookie,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.ifMatch !== undefined) {
    headers['If-Match'] = options.ifMatch;
  }
  const response = await app.request(
    path,
    {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
  );
  const text = await response.text();
  return {
    status: response.status,
    etag: response.headers.get('ETag'),
    data: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    text,
  };
}

interface World {
  harness: TestHarness;
  app: Hono<AppEnv>;
  cookies: Record<RoleKey, string>;
  ids: Record<RoleKey, string>;
}

async function world(options: TestHarnessOptions = {}): Promise<World> {
  const harness = createTestHarness(options);
  tick = () => {
    harness.advance(1_000);
  };
  await seedFirm(harness);
  let factoryCalls = 0;
  const app = createApp({
    dependencyFactory: () => {
      factoryCalls += 1;
      return Promise.resolve(harness.dependencies);
    },
    clock: harness.now,
  });
  Object.defineProperty(app, 'factoryCalls', { get: () => factoryCalls });
  const roles: RoleKey[] = ['administrator', 'manager', 'consultant', 'billing', 'read_only'];
  const cookies = {} as Record<RoleKey, string>;
  const ids = {} as Record<RoleKey, string>;
  for (const role of roles) {
    const { user } = await seedUser(harness, {
      username: `staff-${role.replace('_', '-')}`,
      displayName: `Staff ${role}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    ids[role] = user.id;
  }
  return { harness, app, cookies, ids };
}

function individual(overrides: Record<string, unknown> = {}) {
  return {
    type: 'individual',
    legalName: 'Test Individual One',
    cnic: CNIC,
    contacts: [{ name: 'Self', email: 'one@example.test', phone: '0300 1112223', isPrimary: true }],
    notes: 'Synthetic test client.',
    assignedManagerUserId: null,
    ...overrides,
  };
}

function business(overrides: Record<string, unknown> = {}) {
  return {
    type: 'business',
    legalName: 'Synthetic Traders (Pvt.) Ltd.',
    displayName: 'Synthetic Traders',
    ntn: NTN,
    contacts: [{ name: 'Accounts', email: 'accounts@traders.test', isPrimary: true }],
    assignedManagerUserId: null,
    ...overrides,
  };
}

async function create(w: World, body: unknown, role: RoleKey = 'manager') {
  return await call(w.app, '/api/v1/clients', { method: 'POST', body, cookie: w.cookies[role] });
}

describe('TD-201 client schema and validation', () => {
  it('creates an individual with a server-generated code and a masked CNIC', async () => {
    const w = await world();
    const result = await create(w, individual());
    expect(result.status).toBe(201);
    expect(result.data['clientCode']).toBe('CL-00001');
    expect(result.data['cnicMasked']).toBe('•••••-••••567-1');
    expect(result.data['state']).toBe('active');
    expect(result.data['displayName']).toBe('Test Individual One');
    expect(result.etag).toBe('"1"');
    expect(result.text).not.toContain(CNIC);
    expect(result.text).not.toContain(CNIC_DIGITS);

    const second = await create(w, business());
    expect(second.data['clientCode']).toBe('CL-00002');
  });

  it('stores CNIC only as ciphertext, blind index, and mask', async () => {
    const w = await world();
    await create(w, individual());
    const [stored] = [...w.harness.state.clients.values()];
    expect(stored?.cnic?.ciphertext).toMatch(/^v1\./u);
    expect(stored?.cnic?.blindIndex).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(CNIC_DIGITS);
    expect(JSON.stringify(w.harness.state.auditEvents)).not.toContain(CNIC_DIGITS);
  });

  it('validates required fields by client type on the server', async () => {
    const w = await world();
    const missingCnic = await create(w, { ...individual(), cnic: undefined });
    expect(missingCnic.status).toBe(400);
    expect(JSON.stringify(missingCnic.data['errors'])).toContain('cnic');

    const businessWithCnic = await create(w, business({ cnic: CNIC }));
    expect(businessWithCnic.status).toBe(400);

    const missingNtn = await create(w, { ...business(), ntn: undefined });
    expect(missingNtn.status).toBe(400);
    expect(JSON.stringify(missingNtn.data['errors'])).toContain('ntn');
  });

  it('rejects an assigned manager who is not an active user', async () => {
    const w = await world();
    const { user: inactive } = await seedUser(w.harness, {
      username: 'inactive-staff',
      password: PASSWORD,
      role: 'manager',
      status: 'deactivated',
    });
    const result = await create(w, individual({ assignedManagerUserId: inactive.id }));
    expect(result.status).toBe(400);
    expect(result.data['code']).toBe('ASSIGNEE_INVALID');
  });

  it('fails closed with 503 when identifier keys are not configured', async () => {
    const w = await world({ clientKeys: false });
    const result = await create(w, individual());
    expect(result.status).toBe(503);
    expect(w.harness.state.clients.size).toBe(0);
  });
});

describe('TD-202 create and view clients', () => {
  it('shows the summary, contacts, and assigned manager', async () => {
    const w = await world();
    const created = await create(w, individual({ assignedManagerUserId: w.ids.consultant }));
    const view = await call(w.app, `/api/v1/clients/${String(created.data['id'])}`, {
      cookie: w.cookies.read_only,
    });
    expect(view.status).toBe(200);
    expect(view.data['assignedManager']).toEqual({
      id: w.ids.consultant,
      displayName: 'Staff consultant',
    });
    expect((view.data['contacts'] as unknown[]).length).toBe(1);
  });

  it('allows only administrators and managers to create clients', async () => {
    const w = await world();
    for (const role of ['consultant', 'billing', 'read_only'] as const) {
      const result = await create(w, individual(), role);
      expect(result.status, role).toBe(403);
    }
    expect((await create(w, individual(), 'administrator')).status).toBe(201);
  });

  it('limits consultants to clients assigned to them', async () => {
    const w = await world();
    const mine = await create(w, individual({ assignedManagerUserId: w.ids.consultant }));
    const other = await create(w, business());

    const list = await call(w.app, '/api/v1/clients', { cookie: w.cookies.consultant });
    const codes = (list.data['clients'] as { clientCode: string }[]).map((c) => c.clientCode);
    expect(codes).toEqual([mine.data['clientCode']]);

    const denied = await call(w.app, `/api/v1/clients/${String(other.data['id'])}`, {
      cookie: w.cookies.consultant,
    });
    expect(denied.status).toBe(403);
    const deniedActivity = await call(
      w.app,
      `/api/v1/clients/${String(other.data['id'])}/activity`,
      { cookie: w.cookies.consultant },
    );
    expect(deniedActivity.status).toBe(403);

    const allowed = await call(w.app, `/api/v1/clients/${String(mine.data['id'])}`, {
      cookie: w.cookies.consultant,
    });
    expect(allowed.status).toBe(200);
  });

  it('does not reveal whether an unseen client exists', async () => {
    const w = await world();
    const missing = '0198a000-0000-7000-8000-00000000ffff';
    const consultant = await call(w.app, `/api/v1/clients/${missing}`, {
      cookie: w.cookies.consultant,
    });
    expect(consultant.status).toBe(403);
    const manager = await call(w.app, `/api/v1/clients/${missing}`, {
      cookie: w.cookies.manager,
    });
    expect(manager.status).toBe(404);
    expect(manager.data['code']).toBe('CLIENT_NOT_FOUND');
  });

  it('builds the request graph once per client request', async () => {
    const w = await world();
    await call(w.app, '/api/v1/clients', { cookie: w.cookies.manager });
    expect((w.app as unknown as { factoryCalls: number }).factoryCalls).toBe(1);
  });
});

describe('TD-203 update and concurrent edits', () => {
  async function seeded(w: World) {
    const created = await create(w, individual());
    return String(created.data['id']);
  }

  function update(overrides: Record<string, unknown> = {}) {
    return {
      type: 'individual',
      legalName: 'Test Individual Renamed',
      contacts: [{ name: 'Self', email: 'one@example.test', isPrimary: true }],
      notes: 'Updated notes.',
      assignedManagerUserId: null,
      ...overrides,
    };
  }

  it('requires If-Match for edits', async () => {
    const w = await world();
    const id = await seeded(w);
    const result = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update(),
      cookie: w.cookies.manager,
    });
    expect(result.status).toBe(428);
    expect(result.data['code']).toBe('PRECONDITION_REQUIRED');
  });

  it('applies a current edit and rejects the stale one', async () => {
    const w = await world();
    const id = await seeded(w);
    const first = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update(),
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    expect(first.status).toBe(200);
    expect(first.etag).toBe('"2"');
    expect(first.data['legalName']).toBe('Test Individual Renamed');

    const stale = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update({ legalName: 'Colleague Edit' }),
      cookie: w.cookies.administrator,
      ifMatch: '"1"',
    });
    expect(stale.status).toBe(412);
    expect(stale.data['code']).toBe('PRECONDITION_FAILED');
    const current = await call(w.app, `/api/v1/clients/${id}`, { cookie: w.cookies.manager });
    expect(current.data['legalName']).toBe('Test Individual Renamed');
  });

  it('keeps identifiers when omitted and replaces them when sent', async () => {
    const w = await world();
    const id = await seeded(w);
    const kept = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update(),
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    expect(kept.data['cnicMasked']).toBe('•••••-••••567-1');
    const replaced = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update({ cnic: '42101-7654321-9', ntn: '1234567-8' }),
      cookie: w.cookies.manager,
      ifMatch: '"2"',
    });
    expect(replaced.data['cnicMasked']).toBe('•••••-••••321-9');
    expect(replaced.data['ntnMasked']).toBe('••••567-8');
    const cleared = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update({ ntn: null }),
      cookie: w.cookies.manager,
      ifMatch: '"3"',
    });
    expect(cleared.data['ntnMasked']).toBeNull();
  });

  it('refuses a type change and an identifier already used by another client', async () => {
    const w = await world();
    const id = await seeded(w);
    await create(w, individual({ cnic: '42101-7654321-9', contacts: [], legalName: 'Other' }));
    const typeChange = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: { ...business(), notes: '' },
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    expect(typeChange.status).toBe(400);
    const clash = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update({ cnic: '42101-7654321-9' }),
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    expect(clash.status).toBe(409);
    expect(clash.data['code']).toBe('CLIENT_IDENTIFIER_EXISTS');
  });

  it('records an update without values in activity', async () => {
    const w = await world();
    const id = await seeded(w);
    await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      body: update({ cnic: '42101-7654321-9' }),
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    const activity = await call(w.app, `/api/v1/clients/${id}/activity`, {
      cookie: w.cookies.manager,
    });
    const events = activity.data['events'] as Record<string, unknown>[];
    expect(events.map((event) => event['action'])).toEqual(['client.updated', 'client.created']);
    expect(events[0]?.['changedFields']).toEqual([
      'legalName',
      'displayName',
      'cnic',
      'contacts',
      'notes',
    ]);
    expect(events[0]?.['cnicMasked']).toBe('•••••-••••321-9');
    expect(events[0]?.['actor']).toEqual({ id: w.ids.manager, displayName: 'Staff manager' });
    expect(activity.text).not.toContain('4210176543219');
    expect(activity.text).not.toContain('Updated notes.');
    expect(activity.text).not.toContain('one@example.test');
  });
});

describe('TD-204 search, filter, and pagination', () => {
  async function seedMany(w: World) {
    await create(w, individual({ assignedManagerUserId: w.ids.manager }));
    await create(w, business());
    await create(
      w,
      individual({
        legalName: 'Another Person',
        cnic: '61101-2223334-5',
        contacts: [{ name: 'Self', phone: '+92 321 5556667', isPrimary: true }],
      }),
    );
  }

  async function search(w: World, query: string): Promise<string[]> {
    const result = await call(w.app, `/api/v1/clients?${query}`, { cookie: w.cookies.read_only });
    expect(result.status, query).toBe(200);
    return (result.data['clients'] as { legalName: string }[]).map((c) => c.legalName);
  }

  it('searches code, normalized name, phone, email, and exact identifier', async () => {
    const w = await world();
    await seedMany(w);
    expect(await search(w, 'q=cl-00002')).toEqual(['Synthetic Traders (Pvt.) Ltd.']);
    expect(await search(w, 'q=synthetic%20traders%20ltd')).toEqual([
      'Synthetic Traders (Pvt.) Ltd.',
    ]);
    expect(await search(w, `q=${encodeURIComponent('03215556667')}`)).toEqual(['Another Person']);
    expect(await search(w, 'q=ACCOUNTS%40traders')).toEqual(['Synthetic Traders (Pvt.) Ltd.']);
    expect(await search(w, `q=${encodeURIComponent(CNIC)}`)).toEqual(['Test Individual One']);
    expect(await search(w, `q=${CNIC_DIGITS}`)).toEqual(['Test Individual One']);
    // Partial identifiers never match: identifier search is exact only.
    expect(await search(w, 'q=35202-12345')).toEqual([]);
    expect(await search(w, 'q=nothing%20matches')).toEqual([]);
  });

  it('treats LIKE wildcards in a search as literal text', async () => {
    const w = await world();
    await seedMany(w);
    expect(await search(w, 'q=%25')).toEqual([]);
    expect(await search(w, 'q=_')).toEqual([]);
  });

  it('filters by type, manager, and archive state on the server', async () => {
    const w = await world();
    await seedMany(w);
    expect(await search(w, 'type=business')).toEqual(['Synthetic Traders (Pvt.) Ltd.']);
    expect(await search(w, `manager=${w.ids.manager}`)).toEqual(['Test Individual One']);
    expect(await search(w, 'manager=unassigned')).toEqual([
      'Another Person',
      'Synthetic Traders (Pvt.) Ltd.',
    ]);
    expect(await search(w, 'state=archived')).toEqual([]);
    expect(await search(w, 'type=partnership').catch(() => 'rejected')).toBe('rejected');
  });

  it('pages with an opaque cursor and no gaps or repeats', async () => {
    const w = await world();
    for (let index = 0; index < 5; index += 1) {
      await create(
        w,
        business({
          legalName: `Paged Business ${String(index)}`,
          displayName: undefined,
          ntn: `100000${String(index)}`,
          contacts: [],
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
      const page = await call(w.app, `/api/v1/clients?${query}`, { cookie: w.cookies.manager });
      seen.push(...(page.data['clients'] as { legalName: string }[]).map((c) => c.legalName));
      cursor = page.data['nextCursor'] as string | null;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([0, 1, 2, 3, 4].map((index) => `Paged Business ${String(index)}`));

    const bad = await call(w.app, '/api/v1/clients?cursor=not-a-cursor', {
      cookie: w.cookies.manager,
    });
    expect(bad.status).toBe(400);
  });
});

describe('TD-205 duplicate detection', () => {
  it('blocks an exact CNIC duplicate, including an archived client', async () => {
    const w = await world();
    const first = await create(w, individual());
    await call(w.app, `/api/v1/clients/${String(first.data['id'])}/archive`, {
      method: 'POST',
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    const again = await create(
      w,
      individual({ legalName: 'Different Name', cnic: CNIC_DIGITS, contacts: [] }),
    );
    expect(again.status).toBe(409);
    expect(again.data['code']).toBe('CLIENT_IDENTIFIER_EXISTS');
    // An override reason never bypasses an exact identifier block.
    const forced = await create(
      w,
      individual({
        legalName: 'Different Name',
        contacts: [],
        duplicateOverrideReason: 'Trying to force a duplicate identifier.',
      }),
    );
    expect(forced.status).toBe(409);
  });

  it('blocks an exact NTN duplicate across client types', async () => {
    const w = await world();
    await create(w, business());
    const result = await create(w, individual({ ntn: NTN, contacts: [], legalName: 'Owner' }));
    expect(result.data['code']).toBe('CLIENT_IDENTIFIER_EXISTS');
  });

  it('previews blocking matches and warnings before creation', async () => {
    const w = await world();
    await create(w, individual());
    const preview = await call(w.app, '/api/v1/clients/duplicate-check', {
      method: 'POST',
      cookie: w.cookies.manager,
      body: individual({
        legalName: 'MR. test individual one',
        cnic: '42101-7654321-9',
        contacts: [{ name: 'Other', phone: '+92 300 1112223', isPrimary: false }],
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.data['blocking']).toEqual([]);
    const warnings = preview.data['warnings'] as { clientCode: string; reasons: string[] }[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reasons).toEqual(['phone', 'name']);
    expect(preview.text).not.toContain(CNIC_DIGITS);
  });

  it('requires a reason to override a warning and audits the decision', async () => {
    const w = await world();
    await create(w, individual());
    const candidate = individual({
      legalName: 'New Person',
      cnic: '42101-7654321-9',
      contacts: [{ name: 'Shared inbox', email: 'ONE@example.test', isPrimary: true }],
    });
    const warned = await create(w, candidate);
    expect(warned.status).toBe(409);
    expect(warned.data['code']).toBe('CLIENT_DUPLICATE_WARNING');

    const overridden = await create(w, {
      ...candidate,
      duplicateOverrideReason: 'Spouses share one household email address.',
    });
    expect(overridden.status).toBe(201);
    const override = w.harness.state.auditEvents.find(
      (event) => event.action === 'client.duplicate_override',
    );
    expect(override?.actorUserId).toBe(w.ids.manager);
    expect(override?.metadata).toMatchObject({
      reason: 'Spouses share one household email address.',
      matchedClients: 'CL-00001',
      matchReasons: 'email',
    });

    const activity = await call(
      w.app,
      `/api/v1/clients/${String(overridden.data['id'])}/activity`,
      { cookie: w.cookies.administrator },
    );
    const events = activity.data['events'] as Record<string, unknown>[];
    expect(events.some((event) => event['overrideReason'] === override?.metadata['reason'])).toBe(
      true,
    );
  });

  it('lets only managers and administrators run the duplicate check', async () => {
    const w = await world();
    for (const role of ['consultant', 'billing', 'read_only'] as const) {
      const result = await call(w.app, '/api/v1/clients/duplicate-check', {
        method: 'POST',
        cookie: w.cookies[role],
        body: individual(),
      });
      expect(result.status, role).toBe(403);
    }
  });
});

describe('TD-206 archive and activity history', () => {
  it('archives and restores with If-Match and records both', async () => {
    const w = await world();
    const created = await create(w, individual());
    const id = String(created.data['id']);
    const unguarded = await call(w.app, `/api/v1/clients/${id}/archive`, {
      method: 'POST',
      cookie: w.cookies.manager,
    });
    expect(unguarded.status).toBe(428);

    const archived = await call(w.app, `/api/v1/clients/${id}/archive`, {
      method: 'POST',
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    expect(archived.status).toBe(200);
    expect(archived.data['state']).toBe('archived');
    expect(archived.data['archivedAt']).not.toBeNull();

    const again = await call(w.app, `/api/v1/clients/${id}/archive`, {
      method: 'POST',
      cookie: w.cookies.manager,
      ifMatch: '"2"',
    });
    expect(again.data['code']).toBe('CLIENT_ARCHIVED');

    const edit = await call(w.app, `/api/v1/clients/${id}`, {
      method: 'PATCH',
      cookie: w.cookies.manager,
      ifMatch: '"2"',
      body: { ...individual(), cnic: undefined, notes: '' },
    });
    expect(edit.data['code']).toBe('CLIENT_ARCHIVED');

    const restored = await call(w.app, `/api/v1/clients/${id}/restore`, {
      method: 'POST',
      cookie: w.cookies.administrator,
      ifMatch: '"2"',
    });
    expect(restored.data['state']).toBe('active');

    const activity = await call(w.app, `/api/v1/clients/${id}/activity`, {
      cookie: w.cookies.read_only,
    });
    expect((activity.data['events'] as { action: string }[]).map((e) => e.action)).toEqual([
      'client.restored',
      'client.archived',
      'client.created',
    ]);
  });

  it('hides archived clients from the default list and shows them on request', async () => {
    const w = await world();
    const created = await create(w, individual());
    await create(w, business());
    await call(w.app, `/api/v1/clients/${String(created.data['id'])}/archive`, {
      method: 'POST',
      cookie: w.cookies.manager,
      ifMatch: '"1"',
    });
    const names = async (query: string) =>
      (
        (await call(w.app, `/api/v1/clients${query}`, { cookie: w.cookies.manager })).data[
          'clients'
        ] as { legalName: string }[]
      ).map((c) => c.legalName);
    expect(await names('')).toEqual(['Synthetic Traders (Pvt.) Ltd.']);
    expect(await names('?state=archived')).toEqual(['Test Individual One']);
    expect(await names('?state=all')).toHaveLength(2);
  });

  it('denies archive and restore to roles without clients.manage', async () => {
    const w = await world();
    const created = await create(w, individual({ assignedManagerUserId: w.ids.consultant }));
    for (const role of ['consultant', 'billing', 'read_only'] as const) {
      const result = await call(w.app, `/api/v1/clients/${String(created.data['id'])}/archive`, {
        method: 'POST',
        cookie: w.cookies[role],
        ifMatch: '"1"',
      });
      expect(result.status, role).toBe(403);
    }
  });

  it('lists active staff as assignable managers', async () => {
    const w = await world();
    await seedUser(w.harness, {
      username: 'gone-staff',
      password: PASSWORD,
      role: 'manager',
      status: 'deactivated',
    });
    const result = await call(w.app, '/api/v1/clients/assignees', {
      cookie: w.cookies.consultant,
    });
    const ids = (result.data['assignees'] as { id: string }[]).map((a) => a.id);
    expect(ids).toHaveLength(5);
    expect(result.text).not.toContain('gone-staff');
  });
});
