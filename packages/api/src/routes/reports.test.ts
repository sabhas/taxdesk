/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { STARTER_WORKFLOW_DEFINITION, type RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import type { AppEnv } from '../types.js';
import {
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
} from '../testing/harness.js';
import type { UserRecord } from '../domain/auth/types.js';

const PASSWORD = 'correct horse battery staple';
let counter = 0;

interface Called {
  status: number;
  etag: string | null;
  headers: Headers;
  text: string;
  data: Record<string, any>;
}

interface CallOptions {
  as: RoleKey;
  method?: string;
  body?: unknown;
  ifMatch?: number;
  key?: string;
}

interface World {
  harness: TestHarness;
  app: Hono<AppEnv>;
  users: Record<RoleKey, UserRecord>;
  call: (path: string, options: CallOptions) => Promise<Called>;
}

async function world(): Promise<World> {
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z') });
  await seedFirm(harness);
  const app = createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
  const cookies = {} as Record<RoleKey, string>;
  const users = {} as Record<RoleKey, UserRecord>;
  const roles: RoleKey[] = ['administrator', 'manager', 'consultant', 'billing', 'read_only'];
  for (const role of roles) {
    const { user } = await seedUser(harness, {
      username: `rep-${role.replace('_', '-')}`,
      displayName: `Staff ${role}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    users[role] = user;
  }
  const call = async (path: string, options: CallOptions): Promise<Called> => {
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': `rep-${String(++counter)}`,
      Cookie: cookies[options.as],
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.ifMatch !== undefined) {
      headers['If-Match'] = `"${String(options.ifMatch)}"`;
    }
    if (options.key !== undefined) {
      headers['Idempotency-Key'] = options.key;
    }
    const response = await app.request(
      path,
      { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const text = await response.text();
    let data: Record<string, any> = {};
    if ((response.headers.get('Content-Type') ?? '').includes('json') && text.length > 0) {
      data = JSON.parse(text) as Record<string, any>;
    }
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      headers: response.headers,
      text,
      data,
    };
  };
  return { harness, app, users, call };
}

const key = (): string => `idem-key-${String(++counter).padStart(12, '0')}`;
let cnicCounter = 1;

async function createClient(w: World, name?: string): Promise<Record<string, any>> {
  const result = await w.call('/api/v1/clients', {
    as: 'manager',
    method: 'POST',
    body: {
      type: 'individual',
      legalName: name ?? `Synthetic Client ${String(cnicCounter)}`,
      cnic: `35202-${String(4_000_000 + cnicCounter++).padStart(7, '0')}-1`,
      contacts: [],
      assignedManagerUserId: null,
    },
  });
  expect(result.status).toBe(201);
  return result.data;
}

interface Setup {
  versionId: string;
  serviceId: string;
}

async function catalog(w: World): Promise<Setup> {
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
  return { versionId, serviceId: service.data['id'] as string };
}

async function openCase(
  w: World,
  setup: Setup,
  client: Record<string, any>,
  options: { dueDate?: string; consultant?: string | null; taxYear?: number } = {},
): Promise<Record<string, any>> {
  const created = await w.call('/api/v1/cases', {
    as: 'manager',
    method: 'POST',
    body: {
      clientId: client['id'],
      serviceTypeId: setup.serviceId,
      taxYear: options.taxYear ?? 2026,
      workflowVersionId: setup.versionId,
      dueDate: options.dueDate ?? '2026-09-30',
      primaryConsultantUserId:
        options.consultant === undefined ? w.users.consultant.id : options.consultant,
      reviewerUserId: null,
    },
  });
  expect(created.status).toBe(201);
  return created.data;
}

async function finalizedInvoice(
  w: World,
  client: Record<string, any>,
  dueDate: string,
  unit = 1_000_000,
): Promise<Record<string, any>> {
  const created = await w.call('/api/v1/invoices', {
    as: 'billing',
    method: 'POST',
    body: { clientId: client['id'] },
  });
  const updated = await w.call(`/api/v1/invoices/${created.data['id'] as string}`, {
    as: 'billing',
    method: 'PATCH',
    ifMatch: created.data['version'],
    body: {
      items: [{ description: 'Return filing', quantity: 1, unitAmountMinor: unit }],
      discountMinor: 0,
      issueDate: null,
      dueDate,
      notes: '',
    },
  });
  const done = await w.call(`/api/v1/invoices/${created.data['id'] as string}/finalize`, {
    as: 'billing',
    method: 'POST',
    ifMatch: updated.data['version'],
    key: key(),
  });
  expect(done.status).toBe(200);
  return done.data;
}

function pay(w: World, invoice: Record<string, any>, amountMinor: number) {
  return w.call(`/api/v1/invoices/${invoice['id'] as string}/payments`, {
    as: 'billing',
    method: 'POST',
    key: key(),
    body: { amountMinor, method: 'cash', receivedOn: '2026-06-01', reference: '' },
  });
}

describe('dashboard (TD-601)', () => {
  it('shows each role only the sections its permissions allow', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    await openCase(w, setup, client);

    const consultant = await w.call('/api/v1/dashboard/summary', { as: 'consultant' });
    expect(consultant.status).toBe(200);
    expect(consultant.data['work'].assigned.count).toBe(1);
    expect(consultant.data['management']).toBeNull();
    expect(consultant.data['billing']).toBeNull();

    const manager = await w.call('/api/v1/dashboard/summary', { as: 'manager' });
    expect(manager.data['work']).not.toBeNull();
    expect(manager.data['management'].teamOpen.count).toBe(1);
    expect(manager.data['management'].workload.length).toBeGreaterThan(0);
    expect(manager.data['billing']).not.toBeNull();

    const billing = await w.call('/api/v1/dashboard/summary', { as: 'billing' });
    expect(billing.data['management']).toBeNull();
    expect(billing.data['billing']).not.toBeNull();
  });

  it('counts unassigned work, the review queue, and checklist gaps', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    await openCase(w, setup, client, { consultant: null });
    await openCase(w, setup, client, { taxYear: 2025 });

    const manager = await w.call('/api/v1/dashboard/summary', { as: 'manager' });
    expect(manager.data['management'].unassigned.count).toBe(1);
    expect(manager.data['management'].teamOpen.count).toBe(2);
    expect(manager.data['management'].reviewQueue.count).toBe(0);
  });

  it('reconciles every case and invoice count with the list its link opens', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    await openCase(w, setup, client, { dueDate: '2026-06-04' });
    await openCase(w, setup, client, { consultant: null, taxYear: 2025 });
    const invoice = await finalizedInvoice(w, client, '2026-06-20');
    await finalizedInvoice(w, client, '2026-06-30', 500_000);
    await pay(w, invoice, 400_000);

    const summary = await w.call('/api/v1/dashboard/summary', { as: 'manager' });
    const counts: { count: number; href: string }[] = [
      summary.data['work'].assigned,
      summary.data['work'].overdue,
      summary.data['work'].dueSoon,
      summary.data['work'].checklistGaps,
      summary.data['work'].filing.inProgress,
      summary.data['work'].filing.filed,
      summary.data['work'].filing.completed,
      summary.data['management'].unassigned,
      summary.data['management'].teamOpen,
      summary.data['management'].teamOverdue,
      summary.data['management'].reviewQueue,
      ...summary.data['management'].workload.flatMap((row: Record<string, any>) => [
        row['open'],
        row['overdue'],
        row['dueSoon'],
        row['reviewing'],
      ]),
    ];
    expect(summary.data['work'].dueSoon.count).toBe(1);
    for (const entry of counts) {
      expect(entry.href.startsWith('/cases?')).toBe(true);
      const list = await w.call(`/api/v1${entry.href}&limit=1`, { as: 'manager' });
      expect(list.status).toBe(200);
      expect(list.data['total'], entry.href).toBe(entry.count);
    }

    const billing = summary.data['billing'];
    expect(billing.unpaid.count).toBe(2);
    expect(billing.unpaid.amountMinor).toBe(1_100_000);
    for (const entry of [billing.unpaid, billing.overdue]) {
      const list = await w.call(`/api/v1${String(entry.href)}&limit=100`, { as: 'manager' });
      expect(list.data['invoices'], entry.href).toHaveLength(entry.count);
      const sum = (list.data['invoices'] as Record<string, any>[]).reduce(
        (total, row) => total + (row['outstandingMinor'] as number),
        0,
      );
      expect(sum).toBe(entry.amountMinor);
    }
    expect(billing.collected).toMatchObject({
      receivedMinor: 400_000,
      reversedMinor: 0,
      netMinor: 400_000,
    });
  });

  it('follows the firm due-soon window setting', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    await openCase(w, setup, client, { dueDate: '2026-06-20' });
    const before = await w.call('/api/v1/dashboard/summary', { as: 'manager' });
    expect(before.data['work'].dueSoon.count).toBe(0);

    const settings = await w.call('/api/v1/firm/settings', { as: 'administrator' });
    const updated = await w.call('/api/v1/firm/settings', {
      as: 'administrator',
      method: 'PATCH',
      ifMatch: settings.data['version'],
      body: {
        firmName: settings.data['firmName'],
        timezone: settings.data['timezone'],
        dueSoonDays: 30,
      },
    });
    expect(updated.status).toBe(200);
    const after = await w.call('/api/v1/dashboard/summary', { as: 'manager' });
    expect(after.data['dueSoonDays']).toBe(30);
    expect(after.data['work'].dueSoon.count).toBe(1);
  });
});

describe('case and workload reports (TD-602)', () => {
  it('filters by due range, service, assignee, tax year, and state, with cursor paging', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    const other = await catalog(w);
    await openCase(w, setup, client, { dueDate: '2026-07-01', taxYear: 2024 });
    await openCase(w, setup, client, { dueDate: '2026-08-01', taxYear: 2025, consultant: null });
    await openCase(w, other, client, { dueDate: '2026-09-01', taxYear: 2026 });

    const all = await w.call('/api/v1/reports/cases?limit=2', { as: 'manager' });
    expect(all.status).toBe(200);
    expect(all.data['total']).toBe(3);
    expect(all.data['cases']).toHaveLength(2);
    expect(all.data['nextCursor']).not.toBeNull();
    const next = await w.call(
      `/api/v1/reports/cases?limit=2&cursor=${encodeURIComponent(all.data['nextCursor'])}`,
      { as: 'manager' },
    );
    expect(next.data['cases']).toHaveLength(1);

    const ranged = await w.call('/api/v1/reports/cases?from=2026-07-15&to=2026-08-15', {
      as: 'manager',
    });
    expect(ranged.data['total']).toBe(1);
    expect(
      (await w.call(`/api/v1/reports/cases?service=${other.serviceId}`, { as: 'manager' })).data[
        'total'
      ],
    ).toBe(1);
    expect(
      (await w.call(`/api/v1/reports/cases?assignee=${w.users.consultant.id}`, { as: 'manager' }))
        .data['total'],
    ).toBe(2);
    expect(
      (await w.call('/api/v1/reports/cases?taxYear=2025', { as: 'manager' })).data['total'],
    ).toBe(1);
    expect(
      (await w.call('/api/v1/reports/cases?state=archived', { as: 'manager' })).data['total'],
    ).toBe(0);
    expect((await w.call('/api/v1/reports/cases?state=all', { as: 'manager' })).data['total']).toBe(
      3,
    );
  });

  it('validates filters and the date range', async () => {
    const w = await world();
    const bad = await w.call('/api/v1/reports/cases?from=2026-08-01&to=2026-07-01', {
      as: 'manager',
    });
    expect(bad.status).toBe(400);
    expect(bad.data['code']).toBe('VALIDATION_FAILED');
    expect((await w.call('/api/v1/reports/cases?limit=1000', { as: 'manager' })).status).toBe(400);
    expect((await w.call('/api/v1/reports/cases?bogus=1', { as: 'manager' })).status).toBe(400);
  });

  it('denies case reports without the report permission', async () => {
    const w = await world();
    for (const path of [
      '/api/v1/reports/cases',
      '/api/v1/reports/cases.csv',
      '/api/v1/reports/workload',
    ]) {
      expect((await w.call(path, { as: 'consultant' })).status).toBe(403);
    }
    expect((await w.call('/api/v1/reports/cases', { as: 'read_only' })).status).toBe(200);
  });

  it('exports CSV only for report roles, guards formulas, and audits the export', async () => {
    const w = await world();
    const client = await createClient(w, '=HYPERLINK("x")');
    const setup = await catalog(w);
    await openCase(w, setup, client);

    expect((await w.call('/api/v1/reports/cases.csv', { as: 'consultant' })).status).toBe(403);
    const csv = await w.call('/api/v1/reports/cases.csv', { as: 'manager' });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    expect(csv.headers.get('Content-Disposition')).toContain('attachment');
    expect(csv.headers.get('X-Report-Truncated')).toBe('false');
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toContain('Case code');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);

    const audit = await w.call('/api/v1/admin/audit-events?action=report.*', {
      as: 'administrator',
    });
    expect(audit.data['events']).toHaveLength(1);
    expect(audit.data['events'][0].metadata).toMatchObject({ report: 'cases', rows: 1 });
  });

  it('reports workload per staff member from the same predicate as the case lists', async () => {
    const w = await world();
    const client = await createClient(w);
    const setup = await catalog(w);
    await openCase(w, setup, client, { dueDate: '2026-06-03' });
    await openCase(w, setup, client, { taxYear: 2025 });

    const report = await w.call('/api/v1/reports/workload', { as: 'manager' });
    expect(report.status).toBe(200);
    const row = (report.data['rows'] as Record<string, any>[]).find(
      (entry) => entry['userId'] === w.users.consultant.id,
    );
    expect(row?.['open'].count).toBe(2);
    expect(row?.['dueSoon'].count).toBe(1);
    for (const count of [row?.['open'], row?.['overdue'], row?.['dueSoon'], row?.['reviewing']]) {
      const list = await w.call(`/api/v1${String(count.href)}&limit=1`, { as: 'manager' });
      expect(list.data['total']).toBe(count.count);
    }
    const filtered = await w.call('/api/v1/reports/workload?taxYear=2025', { as: 'manager' });
    const filteredRow = (filtered.data['rows'] as Record<string, any>[]).find(
      (entry) => entry['userId'] === w.users.consultant.id,
    );
    expect(filteredRow?.['open'].count).toBe(1);
  });
});

describe('billing report (TD-603)', () => {
  it('totals invoices, payments, reversals, outstanding, and overdue for a date range', async () => {
    const w = await world();
    const client = await createClient(w);
    const first = await finalizedInvoice(w, client, '2026-06-01', 1_000_000);
    await finalizedInvoice(w, client, '2026-07-31', 500_000);
    const paid = await pay(w, first, 600_000);
    const reversal = await w.call(`/api/v1/payments/${paid.data['payment'].id as string}/reverse`, {
      as: 'manager',
      method: 'POST',
      key: key(),
      body: { amountMinor: 100_000, reason: 'Bounced' },
    });
    expect(reversal.status).toBe(200);

    const report = await w.call('/api/v1/reports/billing?from=2026-06-01&to=2026-06-30', {
      as: 'manager',
    });
    expect(report.status).toBe(200);
    expect(report.data['totals']).toMatchObject({
      invoiced: { count: 2, amountMinor: 1_500_000 },
      collected: { count: 1, amountMinor: 600_000 },
      reversed: { count: 1, amountMinor: 100_000 },
      netCollectedMinor: 500_000,
      outstanding: { count: 2, amountMinor: 1_000_000 + 500_000 - 500_000 },
    });
    expect(report.data['totals'].overdue).toEqual({ count: 0, amountMinor: 0 });
    expect(report.data['invoices']).toHaveLength(2);

    // Each row, and the outstanding total, match invoice detail.
    let sum = 0;
    for (const row of report.data['invoices'] as Record<string, any>[]) {
      const detail = await w.call(`/api/v1/invoices/${row['id'] as string}`, { as: 'manager' });
      expect(row['outstandingMinor']).toBe(detail.data['outstandingMinor']);
      expect(row['paidMinor']).toBe(detail.data['paidMinor']);
      sum += detail.data['outstandingMinor'] as number;
    }
    expect(report.data['totals'].outstanding.amountMinor).toBe(sum);
  });

  it('flags overdue invoices once their due date has passed', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalizedInvoice(w, client, '2026-06-01');
    // The clock is fixed in this world, so move the due date into the past
    // directly (the database forbids this for real; the report is read-only).
    const record = w.harness.state.invoices.get(invoice['id'] as string);
    expect(record).toBeDefined();
    w.harness.state.invoices.set(invoice['id'] as string, { ...record!, dueDate: '2026-05-25' });
    const report = await w.call('/api/v1/reports/billing?from=2026-06-01&to=2026-06-30', {
      as: 'billing',
    });
    expect(report.data['totals'].overdue).toEqual({ count: 1, amountMinor: 1_000_000 });
  });

  it('shows a zero-result report as empty totals and an empty list', async () => {
    const w = await world();
    const report = await w.call('/api/v1/reports/billing?from=2025-01-01&to=2025-01-31', {
      as: 'manager',
    });
    expect(report.status).toBe(200);
    expect(report.data['totals'].invoiced).toEqual({ count: 0, amountMinor: 0 });
    expect(report.data['invoices']).toEqual([]);
  });

  it('denies billing reports to roles without billing and report access', async () => {
    const w = await world();
    const path = '/api/v1/reports/billing?from=2026-06-01&to=2026-06-30';
    expect((await w.call(path, { as: 'consultant' })).status).toBe(403);
    expect(
      (await w.call(path.replace('billing?', 'billing.csv?'), { as: 'consultant' })).status,
    ).toBe(403);
    expect((await w.call(path, { as: 'read_only' })).status).toBe(200);
    expect((await w.call('/api/v1/reports/billing', { as: 'manager' })).status).toBe(400);
  });

  it('exports billing CSV with decimal amounts and audits it', async () => {
    const w = await world();
    const client = await createClient(w);
    await finalizedInvoice(w, client, '2026-06-30', 1_234_550);
    const csv = await w.call('/api/v1/reports/billing.csv?from=2026-06-01&to=2026-06-30', {
      as: 'billing',
    });
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('12345.50');
    const audit = await w.call('/api/v1/admin/audit-events?action=report.exported', {
      as: 'administrator',
    });
    expect(audit.data['events'][0].metadata).toMatchObject({ report: 'billing', rows: 1 });
  });
});

describe('audit explorer (TD-604)', () => {
  it('denies everyone but administrators', async () => {
    const w = await world();
    for (const role of ['manager', 'consultant', 'billing', 'read_only'] as const) {
      expect((await w.call('/api/v1/admin/audit-events', { as: role })).status).toBe(403);
    }
    expect((await w.call('/api/v1/admin/audit-events', { as: 'administrator' })).status).toBe(200);
  });

  it('filters by actor, action, entity, request ID, and date range', async () => {
    const w = await world();
    const client = await createClient(w);
    const all = await w.call('/api/v1/admin/audit-events?limit=100', { as: 'administrator' });
    const created = (all.data['events'] as Record<string, any>[]).find(
      (event) => event['action'] === 'client.created',
    );
    expect(created?.['actorDisplayName']).toBe('Staff manager');

    const byActor = await w.call(`/api/v1/admin/audit-events?actor=${w.users.manager.id}`, {
      as: 'administrator',
    });
    expect(
      (byActor.data['events'] as Record<string, any>[]).every(
        (e) => e['actorUserId'] === w.users.manager.id,
      ),
    ).toBe(true);
    const byAction = await w.call('/api/v1/admin/audit-events?action=client.*', {
      as: 'administrator',
    });
    expect(
      (byAction.data['events'] as Record<string, any>[]).every((e) =>
        e['action'].startsWith('client.'),
      ),
    ).toBe(true);
    const byEntity = await w.call(
      `/api/v1/admin/audit-events?entityType=client&entityId=${client['id'] as string}`,
      { as: 'administrator' },
    );
    expect(byEntity.data['events']).toHaveLength(1);
    const byRequest = await w.call(
      `/api/v1/admin/audit-events?requestId=${encodeURIComponent(created?.['requestId'])}`,
      { as: 'administrator' },
    );
    expect(byRequest.data['events']).toHaveLength(1);
    expect(
      (
        await w.call('/api/v1/admin/audit-events?from=2026-06-01&to=2026-06-01', {
          as: 'administrator',
        })
      ).data['events'].length,
    ).toBeGreaterThan(0);
    expect(
      (await w.call('/api/v1/admin/audit-events?from=2030-01-01', { as: 'administrator' })).data[
        'events'
      ],
    ).toEqual([]);
    expect(
      (await w.call('/api/v1/admin/audit-events?actor=not-a-uuid', { as: 'administrator' })).status,
    ).toBe(400);
  });

  it('pages with a cursor', async () => {
    const w = await world();
    await createClient(w);
    await createClient(w);
    const first = await w.call('/api/v1/admin/audit-events?limit=1', { as: 'administrator' });
    expect(first.data['events']).toHaveLength(1);
    const second = await w.call(
      `/api/v1/admin/audit-events?limit=1&cursor=${first.data['nextCursor'] as string}`,
      { as: 'administrator' },
    );
    expect(second.data['events'][0].id).not.toBe(first.data['events'][0].id);
  });

  it('masks secrets and identifiers in displayed changes', async () => {
    const w = await world();
    const { appendAuditEvent } = await import('../domain/auth/audit-service.js');
    await appendAuditEvent(w.harness.repositories.audit, w.harness.now(), {
      actorUserId: w.users.administrator.id,
      action: 'test.masking',
      entityType: 'test',
      entityId: null,
      requestId: 'mask-1',
      metadata: {
        sessionToken: 'abc',
        note: 'CNIC 35202-1234567-1 on file',
        opaque: 'A'.repeat(48),
        cnic: '3520212345671',
        label: 'plain value',
        count: 3,
      },
    });
    const result = await w.call('/api/v1/admin/audit-events?requestId=mask-1', {
      as: 'administrator',
    });
    const metadata = result.data['events'][0].metadata;
    expect(metadata).toEqual({
      sessionToken: '[masked]',
      note: '[masked]',
      opaque: '[masked]',
      cnic: '[masked]',
      label: 'plain value',
      count: 3,
    });
    expect(result.text).not.toContain('35202');
  });
});

describe('firm settings (TD-605)', () => {
  async function update(w: World, body: Record<string, unknown>, ifMatch?: number) {
    const settings = await w.call('/api/v1/firm/settings', { as: 'administrator' });
    return await w.call('/api/v1/firm/settings', {
      as: 'administrator',
      method: 'PATCH',
      ifMatch: ifMatch ?? settings.data['version'],
      body: { firmName: settings.data['firmName'], timezone: settings.data['timezone'], ...body },
    });
  }

  it('returns the business settings with their defaults', async () => {
    const w = await world();
    const settings = await w.call('/api/v1/firm/settings', { as: 'consultant' });
    expect(settings.data).toMatchObject({
      currency: 'PKR',
      invoicePrefix: 'INV',
      receiptPrefix: 'RCP',
      documentMaxUploadBytes: 250 * 1024 * 1024,
      dueSoonDays: 7,
    });
  });

  it('rejects values outside the safe ranges', async () => {
    const w = await world();
    for (const body of [
      { invoicePrefix: 'inv' },
      { invoicePrefix: 'TOOLONGPREFIX' },
      { receiptPrefix: 'A' },
      { currency: 'USD' },
      { dueSoonDays: 0 },
      { dueSoonDays: 61 },
      { documentMaxUploadBytes: 1024 },
      { documentMaxUploadBytes: 251 * 1024 * 1024 },
    ]) {
      const result = await update(w, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('is limited to administrators and checks the version', async () => {
    const w = await world();
    const denied = await w.call('/api/v1/firm/settings', {
      as: 'manager',
      method: 'PATCH',
      ifMatch: 1,
      body: { firmName: 'x', timezone: 'Asia/Karachi' },
    });
    expect(denied.status).toBe(403);
    const stale = await update(w, { dueSoonDays: 10 }, 99);
    expect(stale.status).toBe(412);
  });

  it('audits what changed, with old and new values', async () => {
    const w = await world();
    const result = await update(w, { dueSoonDays: 14, invoicePrefix: 'TAX' });
    expect(result.status).toBe(200);
    const audit = await w.call('/api/v1/admin/audit-events?action=firm.settings_updated', {
      as: 'administrator',
    });
    expect(audit.data['events'][0].metadata).toMatchObject({
      changedFields: 'invoicePrefix,dueSoonDays',
      invoicePrefixFrom: 'INV',
      invoicePrefixTo: 'TAX',
      dueSoonDaysFrom: 7,
      dueSoonDaysTo: 14,
    });
  });

  it('applies a new prefix to new invoices and receipts only', async () => {
    const w = await world();
    const client = await createClient(w);
    const before = await finalizedInvoice(w, client, '2026-06-30');
    expect(before['invoiceNumber']).toBe('INV-00001');
    await update(w, { invoicePrefix: 'TAX', receiptPrefix: 'REC' });
    const after = await finalizedInvoice(w, client, '2026-06-30');
    expect(after['invoiceNumber']).toBe('TAX-00002');
    const payment = await pay(w, after, 100_000);
    expect(payment.data['payment'].receiptNumber).toBe('REC-00001');
    const old = await w.call(`/api/v1/invoices/${before['id'] as string}`, { as: 'billing' });
    expect(old.data['invoiceNumber']).toBe('INV-00001');
  });

  it('applies the document-size limit to uploads', async () => {
    const w = await world();
    const result = await update(w, { documentMaxUploadBytes: 2 * 1024 * 1024 });
    expect(result.status).toBe(200);
    const settings = await w.call('/api/v1/firm/settings', { as: 'administrator' });
    expect(settings.data['documentMaxUploadBytes']).toBe(2 * 1024 * 1024);
  });
});
