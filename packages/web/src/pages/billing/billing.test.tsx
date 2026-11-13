import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  STARTER_WORKFLOW_DEFINITION,
  calculateInvoiceTotals,
  checklistProgress,
  paymentStatusFor,
  permissionsForRoles,
  type CurrentSession,
  type Invoice,
  type Payment,
  type RoleKey,
  type TaxCase,
} from '@taxdesk/shared';
import { App } from '../../App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const CASE_ID = '0198a000-0000-7000-8000-0000000000a1';
const INVOICE_ID = '0198a000-0000-7000-8000-0000000000b1';
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

const workflow = STARTER_WORKFLOW_DEFINITION;
const initial = workflow.statuses.find((status) => status.initial)!;

const taxCase: TaxCase = {
  id: CASE_ID,
  caseCode: 'TC-00001',
  client: { id: CLIENT_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
  service: {
    id: '0198a000-0000-7000-8000-0000000000e1',
    name: 'Individual return',
    feeMinor: 1_500_000,
  },
  taxYear: 2026,
  workflow: {
    templateId: '0198a000-0000-7000-8000-0000000000f1',
    versionId: '0198a000-0000-7000-8000-0000000000f2',
    templateName: 'Annual return',
    versionNumber: 1,
    statuses: workflow.statuses,
    transitions: workflow.transitions,
  },
  status: { key: initial.key, name: initial.name, kind: initial.kind },
  dueDate: '2026-09-30',
  urgency: null,
  primaryConsultant: { id: USER_ID, displayName: 'Test Person' },
  reviewer: null,
  notes: '',
  checklist: [],
  checklistProgress: checklistProgress([]),
  availableTransitions: [],
  allowedActions: {
    edit: true,
    assign: true,
    transition: false,
    prepareChecklist: true,
    reviewChecklist: true,
    archive: false,
  },
  state: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/**
 * A stateful stand-in for the billing API that applies the rules the server
 * applies (server-side totals, draft-only edits, numbering, balance, version
 * checks) so the UI can be driven from a case to full settlement.
 */
function billingBackend(options: { pdfFails?: boolean; staleOnPatch?: boolean } = {}) {
  let invoice: Invoice | null = null;
  let payments: Payment[] = [];
  let invoiceNumber = 0;
  let receiptNumber = 0;
  const pdfCalls: string[] = [];

  const summary = (record: Invoice) => {
    const omitted = new Set(['items', 'notes', 'finalizedAt', 'voidReason', 'voidedAt']);
    const rest = Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key)));
    return rest;
  };

  const handle = (request: Recorded): Response | undefined => {
    const { method, url, body, headers } = request;
    if (method === 'POST' && url === '/api/v1/invoices') {
      invoice = {
        id: INVOICE_ID,
        invoiceNumber: null,
        status: 'draft',
        paymentStatus: 'unpaid',
        currency: 'PKR',
        client: taxCase.client,
        case: { id: CASE_ID, caseCode: 'TC-00001', serviceName: 'Individual return' },
        issueDate: null,
        dueDate: null,
        items: [
          {
            id: '0198a000-0000-7000-8000-0000000001a1',
            position: 1,
            description: 'Individual return (tax year 2026)',
            quantity: 1,
            unitAmountMinor: 1_500_000,
            lineTotalMinor: 1_500_000,
          },
        ],
        subtotalMinor: 1_500_000,
        discountMinor: 0,
        totalMinor: 1_500_000,
        paidMinor: 0,
        outstandingMinor: 1_500_000,
        notes: '',
        pdfState: 'none',
        finalizedAt: null,
        voidReason: null,
        voidedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
      };
      return json(invoice, 201);
    }
    if (url.startsWith('/api/v1/invoices?')) {
      return json({ invoices: invoice === null ? [] : [summary(invoice)], nextCursor: null });
    }
    if (invoice === null) return undefined;
    const record = invoice;
    if (method === 'GET' && url === `/api/v1/invoices/${INVOICE_ID}`) return json(record);
    if (method === 'GET' && url === `/api/v1/invoices/${INVOICE_ID}/payments`) {
      return json({ payments });
    }
    if (method === 'PATCH' && url === `/api/v1/invoices/${INVOICE_ID}`) {
      if (options.staleOnPatch === true) {
        return problem(412, 'PRECONDITION_FAILED', 'This invoice changed.');
      }
      const items = body['items'] as {
        description: string;
        quantity: number;
        unitAmountMinor: number;
      }[];
      const totals = calculateInvoiceTotals(items, body['discountMinor'] as number);
      if (!totals.ok) return problem(400, 'VALIDATION_FAILED', totals.message);
      invoice = {
        ...record,
        items: items.map((item, index) => ({
          id: `0198a000-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`,
          position: index + 1,
          ...item,
          lineTotalMinor: totals.totals.lineTotalsMinor[index] ?? 0,
        })),
        subtotalMinor: totals.totals.subtotalMinor,
        discountMinor: totals.totals.discountMinor,
        totalMinor: totals.totals.totalMinor,
        outstandingMinor: totals.totals.totalMinor,
        dueDate: body['dueDate'] as string | null,
        issueDate: body['issueDate'] as string | null,
        notes: body['notes'] as string,
        version: record.version + 1,
      };
      return json(invoice);
    }
    if (method === 'POST' && url === `/api/v1/invoices/${INVOICE_ID}/finalize`) {
      if (headers['Idempotency-Key'] === undefined || headers['If-Match'] === undefined) {
        return problem(428, 'PRECONDITION_REQUIRED', 'Missing header.');
      }
      invoiceNumber += 1;
      invoice = {
        ...record,
        status: 'finalized',
        invoiceNumber: `INV-${String(invoiceNumber).padStart(5, '0')}`,
        issueDate: '2026-06-01',
        finalizedAt: NOW,
        pdfState: options.pdfFails === true ? 'failed' : 'ready',
        version: record.version + 1,
      };
      return json(invoice);
    }
    if (method === 'POST' && url === `/api/v1/invoices/${INVOICE_ID}/void`) {
      if (body['confirm'] !== true) return problem(400, 'VALIDATION_FAILED', 'Confirm the void.');
      invoice = {
        ...record,
        status: 'void',
        voidReason: body['reason'] as string,
        voidedAt: NOW,
        version: record.version + 1,
      };
      return json(invoice);
    }
    if (method === 'POST' && url === `/api/v1/invoices/${INVOICE_ID}/pdf`) {
      pdfCalls.push(url);
      invoice = { ...record, pdfState: 'ready' };
      return json({ pdfState: 'ready', created: true });
    }
    if (method === 'POST' && url === `/api/v1/invoices/${INVOICE_ID}/payments`) {
      const amount = body['amountMinor'] as number;
      if (amount > record.outstandingMinor) {
        return problem(409, 'PAYMENT_EXCEEDS_OUTSTANDING', 'More than outstanding.');
      }
      receiptNumber += 1;
      const payment: Payment = {
        id: `0198a000-0000-7000-8000-0000000003${String(receiptNumber).padStart(2, '0')}`,
        invoiceId: INVOICE_ID,
        receiptNumber: `RCP-${String(receiptNumber).padStart(5, '0')}`,
        amountMinor: amount,
        method: body['method'] as Payment['method'],
        receivedOn: body['receivedOn'] as string,
        reference: body['reference'] as string,
        recordedByName: 'Test Person',
        recordedAt: NOW,
        reversedMinor: 0,
        reversals: [],
        receiptPdfState: 'ready',
      };
      payments = [...payments, payment];
      const paid = record.paidMinor + amount;
      invoice = {
        ...record,
        paidMinor: paid,
        outstandingMinor: record.totalMinor - paid,
        paymentStatus: paymentStatusFor(record.totalMinor, paid),
        version: record.version + 1,
      };
      return json({ payment, invoice }, 201);
    }
    return undefined;
  };

  return {
    handle,
    pdfCalls,
    seedPayment: () => {
      payments = [
        {
          id: '0198a000-0000-7000-8000-000000000399',
          invoiceId: INVOICE_ID,
          receiptNumber: 'RCP-00001',
          amountMinor: 500_000,
          method: 'cash',
          receivedOn: '2026-06-01',
          reference: '',
          recordedByName: 'Test Person',
          recordedAt: NOW,
          reversedMinor: 0,
          reversals: [],
          receiptPdfState: 'ready',
        },
      ];
    },
    seedFinalized: (overrides: Partial<Invoice> = {}) => {
      handle({ method: 'POST', url: '/api/v1/invoices', headers: {}, body: {} });
      invoiceNumber = 1;
      invoice = {
        ...invoice!,
        status: 'finalized',
        invoiceNumber: 'INV-00001',
        issueDate: '2026-06-01',
        finalizedAt: NOW,
        pdfState: 'ready',
        version: 3,
        ...overrides,
      };
    },
  };
}

function mockApi(role: RoleKey, backend: ReturnType<typeof billingBackend>): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      recorded.push(request);
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      const response = backend.handle(request);
      if (response !== undefined) return Promise.resolve(response);
      if (input === `/api/v1/cases/${CASE_ID}`) return Promise.resolve(json(taxCase));
      if (input.startsWith(`/api/v1/cases/${CASE_ID}/status-history`)) {
        return Promise.resolve(json({ entries: [] }));
      }
      if (input.startsWith(`/api/v1/cases/${CASE_ID}/activity`)) {
        return Promise.resolve(json({ events: [], nextCursor: null }));
      }
      if (input === '/api/v1/cases/assignees') return Promise.resolve(json({ assignees: [] }));
      return Promise.resolve(problem(404, 'NOT_FOUND', 'Not found.'));
    }),
  );
  return recorded;
}

function visit(path: string) {
  window.history.replaceState({}, '', path);
  return render(<App />);
}

describe('invoice journey (TD-502–TD-510)', () => {
  it('goes from a case to a draft, finalize, partial payment, and full settlement', async () => {
    const backend = billingBackend();
    const recorded = mockApi('billing', backend);
    visit(`/cases/${CASE_ID}`);

    fireEvent.click(await screen.findByRole('button', { name: /create invoice/iu }));
    // The draft opens with the service fee as its first line.
    expect(await screen.findByRole('heading', { level: 1, name: /draft invoice/iu })).toBeTruthy();
    expect(
      recorded.find((request) => request.url === '/api/v1/invoices' && request.method === 'POST')
        ?.body,
    ).toEqual({ caseId: CASE_ID });
    const description = await screen.findByLabelText('Description');
    expect((description as HTMLInputElement).value).toContain('Individual return');

    // Add a line, then watch the preview and save.
    fireEvent.click(screen.getByRole('button', { name: /add line/iu }));
    const descriptions = screen.getAllByLabelText('Description');
    fireEvent.change(descriptions[1]!, { target: { value: 'Advisory hours' } });
    fireEvent.change(screen.getAllByLabelText('Quantity')[1]!, { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText(/Unit amount/iu)[1]!, {
      target: { value: '2,500.00' },
    });
    fireEvent.change(screen.getByLabelText(/Discount/iu), { target: { value: '1,000' } });
    expect(screen.getByLabelText('Invoice total preview').textContent).toContain('PKR 19,000.00');
    fireEvent.click(screen.getByRole('button', { name: /save draft/iu }));
    expect(await screen.findByText('Draft saved.')).toBeTruthy();
    const patch = recorded.find((request) => request.method === 'PATCH');
    expect(patch?.headers['If-Match']).toBe('"1"');
    expect(patch?.body).toMatchObject({ discountMinor: 100_000 });
    expect(patch?.body).not.toHaveProperty('totalMinor');

    // Finalize.
    fireEvent.click(screen.getByRole('button', { name: /finalize…/iu }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize invoice' }));
    expect(await screen.findByRole('heading', { level: 1, name: /INV-00001/u })).toBeTruthy();
    const finalizeCall = recorded.find((request) => request.url.endsWith('/finalize'));
    expect(finalizeCall?.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(finalizeCall?.headers['If-Match']).toBe('"2"');
    expect(screen.queryByRole('button', { name: /save draft/iu })).toBeNull();
    expect(screen.getByText('PDF ready')).toBeTruthy();

    // Partial payment.
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const amount = await screen.findByLabelText(/Amount \(PKR\)/iu);
    expect((amount as HTMLInputElement).value).toBe('19000.00');
    fireEvent.change(amount, { target: { value: '5,000' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Record payment', hidden: false, description: '' }),
    );
    expect(await screen.findByText(/receipt RCP-00001/iu)).toBeTruthy();
    expect(screen.getAllByText(/Partly paid/u).length).toBeGreaterThan(0);

    // An over-balance amount is stopped in the form, before any request.
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const second = await screen.findByLabelText(/Amount \(PKR\)/iu);
    expect((second as HTMLInputElement).value).toBe('14000.00');
    fireEvent.change(second, { target: { value: '15,000' } });
    const before = recorded.filter((request) => request.url.endsWith('/payments')).length;
    fireEvent.click(
      screen.getByRole('button', { name: 'Record payment', hidden: false, description: '' }),
    );
    expect(await screen.findByText(/more than the PKR 14,000.00 outstanding/iu)).toBeTruthy();
    expect(recorded.filter((request) => request.url.endsWith('/payments')).length).toBe(before);

    // Settle in full.
    fireEvent.change(second, { target: { value: '14,000' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Record payment', hidden: false, description: '' }),
    );
    expect(await screen.findByText(/receipt RCP-00002/iu)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
    // Case status is never touched by billing.
    expect(
      recorded.some(
        (request) => request.url.startsWith('/api/v1/cases') && request.method !== 'GET',
      ),
    ).toBe(false);
  });

  it('reuses one idempotency key when a failed payment is retried', async () => {
    const backend = billingBackend();
    backend.seedFinalized({ version: 3 });
    const recorded = mockApi('billing', backend);
    let failures = 1;
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (input.endsWith('/payments') && init?.method === 'POST' && failures > 0) {
        failures -= 1;
        recorded.push({
          method: 'POST',
          url: input,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return Promise.reject(new TypeError('network down'));
      }
      return original(input, init);
    });
    visit(`/invoices/${INVOICE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment', description: '' }));
    expect(await screen.findByText(/Connection problem/iu)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record payment', description: '' }));
    expect(await screen.findByText(/receipt RCP-00001/iu)).toBeTruthy();
    const posts = recorded.filter(
      (request) => request.url.endsWith('/payments') && request.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['Idempotency-Key']).toBe(posts[1]?.headers['Idempotency-Key']);
  });
});

describe('invoice states', () => {
  it('refreshes and explains a stale save instead of overwriting', async () => {
    const backend = billingBackend({ staleOnPatch: true });
    backend.handle({ method: 'POST', url: '/api/v1/invoices', headers: {}, body: {} });
    mockApi('billing', backend);
    visit(`/invoices/${INVOICE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: /save draft/iu }));
    expect(await screen.findByText(/changed while you were working/iu)).toBeTruthy();
  });

  it('shows a failed PDF with a retry that stores it', async () => {
    const backend = billingBackend({ pdfFails: true });
    backend.seedFinalized({ pdfState: 'failed' });
    mockApi('billing', backend);
    visit(`/invoices/${INVOICE_ID}`);
    expect(await screen.findByText('PDF could not be stored')).toBeTruthy();
    expect(screen.getByText(/The invoice is saved/iu)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /generate pdf again/iu }));
    expect(await screen.findByText('PDF ready')).toBeTruthy();
    expect(backend.pdfCalls).toHaveLength(1);
  });

  it('lets read-only users view but not change an invoice', async () => {
    const backend = billingBackend();
    backend.seedFinalized({ version: 3 });
    mockApi('read_only', backend);
    visit(`/invoices/${INVOICE_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: /INV-00001/u })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
    expect(screen.queryByRole('button', { name: /void invoice/iu })).toBeNull();
  });

  it('offers reversal only to roles that hold the reverse permission', async () => {
    for (const [role, visible] of [
      ['manager', true],
      ['billing', false],
    ] as const) {
      const backend = billingBackend();
      backend.seedFinalized({
        paidMinor: 500_000,
        outstandingMinor: 1_000_000,
        paymentStatus: 'partially_paid',
      });
      backend.seedPayment();
      mockApi(role, backend);
      visit(`/invoices/${INVOICE_ID}`);
      await screen.findByText(/RCP-00001/u);
      expect(screen.queryByRole('button', { name: 'Reverse payment RCP-00001' }) !== null).toBe(
        visible,
      );
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('voids an unpaid invoice only with a reason and keeps it visible', async () => {
    const backend = billingBackend();
    backend.seedFinalized({ version: 3 });
    const recorded = mockApi('billing', backend);
    visit(`/invoices/${INVOICE_ID}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Void invoice' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Void invoice', description: '' }));
    expect(await screen.findByText('Enter the reason for voiding this invoice.')).toBeTruthy();
    expect(recorded.some((request) => request.url.endsWith('/void'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Issued in error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void invoice', description: '' }));
    expect(await screen.findByText(/This invoice was voided/iu)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: /INV-00001/u })).toBeTruthy();
    expect(recorded.find((request) => request.url.endsWith('/void'))?.body).toEqual({
      reason: 'Issued in error',
      confirm: true,
    });
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
  });

  it('does not offer a void once payments exist', async () => {
    const backend = billingBackend();
    backend.seedFinalized({
      paidMinor: 100,
      outstandingMinor: 1_499_900,
      paymentStatus: 'partially_paid',
    });
    backend.seedPayment();
    mockApi('billing', backend);
    visit(`/invoices/${INVOICE_ID}`);
    await screen.findByText(/RCP-00001/u);
    expect(screen.queryByRole('button', { name: 'Void invoice' })).toBeNull();
  });

  it('blocks consultants from the invoice area', async () => {
    mockApi('consultant', billingBackend());
    visit('/invoices');
    expect(await screen.findByText(/You do not have permission/iu)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Invoices' })).toBeNull();
  });

  it('lists invoices with filters and an empty state', async () => {
    const backend = billingBackend();
    const recorded = mockApi('manager', backend);
    visit('/invoices');
    expect(await screen.findByText('No invoices yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    await waitFor(() => {
      expect(recorded.some((request) => request.url.includes('status=draft'))).toBe(true);
    });
    expect(await screen.findByText('No invoices match these filters')).toBeTruthy();
  });

  it('has no accessibility violations on the draft and finalized views', async () => {
    const backend = billingBackend();
    backend.handle({ method: 'POST', url: '/api/v1/invoices', headers: {}, body: {} });
    mockApi('billing', backend);
    const { container } = visit(`/invoices/${INVOICE_ID}`);
    await screen.findByRole('button', { name: /save draft/iu });
    expect((await axe(container)).violations).toEqual([]);
    cleanup();

    const finalized = billingBackend();
    finalized.seedFinalized({ version: 3 });
    mockApi('manager', finalized);
    const view = visit(`/invoices/${INVOICE_ID}`);
    await screen.findByRole('heading', { level: 1, name: /INV-00001/u });
    expect((await axe(view.container)).violations).toEqual([]);
  });
});
