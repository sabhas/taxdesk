import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  IMPORT_TEMPLATES,
  permissionsForRoles,
  type CurrentSession,
  type ImportBatch,
  type ImportReconciliation,
  type ImportRow,
  type RoleKey,
} from '@taxdesk/shared';
import { App } from '../../App.js';
import { rememberImportFile } from '../../import-api.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const BATCH_ID = '0198a000-0000-7000-8000-0000000000b1';
const NOW = '2026-07-15T04:00:00.000Z';
const CSV = 'external_ref,client_type\r\nA-1,individual\r\n';

function sessionFor(role: RoleKey): CurrentSession {
  return {
    user: {
      id: USER_ID,
      username: 'person',
      displayName: 'Test Person',
      status: 'active',
      mfaEnrolled: true,
      createdAt: NOW,
    },
    roles: [role],
    permissions: permissionsForRoles([role]),
    session: {
      idleExpiresAt: '2026-07-15T04:30:00.000Z',
      absoluteExpiresAt: '2026-07-15T16:00:00.000Z',
      mfaVerified: true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-test' },
  });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://taxdesk.app/problems/${code.toLowerCase()}`,
      title: 'Error',
      status,
      code,
      detail,
      requestId: 'req-problem',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return {
    id: BATCH_ID,
    batchCode: 'IMP-00001',
    template: 'clients.v1',
    kind: 'clients',
    fileName: 'clients.csv',
    sizeBytes: CSV.length,
    sourceChecksum: 'a'.repeat(64),
    rowCount: 3,
    status: 'blocked',
    plan: { create: 1, update: 0, skip: 0, review: 1, error: 1 },
    outcomes: { created: 0, updated: 0, skipped: 0, failed: 0, pending: 3 },
    reconciliation: {
      sourceRows: 3,
      accountedRows: 0,
      sourceAmountMinor: null,
      importedAmountMinor: null,
      skippedAmountMinor: null,
      balanced: false,
    },
    canCommit: false,
    createdBy: { id: USER_ID, displayName: 'Test Person' },
    createdAt: NOW,
    validatedAt: NOW,
    commitStartedAt: null,
    committedAt: null,
    committedBy: null,
    discardedAt: null,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function row(overrides: Partial<ImportRow>): ImportRow {
  return {
    rowNumber: 2,
    externalRef: 'A-1',
    action: 'create',
    reason: null,
    reasonMessage: null,
    errors: [],
    match: null,
    amountMinor: null,
    decision: null,
    outcome: null,
    outcomeReason: null,
    record: null,
    committedAt: null,
    version: 1,
    ...overrides,
  };
}

const ROWS: ImportRow[] = [
  row({
    rowNumber: 3,
    externalRef: 'A-2',
    action: 'error',
    reason: 'INVALID_FORMAT',
    errors: [
      {
        column: 'cnic',
        code: 'INVALID_FORMAT',
        message: 'The value does not match the documented format.',
      },
    ],
  }),
  row({
    rowNumber: 4,
    externalRef: 'A-3',
    action: 'review',
    reason: 'POSSIBLE_DUPLICATE',
    reasonMessage:
      'A client with a similar name, email, or phone exists. Decide whether to create or skip.',
    match: {
      entityType: 'client',
      entityId: '0198a000-0000-7000-8000-0000000000c1',
      code: 'CL-00007',
    },
  }),
];

const RECONCILIATION: ImportReconciliation = {
  generatedAt: NOW,
  clients: { total: 12, active: 11, imported: 10 },
  cases: { active: 4, imported: 3, importedStillActive: 3 },
  openingBalances: { invoices: 2, totalMinor: 1_550_050, outstandingMinor: 1_000_000 },
  batches: { committed: 2, failedRows: 0 },
  samples: [
    {
      kind: 'clients',
      batchCode: 'IMP-00001',
      rowNumber: 2,
      externalRef: 'LEGACY-C-0001',
      entityType: 'client',
      entityId: '0198a000-0000-7000-8000-0000000000c2',
      code: 'CL-00001',
    },
  ],
};

type Handler = (url: string, init: RequestInit) => Response | undefined;

interface Call {
  url: string;
  init: RequestInit;
}

function mockApi(role: RoleKey, handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      calls.push({ url: `${init.method ?? 'GET'} ${input}`, init });
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      return Promise.resolve(
        handler(input, init) ?? problem(404, 'NOT_FOUND', `Unexpected request ${input}`),
      );
    }),
  );
  return calls;
}

function listHandler(url: string): Response | undefined {
  if (url === '/api/v1/imports/templates') {
    return json({
      templates: IMPORT_TEMPLATES.map((template) => ({
        id: template.id,
        kind: template.kind,
        version: template.version,
        title: template.title,
        description: template.description,
        columns: template.columns,
      })),
      limits: { maxFileBytes: 2 * 1024 * 1024, maxRows: 5000 },
    });
  }
  if (url === '/api/v1/imports') return json({ batches: [batch()], nextCursor: null });
  if (url.startsWith('/api/v1/imports/reconciliation')) return json(RECONCILIATION);
  return undefined;
}

function visit(path: string) {
  window.history.replaceState({}, '', path);
  return render(<App />);
}

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toHaveLength(0);
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('data import access', () => {
  it('shows the data import area to administrators only', async () => {
    mockApi('manager', () => undefined);
    visit('/imports');
    expect(await screen.findByText('You do not have permission')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Data import' })).toBeNull();
  });
});

describe('imports page', () => {
  it('lists templates, batches, and the migration reconciliation without serious accessibility violations', async () => {
    mockApi('administrator', listHandler);
    const { container } = visit('/imports');
    expect(await screen.findByRole('heading', { level: 1, name: 'Data import' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Data import' })).toBeTruthy();
    const download = await screen.findByRole('link', { name: 'Download clients template' });
    expect(download.getAttribute('href')).toBe('/api/v1/imports/templates/clients.v1/csv');
    expect(screen.getByRole('link', { name: 'IMP-00001' }).getAttribute('href')).toBe(
      `/imports/${BATCH_ID}`,
    );
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('PKR 15,500.50')).toBeTruthy();
    expect(screen.getByText('LEGACY-C-0001')).toBeTruthy();
    await expectNoSeriousViolations(container);
  });

  it('runs a dry run with the chosen file and opens the batch', async () => {
    const calls = mockApi('administrator', (url, init) => {
      if (url === '/api/v1/imports' && init.method === 'POST') return json(batch(), 201);
      if (url === `/api/v1/imports/${BATCH_ID}`) return json(batch());
      if (url.startsWith(`/api/v1/imports/${BATCH_ID}/rows`)) {
        return json({ rows: ROWS.filter((r) => r.action === 'error'), nextCursor: null });
      }
      return listHandler(url);
    });
    visit('/imports');
    fireEvent.click(await screen.findByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByText('Choose a CSV file.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('CSV file'), {
      target: { files: [new File([CSV], 'clients.csv', { type: 'text/csv' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(await screen.findByRole('heading', { level: 1, name: /IMP-00001/u })).toBeTruthy();
    const post = calls.find((call) => call.url === 'POST /api/v1/imports');
    expect(JSON.parse(post?.init.body as string)).toEqual({
      template: 'clients.v1',
      fileName: 'clients.csv',
      content: CSV,
    });
    // The batch page opens on the errors, with column-level messages.
    expect(await screen.findByText(/does not match the documented format/u)).toBeTruthy();
    expect(screen.getByText(/Fix every error in the source file/u)).toBeTruthy();
  });
});

describe('import batch page', () => {
  it('records a reasoned decision for a possible duplicate', async () => {
    rememberImportFile(BATCH_ID, CSV);
    const calls = mockApi('administrator', (url, init) => {
      if (url === `/api/v1/imports/${BATCH_ID}`) {
        return json(batch({ plan: { create: 1, update: 0, skip: 0, review: 1, error: 0 } }));
      }
      if (url.startsWith(`/api/v1/imports/${BATCH_ID}/rows?`)) {
        return json({ rows: ROWS.filter((r) => r.action === 'review'), nextCursor: null });
      }
      if (url === `/api/v1/imports/${BATCH_ID}/rows/4/decision` && init.method === 'POST') {
        return json({
          batch: batch({
            status: 'validated',
            canCommit: true,
            version: 2,
            plan: { create: 2, update: 0, skip: 0, review: 0, error: 0 },
          }),
          row: {
            ...ROWS[1],
            decision: {
              decision: 'create',
              reason: 'Different person.',
              decidedBy: null,
              decidedAt: NOW,
            },
          },
        });
      }
      return undefined;
    });
    const { container } = visit(`/imports/${BATCH_ID}`);
    await screen.findByText('Matches CL-00007');
    await expectNoSeriousViolations(container);
    fireEvent.click(screen.getByRole('button', { name: 'Decide for row 4' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByLabelText('Create a new client anyway'));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'short' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    expect(await within(dialog).findByText(/at least 10 characters/u)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Different person, checked CNIC.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await screen.findByText('Ready to commit');
    const decision = calls.find((call) => call.url.endsWith('/rows/4/decision'));
    expect(JSON.parse(decision?.init.body as string)).toEqual({
      decision: 'create',
      reason: 'Different person, checked CNIC.',
    });
    expect(header(decision!.init, 'If-Match')).toBe('"1"');
  });

  it('asks for the file again before committing when it is not in memory', async () => {
    const id = '0198a000-0000-7000-8000-0000000000b3';
    mockApi('administrator', (url) => {
      if (url === `/api/v1/imports/${id}`) {
        return json(
          batch({
            id,
            status: 'validated',
            canCommit: true,
            plan: { create: 3, update: 0, skip: 0, review: 0, error: 0 },
          }),
        );
      }
      if (url.startsWith(`/api/v1/imports/${id}/rows`)) return json({ rows: [], nextCursor: null });
      return undefined;
    });
    visit(`/imports/${id}`);
    const commitButton = await screen.findByRole('button', { name: 'Commit import' });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Choose clients.csv again'), {
      target: { files: [new File([CSV], 'clients.csv', { type: 'text/csv' })] },
    });
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Commit import' }).disabled,
      ).toBe(false);
    });
  });

  it('commits with one idempotency key that a retry reuses', async () => {
    const id = '0198a000-0000-7000-8000-0000000000b2';
    rememberImportFile(id, CSV);
    let attempts = 0;
    const calls = mockApi('administrator', (url, init) => {
      if (url === `/api/v1/imports/${id}`) {
        return json(
          batch({
            id,
            status: 'validated',
            canCommit: true,
            plan: { create: 3, update: 0, skip: 0, review: 0, error: 0 },
          }),
        );
      }
      if (url.startsWith(`/api/v1/imports/${id}/rows`)) return json({ rows: [], nextCursor: null });
      if (url === `/api/v1/imports/${id}/commit` && init.method === 'POST') {
        attempts += 1;
        if (attempts === 1) return problem(503, 'SERVICE_UNAVAILABLE', 'Try again shortly.');
        return json(
          batch({
            id,
            status: 'committed',
            canCommit: false,
            version: 3,
            outcomes: { created: 3, updated: 0, skipped: 0, failed: 0, pending: 0 },
            reconciliation: {
              sourceRows: 3,
              accountedRows: 3,
              sourceAmountMinor: null,
              importedAmountMinor: null,
              skippedAmountMinor: null,
              balanced: true,
            },
          }),
        );
      }
      return undefined;
    });
    visit(`/imports/${id}`);
    const commitButton = await screen.findByRole('button', { name: 'Commit import' });
    fireEvent.click(commitButton);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/3 records will be created/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText('The import did not finish')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Commit import' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Commit import' }),
    );
    expect(await screen.findByText(/Import committed: 3 created/u)).toBeTruthy();
    expect(screen.getByText(/Reconciled: all 3 rows are accounted for/u)).toBeTruthy();
    const commits = calls.filter((call) => call.url === `POST /api/v1/imports/${id}/commit`);
    expect(commits).toHaveLength(2);
    const firstKey = header(commits[0]!.init, 'Idempotency-Key');
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(header(commits[1]!.init, 'Idempotency-Key')).toBe(firstKey);
    expect(JSON.parse(commits[0]?.init.body as string)).toEqual({ content: CSV });
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Lineage CSV' })).toBeTruthy();
    });
  });
});
