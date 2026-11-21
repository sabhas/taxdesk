import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type BillableCase,
  type Client,
  type CurrentSession,
  type Invoice,
  type InvoiceItem,
  type RoleKey,
} from '@taxdesk/shared';
import { App } from '../../App.js';

/**
 * TD-511 combined group invoices in the browser: creating one from a group
 * head, choosing a client and case for each line (with the service default
 * and the duplicate-billing warning), and the grouped finalized view.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const HEAD_ID = '0198a000-0000-7000-8000-0000000000c1';
const MEMBER_ID = '0198a000-0000-7000-8000-0000000000c2';
const CASE_ID = '0198a000-0000-7000-8000-0000000000a1';
const INVOICE_ID = '0198a000-0000-7000-8000-0000000000b1';
const OTHER_INVOICE_ID = '0198a000-0000-7000-8000-0000000000b2';
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

function lineProblem(code: string, field: string, message: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://taxdesk.app/problems/${code.toLowerCase()}`,
      title: 'Conflict',
      status: 409,
      code,
      detail: message,
      requestId: 'req-problem',
      errors: [{ field, message }],
    }),
    { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function notFound(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://taxdesk.app/problems/not_found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Not found.',
      requestId: 'req-problem',
    }),
    { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const head: Client = {
  id: HEAD_ID,
  clientCode: 'CL-00001',
  type: 'business',
  legalName: 'Group Head Holdings',
  displayName: 'Group Head Holdings',
  cnicMasked: null,
  ntnMasked: null,
  contacts: [],
  notes: '',
  assignedManager: null,
  parentClient: null,
  groupMembers: [
    { id: MEMBER_ID, clientCode: 'CL-00002', displayName: 'Member One', state: 'active' },
  ],
  state: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
};

const memberCase: BillableCase = {
  id: CASE_ID,
  caseCode: 'TC-00009',
  serviceName: 'Individual return',
  taxYear: 2026,
  description: 'Individual return (tax year 2026)',
  unitAmountMinor: 1_500_000,
  otherInvoices: [{ id: OTHER_INVOICE_ID, invoiceNumber: 'INV-00003', status: 'finalized' }],
};

function item(
  position: number,
  description: string,
  amount: number,
  client: { id: string; clientCode: string; displayName: string },
  withCase = false,
): InvoiceItem {
  return {
    id: `0198a000-0000-7000-8000-0000000001a${String(position)}`,
    position,
    description,
    quantity: 1,
    unitAmountMinor: amount,
    lineTotalMinor: amount,
    client,
    case: withCase ? { id: CASE_ID, caseCode: 'TC-00009', serviceName: 'Individual return' } : null,
  };
}

const headRef = { id: HEAD_ID, clientCode: 'CL-00001', displayName: 'Group Head Holdings' };
const memberRef = { id: MEMBER_ID, clientCode: 'CL-00002', displayName: 'Member One' };

function combinedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    invoiceNumber: null,
    status: 'draft',
    paymentStatus: 'unpaid',
    billingMode: 'combined',
    currency: 'PKR',
    client: headRef,
    case: null,
    issueDate: null,
    dueDate: null,
    items: [],
    subtotalMinor: 0,
    discountMinor: 0,
    totalMinor: 0,
    paidMinor: 0,
    outstandingMinor: 0,
    notes: '',
    pdfState: 'none',
    finalizedAt: null,
    voidReason: null,
    voidedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function mockApi(
  role: RoleKey,
  invoice: () => Invoice,
  override?: (request: Recorded) => Response | undefined,
): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      recorded.push(request);
      const overridden = override?.(request);
      if (overridden !== undefined) return Promise.resolve(overridden);
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      if (input === `/api/v1/clients/${HEAD_ID}`) return Promise.resolve(json(head));
      if (input.startsWith(`/api/v1/clients/${HEAD_ID}/activity`)) {
        return Promise.resolve(json({ events: [], nextCursor: null }));
      }
      if (request.method === 'POST' && input === '/api/v1/invoices') {
        return Promise.resolve(json(combinedInvoice(), 201));
      }
      if (input.startsWith('/api/v1/invoices?')) {
        return Promise.resolve(json({ invoices: [], nextCursor: null }));
      }
      if (input.startsWith(`/api/v1/invoices/${INVOICE_ID}/billable-cases?`)) {
        const clientId = new URLSearchParams(input.split('?')[1]).get('clientId');
        return Promise.resolve(json({ cases: clientId === MEMBER_ID ? [memberCase] : [] }));
      }
      if (input === `/api/v1/invoices/${INVOICE_ID}/payments`) {
        return Promise.resolve(json({ payments: [] }));
      }
      if (request.method === 'GET' && input === `/api/v1/invoices/${INVOICE_ID}`) {
        return Promise.resolve(json(invoice()));
      }
      if (request.method === 'PATCH' && input === `/api/v1/invoices/${INVOICE_ID}`) {
        const items = request.body['items'] as {
          description: string;
          unitAmountMinor: number;
          clientId: string;
          caseId?: string;
        }[];
        const saved = combinedInvoice({
          items: items.map((entry, index) =>
            item(
              index + 1,
              entry.description,
              entry.unitAmountMinor,
              entry.clientId === MEMBER_ID ? memberRef : headRef,
              entry.caseId !== undefined,
            ),
          ),
          version: 2,
        });
        return Promise.resolve(json(saved));
      }
      return Promise.resolve(notFound());
    }),
  );
  return recorded;
}

function visit(path: string) {
  window.history.replaceState({}, '', path);
  return render(<App />);
}

describe('combined group invoices (TD-511)', () => {
  it('creates a combined invoice from a group head client', async () => {
    const recorded = mockApi('billing', () => combinedInvoice());
    visit(`/clients/${HEAD_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /create combined invoice/iu }));
    expect(await screen.findByRole('heading', { level: 1, name: /draft invoice/iu })).toBeTruthy();
    expect(
      recorded.find((request) => request.method === 'POST' && request.url === '/api/v1/invoices')
        ?.body,
    ).toEqual({ clientId: HEAD_ID, billingMode: 'combined' });
  });

  it('offers no combined invoice for roles that cannot manage billing', async () => {
    mockApi('read_only', () => combinedInvoice());
    visit(`/clients/${HEAD_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: /Group Head Holdings/u }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create combined invoice/iu })).toBeNull();
  });

  it('bills a member case with its default fee, warns about other invoices, and saves the line client', async () => {
    const recorded = mockApi('billing', () => combinedInvoice());
    const view = visit(`/invoices/${INVOICE_ID}`);
    expect(await screen.findByText(/A combined invoice to Group Head Holdings/u)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /add line/iu }));
    const billedFor = await screen.findByLabelText('Billed for');
    // New lines start for the group head; the member appears once the group loads.
    expect((billedFor as HTMLSelectElement).value).toBe(HEAD_ID);
    await within(billedFor).findByRole('option', { name: /Member One/u });
    fireEvent.change(billedFor, { target: { value: MEMBER_ID } });

    const caseSelect = screen.getByLabelText('Case (optional)');
    await within(caseSelect).findByRole('option', { name: /TC-00009/u });
    fireEvent.change(caseSelect, { target: { value: CASE_ID } });
    expect(screen.getByLabelText<HTMLInputElement>('Description').value).toBe(
      'Individual return (tax year 2026)',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/Unit amount/iu).value).toBe('15000.00');
    // The duplicate-billing warning names the other invoice but does not block.
    expect(screen.getByText(/TC-00009 is already on/u).textContent).toContain('INV-00003');
    expect(screen.getByLabelText('Subtotal by client').textContent).toContain('Member One');

    expect((await axe(view.container)).violations).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /save draft/iu }));
    expect(await screen.findByText('Draft saved.')).toBeTruthy();
    const patch = recorded.find((request) => request.method === 'PATCH');
    expect(patch?.body['items']).toEqual([
      {
        description: 'Individual return (tax year 2026)',
        quantity: 1,
        unitAmountMinor: 1_500_000,
        clientId: MEMBER_ID,
        caseId: CASE_ID,
      },
    ]);
  });

  it('requires a client on every combined line before saving', async () => {
    const recorded = mockApi('billing', () => combinedInvoice());
    visit(`/invoices/${INVOICE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /add line/iu }));
    fireEvent.change(await screen.findByLabelText('Billed for'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Advisory' } });
    fireEvent.click(screen.getByRole('button', { name: /save draft/iu }));
    expect(await screen.findByText('Choose who this line is for.')).toBeTruthy();
    expect(recorded.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('shows a finalized combined invoice grouped by client with subtotals', async () => {
    const finalized = combinedInvoice({
      status: 'finalized',
      invoiceNumber: 'INV-00010',
      issueDate: '2026-06-01',
      finalizedAt: NOW,
      pdfState: 'ready',
      items: [
        item(1, 'Group advisory', 200_000, headRef),
        item(2, 'Individual return (tax year 2026)', 1_500_000, memberRef, true),
        item(3, 'Wealth statement', 100_000, memberRef),
      ],
      subtotalMinor: 1_800_000,
      totalMinor: 1_800_000,
      outstandingMinor: 1_800_000,
      version: 3,
    });
    mockApi('billing', () => finalized);
    const view = visit(`/invoices/${INVOICE_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: /INV-00010/u })).toBeTruthy();
    expect(screen.getByText('Combined')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Subtotal for Member One')).toBeTruthy();
    });
    expect(screen.getByText('Subtotal for Group Head Holdings')).toBeTruthy();
    expect(screen.getByText('PKR 16,000.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'TC-00009' })).toBeTruthy();
    expect((await axe(view.container)).violations).toEqual([]);
  });

  it('marks the line a refused save names, and clears it on the next edit', async () => {
    const message = 'Choose the group head or a current member of its group.';
    mockApi(
      'billing',
      () => combinedInvoice({ items: [item(1, 'Advisory', 100_000, memberRef)] }),
      (request) =>
        request.method === 'PATCH'
          ? lineProblem('INVOICE_LINE_NOT_IN_GROUP', 'items.0.clientId', message)
          : undefined,
    );
    visit(`/invoices/${INVOICE_ID}`);
    await screen.findByLabelText('Billed for');
    fireEvent.click(screen.getByRole('button', { name: /save draft/iu }));
    const field = await screen.findByText(message, { selector: '[data-slot="field-error"]' });
    expect(field).toBeTruthy();
    expect(screen.getByLabelText('Billed for').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Advisory work' } });
    await waitFor(() => {
      expect(screen.getByLabelText('Billed for').getAttribute('aria-invalid')).toBe('false');
    });
  });

  it('closes the finalize dialog and marks the line when a member left the group', async () => {
    const message =
      'CL-00002 is no longer in this group. Change or remove its lines, then finalize.';
    mockApi(
      'billing',
      () =>
        combinedInvoice({
          items: [item(1, 'Advisory', 100_000, headRef), item(2, 'Filing', 200_000, memberRef)],
          subtotalMinor: 300_000,
          totalMinor: 300_000,
          outstandingMinor: 300_000,
        }),
      (request) =>
        request.url.endsWith('/finalize')
          ? lineProblem('INVOICE_GROUP_CHANGED', 'items.1.clientId', message)
          : undefined,
    );
    visit(`/invoices/${INVOICE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /finalize…/iu }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize invoice' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Finalize invoice' })).toBeNull();
    });
    const selects = screen.getAllByLabelText('Billed for');
    expect(selects[1]?.getAttribute('aria-invalid')).toBe('true');
    expect(selects[0]?.getAttribute('aria-invalid')).toBe('false');
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  });
});
