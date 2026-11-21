/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/dot-notation -- route tests navigate untyped JSON response bodies */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { STARTER_WORKFLOW_DEFINITION, type RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import { CombinedInvoiceRuleError } from '../repositories/ports.js';
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
 * TD-511 combined group invoices: a draft addressed to a group head, lines for
 * the head and its members with optional cases, the group recheck and client
 * snapshot at finalization, payments on the whole invoice, the duplicate-case
 * warning data, visibility, and group billing totals.
 */

const PASSWORD = 'correct horse battery staple';
let counter = 0;
let cnicCounter = 1;

type Actor = RoleKey;

interface Called {
  status: number;
  etag: string | null;
  bytes: Uint8Array;
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
      username: `combined-${role.replace('_', '-')}`,
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
      'X-Request-Id': `combined-${String(++counter)}`,
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const isJson = (response.headers.get('Content-Type') ?? '').includes('json');
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      bytes,
      data: isJson && text.length > 0 ? (JSON.parse(text) as Record<string, any>) : {},
      text: isJson ? text : '',
    };
  };
  return { harness, users, call };
}

const key = (): string => `combined-key-${String(++counter).padStart(12, '0')}`;

async function createClient(
  w: World,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const sequence = cnicCounter++;
  const result = await w.call('/api/v1/clients', {
    as: 'manager',
    method: 'POST',
    body: {
      type: 'individual',
      legalName: `Synthetic Person ${String(sequence)}`,
      cnic: `35202-${String(5_000_000 + sequence).padStart(7, '0')}-1`,
      contacts: [],
      assignedManagerUserId: null,
      ...overrides,
    },
  });
  expect(result.status, result.text).toBe(201);
  return result.data;
}

async function editClient(
  w: World,
  client: Record<string, any>,
  overrides: Record<string, unknown>,
): Promise<Called> {
  const current = await w.call(`/api/v1/clients/${client['id'] as string}`, { as: 'manager' });
  return await w.call(`/api/v1/clients/${client['id'] as string}`, {
    as: 'manager',
    method: 'PATCH',
    ifMatch: current.data['version'],
    body: {
      type: current.data['type'],
      legalName: current.data['legalName'],
      contacts: [],
      notes: current.data['notes'],
      assignedManagerUserId: null,
      ...overrides,
    },
  });
}

const services = new WeakMap<World, { id: string; versionId: string }>();

async function openCase(w: World, client: Record<string, any>): Promise<Record<string, any>> {
  let service = services.get(w);
  if (service === undefined) {
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
    const created = await w.call('/api/v1/service-types', {
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
    service = { id: created.data['id'] as string, versionId };
    services.set(w, service);
  }
  const created = await w.call('/api/v1/cases', {
    as: 'manager',
    method: 'POST',
    body: {
      clientId: client['id'],
      serviceTypeId: service.id,
      taxYear: 2026,
      workflowVersionId: service.versionId,
      dueDate: '2026-09-30',
      primaryConsultantUserId: w.users.consultant.id,
      reviewerUserId: null,
    },
  });
  expect(created.status, created.text).toBe(201);
  return created.data;
}

/** A group head with two members; the first member has a case. */
async function group(w: World) {
  const head = await createClient(w, { legalName: 'Group Head Holdings' });
  const member = await createClient(w, { legalName: 'Member One', parentClientId: head['id'] });
  const second = await createClient(w, { legalName: 'Member Two', parentClientId: head['id'] });
  const memberCase = await openCase(w, member);
  return { head, member, second, memberCase };
}

async function combinedDraft(w: World, head: Record<string, any>): Promise<Called> {
  return await w.call('/api/v1/invoices', {
    as: 'billing',
    method: 'POST',
    body: { clientId: head['id'], billingMode: 'combined' },
  });
}

function draftBody(items: unknown[], overrides: Record<string, unknown> = {}) {
  return { items, discountMinor: 0, issueDate: null, dueDate: null, notes: '', ...overrides };
}

async function save(w: World, invoice: Record<string, any>, items: unknown[], discount = 0) {
  return await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
    as: 'billing',
    method: 'PATCH',
    ifMatch: invoice['version'],
    body: draftBody(items, { discountMinor: discount }),
  });
}

async function finalize(w: World, invoice: Record<string, any>): Promise<Called> {
  return await w.call(`/api/v1/invoices/${invoice['id'] as string}/finalize`, {
    as: 'billing',
    method: 'POST',
    ifMatch: invoice['version'],
    key: key(),
  });
}

/** A saved combined draft: head 2,000.00, member case line 15,000.00, second 1,000.00. */
async function pricedCombined(w: World) {
  const parts = await group(w);
  const created = await combinedDraft(w, parts.head);
  expect(created.status, created.text).toBe(201);
  const saved = await save(
    w,
    created.data,
    [
      {
        description: 'Group advisory',
        quantity: 1,
        unitAmountMinor: 200_000,
        clientId: parts.head['id'],
      },
      {
        description: 'Return filing',
        quantity: 1,
        unitAmountMinor: 1_500_000,
        clientId: parts.member['id'],
        caseId: parts.memberCase['id'],
      },
      {
        description: 'Wealth statement',
        quantity: 1,
        unitAmountMinor: 100_000,
        clientId: parts.second['id'],
      },
    ],
    50_000,
  );
  expect(saved.status, saved.text).toBe(200);
  return { ...parts, draft: saved.data };
}

describe('TD-511 combined draft creation', () => {
  it('creates an empty combined draft addressed to the group head with no case', async () => {
    const w = await world();
    const { head } = await group(w);
    const created = await combinedDraft(w, head);
    expect(created.status, created.text).toBe(201);
    expect(created.data['billingMode']).toBe('combined');
    expect(created.data['client']['id']).toBe(head['id']);
    expect(created.data['case']).toBeNull();
    expect(created.data['items']).toEqual([]);

    const audit = w.harness.state.auditEvents.find(
      (event) =>
        event.action === 'billing.invoice_drafted' && event.entityId === created.data['id'],
    );
    expect(audit?.metadata['billingMode']).toBe('combined');
  });

  it('refuses a member, a client without members, and a case as the starting point', async () => {
    const w = await world();
    const { member, memberCase } = await group(w);
    const fromMember = await combinedDraft(w, member);
    expect(fromMember.status).toBe(409);
    expect(fromMember.data['code']).toBe('CLIENT_NOT_GROUP_HEAD');

    const loner = await createClient(w);
    const fromLoner = await combinedDraft(w, loner);
    expect(fromLoner.status).toBe(409);
    expect(fromLoner.data['detail']).toContain('no group members');

    const fromCase = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { caseId: memberCase['id'], billingMode: 'combined' },
    });
    expect(fromCase.status).toBe(400);
  });

  it('leaves individual invoices unchanged', async () => {
    const w = await world();
    const { member, memberCase } = await group(w);
    const fromCase = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { caseId: memberCase['id'] },
    });
    expect(fromCase.status).toBe(201);
    expect(fromCase.data['billingMode']).toBe('individual');
    expect(fromCase.data['items']).toEqual([
      expect.objectContaining({
        description: `${memberCase['service']['name'] as string} (tax year 2026)`,
        unitAmountMinor: 1_500_000,
        client: null,
        case: null,
      }),
    ]);

    // An individual invoice never names a client on a line.
    const withClient = await save(w, fromCase.data, [
      { description: 'Filing', quantity: 1, unitAmountMinor: 1_000, clientId: member['id'] },
    ]);
    expect(withClient.status).toBe(400);
    expect(withClient.data['errors'][0]['field']).toBe('items.0.clientId');
  });
});

describe('TD-511 combined lines', () => {
  it('records each line client and case and returns them on the draft', async () => {
    const w = await world();
    const { head, member, second, memberCase, draft } = await pricedCombined(w);
    expect(draft['totalMinor']).toBe(1_750_000);
    const items = draft['items'] as Record<string, any>[];
    expect(items.map((item) => item['client']['id'])).toEqual([
      head['id'],
      member['id'],
      second['id'],
    ]);
    expect(items[0]?.['client']).toEqual({
      id: head['id'],
      clientCode: head['clientCode'],
      displayName: 'Group Head Holdings',
    });
    expect(items[1]?.['case']).toEqual({
      id: memberCase['id'],
      caseCode: memberCase['caseCode'],
      serviceName: memberCase['service']['name'],
    });
    expect(items[0]?.['case']).toBeNull();
  });

  it('requires a client on every line, in the group, with its own case', async () => {
    const w = await world();
    const { head, member, second, memberCase } = await group(w);
    const created = await combinedDraft(w, head);
    const draft = created.data;

    const noClient = await save(w, draft, [
      { description: 'Filing', quantity: 1, unitAmountMinor: 1_000 },
    ]);
    expect(noClient.status).toBe(400);
    expect(noClient.data['errors']).toEqual([
      { field: 'items.0.clientId', message: 'Choose who this line is for.' },
    ]);

    const outsider = await createClient(w);
    const notInGroup = await save(w, draft, [
      { description: 'Filing', quantity: 1, unitAmountMinor: 1_000, clientId: outsider['id'] },
    ]);
    expect(notInGroup.status).toBe(409);
    expect(notInGroup.data['code']).toBe('INVOICE_LINE_NOT_IN_GROUP');

    const unknown = await save(w, draft, [
      {
        description: 'Filing',
        quantity: 1,
        unitAmountMinor: 1_000,
        clientId: '0198a000-0000-7000-8000-00000000ffff',
      },
    ]);
    expect(unknown.status).toBe(409);
    expect(unknown.data['code']).toBe('INVOICE_LINE_NOT_IN_GROUP');

    const wrongCase = await save(w, draft, [
      {
        description: 'Filing',
        quantity: 1,
        unitAmountMinor: 1_000,
        clientId: second['id'],
        caseId: memberCase['id'],
      },
    ]);
    expect(wrongCase.status).toBe(400);
    expect(wrongCase.data['errors'][0]['field']).toBe('items.0.caseId');

    const caseWithoutClient = await save(w, draft, [
      { description: 'Filing', quantity: 1, unitAmountMinor: 1_000, caseId: memberCase['id'] },
    ]);
    expect(caseWithoutClient.status).toBe(400);

    // Nothing above was saved.
    const current = await w.call(`/api/v1/invoices/${draft['id'] as string}`, { as: 'billing' });
    expect(current.data['version']).toBe(1);
    expect(member['id']).toBeDefined();
  });

  it('rejects a line for an archived member', async () => {
    const w = await world();
    const { head, second } = await group(w);
    const created = await combinedDraft(w, head);
    const archived = await w.call(`/api/v1/clients/${second['id'] as string}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: second['version'],
    });
    expect(archived.status, archived.text).toBe(200);
    const result = await save(w, created.data, [
      { description: 'Filing', quantity: 1, unitAmountMinor: 1_000, clientId: second['id'] },
    ]);
    expect(result.status).toBe(409);
    expect(result.data['code']).toBe('CLIENT_ARCHIVED');
  });
});

describe('TD-511 billable cases and the duplicate-billing warning', () => {
  it('offers the line client cases with the service default fee', async () => {
    const w = await world();
    const { head, member, memberCase } = await group(w);
    const created = await combinedDraft(w, head);
    const result = await w.call(
      `/api/v1/invoices/${created.data['id'] as string}/billable-cases?clientId=${member['id'] as string}`,
      { as: 'billing' },
    );
    expect(result.status, result.text).toBe(200);
    expect(result.data['cases']).toEqual([
      {
        id: memberCase['id'],
        caseCode: memberCase['caseCode'],
        serviceName: memberCase['service']['name'],
        taxYear: 2026,
        description: `${memberCase['service']['name'] as string} (tax year 2026)`,
        unitAmountMinor: 1_500_000,
        otherInvoices: [],
      },
    ]);
  });

  it('lists other invoices, not void, that already bill the case', async () => {
    const w = await world();
    const { head, member, memberCase, draft } = await pricedCombined(w);
    const individual = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { caseId: memberCase['id'] },
    });
    const voided = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { caseId: memberCase['id'] },
    });
    await w.call(`/api/v1/invoices/${voided.data['id'] as string}/void`, {
      as: 'billing',
      method: 'POST',
      ifMatch: voided.data['version'],
      key: key(),
      body: { reason: 'Created by mistake', confirm: true },
    });
    const second = await combinedDraft(w, head);
    const result = await w.call(
      `/api/v1/invoices/${second.data['id'] as string}/billable-cases?clientId=${member['id'] as string}`,
      { as: 'billing' },
    );
    const others = result.data['cases'][0]['otherInvoices'] as Record<string, any>[];
    expect(others.map((other) => other['id']).sort()).toEqual(
      [draft['id'], individual.data['id']].sort(),
    );
    expect(others.every((other) => other['status'] === 'draft')).toBe(true);

    // The warning never blocks: the second combined draft can bill the case too.
    const saved = await save(w, second.data, [
      {
        description: 'Follow-up filing',
        quantity: 1,
        unitAmountMinor: 500_000,
        clientId: member['id'],
        caseId: memberCase['id'],
      },
    ]);
    expect(saved.status, saved.text).toBe(200);

    // The case filter on the invoice list finds combined invoices by their lines.
    const byCase = await w.call(`/api/v1/invoices?caseId=${memberCase['id'] as string}`, {
      as: 'billing',
    });
    expect(byCase.data['invoices'].map((invoice: any) => invoice['id']).sort()).toEqual(
      [draft['id'], individual.data['id'], voided.data['id'], second.data['id']].sort(),
    );
  });

  it('needs billing.manage, a combined draft, and a client in the group', async () => {
    const w = await world();
    const { head, member } = await group(w);
    const created = await combinedDraft(w, head);
    const path = `/api/v1/invoices/${created.data['id'] as string}/billable-cases`;
    for (const role of ['manager', 'consultant', 'read_only'] as const) {
      const denied = await w.call(`${path}?clientId=${member['id'] as string}`, { as: role });
      expect(denied.status, role).toBe(403);
    }
    const outsider = await createClient(w);
    const notInGroup = await w.call(`${path}?clientId=${outsider['id'] as string}`, {
      as: 'billing',
    });
    expect(notInGroup.status).toBe(409);
    expect(notInGroup.data['code']).toBe('INVOICE_LINE_NOT_IN_GROUP');
    expect((await w.call(path, { as: 'billing' })).status).toBe(400);

    const individual = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: member['id'] },
    });
    const notCombined = await w.call(
      `/api/v1/invoices/${individual.data['id'] as string}/billable-cases?clientId=${member['id'] as string}`,
      { as: 'billing' },
    );
    expect(notCombined.status).toBe(409);
    expect(notCombined.data['code']).toBe('INVOICE_NOT_COMBINED');
  });
});

describe('TD-511 finalization', () => {
  it('snapshots each line client so later group and name changes never alter it', async () => {
    const w = await world();
    const { head, member, draft } = await pricedCombined(w);
    const finalized = await finalize(w, draft);
    expect(finalized.status, finalized.text).toBe(200);
    expect(finalized.data['status']).toBe('finalized');
    expect(finalized.data['pdfState']).toBe('ready');

    // Rename the member and take it out of the group.
    const renamed = await editClient(w, member, {
      legalName: 'Renamed Member',
      displayName: 'Renamed Member',
      parentClientId: null,
    });
    expect(renamed.status, renamed.text).toBe(200);

    const reloaded = await w.call(`/api/v1/invoices/${draft['id'] as string}`, { as: 'billing' });
    const memberLine = (reloaded.data['items'] as Record<string, any>[])[1];
    expect(memberLine?.['client']).toEqual({
      id: member['id'],
      clientCode: member['clientCode'],
      displayName: 'Member One',
    });
    expect(reloaded.data['totalMinor']).toBe(1_750_000);
    expect(reloaded.data['client']['id']).toBe(head['id']);

    // Line items stay frozen in storage too.
    const items = await w.harness.dependencies.repositories.invoices.listItems(draft['id']);
    expect(items.map((item) => item.clientNameSnapshot)).toEqual([
      'Group Head Holdings',
      'Member One',
      expect.stringMatching(/^Synthetic Person|Member Two$/u),
    ]);

    const pdf = await w.call(`/api/v1/invoices/${draft['id'] as string}/pdf`, { as: 'billing' });
    expect(pdf.status).toBe(200);
    const loaded = await PDFDocument.load(pdf.bytes);
    expect(loaded.getSubject()).toContain('total PKR 17,500.00');
  });

  it('rechecks the group and refuses a line client that left it', async () => {
    const w = await world();
    const { second, draft } = await pricedCombined(w);
    const left = await editClient(w, second, { parentClientId: null });
    expect(left.status).toBe(200);
    const refused = await finalize(w, draft);
    expect(refused.status).toBe(409);
    expect(refused.data['code']).toBe('INVOICE_GROUP_CHANGED');
    expect(refused.data['errors']).toEqual([
      {
        field: 'items.2.clientId',
        message: `${second['clientCode'] as string} is no longer in this group. Change or remove its lines, then finalize.`,
      },
    ]);
    const current = await w.call(`/api/v1/invoices/${draft['id'] as string}`, { as: 'billing' });
    expect(current.data['status']).toBe('draft');
    expect(current.data['invoiceNumber']).toBeNull();
  });
});

describe('TD-511 database backstop', () => {
  it('answers 409 when the database rejects the group on save or finalize', async () => {
    const w = await world();
    const { head, draft } = await pricedCombined(w);
    const invoices = w.harness.dependencies.repositories.invoices;

    const replace = vi
      .spyOn(invoices, 'replaceDraft')
      .mockRejectedValueOnce(new CombinedInvoiceRuleError());
    const saved = await save(w, draft, [
      { description: 'Advisory', quantity: 1, unitAmountMinor: 1_000, clientId: head['id'] },
    ]);
    replace.mockRestore();
    expect(saved.status).toBe(409);
    expect(saved.data['code']).toBe('INVOICE_GROUP_CHANGED');

    const finalizeSpy = vi
      .spyOn(invoices, 'finalize')
      .mockRejectedValueOnce(new CombinedInvoiceRuleError());
    const finalized = await finalize(w, draft);
    finalizeSpy.mockRestore();
    expect(finalized.status).toBe(409);
    expect(finalized.data['code']).toBe('INVOICE_GROUP_CHANGED');
    expect(finalized.data['detail']).toContain('no longer in the group');
  });
});

describe('TD-511 payments, totals, and visibility', () => {
  it('applies payments, reversals, and void to the whole combined invoice', async () => {
    const w = await world();
    const { head, member, draft } = await pricedCombined(w);
    const finalized = await finalize(w, draft);
    const paid = await w.call(`/api/v1/invoices/${draft['id'] as string}/payments`, {
      as: 'billing',
      method: 'POST',
      key: key(),
      body: { amountMinor: 750_000, method: 'cash', receivedOn: '2026-06-01', reference: '' },
    });
    expect(paid.status, paid.text).toBe(201);
    expect(paid.data['invoice']['paymentStatus']).toBe('partially_paid');
    expect(paid.data['invoice']['outstandingMinor']).toBe(1_000_000);

    const totals = await w.call(`/api/v1/invoices/group-totals?group=${head['id'] as string}`, {
      as: 'billing',
    });
    expect(totals.data).toMatchObject({
      invoiceCount: 1,
      invoicedMinor: 1_750_000,
      paidMinor: 750_000,
      outstandingMinor: 1_000_000,
    });
    const groupList = await w.call(`/api/v1/invoices?group=${head['id'] as string}`, {
      as: 'billing',
    });
    expect(groupList.data['invoices'].map((invoice: any) => invoice['id'])).toEqual([draft['id']]);
    // Counted against the head, never the member.
    const memberList = await w.call(`/api/v1/invoices?clientId=${member['id'] as string}`, {
      as: 'billing',
    });
    expect(memberList.data['invoices']).toEqual([]);

    const reversed = await w.call(
      `/api/v1/payments/${paid.data['payment']['id'] as string}/reverse`,
      {
        as: 'manager',
        method: 'POST',
        key: key(),
        body: { amountMinor: 750_000, reason: 'Recorded against the wrong group' },
      },
    );
    expect(reversed.status, reversed.text).toBe(200);
    expect(reversed.data['invoice']['paidMinor']).toBe(0);

    const voided = await w.call(`/api/v1/invoices/${draft['id'] as string}/void`, {
      as: 'billing',
      method: 'POST',
      ifMatch: reversed.data['invoice']['version'],
      key: key(),
      body: { reason: 'Rebilling individually', confirm: true },
    });
    expect(voided.status, voided.text).toBe(200);
    expect(voided.data['status']).toBe('void');
    expect(finalized.data['invoiceNumber']).toBe(voided.data['invoiceNumber']);
  });

  it('shows a combined invoice to readers who can see every client and hides it otherwise', async () => {
    const w = await world();
    const { draft } = await pricedCombined(w);
    for (const role of ['administrator', 'manager', 'billing', 'read_only'] as const) {
      const read = await w.call(`/api/v1/invoices/${draft['id'] as string}`, { as: role });
      expect(read.status, role).toBe(200);
    }
    const consultant = await w.call(`/api/v1/invoices/${draft['id'] as string}`, {
      as: 'consultant',
    });
    expect(consultant.status).toBe(403);
  });
});
