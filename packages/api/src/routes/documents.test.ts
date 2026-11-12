/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { DOCUMENT_LIMITS, STARTER_WORKFLOW_DEFINITION, type RoleKey } from '@taxdesk/shared';
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
const CHUNK = DOCUMENT_LIMITS.chunkBytes;
let counter = 0;

type Actor = RoleKey | 'consultant2' | 'consultant3';

interface Called {
  status: number;
  etag: string | null;
  headers: Headers;
  text: string;
  bytes: Uint8Array;
  data: Record<string, any>;
}

interface CallOptions {
  as: Actor;
  method?: string;
  body?: unknown;
  raw?: Uint8Array;
  ifMatch?: number;
  requestId?: string;
}

interface World {
  harness: TestHarness;
  app: Hono<AppEnv>;
  users: Record<Actor, UserRecord>;
  ids: Record<Actor, string>;
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
  const ids = {} as Record<Actor, string>;
  const people: [Actor, RoleKey][] = [
    ['administrator', 'administrator'],
    ['manager', 'manager'],
    ['consultant', 'consultant'],
    ['consultant2', 'consultant'],
    ['consultant3', 'consultant'],
    ['billing', 'billing'],
    ['read_only', 'read_only'],
  ];
  for (const [name, role] of people) {
    const { user } = await seedUser(harness, {
      username: `doc-${name.replace('_', '-')}`,
      displayName: `Staff ${name}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[name] = (await sessionCookieFor(harness, user)).cookie;
    users[name] = user;
    ids[name] = user.id;
  }
  if (options.connected !== false) {
    await connectStorage(harness, users.administrator);
  }
  const call = async (path: string, call: CallOptions): Promise<Called> => {
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': call.requestId ?? `docs-${String(++counter)}`,
      Cookie: cookies[call.as],
    };
    let body: BodyInit | undefined;
    if (call.raw !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = call.raw;
    } else if (call.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(call.body);
    }
    if (call.ifMatch !== undefined) {
      headers['If-Match'] = `"${String(call.ifMatch)}"`;
    }
    const response = await app.request(
      path,
      { method: call.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let data: Record<string, any> = {};
    if ((response.headers.get('Content-Type') ?? '').includes('json') && text.length > 0) {
      data = JSON.parse(text) as Record<string, any>;
    }
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      headers: response.headers,
      text,
      bytes,
      data,
    };
  };
  return { harness, app, users, ids, call };
}

let cnicCounter = 1;

async function createClient(w: World, assignedManager: Actor | null = null) {
  const cnic = `35202-${String(2_000_000 + cnicCounter++).padStart(7, '0')}-1`;
  const result = await w.call('/api/v1/clients', {
    as: 'manager',
    method: 'POST',
    body: {
      type: 'individual',
      legalName: `Synthetic Client ${String(cnicCounter)}`,
      cnic,
      contacts: [],
      assignedManagerUserId: assignedManager === null ? null : w.ids[assignedManager],
    },
  });
  expect(result.status).toBe(201);
  return result.data;
}

async function openCase(w: World, client: Record<string, any>) {
  const template = await w.call('/api/v1/workflow-templates', {
    as: 'manager',
    method: 'POST',
    body: { name: `Annual return ${String(++counter)}`, definition: STARTER_WORKFLOW_DEFINITION },
  });
  expect(template.status).toBe(201);
  const versionId = template.data['draft'].id as string;
  const published = await w.call(
    `/api/v1/workflow-templates/${template.data['id'] as string}/versions/${versionId}/publish`,
    { as: 'manager', method: 'POST', ifMatch: 1 },
  );
  expect(published.status).toBe(200);
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
  expect(service.status).toBe(201);
  const created = await w.call('/api/v1/cases', {
    as: 'manager',
    method: 'POST',
    body: {
      clientId: client['id'],
      serviceTypeId: service.data['id'],
      taxYear: 2026,
      workflowVersionId: versionId,
      dueDate: '2026-09-30',
      primaryConsultantUserId: w.ids.consultant,
      reviewerUserId: w.ids.consultant2,
    },
  });
  expect(created.status).toBe(201);
  return created.data;
}

function bytesOf(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  const prefix = Math.min(size, 251);
  for (let index = 0; index < prefix; index += 1) {
    bytes[index] = (index * 31 + seed) % 251;
  }
  // Repeat the 251-byte pattern by doubling copies (fast for multi-MiB files).
  for (let filled = prefix; filled < size; filled *= 2) {
    bytes.copyWithin(filled, 0, Math.min(filled, size - filled));
  }
  return bytes;
}

interface UploadInput {
  clientId: string;
  caseId?: string | null;
  checklistItemId?: string | null;
  fileName?: string;
  contentType?: string;
  documentType?: string;
  size?: number;
}

function uploadBody(input: UploadInput) {
  return {
    clientId: input.clientId,
    caseId: input.caseId ?? null,
    checklistItemId: input.checklistItemId ?? null,
    documentType: input.documentType ?? 'Bank statement',
    fileName: input.fileName ?? 'statement.pdf',
    contentType: input.contentType ?? 'application/pdf',
    sizeBytes: input.size ?? 1000,
  };
}

/** Uploads a whole file in 5 MiB chunks and completes it. */
async function upload(w: World, input: UploadInput, as: Actor = 'consultant') {
  const size = input.size ?? 1000;
  const content = bytesOf(size);
  const started = await w.call('/api/v1/documents/uploads', {
    as,
    method: 'POST',
    body: uploadBody({ ...input, size }),
  });
  expect(started.status).toBe(201);
  const uploadId = started.data['id'] as string;
  for (let offset = 0; offset < size; offset += CHUNK) {
    const chunk = await w.call(
      `/api/v1/documents/uploads/${uploadId}/content?offset=${String(offset)}`,
      {
        as,
        method: 'PUT',
        raw: content.slice(offset, Math.min(offset + CHUNK, size)),
      },
    );
    expect(chunk.status).toBe(200);
  }
  const completed = await w.call(`/api/v1/documents/uploads/${uploadId}/complete`, {
    as,
    method: 'POST',
  });
  expect(completed.status).toBe(201);
  return { document: completed.data, content, uploadId };
}

function itemWithDocument(taxCase: Record<string, any>) {
  return (
    (taxCase['checklist'] as Record<string, any>[]).find(
      (item) =>
        item['required'] && item['documentType'] !== null && item['reviewRequired'] === false,
    ) ??
    (taxCase['checklist'] as Record<string, any>[]).find(
      (item) => item['required'] && item['documentType'] !== null,
    )!
  );
}

function noSecrets(w: World, value: string) {
  // Upload-session handles, provider tokens, and the fake storage host never leak.
  expect(value).not.toMatch(/fake-storage\.test|access-\d|refresh-\d|session-\d/u);
  for (const event of w.harness.state.auditEvents) {
    expect(JSON.stringify(event)).not.toMatch(/fake-storage\.test|access-\d|refresh-\d/u);
  }
}

describe('resumable upload (TD-406)', () => {
  it('uploads in 5 MiB chunks with a short final chunk and completes idempotently', async () => {
    const w = await world();
    const client = await createClient(w);
    const taxCase = await openCase(w, client);
    const size = 2 * CHUNK + 1234;
    const content = bytesOf(size, 7);
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], caseId: taxCase['id'], size }),
    });
    expect(started.status).toBe(201);
    expect(started.data).toMatchObject({ nextOffset: 0, chunkBytes: CHUNK, state: 'active' });
    noSecrets(w, started.text);
    const uploadId = started.data['id'] as string;
    const base = `/api/v1/documents/uploads/${uploadId}`;

    const first = await w.call(`${base}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(0, CHUNK),
    });
    expect(first.data).toEqual({ nextOffset: CHUNK, complete: false });

    // Completing early is refused.
    const early = await w.call(`${base}/complete`, { as: 'consultant', method: 'POST' });
    expect(early.status).toBe(409);
    expect(early.data['code']).toBe('UPLOAD_INCOMPLETE');

    const second = await w.call(`${base}/content?offset=${String(CHUNK)}`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(CHUNK, 2 * CHUNK),
    });
    expect(second.data).toEqual({ nextOffset: 2 * CHUNK, complete: false });
    const last = await w.call(`${base}/content?offset=${String(2 * CHUNK)}`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(2 * CHUNK),
    });
    expect(last.data).toEqual({ nextOffset: size, complete: true });

    const completed = await w.call(`${base}/complete`, { as: 'consultant', method: 'POST' });
    expect(completed.status).toBe(201);
    expect(completed.data).toMatchObject({
      clientId: client['id'],
      caseId: taxCase['id'],
      caseCode: taxCase['caseCode'],
      sizeBytes: size,
      verificationState: 'pending',
      providerState: 'present',
      uploadedByName: 'Staff consultant',
    });
    expect(completed.etag).toBe('"1"');
    noSecrets(w, completed.text);

    const again = await w.call(`${base}/complete`, { as: 'consultant', method: 'POST' });
    expect(again.status).toBe(200);
    expect(again.data['id']).toBe(completed.data['id']);
    expect(w.harness.state.documents.size).toBe(1);
    expect(
      w.harness.state.auditEvents.filter((event) => event.action === 'document.uploaded'),
    ).toHaveLength(1);
    const uploaded = w.harness.state.auditEvents.find((e) => e.action === 'document.uploaded')!;
    expect(uploaded.metadata).toMatchObject({ caseCode: taxCase['caseCode'], sizeBytes: size });
    expect(JSON.stringify(uploaded.metadata)).not.toContain('statement.pdf');

    // Stored bytes match; the record keeps the external item ID, not a path.
    const record = w.harness.state.documents.get(completed.data['id'] as string)!;
    expect(w.harness.storage.contentOf(record.externalItemId)).toEqual(content);
    expect(Object.keys(record)).not.toContain('path');
  });

  it('stores objects under the stable client-code/year/case/document layout', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const { document } = await upload(w, { clientId: client['id'], caseId: taxCase['id'] });
    const clientLevel = await upload(w, {
      clientId: client['id'],
      fileName: 'cnic.png',
      contentType: 'image/png',
    });
    const paths = [...w.harness.storage.items.values()].map((entry) => entry.path).sort();
    expect(paths).toEqual(
      [
        `clients/${client['clientCode'] as string}/2026/${taxCase['id'] as string}/${document['id'] as string}/statement.pdf`,
        `clients/${client['clientCode'] as string}/general/client-documents/${clientLevel.document['id'] as string}/cnic.png`,
      ].sort(),
    );
  });

  it('is idempotent on the request ID when starting an upload', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const body = uploadBody({ clientId: client['id'] });
    const a = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body,
      requestId: 'same-upload',
    });
    const b = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body,
      requestId: 'same-upload',
    });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.data['id']).toBe(a.data['id']);
    expect(w.harness.storage.calls['createUploadSession']).toBe(1);
  });

  it('refuses a reused request ID with a different body', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const first = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'] }),
      requestId: 'reused-upload',
    });
    expect(first.status).toBe(201);
    for (const change of [
      { fileName: 'other.pdf' },
      { sizeBytes: 999 },
      { documentType: 'CNIC copy' },
    ]) {
      const second = await w.call('/api/v1/documents/uploads', {
        as: 'consultant',
        method: 'POST',
        body: { ...uploadBody({ clientId: client['id'] }), ...change },
        requestId: 'reused-upload',
      });
      expect(second.status, JSON.stringify(change)).toBe(409);
      expect(second.data['code']).toBe('CONFLICT');
    }
    expect(w.harness.storage.calls['createUploadSession']).toBe(1);
  });

  it('rechecks authorization and case state on every chunk, status check, and completion', async () => {
    const w = await world();
    const client = await createClient(w);
    const taxCase = await openCase(w, client);
    const start = async () => {
      const started = await w.call('/api/v1/documents/uploads', {
        as: 'consultant',
        method: 'POST',
        body: uploadBody({ clientId: client['id'], caseId: taxCase['id'], size: 50 }),
      });
      expect(started.status).toBe(201);
      return `/api/v1/documents/uploads/${started.data['id'] as string}`;
    };
    const beforeChunk = await start();
    const beforeComplete = await start();
    await w.call(`${beforeComplete}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: bytesOf(50),
    });

    // The consultant is taken off the case mid-upload.
    const latest = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    const reassigned = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      body: {
        dueDate: latest.data['dueDate'],
        notes: '',
        primaryConsultantUserId: w.ids.consultant3,
        reviewerUserId: w.ids.consultant2,
      },
      ifMatch: latest.data['version'] as number,
    });
    expect(reassigned.status).toBe(200);

    const chunk = await w.call(`${beforeChunk}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: bytesOf(50),
    });
    expect(chunk.status).toBe(403);
    expect((await w.call(beforeChunk, { as: 'consultant' })).status).toBe(403);
    const complete = await w.call(`${beforeComplete}/complete`, {
      as: 'consultant',
      method: 'POST',
    });
    expect(complete.status).toBe(403);
    expect(w.harness.state.documents.size).toBe(0);
  });

  it('refuses to finish an upload once the case is closed or archived', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'manager',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], caseId: taxCase['id'], size: 50 }),
    });
    const base = `/api/v1/documents/uploads/${started.data['id'] as string}`;
    await w.call(`${base}/content?offset=0`, { as: 'manager', method: 'PUT', raw: bytesOf(50) });
    const latest = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    const moved = await w.call(`/api/v1/cases/${taxCase['id'] as string}/transitions`, {
      as: 'manager',
      method: 'POST',
      body: { toStatus: 'cancelled', note: 'Client withdrew' },
      ifMatch: latest.data['version'] as number,
    });
    expect(moved.status).toBe(200);
    const closed = await w.call(`${base}/complete`, { as: 'manager', method: 'POST' });
    expect(closed.status).toBe(409);
    expect(closed.data['code']).toBe('CASE_CLOSED');

    const archived = await w.call(`/api/v1/cases/${taxCase['id'] as string}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: moved.data['version'] as number,
    });
    expect(archived.status).toBe(200);
    const afterArchive = await w.call(`${base}/complete`, { as: 'manager', method: 'POST' });
    expect(afterArchive.status).toBe(409);
    expect(afterArchive.data['code']).toBe('CASE_ARCHIVED');
    expect(w.harness.state.documents.size).toBe(0);
  });

  it('returns the existing document for a repeated completion after the case closes', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'manager',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], caseId: taxCase['id'], size: 50 }),
    });
    const base = `/api/v1/documents/uploads/${started.data['id'] as string}`;
    await w.call(`${base}/content?offset=0`, { as: 'manager', method: 'PUT', raw: bytesOf(50) });
    const first = await w.call(`${base}/complete`, { as: 'manager', method: 'POST' });
    expect(first.status).toBe(201);
    const latest = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    const moved = await w.call(`/api/v1/cases/${taxCase['id'] as string}/transitions`, {
      as: 'manager',
      method: 'POST',
      body: { toStatus: 'cancelled', note: 'Client withdrew' },
      ifMatch: latest.data['version'] as number,
    });
    expect(moved.status).toBe(200);
    const repeat = await w.call(`${base}/complete`, { as: 'manager', method: 'POST' });
    expect(repeat.status).toBe(200);
    expect(repeat.data['id']).toBe(first.data['id']);
    expect(w.harness.state.documents.size).toBe(1);
  });

  it('rejects disallowed, unsafe, oversized, and mismatched files before any provider call', async () => {
    const w = await world({ maxUploadBytes: 3 * CHUNK });
    const client = await createClient(w, 'consultant');
    const cases: [Record<string, unknown>, string][] = [
      [{ fileName: 'tool.exe', contentType: 'application/pdf' }, 'VALIDATION_FAILED'],
      [{ fileName: 'macro.docm', contentType: 'application/pdf' }, 'VALIDATION_FAILED'],
      [{ fileName: '../etc/passwd.pdf' }, 'VALIDATION_FAILED'],
      [{ fileName: 'con.pdf' }, 'VALIDATION_FAILED'],
      [{ fileName: 'a:b.pdf' }, 'VALIDATION_FAILED'],
      [{ fileName: 'photo.png', contentType: 'application/pdf' }, 'VALIDATION_FAILED'],
      [{ contentType: 'application/zip' }, 'VALIDATION_FAILED'],
      [{ sizeBytes: 0 }, 'VALIDATION_FAILED'],
      [{ sizeBytes: 3 * CHUNK + 1 }, 'DOCUMENT_TOO_LARGE'],
    ];
    for (const [override, code] of cases) {
      const result = await w.call('/api/v1/documents/uploads', {
        as: 'consultant',
        method: 'POST',
        body: { ...uploadBody({ clientId: client['id'] }), ...override },
      });
      expect(result.status, JSON.stringify(override)).toBe(400);
      expect(result.data['code']).toBe(code);
    }
    expect(w.harness.storage.calls['createUploadSession']).toBeUndefined();
  });

  it('defaults to a 250 MiB limit', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const result = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], size: 250 * 1024 * 1024 + 1 }),
    });
    expect(result.data['code']).toBe('DOCUMENT_TOO_LARGE');
    const list = await w.call(`/api/v1/documents?clientId=${client['id'] as string}`, {
      as: 'consultant',
    });
    expect(list.data['maxUploadBytes']).toBe(250 * 1024 * 1024);
  });

  it('refuses wrong offsets and odd chunk sizes, and resumes after an interruption', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const size = CHUNK + 10;
    const content = bytesOf(size);
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], size }),
    });
    const base = `/api/v1/documents/uploads/${started.data['id'] as string}`;

    const wrongOffset = await w.call(`${base}/content?offset=${String(CHUNK)}`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(CHUNK),
    });
    expect(wrongOffset.status).toBe(409);
    expect(wrongOffset.data['code']).toBe('UPLOAD_OFFSET_MISMATCH');

    const shortMiddle = await w.call(`${base}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(0, 1000),
    });
    expect(shortMiddle.status).toBe(400);

    // The provider drops out mid-chunk: the chunk fails safely and visibly.
    w.harness.storage.failNext('unavailable');
    const interrupted = await w.call(`${base}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(0, CHUNK),
    });
    expect(interrupted.status).toBe(503);
    expect(interrupted.data['code']).toBe('STORAGE_UNAVAILABLE');

    // The client checks progress and resumes from the provider's offset.
    const status = await w.call(base, { as: 'consultant' });
    expect(status.data).toMatchObject({ nextOffset: 0, state: 'active' });
    const resumed = await w.call(`${base}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(0, CHUNK),
    });
    expect(resumed.status).toBe(200);
    const progress = await w.call(base, { as: 'consultant' });
    expect(progress.data['nextOffset']).toBe(CHUNK);
    const final = await w.call(`${base}/content?offset=${String(CHUNK)}`, {
      as: 'consultant',
      method: 'PUT',
      raw: content.slice(CHUNK),
    });
    expect(final.data).toEqual({ nextOffset: size, complete: true });
    const completed = await w.call(`${base}/complete`, { as: 'consultant', method: 'POST' });
    expect(completed.status).toBe(201);
  });

  it('rejects completion when the provider cannot confirm the object', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], size: 50 }),
    });
    const base = `/api/v1/documents/uploads/${started.data['id'] as string}`;
    await w.call(`${base}/content?offset=0`, { as: 'consultant', method: 'PUT', raw: bytesOf(50) });
    for (const id of [...w.harness.storage.items.keys()]) {
      w.harness.storage.removeExternally(id);
    }
    const completed = await w.call(`${base}/complete`, { as: 'consultant', method: 'POST' });
    expect(completed.status).toBe(409);
    expect(completed.data['code']).toBe('UPLOAD_VERIFICATION_FAILED');
    expect(w.harness.state.documents.size).toBe(0);
    const status = await w.call(base, { as: 'consultant' });
    expect(status.data['state']).toBe('failed');
  });

  it('cancels an upload and its provider session', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const started = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], size: CHUNK + 1 }),
    });
    const base = `/api/v1/documents/uploads/${started.data['id'] as string}`;
    expect((await w.call(base, { as: 'consultant', method: 'DELETE' })).status).toBe(204);
    expect(w.harness.storage.calls['cancelUploadSession']).toBe(1);
    const chunk = await w.call(`${base}/content?offset=0`, {
      as: 'consultant',
      method: 'PUT',
      raw: bytesOf(CHUNK),
    });
    expect(chunk.data['code']).toBe('UPLOAD_NOT_ACTIVE');
    expect(w.harness.state.auditEvents.some((e) => e.action === 'document.upload_cancelled')).toBe(
      true,
    );
  });

  it('stops safely when storage is not connected or consent was revoked', async () => {
    const disconnected = await world({ connected: false });
    const client = await createClient(disconnected, 'consultant');
    const notConnected = await disconnected.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: client['id'] }),
    });
    expect(notConnected.status).toBe(503);
    expect(notConnected.data['code']).toBe('STORAGE_NOT_CONNECTED');
    expect(disconnected.harness.storage.calls['createUploadSession']).toBeUndefined();
    const list = await disconnected.call(`/api/v1/documents?clientId=${client['id'] as string}`, {
      as: 'consultant',
    });
    expect(list.data['storageAvailable']).toBe(false);

    const w = await world();
    const revokedClient = await createClient(w, 'consultant');
    w.harness.storage.revokeConsent();
    const revoked = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: revokedClient['id'] }),
    });
    expect(revoked.status).toBe(503);
    expect(revoked.data['code']).toBe('STORAGE_RECONNECT_REQUIRED');
    expect(w.harness.state.documentUploads.size).toBe(0);
    // Every later operation stops before reaching the provider.
    const calls = w.harness.storage.calls['createUploadSession'] ?? 0;
    const again = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({ clientId: revokedClient['id'] }),
    });
    expect(again.data['code']).toBe('STORAGE_RECONNECT_REQUIRED');
    expect(w.harness.storage.calls['createUploadSession'] ?? 0).toBe(calls);
    noSecrets(w, revoked.text + again.text);
  });
});

describe('protected document access (TD-407)', () => {
  it('streams content with safe headers and an audit event without content', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const { document, content } = await upload(w, {
      clientId: client['id'],
      caseId: taxCase['id'],
      fileName: 'Bank statement — June.pdf',
      size: 4000,
    });
    const opened = await w.call(`/api/v1/documents/${document['id'] as string}/content`, {
      as: 'read_only',
    });
    expect(opened.status).toBe(200);
    expect(opened.bytes).toEqual(content);
    expect(opened.headers.get('Content-Type')).toBe('application/pdf');
    expect(opened.headers.get('Content-Disposition')).toBe(
      `attachment; filename="Bank statement _ June.pdf"; filename*=UTF-8''${encodeURIComponent('Bank statement — June.pdf')}`,
    );
    expect(opened.headers.get('Cache-Control')).toBe('private, no-store');
    expect(opened.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const audit = w.harness.state.auditEvents.filter((e) => e.action === 'document.opened');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: w.ids.read_only, entityId: document['id'] });
    expect(JSON.stringify(audit[0])).not.toContain(new TextDecoder().decode(content.slice(0, 20)));
  });

  it('applies the role and assignment matrix to read, upload, review, delete, and restore', async () => {
    const w = await world();
    const client = await createClient(w); // no assigned manager
    const taxCase = await openCase(w, client); // consultant preparer, consultant2 reviewer
    const { document } = await upload(w, { clientId: client['id'], caseId: taxCase['id'] });
    const id = document['id'] as string;
    const read = async (as: Actor) => (await w.call(`/api/v1/documents/${id}`, { as })).status;

    expect(await read('administrator')).toBe(200);
    expect(await read('manager')).toBe(200);
    expect(await read('consultant')).toBe(200);
    expect(await read('consultant2')).toBe(200);
    expect(await read('read_only')).toBe(200);
    expect(await read('consultant3')).toBe(403); // not assigned
    expect(await read('billing')).toBe(403); // no documents.read
    expect((await w.call(`/api/v1/documents/${id}/content`, { as: 'consultant3' })).status).toBe(
      403,
    );

    const caseList = async (as: Actor) =>
      await w.call(`/api/v1/documents?caseId=${taxCase['id'] as string}`, { as });
    expect((await caseList('consultant3')).status).toBe(403);
    expect((await caseList('consultant')).data['documents']).toHaveLength(1);
    expect((await caseList('consultant')).data['permissions'].upload).toBe(true);
    expect((await caseList('read_only')).data['permissions'].upload).toBe(false);
    // An unassigned consultant listing by client sees nothing of other people's cases.
    const clientList = await w.call(`/api/v1/documents?clientId=${client['id'] as string}`, {
      as: 'consultant3',
    });
    expect(clientList.status).toBe(403);

    const startAs = async (as: Actor) =>
      (
        await w.call('/api/v1/documents/uploads', {
          as,
          method: 'POST',
          body: uploadBody({ clientId: client['id'], caseId: taxCase['id'] }),
        })
      ).status;
    expect(await startAs('read_only')).toBe(403);
    expect(await startAs('consultant3')).toBe(403);
    expect(await startAs('billing')).toBe(403);
    expect(await startAs('consultant2')).toBe(201); // reviewer can work the case

    const review = async (as: Actor, version: number) =>
      await w.call(`/api/v1/documents/${id}/review`, {
        as,
        method: 'POST',
        body: { decision: 'verified' },
        ifMatch: version,
      });
    expect((await review('read_only', 1)).status).toBe(403);
    expect((await review('consultant', 1)).status).toBe(403); // preparer, not reviewer
    expect((await review('consultant3', 1)).status).toBe(403);
    const verified = await review('consultant2', 1);
    expect(verified.status).toBe(200);
    expect(verified.data).toMatchObject({
      verificationState: 'verified',
      verifiedByName: 'Staff consultant2',
    });

    expect(
      (await w.call(`/api/v1/documents/${id}`, { as: 'read_only', method: 'DELETE', ifMatch: 2 }))
        .status,
    ).toBe(403);
    const deleted = await w.call(`/api/v1/documents/${id}`, {
      as: 'consultant',
      method: 'DELETE',
      ifMatch: 2,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.data['permissions']).toMatchObject({ restore: false, open: false });
    expect(
      (
        await w.call(`/api/v1/documents/${id}/restore`, {
          as: 'consultant',
          method: 'POST',
          ifMatch: 3,
        })
      ).status,
    ).toBe(403);
    const restored = await w.call(`/api/v1/documents/${id}/restore`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 3,
    });
    expect(restored.status).toBe(200);
  });

  it('lets a client manager work client-level documents', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant3');
    const { document } = await upload(
      w,
      { clientId: client['id'], fileName: 'ntn.jpg', contentType: 'image/jpeg' },
      'consultant3',
    );
    expect(
      (await w.call(`/api/v1/documents/${document['id'] as string}`, { as: 'consultant' })).status,
    ).toBe(403);
    const list = await w.call(`/api/v1/documents?clientId=${client['id'] as string}`, {
      as: 'consultant3',
    });
    expect(list.data['documents']).toHaveLength(1);
    // Client-level review needs clients.manage.
    const review = await w.call(`/api/v1/documents/${document['id'] as string}/review`, {
      as: 'consultant3',
      method: 'POST',
      body: { decision: 'verified' },
      ifMatch: 1,
    });
    expect(review.status).toBe(403);
  });

  it('rechecks deactivation on every access request', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const { document } = await upload(w, { clientId: client['id'] });
    const path = `/api/v1/documents/${document['id'] as string}/content`;
    expect((await w.call(path, { as: 'consultant' })).status).toBe(200);
    const user = (await w.harness.repositories.users.findById(w.ids.consultant))!;
    await w.harness.repositories.users.updateStatus({
      userId: user.id,
      status: 'deactivated',
      expectedVersion: user.version,
      at: w.harness.now().toISOString(),
    });
    expect((await w.call(path, { as: 'consultant' })).status).toBe(401);
    expect(w.harness.state.auditEvents.filter((e) => e.action === 'document.opened')).toHaveLength(
      1,
    );
  });

  it('marks a document missing when its provider object is gone', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const { document } = await upload(w, { clientId: client['id'] });
    const record = w.harness.state.documents.get(document['id'] as string)!;
    w.harness.storage.removeExternally(record.externalItemId);
    const opened = await w.call(`/api/v1/documents/${document['id'] as string}/content`, {
      as: 'consultant',
    });
    expect(opened.status).toBe(409);
    expect(opened.data['code']).toBe('DOCUMENT_MISSING_IN_STORAGE');
    const found = await w.call(`/api/v1/documents/${document['id'] as string}`, {
      as: 'consultant',
    });
    expect(found.data).toMatchObject({
      providerState: 'missing',
      verificationState: 'missing_provider',
    });
  });

  it('answers 404 or 403 for unknown documents without revealing existence', async () => {
    const w = await world();
    const missing = '01900000-0000-7000-8000-000000000000';
    expect((await w.call(`/api/v1/documents/${missing}`, { as: 'manager' })).status).toBe(404);
    expect((await w.call(`/api/v1/documents/${missing}`, { as: 'consultant' })).status).toBe(403);
  });
});

describe('metadata, review, and checklist links (TD-408)', () => {
  it('links documents to checklist items and gates completion on a verified link', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const item = itemWithDocument(taxCase);
    const complete = async (version: number) =>
      await w.call(
        `/api/v1/cases/${taxCase['id'] as string}/checklist/${item['id'] as string}/complete`,
        { as: 'consultant', method: 'POST', body: {}, ifMatch: version },
      );

    const blocked = await complete(1);
    expect(blocked.status).toBe(409);
    expect(blocked.data['code']).toBe('CHECKLIST_DOCUMENT_REQUIRED');

    const { document } = await upload(w, {
      clientId: client['id'],
      caseId: taxCase['id'],
      checklistItemId: item['id'],
      documentType: item['documentType'],
    });
    expect(document['checklistItemLabel']).toBe(item['label']);
    expect((await complete(1)).data['code']).toBe('CHECKLIST_DOCUMENT_REQUIRED'); // pending

    const verified = await w.call(`/api/v1/documents/${document['id'] as string}/review`, {
      as: 'consultant2',
      method: 'POST',
      body: { decision: 'verified' },
      ifMatch: 1,
    });
    expect(verified.status).toBe(200);
    const done = await complete(1);
    expect(done.status).toBe(200);
    const doneItem = (done.data['checklist'] as Record<string, any>[]).find(
      (entry) => entry['id'] === item['id'],
    )!;
    expect(doneItem['state']).toBe('completed');

    // Rejecting the only verified document reopens the item.
    const rejected = await w.call(`/api/v1/documents/${document['id'] as string}/review`, {
      as: 'consultant2',
      method: 'POST',
      body: { decision: 'rejected', note: 'Illegible scan' },
      ifMatch: 2,
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data).toMatchObject({
      verificationState: 'rejected',
      verificationNote: 'Illegible scan',
    });
    const afterReject = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, {
      as: 'consultant',
    });
    const reopened = (afterReject.data['checklist'] as Record<string, any>[]).find(
      (entry) => entry['id'] === item['id'],
    )!;
    expect(reopened['state']).toBe('open');
    expect(
      w.harness.state.auditEvents.some(
        (e) => e.action === 'case.checklist_reopened' && e.metadata['reason'] === 'document',
      ),
    ).toBe(true);

    // Rejection needs a note.
    const noNote = await w.call(`/api/v1/documents/${document['id'] as string}/review`, {
      as: 'consultant2',
      method: 'POST',
      body: { decision: 'rejected' },
      ifMatch: 3,
    });
    expect(noNote.status).toBe(400);
  });

  it('reopens the item when its verified document is deleted', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const item = itemWithDocument(taxCase);
    const { document } = await upload(w, {
      clientId: client['id'],
      caseId: taxCase['id'],
      checklistItemId: item['id'],
      documentType: item['documentType'],
    });
    await w.call(`/api/v1/documents/${document['id'] as string}/review`, {
      as: 'manager',
      method: 'POST',
      body: { decision: 'verified' },
      ifMatch: 1,
    });
    const done = await w.call(
      `/api/v1/cases/${taxCase['id'] as string}/checklist/${item['id'] as string}/complete`,
      { as: 'consultant', method: 'POST', body: {}, ifMatch: 1 },
    );
    expect(done.status).toBe(200);
    await w.call(`/api/v1/documents/${document['id'] as string}`, {
      as: 'consultant',
      method: 'DELETE',
      ifMatch: 2,
    });
    const after = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'consultant' });
    expect(
      (after.data['checklist'] as Record<string, any>[]).find((e) => e['id'] === item['id'])![
        'state'
      ],
    ).toBe('open');
  });

  it('edits type and link with If-Match and validates the link', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const other = await openCase(w, client);
    const { document } = await upload(w, { clientId: client['id'], caseId: taxCase['id'] });
    const path = `/api/v1/documents/${document['id'] as string}`;
    expect(
      (await w.call(path, { as: 'consultant', method: 'PATCH', body: { documentType: 'X' } }))
        .status,
    ).toBe(428);
    const item = itemWithDocument(taxCase);
    // The item names a document type: a different type cannot satisfy it.
    const mismatched = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: { checklistItemId: item['id'] },
      ifMatch: 1,
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.data['code']).toBe('DOCUMENT_LINK_INVALID');
    const linked = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: {
        documentType: ` ${(item['documentType'] as string).toUpperCase()} `,
        checklistItemId: item['id'],
      },
      ifMatch: 1,
    });
    expect(linked.status).toBe(200);
    expect(linked.data).toMatchObject({ checklistItemId: item['id'] });
    const stale = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: { documentType: 'Y' },
      ifMatch: 1,
    });
    expect(stale.status).toBe(412);
    // Changing the type away from the linked item's type is refused too.
    const retyped = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: { documentType: 'Something else' },
      ifMatch: 2,
    });
    expect(retyped.data['code']).toBe('DOCUMENT_LINK_INVALID');
    const foreign = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: { checklistItemId: itemWithDocument(other)['id'] },
      ifMatch: 2,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.data['code']).toBe('DOCUMENT_LINK_INVALID');
    const audit = w.harness.state.auditEvents.find((e) => e.action === 'document.updated')!;
    expect(audit.metadata['fields']).toBe('documentType,checklistItemId');
  });

  it('requires an upload linked to a checklist item to carry its document type', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const item = itemWithDocument(taxCase);
    const wrong = await w.call('/api/v1/documents/uploads', {
      as: 'consultant',
      method: 'POST',
      body: uploadBody({
        clientId: client['id'],
        caseId: taxCase['id'],
        checklistItemId: item['id'],
        documentType: 'Utility bill',
      }),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.data['code']).toBe('DOCUMENT_LINK_INVALID');
    expect(w.harness.storage.calls['createUploadSession']).toBeUndefined();
  });

  it("refuses links to another client's case", async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const otherClient = await createClient(w, 'consultant');
    const taxCase = await openCase(w, otherClient);
    const result = await w.call('/api/v1/documents/uploads', {
      as: 'manager',
      method: 'POST',
      body: uploadBody({ clientId: client['id'], caseId: taxCase['id'] }),
    });
    expect(result.status).toBe(400);
    expect(result.data['code']).toBe('DOCUMENT_LINK_INVALID');
  });
});

describe('soft delete and restore (TD-409)', () => {
  it('refuses a stale delete before touching the provider', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const { document } = await upload(w, { clientId: client['id'] });
    const stale = await w.call(`/api/v1/documents/${document['id'] as string}`, {
      as: 'manager',
      method: 'DELETE',
      ifMatch: 7,
    });
    expect(stale.status).toBe(412);
    expect(w.harness.storage.calls['trash']).toBeUndefined();
    expect(w.harness.state.documents.get(document['id'] as string)!.deletedAt).toBeNull();
  });

  it('keeps the record live when the provider cannot trash the file', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const { document } = await upload(w, { clientId: client['id'] });
    w.harness.storage.failNext('unavailable');
    const failed = await w.call(`/api/v1/documents/${document['id'] as string}`, {
      as: 'manager',
      method: 'DELETE',
      ifMatch: 1,
    });
    expect(failed.status).toBe(503);
    expect(w.harness.state.documents.get(document['id'] as string)).toMatchObject({
      deletedAt: null,
      version: 1,
    });
    expect(w.harness.state.auditEvents.some((e) => e.action === 'document.deleted')).toBe(false);
  });

  it('blocks review, edits, and delete on closed cases but still opens documents', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const taxCase = await openCase(w, client);
    const { document } = await upload(w, { clientId: client['id'], caseId: taxCase['id'] });
    const latest = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    const moved = await w.call(`/api/v1/cases/${taxCase['id'] as string}/transitions`, {
      as: 'manager',
      method: 'POST',
      body: { toStatus: 'cancelled', note: 'Client withdrew' },
      ifMatch: latest.data['version'] as number,
    });
    expect(moved.status).toBe(200);
    const path = `/api/v1/documents/${document['id'] as string}`;
    const review = await w.call(`${path}/review`, {
      as: 'manager',
      method: 'POST',
      body: { decision: 'verified' },
      ifMatch: 1,
    });
    const edit = await w.call(path, {
      as: 'manager',
      method: 'PATCH',
      body: { documentType: 'Other' },
      ifMatch: 1,
    });
    const remove = await w.call(path, { as: 'manager', method: 'DELETE', ifMatch: 1 });
    for (const result of [review, edit, remove]) {
      expect(result.status).toBe(409);
      expect(result.data['code']).toBe('CASE_CLOSED');
    }
    const found = await w.call(path, { as: 'manager' });
    expect(found.data['permissions']).toMatchObject({ edit: false, review: false, delete: false });
    expect((await w.call(`${path}/content`, { as: 'manager' })).status).toBe(200);
  });

  it('trashes the provider object, hides it by default, and restores while recoverable', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const { document } = await upload(w, { clientId: client['id'] });
    const second = await upload(w, {
      clientId: client['id'],
      fileName: 'second.csv',
      contentType: 'text/csv',
    });
    const id = document['id'] as string;
    const record = w.harness.state.documents.get(id)!;

    const deleted = await w.call(`/api/v1/documents/${id}`, {
      as: 'manager',
      method: 'DELETE',
      ifMatch: 1,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.data['deletedByName']).toBe('Staff manager');
    expect(w.harness.storage.calls['trash']).toBe(1);
    expect(w.harness.state.documents.has(id)).toBe(true); // never hard-deleted

    const listed = async (state?: string) =>
      (
        (
          await w.call(
            `/api/v1/documents?clientId=${client['id'] as string}${state === undefined ? '' : `&state=${state}`}`,
            { as: 'manager' },
          )
        ).data['documents'] as Record<string, any>[]
      ).map((d) => d['id'] as string);
    expect(await listed()).toEqual([second.document['id']]);
    expect(await listed('deleted')).toEqual([id]);
    expect((await listed('all')).sort()).toEqual([id, second.document['id']].sort());
    expect((await w.call(`/api/v1/documents/${id}/content`, { as: 'manager' })).data['code']).toBe(
      'DOCUMENT_DELETED',
    );

    const restored = await w.call(`/api/v1/documents/${id}/restore`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 2,
    });
    expect(restored.status).toBe(200);
    expect(restored.data['deletedAt']).toBeNull();
    expect((await w.call(`/api/v1/documents/${id}/content`, { as: 'manager' })).status).toBe(200);

    // Delete again, empty the provider trash: no longer recoverable.
    await w.call(`/api/v1/documents/${id}`, { as: 'manager', method: 'DELETE', ifMatch: 3 });
    w.harness.storage.purgeTrash();
    const unrecoverable = await w.call(`/api/v1/documents/${id}/restore`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 4,
    });
    expect(unrecoverable.status).toBe(409);
    expect(unrecoverable.data['code']).toBe('DOCUMENT_NOT_RECOVERABLE');
    expect(w.harness.state.documents.get(id)!.deletedAt).not.toBeNull();
    expect(record.externalItemId).toBe(w.harness.state.documents.get(id)!.externalItemId);
    const actions = w.harness.state.auditEvents
      .filter((e) => e.entityId === id)
      .map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['document.deleted', 'document.restored', 'document.deleted']),
    );
  });
});

describe('provider reconciliation (TD-410)', () => {
  it('reports missing, moved, and recovered documents without deleting history', async () => {
    const w = await world();
    const client = await createClient(w, 'consultant');
    const a = await upload(w, { clientId: client['id'], fileName: 'a.pdf' });
    const b = await upload(w, { clientId: client['id'], fileName: 'b.pdf' });
    const c = await upload(w, { clientId: client['id'], fileName: 'c.pdf' });
    const recordOf = (doc: Record<string, any>) =>
      w.harness.state.documents.get(doc['id'] as string)!;

    // Take b's bytes aside so it can "come back" later.
    w.harness.storage.moveExternally(recordOf(c.document).externalItemId, 'folder:elsewhere');
    const bItem = w.harness.storage.items.get(recordOf(b.document).externalItemId)!;
    w.harness.storage.removeExternally(recordOf(b.document).externalItemId);

    expect(
      (await w.call('/api/v1/storage/reconciliation', { as: 'manager', method: 'POST' })).status,
    ).toBe(403);
    const run = await w.call('/api/v1/storage/reconciliation', {
      as: 'administrator',
      method: 'POST',
    });
    expect(run.status).toBe(201);
    expect(run.data).toMatchObject({
      state: 'completed',
      connectionStatus: 'healthy',
      checkedCount: 3,
      presentCount: 1,
      missingCount: 1,
      movedCount: 1,
      recoveredCount: 0,
      nextAction: 'review_missing_documents',
      startedByName: 'Staff administrator',
    });
    expect(recordOf(a.document).providerState).toBe('present');
    expect(recordOf(b.document)).toMatchObject({
      providerState: 'missing',
      verificationState: 'missing_provider',
    });
    expect(recordOf(c.document).providerState).toBe('moved');
    expect(w.harness.state.documents.size).toBe(3);

    // The missing object reappears (e.g. restored in OneDrive by hand).
    (w.harness.storage.items as Map<string, unknown>).set(bItem.item.externalItemId, {
      ...bItem,
      bytes: b.content,
      trashed: false,
    });
    const second = await w.call('/api/v1/storage/reconciliation', {
      as: 'administrator',
      method: 'POST',
    });
    expect(second.data).toMatchObject({ missingCount: 0, recoveredCount: 1, nextAction: 'none' });
    expect(recordOf(b.document)).toMatchObject({
      providerState: 'present',
      verificationState: 'pending',
    });

    const runs = await w.call('/api/v1/storage/reconciliation', { as: 'administrator' });
    expect(runs.data['runs']).toHaveLength(2);
    const actions = w.harness.state.auditEvents.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'document.missing',
        'document.moved',
        'document.recovered',
        'storage.reconciliation_run',
      ]),
    );
  });

  it('records a failed run with the next action when storage is unusable', async () => {
    const w = await world({ connected: false });
    const run = await w.call('/api/v1/storage/reconciliation', {
      as: 'administrator',
      method: 'POST',
    });
    expect(run.status).toBe(201);
    expect(run.data).toMatchObject({
      state: 'failed',
      connectionStatus: 'not_connected',
      checkedCount: 0,
      nextAction: 'reconnect_storage',
    });

    const revoked = await world();
    const client = await createClient(revoked, 'consultant');
    await upload(revoked, { clientId: client['id'] });
    revoked.harness.storage.revokeConsent();
    const failed = await revoked.call('/api/v1/storage/reconciliation', {
      as: 'administrator',
      method: 'POST',
    });
    expect(failed.data).toMatchObject({
      state: 'failed',
      connectionStatus: 'reconnect_required',
      nextAction: 'reconnect_storage',
    });
    expect(revoked.harness.state.documents.size).toBe(1);
  });
});
