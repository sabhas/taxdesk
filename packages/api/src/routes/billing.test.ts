/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands, @typescript-eslint/dot-notation -- route tests navigate untyped JSON response bodies */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { STARTER_WORKFLOW_DEFINITION, type RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import type { AppEnv } from '../types.js';
import {
  connectStorage,
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
  type TestHarnessOptions,
} from '../testing/harness.js';
import type { UserRecord } from '../domain/auth/types.js';

const PASSWORD = 'correct horse battery staple';
let counter = 0;

type Actor = RoleKey;

interface Called {
  status: number;
  etag: string | null;
  headers: Headers;
  bytes: Uint8Array;
  data: Record<string, any>;
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
  app: Hono<AppEnv>;
  users: Record<Actor, UserRecord>;
  call: (path: string, options: CallOptions) => Promise<Called>;
}

async function world(options: TestHarnessOptions & { connected?: boolean } = {}): Promise<World> {
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z'), ...options });
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
      username: `bill-${role.replace('_', '-')}`,
      displayName: `Staff ${role}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[role] = (await sessionCookieFor(harness, user)).cookie;
    users[role] = user;
  }
  if (options.connected !== false) {
    await connectStorage(harness, users.administrator);
  }
  const call = async (path: string, call: CallOptions): Promise<Called> => {
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': `bill-${String(++counter)}`,
      Cookie: cookies[call.as],
    };
    let body: BodyInit | undefined;
    if (call.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(call.body);
    }
    if (call.ifMatch !== undefined) {
      headers['If-Match'] = `"${String(call.ifMatch)}"`;
    }
    if (call.key !== undefined) {
      headers['Idempotency-Key'] = call.key;
    }
    const response = await app.request(
      path,
      { method: call.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    let data: Record<string, any> = {};
    if ((response.headers.get('Content-Type') ?? '').includes('json') && bytes.length > 0) {
      data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
    }
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      headers: response.headers,
      bytes,
      data,
    };
  };
  return { harness, app, users, call };
}

const key = (): string => `idem-key-${String(++counter).padStart(12, '0')}`;
let cnicCounter = 1;

async function createClient(w: World): Promise<Record<string, any>> {
  const result = await w.call('/api/v1/clients', {
    as: 'manager',
    method: 'POST',
    body: {
      type: 'individual',
      legalName: `Synthetic Client ${String(cnicCounter)}`,
      cnic: `35202-${String(3_000_000 + cnicCounter++).padStart(7, '0')}-1`,
      contacts: [],
      assignedManagerUserId: null,
    },
  });
  expect(result.status).toBe(201);
  return result.data;
}

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
  expect(created.status).toBe(201);
  return created.data;
}

const line = (description: string, quantity: number, unitAmountMinor: number) => ({
  description,
  quantity,
  unitAmountMinor,
});

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [line('Return filing', 1, 1_000_000), line('Advisory hours', 2, 250_000)],
    discountMinor: 100_000,
    issueDate: null,
    dueDate: '2026-07-15',
    notes: '',
    ...overrides,
  };
}

/** A priced draft from a client: total 14,000.00. */
async function pricedDraft(w: World, client: Record<string, any>, body = draftBody()) {
  const created = await w.call('/api/v1/invoices', {
    as: 'billing',
    method: 'POST',
    body: { clientId: client['id'] },
  });
  expect(created.status).toBe(201);
  const updated = await w.call(`/api/v1/invoices/${created.data['id'] as string}`, {
    as: 'billing',
    method: 'PATCH',
    ifMatch: created.data['version'],
    body,
  });
  expect(updated.status).toBe(200);
  return updated.data;
}

async function finalize(w: World, invoice: Record<string, any>, idempotencyKey = key()) {
  return await w.call(`/api/v1/invoices/${invoice['id'] as string}/finalize`, {
    as: 'billing',
    method: 'POST',
    ifMatch: invoice['version'],
    key: idempotencyKey,
  });
}

async function finalized(w: World, client: Record<string, any>, body = draftBody()) {
  const draft = await pricedDraft(w, client, body);
  const result = await finalize(w, draft);
  expect(result.status).toBe(200);
  return result.data;
}

function pay(
  w: World,
  invoice: Record<string, any>,
  amountMinor: number,
  options: { idempotencyKey?: string; as?: Actor } = {},
) {
  return w.call(`/api/v1/invoices/${invoice['id'] as string}/payments`, {
    as: options.as ?? 'billing',
    method: 'POST',
    key: options.idempotencyKey ?? key(),
    body: { amountMinor, method: 'bank_transfer', receivedOn: '2026-06-01', reference: 'TRX-1' },
  });
}

describe('drafts (TD-501, TD-502)', () => {
  it('drafts from a case with the service default and leaves case status alone', async () => {
    const w = await world();
    const client = await createClient(w);
    const taxCase = await openCase(w, client);
    const created = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { caseId: taxCase['id'] },
    });
    expect(created.status).toBe(201);
    expect(created.etag).toBe('"1"');
    expect(created.data).toMatchObject({
      status: 'draft',
      invoiceNumber: null,
      currency: 'PKR',
      subtotalMinor: 1_500_000,
      totalMinor: 1_500_000,
      outstandingMinor: 1_500_000,
      paidMinor: 0,
      client: { id: client['id'] },
      case: { id: taxCase['id'] },
    });
    expect(created.data['items']).toHaveLength(1);
    expect(created.data['items'][0].description).toContain('tax year 2026');

    await finalize(w, {
      id: created.data['id'],
      version: created.data['version'],
    });
    const after = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    expect(after.data['currentStatus']).toEqual(taxCase['currentStatus']);
    expect(after.data['version']).toBe(taxCase['version']);
  });

  it('drafts manually from a client with no lines', async () => {
    const w = await world();
    const client = await createClient(w);
    const created = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: client['id'] },
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ items: [], totalMinor: 0, case: null });
  });

  it('requires exactly one of client or case and a known record', async () => {
    const w = await world();
    const client = await createClient(w);
    const both = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: client['id'], caseId: client['id'] },
    });
    expect(both.status).toBe(400);
    const missing = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: '0190a8e2-7b3c-7a1e-8d4f-123456789abc' },
    });
    expect(missing.status).toBe(404);
    expect(missing.data['code']).toBe('CLIENT_NOT_FOUND');
  });

  it('recomputes totals on the server and rejects supplied totals', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await pricedDraft(w, client);
    expect(invoice).toMatchObject({
      subtotalMinor: 1_500_000,
      discountMinor: 100_000,
      totalMinor: 1_400_000,
      outstandingMinor: 1_400_000,
    });
    expect(invoice['items'].map((item: Record<string, any>) => item['position'])).toEqual([1, 2]);
    const supplied = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: invoice['version'],
      body: { ...draftBody(), totalMinor: 1 },
    });
    expect(supplied.status).toBe(400);
  });

  it('rejects a discount above the subtotal and malformed lines with field errors', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await pricedDraft(w, client);
    const overDiscount = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: invoice['version'],
      body: draftBody({ discountMinor: 9_000_000 }),
    });
    expect(overDiscount.status).toBe(400);
    expect(overDiscount.data['errors'][0].field).toBe('discountMinor');
    const malformed = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: invoice['version'],
      body: draftBody({ items: [line('Bad', 0, 100)] }),
    });
    expect(malformed.status).toBe(400);
  });

  it('requires If-Match and rejects a stale version with 412', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await pricedDraft(w, client);
    const missing = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      body: draftBody(),
    });
    expect(missing.status).toBe(428);
    const staleEdit = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: 1,
      body: draftBody({ notes: 'older' }),
    });
    expect(staleEdit.status).toBe(412);
    expect(staleEdit.data['code']).toBe('PRECONDITION_FAILED');
  });

  it('supports reordering, adding, and removing lines', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await pricedDraft(w, client);
    const reordered = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: invoice['version'],
      body: draftBody({
        items: [
          line('Advisory hours', 2, 250_000),
          line('Return filing', 1, 1_000_000),
          line('Extra', 1, 5),
        ],
      }),
    });
    expect(reordered.status).toBe(200);
    expect(reordered.data['items'].map((item: Record<string, any>) => item['description'])).toEqual(
      ['Advisory hours', 'Return filing', 'Extra'],
    );
    const removed = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: reordered.data['version'],
      body: draftBody({ items: [line('Only', 1, 1_000)], discountMinor: 0 }),
    });
    expect(removed.data).toMatchObject({ totalMinor: 1_000 });
    expect(removed.data['items']).toHaveLength(1);
  });
});

describe('finalize (TD-503)', () => {
  it('numbers gaplessly, freezes the invoice, and audits a safe summary', async () => {
    const w = await world();
    const client = await createClient(w);
    const first = await finalized(w, client);
    const second = await finalized(w, client);
    expect(first['invoiceNumber']).toBe('INV-00001');
    expect(second['invoiceNumber']).toBe('INV-00002');
    expect(first).toMatchObject({
      status: 'finalized',
      issueDate: '2026-06-01',
      pdfState: 'ready',
    });

    const edit = await w.call(`/api/v1/invoices/${first['id'] as string}`, {
      as: 'billing',
      method: 'PATCH',
      ifMatch: first['version'],
      body: draftBody({ notes: 'tamper' }),
    });
    expect(edit.status).toBe(409);
    expect(edit.data['code']).toBe('INVOICE_NOT_DRAFT');

    const event = w.harness.state.auditEvents.find(
      (entry) => entry.action === 'billing.invoice_finalized',
    );
    expect(event?.metadata).toEqual({
      clientCode: client['clientCode'],
      caseCode: null,
      invoiceNumber: 'INV-00001',
      totalMinor: 1_400_000,
      currency: 'PKR',
    });
  });

  it('requires If-Match and an Idempotency-Key', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const noKey = await w.call(`/api/v1/invoices/${draft['id'] as string}/finalize`, {
      as: 'billing',
      method: 'POST',
      ifMatch: draft['version'],
    });
    expect(noKey.status).toBe(428);
    expect(noKey.data['code']).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const noMatch = await w.call(`/api/v1/invoices/${draft['id'] as string}/finalize`, {
      as: 'billing',
      method: 'POST',
      key: key(),
    });
    expect(noMatch.status).toBe(428);
    const badKey = await w.call(`/api/v1/invoices/${draft['id'] as string}/finalize`, {
      as: 'billing',
      method: 'POST',
      ifMatch: draft['version'],
      key: 'short',
    });
    expect(badKey.status).toBe(400);
  });

  it('returns the original outcome on a retry and never allocates a second number', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const idempotencyKey = key();
    const first = await finalize(w, draft, idempotencyKey);
    const retry = await finalize(w, draft, idempotencyKey);
    expect(retry.status).toBe(200);
    expect(retry.data['invoiceNumber']).toBe('INV-00001');
    expect(retry.data['id']).toBe(first.data['id']);
    expect(w.harness.state.numberSequences.invoice).toBe(2);
    expect(
      w.harness.state.auditEvents.filter((entry) => entry.action === 'billing.invoice_finalized'),
    ).toHaveLength(1);
  });

  it('answers simultaneous retries with one numbered invoice', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const idempotencyKey = key();
    const results = await Promise.all([
      finalize(w, draft, idempotencyKey),
      finalize(w, draft, idempotencyKey),
    ]);
    expect(results.map((result) => result.data['invoiceNumber'])).toEqual([
      'INV-00001',
      'INV-00001',
    ]);
    expect(w.harness.state.numberSequences.invoice).toBe(2);
  });

  it('rejects a key reused for a different request', async () => {
    const w = await world();
    const client = await createClient(w);
    const first = await pricedDraft(w, client);
    const second = await pricedDraft(w, client);
    const idempotencyKey = key();
    expect((await finalize(w, first, idempotencyKey)).status).toBe(200);
    const other = await finalize(w, second, idempotencyKey);
    // A different invoice is a different scope, so it is a fresh request…
    expect(other.status).toBe(200);
    // …but the same invoice with a different version is a different request.
    const reused = await finalize(w, { id: first['id'], version: 99 }, idempotencyKey);
    expect(reused.status).toBe(409);
    expect(reused.data['code']).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses an empty invoice, a stale version, and a second finalize with a new key', async () => {
    const w = await world();
    const client = await createClient(w);
    const empty = await w.call('/api/v1/invoices', {
      as: 'billing',
      method: 'POST',
      body: { clientId: client['id'] },
    });
    const emptyResult = await finalize(w, empty.data);
    expect(emptyResult.status).toBe(409);
    expect(emptyResult.data['code']).toBe('INVOICE_EMPTY');

    const draft = await pricedDraft(w, client);
    const staleResult = await finalize(w, { id: draft['id'], version: 1 });
    expect(staleResult.status).toBe(412);

    await finalize(w, draft);
    const again = await finalize(w, draft);
    expect(again.status).toBe(409);
    expect(again.data['code']).toBe('INVOICE_NOT_DRAFT');
  });

  it('refuses a due date earlier than the issue date it would default to', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client, draftBody({ dueDate: '2026-05-01' }));
    const result = await finalize(w, draft);
    expect(result.status).toBe(400);
    expect(result.data['errors'][0].field).toBe('dueDate');
  });
});

describe('PDFs (TD-504, TD-507)', () => {
  it('stores a PDF whose metadata matches the finalized record', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const download = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toBe('application/pdf');
    const loaded = await PDFDocument.load(download.bytes);
    expect(loaded.getTitle()).toBe(`Invoice ${invoice['invoiceNumber'] as string}`);
    expect(loaded.getSubject()).toContain('total PKR 14,000.00');
    expect(loaded.getKeywords()).toBe(
      `${invoice['invoiceNumber'] as string} ${client['clientCode'] as string} PKR 1400000`,
    );
    expect(
      w.harness.state.auditEvents.some(
        (entry) => entry.action === 'billing.invoice_pdf_downloaded',
      ),
    ).toBe(true);
  });

  it('keeps billing PDFs out of the general document routes and away from consultants', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    expect(w.harness.state.documents.size).toBe(0);
    const documents = await w.call(`/api/v1/documents?clientId=${client['id'] as string}`, {
      as: 'manager',
    });
    expect(documents.data['documents']).toEqual([]);
    const consultant = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'consultant',
    });
    expect(consultant.status).toBe(403);
  });

  it('commits the invoice when storage is unavailable, then retries the PDF idempotently', async () => {
    const w = await world({ connected: false });
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    expect(invoice).toMatchObject({ status: 'finalized', pdfState: 'failed' });
    const notReady = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
    });
    expect(notReady.status).toBe(409);
    expect(notReady.data['code']).toBe('BILLING_PDF_NOT_READY');
    const unavailable = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
      method: 'POST',
    });
    expect(unavailable.status).toBe(503);

    await connectStorage(w.harness, w.users.administrator);
    const retry = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
      method: 'POST',
    });
    expect(retry.status).toBe(200);
    expect(retry.data).toEqual({ pdfState: 'ready', created: true });
    const again = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
      method: 'POST',
    });
    expect(again.data).toEqual({ pdfState: 'ready', created: false });
    expect(w.harness.state.billingDocuments.size).toBe(1);
  });

  it('refuses a PDF for a draft', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const result = await w.call(`/api/v1/invoices/${draft['id'] as string}/pdf`, {
      as: 'billing',
      method: 'POST',
    });
    expect(result.status).toBe(409);
    expect(result.data['code']).toBe('INVOICE_NOT_FINALIZED');
  });
});

describe('payments and receipts (TD-506, TD-507)', () => {
  it('records partial then full settlement with receipts', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const first = await pay(w, invoice, 500_000);
    expect(first.status).toBe(201);
    expect(first.data['invoice']).toMatchObject({
      paidMinor: 500_000,
      outstandingMinor: 900_000,
      paymentStatus: 'partially_paid',
      version: invoice['version'] + 1,
    });
    expect(first.data['payment']).toMatchObject({
      receiptNumber: 'RCP-00001',
      receiptPdfState: 'ready',
      amountMinor: 500_000,
    });
    const second = await pay(w, invoice, 900_000);
    expect(second.data['invoice']).toMatchObject({
      paidMinor: 1_400_000,
      outstandingMinor: 0,
      paymentStatus: 'paid',
    });
    expect(second.data['payment']['receiptNumber']).toBe('RCP-00002');

    const receipt = await w.call(
      `/api/v1/payments/${first.data['payment']['id'] as string}/receipt-pdf`,
      { as: 'read_only' },
    );
    expect(receipt.status).toBe(200);
    expect((await PDFDocument.load(receipt.bytes)).getTitle()).toBe('Receipt RCP-00001');

    const list = await w.call(`/api/v1/invoices/${invoice['id'] as string}/payments`, {
      as: 'billing',
    });
    expect(list.data['payments']).toHaveLength(2);
    // The invoice PDF is never edited by a payment.
    expect(w.harness.state.billingDocuments.size).toBe(3);
  });

  it('rejects zero, over-balance, and draft payments', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const onDraft = await pay(w, draft, 100);
    expect(onDraft.status).toBe(409);
    expect(onDraft.data['code']).toBe('INVOICE_NOT_FINALIZED');

    const invoice = await finalized(w, client);
    expect((await pay(w, invoice, 0)).status).toBe(400);
    const over = await pay(w, invoice, 1_400_001);
    expect(over.status).toBe(409);
    expect(over.data['code']).toBe('PAYMENT_EXCEEDS_OUTSTANDING');
    const future = await w.call(`/api/v1/invoices/${invoice['id'] as string}/payments`, {
      as: 'billing',
      method: 'POST',
      key: key(),
      body: { amountMinor: 100, method: 'cash', receivedOn: '2027-01-01', reference: '' },
    });
    expect(future.status).toBe(400);
  });

  it('never duplicates a payment on a retry with the same key', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const idempotencyKey = key();
    const first = await pay(w, invoice, 400_000, { idempotencyKey });
    const retry = await pay(w, invoice, 400_000, { idempotencyKey });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.data['payment']['id']).toBe(first.data['payment']['id']);
    expect(w.harness.state.payments.size).toBe(1);
    expect(w.harness.state.numberSequences.receipt).toBe(2);
    const changed = await pay(w, invoice, 300_000, { idempotencyKey });
    expect(changed.status).toBe(409);
    expect(changed.data['code']).toBe('IDEMPOTENCY_KEY_REUSED');
    const current = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, { as: 'billing' });
    expect(current.data['paidMinor']).toBe(400_000);
  });

  it('requires an Idempotency-Key', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const result = await w.call(`/api/v1/invoices/${invoice['id'] as string}/payments`, {
      as: 'billing',
      method: 'POST',
      body: { amountMinor: 100, method: 'cash', receivedOn: '2026-06-01' },
    });
    expect(result.status).toBe(428);
  });

  it('commits the payment when storage is down and offers a receipt retry', async () => {
    const w = await world({ connected: false });
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const result = await pay(w, invoice, 100_000);
    expect(result.status).toBe(201);
    expect(result.data['payment']['receiptPdfState']).toBe('failed');
    await connectStorage(w.harness, w.users.administrator);
    const retry = await w.call(
      `/api/v1/payments/${result.data['payment']['id'] as string}/receipt-pdf`,
      { as: 'billing', method: 'POST' },
    );
    expect(retry.data).toEqual({ pdfState: 'ready', created: true });
  });
});

describe('reversals (TD-508)', () => {
  const reverse = (
    w: World,
    payment: Record<string, any>,
    amountMinor: number,
    as: Actor = 'manager',
    idempotencyKey = key(),
  ) =>
    w.call(`/api/v1/payments/${payment['id'] as string}/reverse`, {
      as,
      method: 'POST',
      key: idempotencyKey,
      body: { amountMinor, reason: 'Entered against the wrong invoice' },
    });

  it('reverses through a linked entry and restores the balance', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const paid = await pay(w, invoice, 1_400_000);
    expect(paid.data['invoice']['paymentStatus']).toBe('paid');
    const partial = await reverse(w, paid.data['payment'], 400_000);
    expect(partial.status).toBe(200);
    expect(partial.data['invoice']).toMatchObject({
      paidMinor: 1_000_000,
      outstandingMinor: 400_000,
      paymentStatus: 'partially_paid',
    });
    expect(partial.data['payment']).toMatchObject({
      amountMinor: 1_400_000,
      reversedMinor: 400_000,
    });
    expect(partial.data['payment']['reversals']).toHaveLength(1);
    const rest = await reverse(w, paid.data['payment'], 1_000_000);
    expect(rest.data['invoice']).toMatchObject({ paidMinor: 0, paymentStatus: 'unpaid' });
    // The original payment row is unchanged.
    expect(w.harness.state.payments.get(paid.data['payment']['id'])?.amountMinor).toBe(1_400_000);
  });

  it('prevents reversal above the unreversed value and replays a retry', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const paid = await pay(w, invoice, 600_000);
    const idempotencyKey = key();
    const first = await reverse(w, paid.data['payment'], 200_000, 'manager', idempotencyKey);
    const retry = await reverse(w, paid.data['payment'], 200_000, 'manager', idempotencyKey);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(w.harness.state.paymentReversals).toHaveLength(1);
    const over = await reverse(w, paid.data['payment'], 400_001);
    expect(over.status).toBe(409);
    expect(over.data['code']).toBe('REVERSAL_EXCEEDS_PAYMENT');
    const zero = await reverse(w, paid.data['payment'], 0);
    expect(zero.status).toBe(400);
  });

  it('keeps reverse and record permissions separate', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const managerRecord = await pay(w, invoice, 100_000, { as: 'manager' });
    expect(managerRecord.status).toBe(403);
    const paid = await pay(w, invoice, 100_000, { as: 'billing' });
    const billingReverse = await reverse(w, paid.data['payment'], 100, 'billing');
    expect(billingReverse.status).toBe(403);
    const readOnlyReverse = await reverse(w, paid.data['payment'], 100, 'read_only');
    expect(readOnlyReverse.status).toBe(403);
    const adminReverse = await reverse(w, paid.data['payment'], 100, 'administrator');
    expect(adminReverse.status).toBe(200);
  });

  it('answers 404 for an unknown payment', async () => {
    const w = await world();
    const result = await reverse(w, { id: '0190a8e2-7b3c-7a1e-8d4f-123456789abc' }, 100);
    expect(result.status).toBe(404);
    expect(result.data['code']).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('void (TD-509)', () => {
  const voidInvoice = (
    w: World,
    invoice: Record<string, any>,
    body: Record<string, unknown> = { reason: 'Issued in error', confirm: true },
    idempotencyKey = key(),
  ) =>
    w.call(`/api/v1/invoices/${invoice['id'] as string}/void`, {
      as: 'billing',
      method: 'POST',
      ifMatch: invoice['version'],
      key: idempotencyKey,
      body,
    });

  it('voids an unpaid finalized invoice and keeps its number and PDF', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const result = await voidInvoice(w, invoice);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      status: 'void',
      invoiceNumber: invoice['invoiceNumber'],
      voidReason: 'Issued in error',
      pdfState: 'ready',
    });
    const blocked = await pay(w, invoice, 100);
    expect(blocked.status).toBe(409);
    expect(blocked.data['code']).toBe('INVOICE_VOID');
    const again = await voidInvoice(w, { id: invoice['id'], version: result.data['version'] });
    expect(again.status).toBe(409);
    const download = await w.call(`/api/v1/invoices/${invoice['id'] as string}/pdf`, {
      as: 'billing',
    });
    expect(download.status).toBe(200);
  });

  it('voids a draft without consuming a number', async () => {
    const w = await world();
    const client = await createClient(w);
    const draft = await pricedDraft(w, client);
    const result = await voidInvoice(w, draft);
    expect(result.data).toMatchObject({ status: 'void', invoiceNumber: null });
    expect(w.harness.state.numberSequences.invoice).toBe(1);
  });

  it('requires explicit confirmation and a reason', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    expect((await voidInvoice(w, invoice, { reason: 'x', confirm: false })).status).toBe(400);
    expect((await voidInvoice(w, invoice, { reason: '', confirm: true })).status).toBe(400);
  });

  it('refuses a void while a payment is active, then allows it after a full reversal', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const paid = await pay(w, invoice, 300_000);
    const afterPay = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, { as: 'billing' });
    const blocked = await voidInvoice(w, afterPay.data);
    expect(blocked.status).toBe(409);
    expect(blocked.data['code']).toBe('INVOICE_HAS_ACTIVE_PAYMENTS');
    const reversed = await w.call(
      `/api/v1/payments/${paid.data['payment']['id'] as string}/reverse`,
      {
        as: 'manager',
        method: 'POST',
        key: key(),
        body: { amountMinor: 300_000, reason: 'Bounced' },
      },
    );
    expect(reversed.status).toBe(200);
    const allowed = await voidInvoice(w, reversed.data['invoice']);
    expect(allowed.status).toBe(200);
  });

  it('rejects a stale version and replays a retry', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const staleResult = await voidInvoice(w, { id: invoice['id'], version: 1 });
    expect(staleResult.status).toBe(412);
    const idempotencyKey = key();
    const first = await voidInvoice(w, invoice, undefined, idempotencyKey);
    const retry = await voidInvoice(w, invoice, undefined, idempotencyKey);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.data['status']).toBe('void');
  });
});

describe('list and detail (TD-505)', () => {
  it('filters, pages with a cursor, and shows balances', async () => {
    const w = await world();
    const clientA = await createClient(w);
    const clientB = await createClient(w);
    const a1 = await finalized(w, clientA);
    await finalized(w, clientA);
    await pricedDraft(w, clientB);
    await pay(w, a1, 1_400_000);

    const all = await w.call('/api/v1/invoices?limit=2', { as: 'read_only' });
    expect(all.data['invoices']).toHaveLength(2);
    expect(all.data['nextCursor']).not.toBeNull();
    const next = await w.call(
      `/api/v1/invoices?limit=2&cursor=${all.data['nextCursor'] as string}`,
      {
        as: 'read_only',
      },
    );
    expect(next.data['invoices']).toHaveLength(1);
    expect(next.data['nextCursor']).toBeNull();

    const byClient = await w.call(`/api/v1/invoices?clientId=${clientA['id'] as string}`, {
      as: 'manager',
    });
    expect(byClient.data['invoices']).toHaveLength(2);
    const paid = await w.call('/api/v1/invoices?paymentStatus=paid', { as: 'manager' });
    expect(paid.data['invoices']).toHaveLength(1);
    expect(paid.data['invoices'][0]).toMatchObject({ paidMinor: 1_400_000, outstandingMinor: 0 });
    const drafts = await w.call('/api/v1/invoices?status=draft', { as: 'manager' });
    expect(drafts.data['invoices']).toHaveLength(1);
    const dueRange = await w.call('/api/v1/invoices?dueFrom=2026-08-01', { as: 'manager' });
    expect(dueRange.data['invoices']).toHaveLength(0);
    expect((await w.call('/api/v1/invoices?limit=0', { as: 'manager' })).status).toBe(400);
    expect((await w.call('/api/v1/invoices?cursor=nope', { as: 'manager' })).status).toBe(400);
  });

  it('serves detail with an ETag and 404s an unknown id', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    const detail = await w.call(`/api/v1/invoices/${invoice['id'] as string}`, { as: 'billing' });
    expect(detail.status).toBe(200);
    expect(detail.etag).toBe(`"${String(invoice['version'])}"`);
    const missing = await w.call('/api/v1/invoices/0190a8e2-7b3c-7a1e-8d4f-123456789abc', {
      as: 'billing',
    });
    expect(missing.status).toBe(404);
    expect(missing.data['code']).toBe('INVOICE_NOT_FOUND');
    expect((await w.call('/api/v1/invoices/not-an-id', { as: 'billing' })).status).toBe(404);
  });
});

describe('roles (TD-510)', () => {
  it('lets read-only and manager read but not draft, edit, finalize, pay, or void', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    for (const as of ['read_only', 'manager'] as const) {
      expect((await w.call('/api/v1/invoices', { as })).status).toBe(200);
      expect((await w.call(`/api/v1/invoices/${invoice['id'] as string}`, { as })).status).toBe(
        200,
      );
      const create = await w.call('/api/v1/invoices', {
        as,
        method: 'POST',
        body: { clientId: client['id'] },
      });
      expect(create.status).toBe(403);
      const record = await pay(w, invoice, 100, { as });
      expect(record.status).toBe(403);
      const voided = await w.call(`/api/v1/invoices/${invoice['id'] as string}/void`, {
        as,
        method: 'POST',
        ifMatch: invoice['version'],
        key: key(),
        body: { reason: 'No', confirm: true },
      });
      expect(voided.status).toBe(403);
    }
  });

  it('keeps invoices away from consultants entirely', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    for (const path of [
      '/api/v1/invoices',
      `/api/v1/invoices/${invoice['id'] as string}`,
      `/api/v1/invoices/${invoice['id'] as string}/payments`,
    ]) {
      expect((await w.call(path, { as: 'consultant' })).status).toBe(403);
    }
  });

  it('never puts amounts-free secrets or names in audit metadata', async () => {
    const w = await world();
    const client = await createClient(w);
    const invoice = await finalized(w, client);
    await pay(w, invoice, 100_000);
    const billingEvents = w.harness.state.auditEvents.filter((entry) =>
      entry.action.startsWith('billing.'),
    );
    expect(billingEvents.length).toBeGreaterThan(3);
    for (const event of billingEvents) {
      const text = JSON.stringify(event.metadata);
      expect(text).not.toContain('Synthetic Client');
      expect(text).not.toContain('35202');
    }
  });
});
