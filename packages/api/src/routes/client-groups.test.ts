/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/dot-notation -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import { STARTER_WORKFLOW_DEFINITION, type RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import { ClientGroupRuleError } from '../repositories/ports.js';
import {
  connectStorage,
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
} from '../testing/harness.js';
import type { UserRecord } from '../domain/auth/types.js';

/**
 * TD-207 client groups: the parent link on the versioned client edit, the
 * one-level group rule, visibility, the audit event, and the group filters on
 * clients, cases, and invoices with group billing totals.
 */

const PASSWORD = 'correct horse battery staple';
let counter = 0;
let cnicCounter = 1;

type Actor = RoleKey;

interface Called {
  status: number;
  etag: string | null;
  data: Record<string, any>;
  text: string;
}

interface CallOptions {
  as: Actor;
  method?: string;
  body?: unknown;
  ifMatch?: number;
  key?: string;
}

interface World {
  harness: TestHarness;
  users: Record<Actor, UserRecord>;
  call: (path: string, options: CallOptions) => Promise<Called>;
}

async function world(): Promise<World> {
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z') });
  await seedFirm(harness);
  const app = createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
  const cookies = {} as Record<Actor, string>;
  const users = {} as Record<Actor, UserRecord>;
  const roles: RoleKey[] = ['administrator', 'manager', 'consultant', 'billing', 'read_only'];
  for (const role of roles) {
    const { user } = await seedUser(harness, {
      username: `group-${role.replace('_', '-')}`,
      displayName: `Staff ${role}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    users[role] = user;
  }
  await connectStorage(harness, users.administrator);
  const call = async (path: string, options: CallOptions): Promise<Called> => {
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': `group-${String(++counter)}`,
      Cookie: cookies[options.as],
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.ifMatch !== undefined) headers['If-Match'] = `"${String(options.ifMatch)}"`;
    if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
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
      data: text.length === 0 ? {} : (JSON.parse(text) as Record<string, any>),
      text,
    };
  };
  return { harness, users, call };
}

function individual(overrides: Record<string, unknown> = {}) {
  const sequence = cnicCounter++;
  return {
    type: 'individual',
    legalName: `Synthetic Person ${String(sequence)}`,
    cnic: `35202-${String(4_000_000 + sequence).padStart(7, '0')}-1`,
    contacts: [],
    assignedManagerUserId: null,
    ...overrides,
  };
}

async function createClient(
  w: World,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await w.call('/api/v1/clients', {
    as: 'manager',
    method: 'POST',
    body: individual(overrides),
  });
  expect(result.status, result.text).toBe(201);
  return result.data;
}

/** The editable fields of a client, as the edit form sends them. */
function editBody(client: Record<string, any>, overrides: Record<string, unknown> = {}) {
  return {
    type: client['type'],
    legalName: client['legalName'],
    contacts: [],
    notes: client['notes'],
    assignedManagerUserId: client['assignedManager']?.id ?? null,
    ...overrides,
  };
}

async function setParent(
  w: World,
  client: Record<string, any>,
  parentClientId: string | null,
  as: Actor = 'manager',
): Promise<Called> {
  const current = await w.call(`/api/v1/clients/${client['id'] as string}`, { as: 'manager' });
  return await w.call(`/api/v1/clients/${client['id'] as string}`, {
    as,
    method: 'PATCH',
    ifMatch: current.data['version'],
    body: editBody(current.data, { parentClientId }),
  });
}

async function getClient(w: World, id: string, as: Actor = 'manager'): Promise<Called> {
  return await w.call(`/api/v1/clients/${id}`, { as });
}

function codes(list: Called, key = 'clients'): string[] {
  return (list.data[key] as { clientCode: string }[]).map((item) => item.clientCode).sort();
}

describe('TD-207 parent client link', () => {
  it('sets a parent on create and shows "Part of" and the group members', async () => {
    const w = await world();
    const head = await createClient(w, { legalName: 'Group Head Trading' });
    const member = await createClient(w, { parentClientId: head['id'] });
    expect(member['parentClient']).toEqual({
      id: head['id'],
      clientCode: head['clientCode'],
      displayName: 'Group Head Trading',
      state: 'active',
    });

    const headDetail = await getClient(w, head['id']);
    expect(headDetail.data['parentClient']).toBeNull();
    expect(headDetail.data['groupMembers']).toEqual([
      {
        id: member['id'],
        clientCode: member['clientCode'],
        displayName: member['displayName'],
        state: 'active',
      },
    ]);

    const list = await w.call('/api/v1/clients', { as: 'read_only' });
    const rows = list.data['clients'] as Record<string, any>[];
    const headRow = rows.find((row) => row['id'] === head['id']);
    const memberRow = rows.find((row) => row['id'] === member['id']);
    expect(headRow?.['memberCount']).toBe(1);
    expect(headRow?.['parentClient']).toBeNull();
    expect(memberRow?.['memberCount']).toBe(0);
    expect(memberRow?.['parentClient']?.['id']).toBe(head['id']);
  });

  it('changes the parent through the versioned edit and rejects a stale version', async () => {
    const w = await world();
    const first = await createClient(w);
    const second = await createClient(w);
    const member = await createClient(w);

    const linked = await setParent(w, member, first['id']);
    expect(linked.status, linked.text).toBe(200);
    expect(linked.data['version']).toBe(2);
    expect(linked.data['parentClient']['id']).toBe(first['id']);

    const stale = await w.call(`/api/v1/clients/${member['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: 1,
      body: editBody(member, { parentClientId: second['id'] }),
    });
    expect(stale.status).toBe(412);
    expect(stale.data['code']).toBe('PRECONDITION_FAILED');

    const missingIfMatch = await w.call(`/api/v1/clients/${member['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      body: editBody(member, { parentClientId: second['id'] }),
    });
    expect(missingIfMatch.status).toBe(428);

    const moved = await setParent(w, member, second['id']);
    expect(moved.status).toBe(200);
    expect(moved.data['parentClient']['id']).toBe(second['id']);
    expect((await getClient(w, first['id'])).data['groupMembers']).toEqual([]);

    const cleared = await setParent(w, member, null);
    expect(cleared.status).toBe(200);
    expect(cleared.data['parentClient']).toBeNull();
  });

  it('keeps the link when an edit omits the parent', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const saved = await w.call(`/api/v1/clients/${member['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: member['version'],
      body: editBody(member, { notes: 'Edited without touching the group.' }),
    });
    expect(saved.status).toBe(200);
    expect(saved.data['parentClient']['id']).toBe(head['id']);
  });

  it('needs clients.manage to set a parent', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w);
    for (const role of ['consultant', 'billing', 'read_only'] as const) {
      const denied = await setParent(w, member, head['id'], role);
      expect(denied.status, role).toBe(403);
    }
    const created = await w.call('/api/v1/clients', {
      as: 'billing',
      method: 'POST',
      body: individual({ parentClientId: head['id'] }),
    });
    expect(created.status).toBe(403);
    expect((await getClient(w, member['id'])).data['parentClient']).toBeNull();
  });
});

describe('TD-207 one-level group rule', () => {
  it('rejects a client as its own parent', async () => {
    const w = await world();
    const client = await createClient(w);
    const result = await setParent(w, client, client['id']);
    expect(result.status).toBe(409);
    expect(result.data['code']).toBe('CLIENT_GROUP_INVALID');
    expect(result.data['errors']).toEqual([
      { field: 'parentClientId', message: 'A client cannot be its own parent client.' },
    ]);
  });

  it('rejects a member as a parent and a head as a member', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const other = await createClient(w);

    // A client with a parent cannot be chosen as a parent (on create or edit).
    const onCreate = await w.call('/api/v1/clients', {
      as: 'manager',
      method: 'POST',
      body: individual({ parentClientId: member['id'] }),
    });
    expect(onCreate.status).toBe(409);
    expect(onCreate.data['code']).toBe('CLIENT_GROUP_INVALID');
    const onEdit = await setParent(w, other, member['id']);
    expect(onEdit.status).toBe(409);
    expect(onEdit.data['detail']).toContain('already part of a group');

    // A client with members cannot be given a parent.
    const headUnder = await setParent(w, head, other['id']);
    expect(headUnder.status).toBe(409);
    expect(headUnder.data['detail']).toContain('has group members');

    expect((await getClient(w, head['id'])).data['parentClient']).toBeNull();
    expect((await getClient(w, other['id'])).data['parentClient']).toBeNull();
  });

  it('refuses an unknown parent without saying whether it exists', async () => {
    const w = await world();
    const client = await createClient(w);
    const result = await setParent(w, client, '0198a000-0000-7000-8000-00000000ffff');
    expect(result.status).toBe(409);
    expect(result.data['detail']).toBe('Choose an active client you can see as the parent client.');
  });

  it('enforces the rule in the repository as a backstop', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const other = await createClient(w);
    const clients = w.harness.dependencies.repositories.clients;
    const record = await clients.findById(other['id']);
    if (record === null) throw new Error('missing client');
    await expect(
      clients.update({
        id: record.id,
        changes: { ...record, parentClientId: member['id'] },
        expectedVersion: record.version,
        at: w.harness.now().toISOString(),
      }),
    ).rejects.toBeInstanceOf(ClientGroupRuleError);
  });

  it('serializes two group changes that would build a two-level chain', async () => {
    const w = await world();
    const a = await createClient(w);
    const b = await createClient(w);
    const c = await createClient(w);
    // Both start from valid states: b under a, and c under b. Only one can win.
    const results = await Promise.all([setParent(w, b, a['id']), setParent(w, c, b['id'])]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const records = await Promise.all(
      [a, b, c].map(async (client) => (await getClient(w, client['id'])).data),
    );
    const parents = records.map((record) => record['parentClient']?.id ?? null);
    // Whichever won, no client is both a parent and a member.
    for (const record of records) {
      const isMember = record['parentClient'] !== null;
      const isParent = parents.includes(record['id']);
      expect(isMember && isParent).toBe(false);
    }
  });
});

describe('TD-207 archive keeps the link', () => {
  it('keeps links when a parent or member is archived and refuses an archived new parent', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const archivedHead = await w.call(`/api/v1/clients/${head['id'] as string}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: head['version'],
    });
    expect(archivedHead.status).toBe(200);
    expect(archivedHead.data['groupMembers']).toHaveLength(1);

    const memberDetail = await getClient(w, member['id']);
    expect(memberDetail.data['parentClient']).toMatchObject({
      id: head['id'],
      state: 'archived',
    });

    // Editing other fields keeps the link to the archived parent.
    const edited = await w.call(`/api/v1/clients/${member['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: memberDetail.data['version'],
      body: editBody(memberDetail.data, {
        notes: 'Still part of the group.',
        parentClientId: head['id'],
      }),
    });
    expect(edited.status).toBe(200);
    expect(edited.data['parentClient']['id']).toBe(head['id']);

    // An archived client cannot be chosen as a new parent.
    const other = await createClient(w);
    const refused = await setParent(w, other, head['id']);
    expect(refused.status).toBe(409);
    expect(refused.data['detail']).toContain('archived');

    const archivedMember = await w.call(`/api/v1/clients/${member['id'] as string}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: edited.data['version'],
    });
    expect(archivedMember.status).toBe(200);
    expect(archivedMember.data['parentClient']['id']).toBe(head['id']);
  });
});

describe('TD-207 audit', () => {
  it('writes client.group_changed with client codes only', async () => {
    const w = await world();
    const first = await createClient(w, { legalName: 'Confidential Parent Name' });
    const second = await createClient(w);
    const member = await createClient(w, { parentClientId: first['id'] });
    await setParent(w, member, second['id']);
    await setParent(w, member, null);

    const events = w.harness.state.auditEvents.filter(
      (event) => event.action === 'client.group_changed' && event.entityId === member['id'],
    );
    expect(events.map((event) => event.metadata)).toEqual([
      {
        clientCode: member['clientCode'],
        previousParentCode: null,
        parentCode: first['clientCode'],
      },
      {
        clientCode: member['clientCode'],
        previousParentCode: first['clientCode'],
        parentCode: second['clientCode'],
      },
      {
        clientCode: member['clientCode'],
        previousParentCode: second['clientCode'],
        parentCode: null,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Confidential Parent Name');
    // A parent-only change is not also logged as a field update.
    const updates = w.harness.state.auditEvents.filter(
      (event) => event.action === 'client.updated' && event.entityId === member['id'],
    );
    expect(updates).toEqual([]);

    const activity = await w.call(`/api/v1/clients/${member['id'] as string}/activity`, {
      as: 'manager',
    });
    // Creation and its group link share an instant, so compare without order.
    expect((activity.data['events'] as { action: string }[]).map((e) => e.action).sort()).toEqual([
      'client.created',
      'client.group_changed',
      'client.group_changed',
      'client.group_changed',
    ]);
  });
});

describe('TD-207 client list group filters', () => {
  it('filters by group and lists group heads and eligible parents', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const loner = await createClient(w);
    const otherHead = await createClient(w);
    await createClient(w, { parentClientId: otherHead['id'] });

    const group = await w.call(`/api/v1/clients?group=${head['id'] as string}`, {
      as: 'read_only',
    });
    expect(group.status).toBe(200);
    expect(codes(group)).toEqual([head['clientCode'], member['clientCode']].sort());

    const heads = await w.call('/api/v1/clients?grouping=heads', { as: 'read_only' });
    expect(codes(heads)).toEqual([head['clientCode'], otherHead['clientCode']].sort());

    const eligible = await w.call('/api/v1/clients?grouping=eligible_parents', {
      as: 'manager',
    });
    expect(codes(eligible)).toEqual(
      [head['clientCode'], loner['clientCode'], otherHead['clientCode']].sort(),
    );

    const invalid = await w.call('/api/v1/clients?grouping=everyone', { as: 'manager' });
    expect(invalid.status).toBe(400);
  });
});

describe('TD-207 visibility', () => {
  it('shows consultants only the group clients they can see and never counts hidden ones', async () => {
    const w = await world();
    const consultant = w.users.consultant.id;
    const head = await createClient(w, { assignedManagerUserId: consultant });
    const visible = await createClient(w, {
      parentClientId: head['id'],
      assignedManagerUserId: consultant,
    });
    const hidden = await createClient(w, { parentClientId: head['id'] });

    const detail = await getClient(w, head['id'], 'consultant');
    expect(detail.status).toBe(200);
    expect((detail.data['groupMembers'] as { id: string }[]).map((m) => m.id)).toEqual([
      visible['id'],
    ]);
    expect(detail.text).not.toContain(hidden['clientCode']);

    const list = await w.call('/api/v1/clients', { as: 'consultant' });
    const headRow = (list.data['clients'] as Record<string, any>[]).find(
      (row) => row['id'] === head['id'],
    );
    expect(headRow?.['memberCount']).toBe(1);

    const group = await w.call(`/api/v1/clients?group=${head['id'] as string}`, {
      as: 'consultant',
    });
    expect(codes(group)).toEqual([head['clientCode'], visible['clientCode']].sort());
  });

  it('does not name a hidden parent or list a head whose members are all hidden', async () => {
    const w = await world();
    const consultant = w.users.consultant.id;
    const hiddenHead = await createClient(w);
    const member = await createClient(w, {
      parentClientId: hiddenHead['id'],
      assignedManagerUserId: consultant,
    });
    const visibleHead = await createClient(w, { assignedManagerUserId: consultant });
    await createClient(w, { parentClientId: visibleHead['id'] });

    const detail = await getClient(w, member['id'], 'consultant');
    expect(detail.data['parentClient']).toBeNull();
    expect(detail.text).not.toContain(hiddenHead['clientCode']);

    const heads = await w.call('/api/v1/clients?grouping=heads', { as: 'consultant' });
    expect(codes(heads)).toEqual([]);

    const denied = await w.call(`/api/v1/clients?group=${hiddenHead['id'] as string}`, {
      as: 'consultant',
    });
    expect(denied.status).toBe(403);
  });

  it('leaves a link to a hidden parent out of the activity a consultant sees', async () => {
    const w = await world();
    const consultant = w.users.consultant.id;
    const hiddenHead = await createClient(w);
    const visibleHead = await createClient(w, { assignedManagerUserId: consultant });
    const member = await createClient(w, { assignedManagerUserId: consultant });
    await setParent(w, member, visibleHead['id']);
    await setParent(w, member, hiddenHead['id']);

    const actions = async (as: Actor) => {
      const activity = await w.call(`/api/v1/clients/${member['id'] as string}/activity`, { as });
      expect(activity.status).toBe(200);
      return (activity.data['events'] as { action: string }[]).map((event) => event.action);
    };
    // The manager sees both changes; the consultant sees only the change that
    // names clients they can see (none → visible head).
    expect((await actions('manager')).filter((a) => a === 'client.group_changed')).toHaveLength(2);
    expect((await actions('consultant')).filter((a) => a === 'client.group_changed')).toHaveLength(
      1,
    );
  });
});

async function openCase(w: World, client: Record<string, any>): Promise<Record<string, any>> {
  const template = await w.call('/api/v1/workflow-templates', {
    as: 'manager',
    method: 'POST',
    body: { name: `Annual return ${String(++counter)}`, definition: STARTER_WORKFLOW_DEFINITION },
  });
  const versionId = template.data['draft'].id as string;
  await w.call(
    `/api/v1/workflow-templates/${template.data['id'] as string}/versions/${versionId}/publish`,
    { as: 'manager', method: 'POST', ifMatch: 1 },
  );
  const service = await w.call('/api/v1/service-types', {
    as: 'manager',
    method: 'POST',
    body: {
      name: `Income tax return ${String(++counter)}`,
      defaultFeeMinor: 1_500_000,
      defaultDeadlineOffsetDays: 30,
      duplicateCasePolicy: 'warn',
      defaultWorkflowTemplateId: template.data['id'],
    },
  });
  const created = await w.call('/api/v1/cases', {
    as: 'manager',
    method: 'POST',
    body: {
      clientId: client['id'],
      serviceTypeId: service.data['id'],
      taxYear: 2026,
      workflowVersionId: versionId,
      dueDate: '2026-09-30',
      primaryConsultantUserId: w.users.consultant.id,
      reviewerUserId: null,
    },
  });
  expect(created.status, created.text).toBe(201);
  return created.data;
}

describe('TD-207 case filters', () => {
  it('filters case lists and work-queue counts by group', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const outsider = await createClient(w);
    const headCase = await openCase(w, head);
    const memberCase = await openCase(w, member);
    await openCase(w, outsider);

    const list = await w.call(`/api/v1/cases?view=team&group=${head['id'] as string}`, {
      as: 'manager',
    });
    expect(list.status).toBe(200);
    expect(list.data['total']).toBe(2);
    expect((list.data['cases'] as { id: string }[]).map((c) => c.id).sort()).toEqual(
      [headCase['id'], memberCase['id']].sort(),
    );

    const counts = await w.call(`/api/v1/cases/queue-counts?group=${head['id'] as string}`, {
      as: 'manager',
    });
    expect(counts.status).toBe(200);
    expect(counts.data['team']).toBe(2);

    const all = await w.call('/api/v1/cases/queue-counts', { as: 'manager' });
    expect(all.data['team']).toBe(3);
  });

  it('refuses a group head the consultant cannot see', async () => {
    const w = await world();
    const head = await createClient(w);
    const denied = await w.call(`/api/v1/cases?view=my&group=${head['id'] as string}`, {
      as: 'consultant',
    });
    expect(denied.status).toBe(403);
  });
});

const key = (): string => `idem-key-${String(++counter).padStart(12, '0')}`;

async function finalizedInvoice(w: World, client: Record<string, any>, unitAmountMinor: number) {
  const created = await w.call('/api/v1/invoices', {
    as: 'billing',
    method: 'POST',
    body: { clientId: client['id'] },
  });
  expect(created.status, created.text).toBe(201);
  const priced = await w.call(`/api/v1/invoices/${created.data['id'] as string}`, {
    as: 'billing',
    method: 'PATCH',
    ifMatch: created.data['version'],
    body: {
      items: [{ description: 'Return filing', quantity: 1, unitAmountMinor }],
      discountMinor: 0,
      issueDate: null,
      dueDate: '2026-07-15',
      notes: '',
    },
  });
  expect(priced.status, priced.text).toBe(200);
  const finalized = await w.call(`/api/v1/invoices/${created.data['id'] as string}/finalize`, {
    as: 'billing',
    method: 'POST',
    ifMatch: priced.data['version'],
    key: key(),
  });
  expect(finalized.status, finalized.text).toBe(200);
  return finalized.data;
}

describe('TD-207 invoice filter and group billing totals', () => {
  it('filters invoices by group and totals invoiced, paid, and outstanding', async () => {
    const w = await world();
    const head = await createClient(w);
    const member = await createClient(w, { parentClientId: head['id'] });
    const outsider = await createClient(w);
    const headInvoice = await finalizedInvoice(w, head, 1_000_000);
    const memberInvoice = await finalizedInvoice(w, member, 500_000);
    await finalizedInvoice(w, outsider, 900_000);
    // A draft is listed by the filter but never counted in the totals.
    const draft = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: member['id'] },
    });
    const paid = await w.call(`/api/v1/invoices/${memberInvoice['id'] as string}/payments`, {
      as: 'billing',
      method: 'POST',
      key: key(),
      body: {
        amountMinor: 200_000,
        method: 'bank_transfer',
        receivedOn: '2026-06-01',
        reference: 'TRX-1',
      },
    });
    expect(paid.status, paid.text).toBe(201);

    const list = await w.call(`/api/v1/invoices?group=${head['id'] as string}`, {
      as: 'read_only',
    });
    expect(list.status).toBe(200);
    expect((list.data['invoices'] as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [headInvoice['id'], memberInvoice['id'], draft.data['id']].sort(),
    );

    const totals = await w.call(`/api/v1/invoices/group-totals?group=${head['id'] as string}`, {
      as: 'billing',
    });
    expect(totals.status, totals.text).toBe(200);
    expect(totals.data).toEqual({
      groupClientId: head['id'],
      currency: 'PKR',
      invoiceCount: 2,
      invoicedMinor: 1_500_000,
      paidMinor: 200_000,
      outstandingMinor: 1_300_000,
    });
  });

  it('needs billing.read and a visible group head', async () => {
    const w = await world();
    const head = await createClient(w);
    const consultant = await w.call(`/api/v1/invoices/group-totals?group=${head['id'] as string}`, {
      as: 'consultant',
    });
    expect(consultant.status).toBe(403);
    const missing = await w.call(
      '/api/v1/invoices/group-totals?group=0198a000-0000-7000-8000-00000000ffff',
      { as: 'billing' },
    );
    expect(missing.status).toBe(404);
    expect(missing.data['code']).toBe('CLIENT_NOT_FOUND');
    const invalid = await w.call('/api/v1/invoices/group-totals', { as: 'billing' });
    expect(invalid.status).toBe(400);
  });
});
