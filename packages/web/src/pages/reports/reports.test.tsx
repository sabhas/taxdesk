import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type CurrentSession,
  type DashboardSummary,
  type RoleKey,
} from '@taxdesk/shared';
import { App } from '../../App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const OTHER_ID = '0198a000-0000-7000-8000-000000000002';
const NOW = '2026-06-01T04:00:00.000Z';

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
      idleExpiresAt: '2026-06-01T04:30:00.000Z',
      absoluteExpiresAt: '2026-06-01T16:00:00.000Z',
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

type Handler = (url: string, init: RequestInit) => Response | undefined;

function mockApi(role: RoleKey, handler: Handler): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      urls.push(`${init.method ?? 'GET'} ${input}`);
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      if (input.startsWith('/api/v1/service-types')) {
        return Promise.resolve(json({ serviceTypes: [] }));
      }
      if (input.startsWith('/api/v1/cases/assignees')) {
        return Promise.resolve(
          json({ assignees: [{ id: OTHER_ID, displayName: 'Ayesha Consultant' }] }),
        );
      }
      return Promise.resolve(
        handler(input, init) ?? problem(404, 'NOT_FOUND', `Unexpected request ${input}`),
      );
    }),
  );
  return urls;
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

const count = (value: number, href: string) => ({ count: value, href });

const managerSummary: DashboardSummary = {
  generatedAt: NOW,
  today: '2026-06-01',
  dueSoonDays: 7,
  work: {
    assigned: count(4, '/cases?view=my'),
    overdue: count(2, '/cases?view=overdue'),
    dueSoon: count(3, '/cases?view=due_soon'),
    checklistGaps: count(1, '/cases?view=my&checklist=gaps'),
    filing: {
      inProgress: count(5, '/cases?view=team&statusKind=open'),
      filed: count(2, '/cases?view=team&statusKind=filed'),
      completed: count(7, '/cases?view=closed&statusKind=completed'),
    },
  },
  management: {
    unassigned: count(1, '/cases?view=unassigned'),
    teamOpen: count(9, '/cases?view=team'),
    teamOverdue: count(2, '/cases?view=overdue'),
    reviewQueue: count(3, '/cases?view=team&checklist=awaiting_review'),
    workload: [
      {
        userId: OTHER_ID,
        displayName: 'Ayesha Consultant',
        open: count(6, `/cases?view=team&assignee=${OTHER_ID}`),
        overdue: count(1, `/cases?view=overdue&assignee=${OTHER_ID}`),
        dueSoon: count(2, `/cases?view=due_soon&assignee=${OTHER_ID}`),
        reviewing: count(0, `/cases?view=team&reviewer=${OTHER_ID}`),
      },
    ],
  },
  billing: {
    unpaid: { count: 3, amountMinor: 4_500_000, href: '/invoices?balance=outstanding' },
    overdue: { count: 1, amountMinor: 1_000_000, href: '/invoices?balance=overdue' },
    monthStart: '2026-06-01',
    monthEnd: '2026-06-30',
    collected: {
      receivedMinor: 2_000_000,
      reversedMinor: 100_000,
      netMinor: 1_900_000,
      href: '/reports/billing?from=2026-06-01&to=2026-06-30',
    },
  },
};

describe('dashboard (TD-601)', () => {
  it('shows case, team, and billing sections with links that open the matching list', async () => {
    mockApi('manager', (url) =>
      url === '/api/v1/dashboard/summary'
        ? json(managerSummary)
        : url.startsWith('/api/v1/cases')
          ? json({
              cases: [],
              nextCursor: null,
              total: 0,
              my: 0,
              team: 0,
              unassigned: 0,
              due_soon: 0,
              overdue: 0,
            })
          : undefined,
    );
    const rendered = visit('/');
    expect(await screen.findByRole('heading', { name: 'Cases that need attention' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Team workload' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Billing' })).toBeTruthy();
    const figures = screen.getByRole('list', { name: 'Case figures' });
    expect(within(figures).getByRole('link', { name: /Overdue/u })).toHaveAttribute(
      'href',
      '/cases?view=overdue',
    );
    expect(screen.getByText(/PKR 45,000.00 owed/u)).toBeTruthy();
    await expectNoSeriousViolations(rendered.container);

    fireEvent.click(within(figures).getByRole('link', { name: /With checklist gaps/u }));
    expect(await screen.findByText(/Required checklist items outstanding/u)).toBeTruthy();
    expect(window.location.search).toContain('checklist=gaps');
  });

  it('shows a consultant only their own case figures', async () => {
    const summary: DashboardSummary = { ...managerSummary, management: null, billing: null };
    mockApi('consultant', () => json(summary));
    visit('/');
    expect(await screen.findByRole('heading', { name: 'Cases that need attention' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Team workload' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Billing' })).toBeNull();
  });

  it('reports a failed load without hiding the page', async () => {
    mockApi('manager', () => problem(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    visit('/');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Welcome, Test Person/u })).toBeTruthy();
  });

  it('follows an unpaid-invoices link to a filtered invoice list', async () => {
    mockApi('manager', (url) => {
      if (url === '/api/v1/dashboard/summary') return json(managerSummary);
      if (url.startsWith('/api/v1/invoices')) return json({ invoices: [], nextCursor: null });
      return undefined;
    });
    const urls = mockApi('manager', (url) => {
      if (url === '/api/v1/dashboard/summary') return json(managerSummary);
      if (url.startsWith('/api/v1/invoices')) return json({ invoices: [], nextCursor: null });
      return undefined;
    });
    visit('/');
    fireEvent.click(await screen.findByRole('link', { name: /Unpaid invoices/u }));
    expect(await screen.findByText(/Showing: invoices with a balance/u)).toBeTruthy();
    await waitFor(() => {
      expect(
        urls.some(
          (entry) => entry.includes('/api/v1/invoices?') && entry.includes('balance=outstanding'),
        ),
      ).toBe(true);
    });
  });
});

describe('reports (TD-602, TD-603)', () => {
  const caseRow = {
    id: '0198a000-0000-7000-8000-0000000000a1',
    caseCode: 'TC-00001',
    client: { id: OTHER_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
    serviceName: 'Individual return',
    taxYear: 2026,
    status: { key: 'in_progress', name: 'In progress', kind: 'open' },
    dueDate: '2026-09-30',
    urgency: null,
    primaryConsultant: { id: OTHER_ID, displayName: 'Ayesha Consultant' },
    reviewer: null,
    state: 'active',
    updatedAt: NOW,
  };

  it('filters the case report server-side and offers the CSV export', async () => {
    const urls = mockApi('manager', (url) =>
      url.startsWith('/api/v1/reports/cases?')
        ? json({ cases: [caseRow], nextCursor: null, total: 1 })
        : undefined,
    );
    const rendered = visit('/reports');
    expect(await screen.findByText('TC-00001')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('1 case match');
    expect(screen.getByRole('link', { name: /Export CSV/u }).getAttribute('href')).toContain(
      '/api/v1/reports/cases.csv',
    );
    await expectNoSeriousViolations(rendered.container);

    fireEvent.change(screen.getByLabelText('Tax year'), { target: { value: '2025' } });
    await waitFor(() => {
      expect(
        urls.some((entry) => entry.includes('/reports/cases?') && entry.includes('taxYear=2025')),
      ).toBe(true);
    });
    expect(screen.getByRole('link', { name: /Export CSV/u }).getAttribute('href')).toContain(
      'taxYear=2025',
    );
  });

  it('shows an empty state when no case matches', async () => {
    mockApi('manager', (url) =>
      url.startsWith('/api/v1/reports/cases?')
        ? json({ cases: [], nextCursor: null, total: 0 })
        : undefined,
    );
    visit('/reports?taxYear=1999');
    expect(await screen.findByText('No cases match these filters')).toBeTruthy();
  });

  it('shows an inaccessible-data state when the API denies the report', async () => {
    mockApi('manager', (url) =>
      url.startsWith('/api/v1/reports/cases?')
        ? problem(403, 'FORBIDDEN', 'No access.')
        : undefined,
    );
    visit('/reports');
    expect(await screen.findByText(/Your role cannot view case reports/u)).toBeTruthy();
  });

  it('blocks the reports page for a role without the report permission', async () => {
    mockApi('consultant', () => undefined);
    visit('/reports');
    expect(await screen.findByRole('heading', { name: 'You do not have permission' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull();
  });

  it('shows per-person workload with links to the matching cases', async () => {
    mockApi('manager', (url) =>
      url.startsWith('/api/v1/reports/workload')
        ? json({ today: '2026-06-01', dueSoonDays: 7, rows: managerSummary.management!.workload })
        : undefined,
    );
    const rendered = visit('/reports/workload');
    const row = await screen.findByRole('row', { name: /Ayesha Consultant/u });
    expect(within(row).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      `/cases?view=team&assignee=${OTHER_ID}`,
    );
    await expectNoSeriousViolations(rendered.container);
  });

  it('totals billing for a date range and lists the invoices', async () => {
    const invoice = {
      id: '0198a000-0000-7000-8000-0000000000b1',
      invoiceNumber: 'INV-00001',
      status: 'finalized',
      paymentStatus: 'partially_paid',
      currency: 'PKR',
      client: { id: OTHER_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
      case: null,
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
      subtotalMinor: 1_000_000,
      discountMinor: 0,
      totalMinor: 1_000_000,
      paidMinor: 400_000,
      outstandingMinor: 600_000,
      pdfState: 'none',
      createdAt: NOW,
      updatedAt: NOW,
      version: 3,
    };
    const urls = mockApi('billing', (url) =>
      url.startsWith('/api/v1/reports/billing?')
        ? json({
            from: '2026-06-01',
            to: '2026-06-30',
            today: '2026-06-01',
            currency: 'PKR',
            totals: {
              invoiced: { count: 1, amountMinor: 1_000_000 },
              collected: { count: 1, amountMinor: 400_000 },
              reversed: { count: 0, amountMinor: 0 },
              netCollectedMinor: 400_000,
              outstanding: { count: 1, amountMinor: 600_000 },
              overdue: { count: 0, amountMinor: 0 },
            },
            invoices: [invoice],
            nextCursor: null,
          })
        : undefined,
    );
    const rendered = visit('/reports/billing?from=2026-06-01&to=2026-06-30');
    const totals = await screen.findByRole('list', { name: 'Billing totals' });
    expect(within(totals).getByText('PKR 6,000.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'INV-00001' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Export CSV/u })).toBeTruthy();
    expect(
      urls.some((entry) => entry.includes('from=2026-06-01') && entry.includes('to=2026-06-30')),
    ).toBe(true);
    await expectNoSeriousViolations(rendered.container);
  });

  it('shows a zero-result billing period and blocks a backwards range', async () => {
    mockApi('billing', (url) =>
      url.startsWith('/api/v1/reports/billing?')
        ? json({
            from: '2026-01-01',
            to: '2026-01-31',
            today: '2026-06-01',
            currency: 'PKR',
            totals: {
              invoiced: { count: 0, amountMinor: 0 },
              collected: { count: 0, amountMinor: 0 },
              reversed: { count: 0, amountMinor: 0 },
              netCollectedMinor: 0,
              outstanding: { count: 0, amountMinor: 0 },
              overdue: { count: 0, amountMinor: 0 },
            },
            invoices: [],
            nextCursor: null,
          })
        : undefined,
    );
    visit('/reports/billing?from=2026-01-01&to=2026-01-31');
    expect(await screen.findByText('No invoices were issued in this period')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2025-12-01' } });
    expect(await screen.findByText(/end date must be on or after/u)).toBeTruthy();
  });
});

describe('audit explorer (TD-604)', () => {
  const event = {
    id: '0198a000-0000-7000-8000-0000000000d1',
    occurredAt: NOW,
    actorUserId: USER_ID,
    actorDisplayName: 'Admin Person',
    action: 'firm.settings_updated',
    entityType: 'firm_settings',
    entityId: OTHER_ID,
    requestId: 'req-abc',
    metadata: {
      changedFields: 'dueSoonDays',
      dueSoonDaysFrom: 7,
      dueSoonDaysTo: 14,
      token: '[masked]',
    },
  };

  it('filters by action and date and shows masked changes with the request ID', async () => {
    const urls = mockApi('administrator', (url) =>
      url.startsWith('/api/v1/admin/audit-events')
        ? json({ events: [event], nextCursor: null })
        : undefined,
    );
    const rendered = visit('/audit');
    expect(await screen.findByText('Admin Person')).toBeTruthy();
    expect(screen.getByText('req-abc')).toBeTruthy();
    expect(screen.getByText('[masked]')).toBeTruthy();
    await expectNoSeriousViolations(rendered.container);

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'firm.*' } });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(
        urls.some((entry) => entry.includes('action=firm.*') && entry.includes('from=2026-06-01')),
      ).toBe(true);
    });
  });

  it('shows an empty result for filters that match nothing', async () => {
    mockApi('administrator', (url) =>
      url.startsWith('/api/v1/admin/audit-events')
        ? json({ events: [], nextCursor: null })
        : undefined,
    );
    visit('/audit');
    fireEvent.change(await screen.findByLabelText('Request ID'), { target: { value: 'nothing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No audit events match')).toBeTruthy();
  });

  it('is unavailable to non-administrators', async () => {
    mockApi('manager', () => undefined);
    visit('/audit');
    expect(await screen.findByRole('heading', { name: 'You do not have permission' })).toBeTruthy();
  });
});

describe('firm settings (TD-605)', () => {
  const settings = {
    id: '0198a000-0000-7000-8000-0000000000f1',
    firmName: 'Synthetic Firm',
    timezone: 'Asia/Karachi',
    currency: 'PKR',
    invoicePrefix: 'INV',
    receiptPrefix: 'RCP',
    documentMaxUploadBytes: 250 * 1024 * 1024,
    dueSoonDays: 7,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };

  it('saves business settings with the version and shows server validation', async () => {
    const bodies: Record<string, unknown>[] = [];
    mockApi('administrator', (url, init) => {
      if (url !== '/api/v1/firm/settings') return undefined;
      if (init.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        bodies.push(body);
        if (body['dueSoonDays'] === 30) {
          return problem(400, 'VALIDATION_FAILED', 'Check the settings.');
        }
        return json({ ...settings, ...body, version: 2 });
      }
      return json(settings);
    });
    const rendered = visit('/firm-settings');
    const days = await screen.findByLabelText('Dashboard due-soon window (days)');
    await expectNoSeriousViolations(rendered.container);

    fireEvent.change(days, { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Invoice number prefix'), { target: { value: 'tax' } });
    fireEvent.change(screen.getByLabelText('Document size limit (MiB)'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Firm settings saved.')).toBeTruthy();
    expect(bodies[0]).toMatchObject({
      dueSoonDays: 14,
      invoicePrefix: 'TAX',
      receiptPrefix: 'RCP',
      documentMaxUploadBytes: 20 * 1024 * 1024,
      currency: 'PKR',
    });

    fireEvent.change(days, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('heading', { name: 'Check the form' })).toBeTruthy();
    expect(screen.getByText('Check the settings.')).toBeTruthy();
  });

  it('is read-only for roles without the manage permission', async () => {
    mockApi('manager', (url) => (url === '/api/v1/firm/settings' ? json(settings) : undefined));
    visit('/firm-settings');
    const days = await screen.findByLabelText('Dashboard due-soon window (days)');
    expect(days).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});
