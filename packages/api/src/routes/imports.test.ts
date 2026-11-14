/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  IMPORT_LIMITS,
  STARTER_WORKFLOW_DEFINITION,
  importTemplate,
  type RoleKey,
} from '@taxdesk/shared';
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
  rawBody?: string;
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
  const harness = createTestHarness({ now: new Date('2026-07-15T04:00:00.000Z') });
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
      username: `imp-${role.replace('_', '-')}`,
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
      'X-Request-Id': `imp-${String(++counter)}`,
      Cookie: cookies[options.as],
    };
    let body: BodyInit | undefined;
    if (options.body !== undefined || options.rawBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = options.rawBody ?? JSON.stringify(options.body);
    }
    if (options.ifMatch !== undefined) headers['If-Match'] = `"${String(options.ifMatch)}"`;
    if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
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

const key = (): string => `import-key-${String(++counter).padStart(12, '0')}`;

function csv(
  template: 'clients.v1' | 'cases.v1' | 'opening_balances.v1',
  rows: string[][],
): string {
  const header = importTemplate(template).columns.map((column) => column.name);
  const quote = (cell: string) =>
    /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return [header, ...rows].map((cells) => cells.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** A clients.v1 row with synthetic values; `cnic` digits are never real. */
function clientRow(
  ref: string,
  name: string,
  cnicSuffix: number,
  extra: Partial<Record<'email' | 'phone' | 'type' | 'ntn' | 'notes' | 'manager', string>> = {},
): string[] {
  const type = extra.type ?? 'individual';
  return [
    ref,
    type,
    name,
    '',
    type === 'individual' ? `00000-${String(cnicSuffix).padStart(7, '0')}-1` : '',
    extra.ntn ?? '',
    extra.email === undefined && extra.phone === undefined ? '' : name,
    '',
    extra.email ?? '',
    extra.phone ?? '',
    extra.manager ?? '',
    extra.notes ?? '',
  ];
}

async function dryRun(
  w: World,
  template: 'clients.v1' | 'cases.v1' | 'opening_balances.v1',
  content: string,
  fileName = 'import.csv',
): Promise<Called> {
  return await w.call('/api/v1/imports', {
    as: 'administrator',
    method: 'POST',
    body: { template, fileName, content },
  });
}

async function commit(
  w: World,
  batch: Record<string, any>,
  content: string,
  commitKey = key(),
): Promise<Called> {
  return await w.call(`/api/v1/imports/${batch['id'] as string}/commit`, {
    as: 'administrator',
    method: 'POST',
    body: { content },
    ifMatch: batch['version'],
    key: commitKey,
  });
}

async function rows(w: World, batchId: string, query = ''): Promise<Record<string, any>[]> {
  const result = await w.call(`/api/v1/imports/${batchId}/rows${query}`, { as: 'administrator' });
  expect(result.status).toBe(200);
  return result.data['rows'];
}

async function catalog(w: World, name = 'Income tax return'): Promise<void> {
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
      name,
      description: '',
      defaultFeeMinor: 1_500_000,
      defaultDeadlineOffsetDays: 30,
      duplicateCasePolicy: 'warn',
      defaultWorkflowTemplateId: template.data['id'],
    },
  });
  expect(service.status).toBe(201);
}

describe('import templates (TD-701)', () => {
  it('lists versioned templates and downloads them with synthetic examples only', async () => {
    const w = await world();
    const list = await w.call('/api/v1/imports/templates', { as: 'administrator' });
    expect(list.status).toBe(200);
    expect(list.data['templates'].map((t: any) => t.id)).toEqual([
      'clients.v1',
      'cases.v1',
      'opening_balances.v1',
    ]);
    expect(list.data['limits']).toEqual({
      maxFileBytes: IMPORT_LIMITS.maxFileBytes,
      maxRows: IMPORT_LIMITS.maxRows,
    });
    const file = await w.call('/api/v1/imports/templates/clients.v1/csv', { as: 'administrator' });
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Type')).toContain('text/csv');
    expect(file.headers.get('Content-Disposition')).toContain('taxdesk-clients-v1.csv');
    expect(file.text.split('\r\n')[0]).toBe(
      importTemplate('clients.v1')
        .columns.map((c) => c.name)
        .join(','),
    );
    // Example identifiers are all-zero placeholders and emails use example.test.
    expect(file.text).toContain('00000-0000001-1');
    expect(file.text).not.toMatch(/@(?!example\.test)[a-z]/u);
    const missing = await w.call('/api/v1/imports/templates/payments.v1/csv', {
      as: 'administrator',
    });
    expect(missing.status).toBe(404);
  });
});

describe('import authorization (TD-705)', () => {
  it('restricts templates, dry runs, commits, and exports to administrators', async () => {
    const w = await world();
    const content = csv('clients.v1', [clientRow('A-1', 'Synthetic Alpha', 1)]);
    const created = await dryRun(w, 'clients.v1', content);
    expect(created.status).toBe(201);
    const id = created.data['id'] as string;
    for (const role of ['manager', 'consultant', 'billing', 'read_only'] as const) {
      expect((await w.call('/api/v1/imports/templates', { as: role })).status).toBe(403);
      expect((await w.call('/api/v1/imports', { as: role })).status).toBe(403);
      expect(
        (
          await w.call('/api/v1/imports', {
            as: role,
            method: 'POST',
            body: { template: 'clients.v1', fileName: 'x.csv', content: `${content} ` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await w.call(`/api/v1/imports/${id}/commit`, {
            as: role,
            method: 'POST',
            body: { content },
            ifMatch: 1,
            key: key(),
          })
        ).status,
      ).toBe(403);
      expect((await w.call(`/api/v1/imports/${id}/rows.csv`, { as: role })).status).toBe(403);
      expect((await w.call('/api/v1/imports/reconciliation', { as: role })).status).toBe(403);
    }
    expect(w.harness.state.clients.size).toBe(0);
  });
});

describe('dry run (TD-702)', () => {
  it('stores upload metadata and checksum and proposes counts without writing records', async () => {
    const w = await world();
    const content = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha', 1, { email: 'alpha@example.test' }),
      clientRow('A-2', 'Synthetic Beta', 2),
      clientRow('B-1', 'Synthetic Gamma Traders', 0, { type: 'business', ntn: '0000003-1' }),
    ]);
    const result = await dryRun(w, 'clients.v1', content, 'clients.csv');
    expect(result.status).toBe(201);
    expect(result.etag).toBe('"1"');
    expect(result.data).toMatchObject({
      template: 'clients.v1',
      kind: 'clients',
      fileName: 'clients.csv',
      rowCount: 3,
      status: 'validated',
      plan: { create: 3, update: 0, skip: 0, review: 0, error: 0 },
      canCommit: true,
    });
    expect(result.data['batchCode']).toMatch(/^IMP-\d{5}$/u);
    expect(result.data['sourceChecksum']).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.data['sizeBytes']).toBe(new TextEncoder().encode(content).length);
    expect(w.harness.state.clients.size).toBe(0);
    const audit = w.harness.state.auditEvents.find((e) => e.action === 'import.validated');
    expect(audit?.metadata).toMatchObject({ rowCount: 3, create: 3, error: 0 });
  });

  it('reports row-level errors by column and code without echoing values, and blocks commit', async () => {
    const w = await world();
    const content = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha', 1, { email: 'not-an-email' }),
      ['A-2', 'individual', 'Synthetic Beta', '', '', '', '', '', '', '', '', ''],
      clientRow('A-1', 'Synthetic Gamma', 1),
      ['A-4', 'business', 'Synthetic Delta', '', '00000-0000009-1', '', '', '', '', '', '', ''],
      ['A-5', 'robot', 'Synthetic Eps', '', '', '', '', '', '', '', '', ''],
      [
        'bad ref!',
        'individual',
        'Synthetic Zeta',
        '',
        '00000-0000011-1',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      ['A-7', 'individual'],
    ]);
    const result = await dryRun(w, 'clients.v1', content);
    expect(result.status).toBe(201);
    expect(result.data['status']).toBe('blocked');
    expect(result.data['plan'].error).toBe(7);
    expect(result.data['canCommit']).toBe(false);
    const listed = await rows(w, result.data['id'], '?action=error');
    const byRow = new Map(listed.map((row) => [row['rowNumber'], row]));
    const codes = (row: number) =>
      (byRow.get(row)?.['errors'] ?? []).map(
        (e: any) => `${e.column as string}:${e.code as string}`,
      );
    expect(codes(2)).toContain('contact_email:INVALID_FORMAT');
    expect(codes(3)).toContain('cnic:REQUIRED');
    expect(codes(4)).toEqual(
      expect.arrayContaining(['external_ref:DUPLICATE_IN_FILE', 'cnic:DUPLICATE_IN_FILE']),
    );
    expect(codes(5)).toEqual(expect.arrayContaining(['cnic:NOT_ALLOWED', 'ntn:REQUIRED']));
    expect(codes(6)).toContain('client_type:INVALID_CHOICE');
    expect(codes(7)).toContain('external_ref:INVALID_FORMAT');
    expect(codes(8)).toContain('row:WRONG_COLUMN_COUNT');
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('not-an-email');
    expect(serialized).not.toContain('0000009');
    expect(serialized).not.toContain('Synthetic');
    expect(serialized).not.toContain('robot');

    const blocked = await commit(w, result.data, content);
    expect(blocked.status).toBe(409);
    expect(blocked.data['code']).toBe('IMPORT_NOT_COMMITTABLE');
    expect(w.harness.state.clients.size).toBe(0);
  });

  it('rejects malformed CSV, a wrong header, and oversized files as a whole', async () => {
    const w = await world();
    const header = importTemplate('clients.v1')
      .columns.map((c) => c.name)
      .join(',');
    const unterminated = await dryRun(
      w,
      'clients.v1',
      `${header}\r\nA-1,"individual,secret-value\r\n`,
    );
    expect(unterminated.status).toBe(400);
    expect(unterminated.data['code']).toBe('IMPORT_FILE_INVALID');
    expect(unterminated.data['detail']).toContain('Line 2');
    expect(JSON.stringify(unterminated.data)).not.toContain('secret-value');

    const binary = await dryRun(w, 'clients.v1', `${header}\r\nA-1\u0000x\r\n`);
    expect(binary.status).toBe(400);

    const wrongHeader = await dryRun(w, 'clients.v1', 'name,secret_column\r\nx,y\r\n');
    expect(wrongHeader.status).toBe(400);
    expect(wrongHeader.data['detail']).toContain('missing external_ref');
    expect(JSON.stringify(wrongHeader.data)).not.toContain('secret_column');

    const tooMany = csv(
      'clients.v1',
      Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) =>
        clientRow(`R-${String(i)}`, 'N', i),
      ),
    );
    const many = await dryRun(w, 'clients.v1', tooMany);
    expect(many.status).toBe(400);
    expect(many.data['detail']).toContain('more than');

    const huge = `${header}\r\n${'x'.repeat(IMPORT_LIMITS.maxFileBytes)}`;
    const large = await dryRun(w, 'clients.v1', huge);
    expect([400, 413]).toContain(large.status);
    expect(w.harness.state.importBatches.size).toBe(0);
  });

  it('keeps one open batch per file checksum until it is discarded', async () => {
    const w = await world();
    const content = csv('clients.v1', [clientRow('A-1', 'Synthetic Alpha', 1)]);
    const first = await dryRun(w, 'clients.v1', content);
    const second = await dryRun(w, 'clients.v1', content);
    expect(second.status).toBe(409);
    expect(second.data['code']).toBe('IMPORT_DUPLICATE_SOURCE');
    expect(second.data['detail']).toContain(first.data['batchCode']);
    const discarded = await w.call(`/api/v1/imports/${first.data['id'] as string}/discard`, {
      as: 'administrator',
      method: 'POST',
      ifMatch: 1,
    });
    expect(discarded.status).toBe(200);
    expect(discarded.data['status']).toBe('discarded');
    expect((await dryRun(w, 'clients.v1', content)).status).toBe(201);
  });
});

describe('commit (TD-703)', () => {
  it('requires If-Match, an idempotency key, and the same file', async () => {
    const w = await world();
    const content = csv('clients.v1', [clientRow('A-1', 'Synthetic Alpha', 1)]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    const path = `/api/v1/imports/${batch['id'] as string}/commit`;
    expect(
      (await w.call(path, { as: 'administrator', method: 'POST', body: { content }, key: key() }))
        .status,
    ).toBe(428);
    expect(
      (await w.call(path, { as: 'administrator', method: 'POST', body: { content }, ifMatch: 1 }))
        .status,
    ).toBe(428);
    const other = await commit(w, batch, `${content}A-2,individual,X,,00000-0000002-1,,,,,,,\r\n`);
    expect(other.status).toBe(409);
    expect(other.data['code']).toBe('IMPORT_SOURCE_MISMATCH');
    const staleVersion = await w.call(path, {
      as: 'administrator',
      method: 'POST',
      body: { content },
      ifMatch: 9,
      key: key(),
    });
    expect(staleVersion.status).toBe(412);
    expect(w.harness.state.clients.size).toBe(0);
  });

  it('creates records with lineage and audit events, and a retry never duplicates them', async () => {
    const w = await world();
    const content = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha', 1, {
        email: 'alpha@example.test',
        manager: 'imp-manager',
      }),
      clientRow('B-1', 'Synthetic Beta Traders', 0, { type: 'business', ntn: '0000003-1' }),
    ]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    const commitKey = key();
    const result = await commit(w, batch, content, commitKey);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      status: 'committed',
      outcomes: { created: 2, updated: 0, skipped: 0, failed: 0, pending: 0 },
      reconciliation: { sourceRows: 2, accountedRows: 2, balanced: true },
    });
    expect(w.harness.state.clients.size).toBe(2);
    const committed = await rows(w, batch['id']);
    for (const row of committed) {
      expect(row['outcome']).toBe('created');
      expect(row['record'].entityType).toBe('client');
      expect(w.harness.state.clients.has(row['record'].entityId)).toBe(true);
      expect(row['record'].code).toMatch(/^CL-\d{5}$/u);
    }
    const alpha = [...w.harness.state.clients.values()].find(
      (c) => c.legalName === 'Synthetic Alpha',
    );
    expect(alpha?.assignedManagerUserId).toBe(w.users.manager.id);
    expect(alpha?.cnic?.masked).toBe('•••••-••••001-1');
    expect(JSON.stringify(alpha)).not.toContain('0000001-1"');
    const createdEvents = w.harness.state.auditEvents.filter((e) => e.action === 'client.created');
    expect(createdEvents).toHaveLength(2);
    expect(createdEvents[0]?.metadata).toMatchObject({
      importBatch: batch['batchCode'],
      importRow: 2,
    });
    expect(w.harness.state.auditEvents.some((e) => e.action === 'import.committed')).toBe(true);

    // Same key: replayed outcome, nothing new.
    const replay = await commit(w, batch, content, commitKey);
    expect(replay.status).toBe(200);
    expect(replay.data['outcomes'].created).toBe(2);
    expect(w.harness.state.clients.size).toBe(2);
    // Different key on a committed batch: refused.
    const again = await commit(w, batch, content);
    expect(again.status).toBe(409);
    expect(again.data['code']).toBe('IMPORT_ALREADY_COMMITTED');
    expect(w.harness.state.clients.size).toBe(2);
  });

  it('resumes an interrupted commit from the next bounded chunk with the same key', async () => {
    const w = await world();
    const total = IMPORT_LIMITS.commitChunkRows + 30;
    const content = csv(
      'clients.v1',
      Array.from({ length: total }, (_, i) =>
        clientRow(`R-${String(i)}`, `Synthetic Person ${String(i)}`, i + 1),
      ),
    );
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    expect(batch['plan'].create).toBe(total);
    const imports = w.harness.repositories.imports;
    const original = imports.pendingRows.bind(imports);
    let calls = 0;
    (imports as { pendingRows: typeof original }).pendingRows = async (batchId, limit) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('simulated network failure');
      }
      return await original(batchId, limit);
    };
    const commitKey = key();
    const interrupted = await commit(w, batch, content, commitKey);
    expect(interrupted.status).toBe(500);
    expect(w.harness.state.clients.size).toBe(IMPORT_LIMITS.commitChunkRows);
    const midway = await w.call(`/api/v1/imports/${batch['id'] as string}`, {
      as: 'administrator',
    });
    expect(midway.data['status']).toBe('committing');
    expect(midway.data['outcomes'].pending).toBe(30);

    // Another key cannot take over a commit in progress.
    const other = await commit(w, midway.data, content);
    expect(other.data['code']).toBe('IMPORT_COMMIT_IN_PROGRESS');

    const resumed = await commit(w, midway.data, content, commitKey);
    expect(resumed.status).toBe(200);
    expect(resumed.data['outcomes']).toMatchObject({ created: total, pending: 0, failed: 0 });
    expect(w.harness.state.clients.size).toBe(total);
  });

  it('refuses a commit when data changed after the dry run until it is revalidated', async () => {
    const w = await world();
    const content = csv('clients.v1', [clientRow('A-1', 'Synthetic Alpha', 1)]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    const direct = await w.call('/api/v1/clients', {
      as: 'manager',
      method: 'POST',
      body: {
        type: 'individual',
        legalName: 'Different Synthetic Name',
        cnic: '00000-0000001-1',
        contacts: [],
        assignedManagerUserId: null,
      },
    });
    expect(direct.status).toBe(201);
    const refused = await commit(w, batch, content);
    expect(refused.status).toBe(409);
    expect(refused.data['code']).toBe('IMPORT_STALE');
    const revalidated = await w.call(`/api/v1/imports/${batch['id'] as string}/revalidate`, {
      as: 'administrator',
      method: 'POST',
      body: { content },
      ifMatch: batch['version'],
    });
    expect(revalidated.status).toBe(200);
    expect(revalidated.data['plan']).toMatchObject({ create: 0, skip: 1 });
    const [row] = await rows(w, batch['id']);
    expect(row?.['reason']).toBe('EXISTING_CLIENT');
    expect(row?.['match'].code).toBe(direct.data['clientCode']);
    const done = await commit(w, revalidated.data, content);
    expect(done.status).toBe(200);
    expect(done.data['outcomes']).toMatchObject({ skipped: 1, created: 0 });
    expect(w.harness.state.clients.size).toBe(1);
    // The skipped row links the reference, so later files can use it.
    const [linked] = await rows(w, batch['id']);
    expect(linked?.['record'].entityId).toBe(direct.data['id']);
  });

  it('updates changed fields and skips unchanged rows when a reference is imported again', async () => {
    const w = await world();
    const first = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha', 1),
      clientRow('A-2', 'Synthetic Beta', 2),
    ]);
    const batch = (await dryRun(w, 'clients.v1', first)).data;
    expect((await commit(w, batch, first)).status).toBe(200);
    const second = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha Renamed', 1, { notes: 'corrected' }),
      clientRow('A-2', 'Synthetic Beta', 2),
    ]);
    const plan = (await dryRun(w, 'clients.v1', second)).data;
    expect(plan['plan']).toMatchObject({ create: 0, update: 1, skip: 1 });
    const done = await commit(w, plan, second);
    expect(done.data['outcomes']).toMatchObject({ updated: 1, skipped: 1 });
    const renamed = [...w.harness.state.clients.values()].find(
      (c) => c.legalName === 'Synthetic Alpha Renamed',
    );
    expect(renamed?.notes).toBe('corrected');
    expect(w.harness.state.clients.size).toBe(2);

    const changedId = csv('clients.v1', [clientRow('A-1', 'Synthetic Alpha Renamed', 5)]);
    const conflict = (await dryRun(w, 'clients.v1', changedId)).data;
    expect(conflict['plan'].error).toBe(1);
    const [row] = await rows(w, conflict['id']);
    expect(row?.['reason']).toBe('IDENTIFIER_CHANGED');
  });
});

describe('review and correction (TD-704)', () => {
  it('requires a reasoned decision for a possible duplicate and records it', async () => {
    const w = await world();
    const existing = await w.call('/api/v1/clients', {
      as: 'manager',
      method: 'POST',
      body: {
        type: 'individual',
        legalName: 'Synthetic Alpha',
        cnic: '00000-0000099-1',
        contacts: [],
        assignedManagerUserId: null,
      },
    });
    expect(existing.status).toBe(201);
    const content = csv('clients.v1', [
      clientRow('A-1', 'Synthetic Alpha', 1),
      clientRow('A-2', 'Synthetic Omega', 2, { phone: '0300 0000002' }),
      clientRow('A-3', 'Synthetic Omega Two', 3, { phone: '+92 300 0000002' }),
    ]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    expect(batch['status']).toBe('blocked');
    expect(batch['plan']).toMatchObject({ create: 1, review: 2 });
    const reviews = await rows(w, batch['id'], '?action=review');
    expect(reviews.map((r) => r['rowNumber'])).toEqual([2, 4]);
    expect(reviews[0]?.['match'].code).toBe(existing.data['clientCode']);
    expect(reviews[1]?.['match']).toBeNull();

    const decide = (row: number, body: unknown, ifMatch: number) =>
      w.call(`/api/v1/imports/${batch['id'] as string}/rows/${String(row)}/decision`, {
        as: 'administrator',
        method: 'POST',
        body,
        ifMatch,
      });
    expect((await decide(2, { decision: 'create', reason: 'short' }, 1)).status).toBe(400);
    expect(
      (await decide(3, { decision: 'create', reason: 'Not a duplicate at all.' }, 1)).data['code'],
    ).toBe('IMPORT_ROW_NOT_REVIEWABLE');
    for (const role of ['manager', 'consultant'] as const) {
      const denied = await w.call(`/api/v1/imports/${batch['id'] as string}/rows/2/decision`, {
        as: role,
        method: 'POST',
        body: { decision: 'create', reason: 'Different person, checked CNIC.' },
        ifMatch: 1,
      });
      expect(denied.status).toBe(403);
    }
    const first = await decide(
      2,
      { decision: 'create', reason: 'Different person, checked CNIC.' },
      1,
    );
    expect(first.status).toBe(200);
    expect(first.data['batch'].status).toBe('blocked');
    expect(first.data['row'].decision).toMatchObject({
      decision: 'create',
      reason: 'Different person, checked CNIC.',
      decidedBy: { id: w.users.administrator.id },
    });
    expect((await decide(4, { decision: 'skip', reason: 'Same family business.' }, 1)).status).toBe(
      412,
    );
    const second = await decide(4, { decision: 'skip', reason: 'Same family business.' }, 2);
    expect(second.data['batch']).toMatchObject({
      status: 'validated',
      plan: { create: 2, skip: 1, review: 0 },
    });
    const decided = w.harness.state.auditEvents.filter((e) => e.action === 'import.row_decided');
    expect(decided).toHaveLength(2);
    expect(decided[0]?.metadata).toMatchObject({ rowNumber: 2, decision: 'create' });

    const done = await commit(w, second.data['batch'], content);
    expect(done.data['outcomes']).toMatchObject({ created: 2, skipped: 1, failed: 0 });
    const outcome = await rows(w, batch['id']);
    expect(outcome.find((r) => r['rowNumber'] === 2)?.['outcomeReason']).toBe('DECIDED_CREATE');
    expect(outcome.find((r) => r['rowNumber'] === 4)?.['outcomeReason']).toBe('DECIDED_SKIP');
    expect(w.harness.state.clients.size).toBe(3);
  });

  it('exports row errors, skips, and decisions as sanitized CSV with audit', async () => {
    const w = await world();
    const content = csv('clients.v1', [
      clientRow('A-1', '=HYPERLINK("x")', 1, { email: 'bad@@example' }),
      clientRow('A-2', 'Synthetic Beta', 2),
    ]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    const exported = await w.call(`/api/v1/imports/${batch['id'] as string}/rows.csv`, {
      as: 'administrator',
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Content-Disposition')).toContain('exceptions.csv');
    const lines = exported.text.trim().split('\r\n');
    expect(lines[0]).toContain('row_number,external_ref,planned_action');
    expect(lines).toHaveLength(2);
    expect(exported.text).toContain('contact_email,INVALID_FORMAT');
    expect(exported.text).not.toContain('bad@@example');
    expect(exported.text).not.toContain('HYPERLINK');
    expect(exported.text).not.toContain('0000001');
    const all = await w.call(`/api/v1/imports/${batch['id'] as string}/rows.csv?scope=all`, {
      as: 'administrator',
    });
    expect(all.text.trim().split('\r\n')).toHaveLength(3);
    expect(
      w.harness.state.auditEvents.filter((e) => e.action === 'import.exceptions_exported'),
    ).toHaveLength(2);
  });
});

describe('active cases and opening balances', () => {
  async function importClients(w: World): Promise<void> {
    const content = csv('clients.v1', [
      clientRow('C-1', 'Synthetic Alpha', 1),
      clientRow('C-2', 'Synthetic Beta', 2),
    ]);
    const batch = (await dryRun(w, 'clients.v1', content)).data;
    expect((await commit(w, batch, content)).status).toBe(200);
  }

  it('imports open cases against imported clients with workflow, status, and assignees', async () => {
    const w = await world();
    await catalog(w);
    await importClients(w);
    const content = csv('cases.v1', [
      [
        'T-1',
        'C-1',
        'income tax RETURN',
        '2026',
        '2026-09-30',
        '',
        'imp-consultant',
        'imp-manager',
        '',
      ],
      ['T-2', 'CL-00002', 'Income tax return', '2026', '', 'in_preparation', '', '', 'note'],
      ['T-3', 'C-9', 'Income tax return', '2026', '', '', '', '', ''],
      ['T-4', 'C-1', 'Bookkeeping', '2026', '', '', '', '', ''],
      ['T-5', 'C-1', 'Income tax return', '2026', '', '', '', '', ''],
      ['T-6', 'C-2', 'Income tax return', '2025', '', 'filed', '', '', ''],
      ['T-7', 'C-2', 'Income tax return', '2024', '', '', 'imp-billing', '', ''],
    ]);
    const batch = (await dryRun(w, 'cases.v1', content)).data;
    const planned = await rows(w, batch['id']);
    const reason = (row: number) => planned.find((r) => r['rowNumber'] === row)?.['reason'];
    expect(reason(4)).toBe('CLIENT_NOT_FOUND');
    expect(reason(5)).toBe('SERVICE_NOT_FOUND');
    expect(reason(6)).toBe('DUPLICATE_IN_FILE');
    expect(reason(7)).toBe('STATUS_NOT_FOUND');
    expect(reason(8)).toBe('USER_NOT_FOUND');
    expect(batch['plan']).toMatchObject({ create: 2, error: 5 });

    const fixed = csv('cases.v1', [
      [
        'T-1',
        'C-1',
        'income tax RETURN',
        '2026',
        '2026-09-30',
        '',
        'imp-consultant',
        'imp-manager',
        '',
      ],
      ['T-2', 'CL-00002', 'Income tax return', '2026', '', 'in_preparation', '', '', 'note'],
    ]);
    const good = (await dryRun(w, 'cases.v1', fixed)).data;
    const done = await commit(w, good, fixed);
    expect(done.data['outcomes']).toMatchObject({ created: 2 });
    const cases = [...w.harness.state.cases.values()];
    expect(cases).toHaveLength(2);
    const t1 = cases.find((c) => c.dueDate === '2026-09-30');
    expect(t1?.primaryConsultantUserId).toBe(w.users.consultant.id);
    expect(t1?.reviewerUserId).toBe(w.users.manager.id);
    const t2 = cases.find((c) => c.id !== t1?.id);
    expect(t2?.dueDate).toBe('2026-08-14');
    expect(t2?.currentStatusKey).toBe('in_preparation');
    const history = w.harness.state.caseStatusHistory.filter((h) => h.caseId === t2?.id);
    expect(history.map((h) => h.toStatusKey)).toEqual(['intake', 'in_preparation']);

    // The same open case again (another reference) is linked, not duplicated.
    const again = csv('cases.v1', [
      ['T-9', 'C-1', 'Income tax return', '2026', '', '', '', '', ''],
    ]);
    const linked = (await dryRun(w, 'cases.v1', again)).data;
    expect(linked['plan']).toMatchObject({ skip: 1 });
    const [row] = await rows(w, linked['id']);
    expect(row?.['reason']).toBe('EXISTING_CASE');
  });

  it('imports opening balances as finalized invoices and reconciles the amounts', async () => {
    const w = await world();
    await catalog(w);
    await importClients(w);
    const content = csv('opening_balances.v1', [
      ['B-1', 'C-1', '', '2026-06-30', '2026-07-31', '12,500.50', ''],
      ['B-2', 'CL-00002', '', '2026-06-30', '', '3000', 'Prior-year fee'],
      ['B-3', 'C-1', '', '2026-08-01', '', '10', ''],
      ['B-4', 'C-1', '', '2026-06-30', '2026-06-01', '10', ''],
      ['B-5', 'C-1', '', '2026-06-30', '', '0', ''],
      ['B-6', 'C-1', '', '2026-06-30', '', '1.234', ''],
      ['B-7', 'C-1', 'TC-99999', '2026-06-30', '', '10', ''],
    ]);
    const batch = (await dryRun(w, 'opening_balances.v1', content)).data;
    const planned = await rows(w, batch['id']);
    const codes = (row: number) =>
      planned.find((r) => r['rowNumber'] === row)?.['errors'].map((e: any) => e.code);
    expect(codes(4)).toContain('DATE_IN_FUTURE');
    expect(codes(5)).toContain('DATE_BEFORE_START');
    expect(codes(6)).toContain('INVALID_AMOUNT');
    expect(codes(7)).toContain('INVALID_AMOUNT');
    expect(planned.find((r) => r['rowNumber'] === 8)?.['reason']).toBe('CASE_NOT_FOUND');

    const good = csv('opening_balances.v1', [
      ['B-1', 'C-1', '', '2026-06-30', '2026-07-31', '12,500.50', ''],
      ['B-2', 'CL-00002', '', '2026-06-30', '', '3000', 'Prior-year fee'],
    ]);
    const plan = (await dryRun(w, 'opening_balances.v1', good)).data;
    expect(plan['reconciliation'].sourceAmountMinor).toBe(1_550_050);
    const done = await commit(w, plan, good);
    expect(done.data['reconciliation']).toMatchObject({
      sourceAmountMinor: 1_550_050,
      importedAmountMinor: 1_550_050,
      balanced: true,
    });
    const invoices = [...w.harness.state.invoices.values()];
    expect(invoices).toHaveLength(2);
    for (const invoice of invoices) {
      expect(invoice.status).toBe('finalized');
      expect(invoice.invoiceNumber).toMatch(/^INV-\d{5}$/u);
      expect(invoice.issueDate).toBe('2026-06-30');
      expect(invoice.outstandingMinor).toBe(invoice.totalMinor);
    }
    const imported = await rows(w, plan['id']);
    expect(imported.map((r) => r['record'].entityType)).toEqual(['invoice', 'invoice']);

    const reconciliation = await w.call('/api/v1/imports/reconciliation?sample=5', {
      as: 'administrator',
    });
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.data).toMatchObject({
      clients: { total: 2, active: 2, imported: 2 },
      openingBalances: { invoices: 2, totalMinor: 1_550_050, outstandingMinor: 1_550_050 },
      batches: { committed: 2, failedRows: 0 },
    });
    expect(reconciliation.data['samples']).toHaveLength(4);

    // Re-importing the same references never bills twice.
    const repeat = good.replace('Prior-year fee', 'Prior-year fee (again)');
    const second = (await dryRun(w, 'opening_balances.v1', repeat)).data;
    expect(second['plan']).toMatchObject({ skip: 2, create: 0 });
    const replayed = await commit(w, second, repeat);
    expect(replayed.data['reconciliation']).toMatchObject({
      importedAmountMinor: 0,
      skippedAmountMinor: 1_550_050,
      balanced: true,
    });
    expect(w.harness.state.invoices.size).toBe(2);
  });
});
