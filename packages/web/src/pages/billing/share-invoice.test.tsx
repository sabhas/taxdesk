import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type CurrentSession,
  type Invoice,
  type InvoiceShareContext,
  type RoleKey,
} from '@taxdesk/shared';
import { App } from '../../App.js';

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const INVOICE_ID = '0198a000-0000-7000-8000-0000000000b1';
const NOW = '2026-06-01T04:00:00.000Z';
const PATH = `/invoices/${INVOICE_ID}`;
const SHARE_URL = `/api/v1/invoices/${INVOICE_ID}/share`;
const SHARES_URL = `/api/v1/invoices/${INVOICE_ID}/shares`;
const PDF_URL = `/api/v1/invoices/${INVOICE_ID}/pdf`;

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

const finalized: Invoice = {
  id: INVOICE_ID,
  invoiceNumber: 'INV-00001',
  status: 'finalized',
  paymentStatus: 'unpaid',
  billingMode: 'individual',
  currency: 'PKR',
  client: { id: CLIENT_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
  case: null,
  issueDate: '2026-06-01',
  dueDate: '2026-06-30',
  items: [
    {
      id: '0198a000-0000-7000-8000-0000000001a1',
      position: 1,
      description: 'Advisory',
      quantity: 1,
      unitAmountMinor: 1_500_000,
      lineTotalMinor: 1_500_000,
      client: null,
      case: null,
    },
  ],
  subtotalMinor: 1_500_000,
  discountMinor: 0,
  totalMinor: 1_500_000,
  paidMinor: 0,
  outstandingMinor: 1_500_000,
  notes: '',
  pdfState: 'ready',
  finalizedAt: NOW,
  voidReason: null,
  voidedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 3,
};

const context: InvoiceShareContext = {
  invoiceId: INVOICE_ID,
  invoiceNumber: 'INV-00001',
  fileName: 'INV-00001.pdf',
  title: 'Invoice INV-00001 from Synthetic Firm',
  message:
    'Dear Synthetic Client,\n\nPlease find attached invoice INV-00001 from Synthetic Firm.\nTotal: PKR 15,000.00',
  whatsappPhone: '923001234567',
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly init: RequestInit;
}

type Handler = (call: Call) => Response | undefined;

function mockApi(role: RoleKey, invoice: Invoice, handler: Handler = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', url, init };
      calls.push(call);
      if (url === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      const handled = handler(call);
      if (handled !== undefined) return Promise.resolve(handled);
      if (url === `/api/v1/invoices/${INVOICE_ID}`) return Promise.resolve(json(invoice));
      if (url === `/api/v1/invoices/${INVOICE_ID}/payments`) {
        return Promise.resolve(json({ payments: [] }));
      }
      if (url === SHARE_URL) return Promise.resolve(json(context));
      if (url === PDF_URL) {
        return Promise.resolve(
          new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
            headers: { 'Content-Type': 'application/pdf' },
          }),
        );
      }
      if (url === SHARES_URL && call.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(problem(404, 'NOT_FOUND', 'Not found.'));
    }),
  );
  return calls;
}

function setShareSupport(share: ((data: ShareData) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  Object.defineProperty(navigator, 'canShare', {
    value: share === undefined ? undefined : () => true,
    configurable: true,
  });
}

function visit() {
  window.history.replaceState({}, '', PATH);
  return render(<App />);
}

async function openShare(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
  return await screen.findByRole('alertdialog', { name: 'Share invoice INV-00001' });
}

const sharesRecorded = (calls: Call[]) =>
  calls.filter((call) => call.url === SHARES_URL && call.method === 'POST');

const createObjectURL = vi.fn((_file: Blob) => 'blob:invoice');

beforeEach(() => {
  createObjectURL.mockClear();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setShareSupport(undefined);
  window.history.replaceState({}, '', '/');
});

describe('sharing an invoice (TD-513)', () => {
  it('shares the PDF and message through the device share sheet and records it', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    setShareSupport(share);
    const calls = mockApi('billing', finalized);
    const rendered = visit();
    const dialog = await openShare();
    expect(await within(dialog).findByText(/Please find attached invoice INV-00001/u)).toBeTruthy();
    expect(within(dialog).getByText(/WhatsApp opens a chat with \+92 300 1234567/u)).toBeTruthy();
    await expectNoSeriousViolations(rendered.baseElement);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Share PDF…' }));
    expect(await screen.findByText('Invoice INV-00001 shared.')).toBeTruthy();
    const data = share.mock.calls[0]?.[0];
    expect(data?.files?.[0]?.name).toBe('INV-00001.pdf');
    expect(data?.files?.[0]?.type).toBe('application/pdf');
    expect(data?.text).toBe(context.message);
    const recorded = sharesRecorded(calls);
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0]?.init.body as string)).toEqual({ channel: 'share_sheet' });
    expect((recorded[0]?.init.headers as Record<string, string>)['X-Request-Id']).toBeTruthy();
  });

  it('shows preparing and busy states, and warns when a completed share is not recorded', async () => {
    let finishShare: (() => void) | undefined;
    setShareSupport(
      () =>
        new Promise<void>((resolve) => {
          finishShare = resolve;
        }),
    );
    let releaseContext: (() => void) | undefined;
    const contextReady = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    mockApi('billing', finalized, (call) =>
      call.url === SHARES_URL
        ? problem(503, 'SERVICE_UNAVAILABLE', 'TaxDesk is temporarily unavailable.')
        : undefined,
    );
    const fetchMock = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === SHARE_URL) {
          await contextReady;
        }
        return await fetchMock(url, init);
      }),
    );
    visit();
    const dialog = await openShare();
    expect(within(dialog).getByText('Preparing the invoice for sharing…')).toBeTruthy();
    releaseContext?.();
    const button = await within(dialog).findByRole('button', { name: 'Share PDF…' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveAttribute('aria-busy', 'true');
    });
    expect(button).toBeDisabled();
    finishShare?.();
    expect(await screen.findByRole('heading', { name: 'Shared, but not recorded' })).toBeTruthy();
    expect(screen.getByText(/missing from the invoice history/u)).toBeTruthy();
    expect(screen.queryByText('Invoice INV-00001 shared.')).toBeNull();
  });

  it('records nothing when the share sheet is cancelled', async () => {
    setShareSupport(() => Promise.reject(new DOMException('Cancelled', 'AbortError')));
    const calls = mockApi('billing', finalized);
    visit();
    const dialog = await openShare();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Share PDF…' }));
    expect(
      await within(dialog).findByText('Sharing was cancelled. Nothing was sent.'),
    ).toBeTruthy();
    expect(sharesRecorded(calls)).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Share PDF…' })).not.toBeDisabled();
  });

  it('offers WhatsApp with the message and phone when the browser cannot share files', async () => {
    setShareSupport(undefined);
    const calls = mockApi('read_only', finalized);
    visit();
    const dialog = await openShare();
    const link = await within(dialog).findByRole('link', { name: 'Send on WhatsApp' });
    expect(within(dialog).queryByRole('button', { name: 'Share PDF…' })).toBeNull();
    expect(within(dialog).getByText(/cannot attach files to a share/u)).toBeTruthy();
    const href = new URL(link.getAttribute('href') ?? '');
    expect(href.origin + href.pathname).toBe('https://wa.me/923001234567');
    expect(href.searchParams.get('text')).toBe(context.message);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    // jsdom cannot follow the hidden download link; record which file it saves.
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    fireEvent.click(link);
    expect(await screen.findByText(/Attach the downloaded file INV-00001.pdf/u)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(['INV-00001.pdf']);
    const recorded = sharesRecorded(calls);
    expect(JSON.parse(recorded[0]?.init.body as string)).toEqual({ channel: 'whatsapp' });
  });

  it('leaves the WhatsApp chat to staff when the client has no phone', async () => {
    mockApi('billing', finalized, (call) =>
      call.url === SHARE_URL ? json({ ...context, whatsappPhone: null }) : undefined,
    );
    visit();
    const dialog = await openShare();
    const link = await within(dialog).findByRole('link', { name: 'Send on WhatsApp' });
    expect(link.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/u);
    expect(within(dialog).getByText(/no phone on file/u)).toBeTruthy();
  });

  it('explains a failed PDF download and retries it', async () => {
    let failures = 1;
    const calls = mockApi('billing', finalized, (call) => {
      if (call.url === PDF_URL && failures > 0) {
        failures -= 1;
        return problem(503, 'STORAGE_UNAVAILABLE', 'Document storage is unavailable.');
      }
      return undefined;
    });
    visit();
    const dialog = await openShare();
    expect(await within(dialog).findByText('Could not download the invoice PDF')).toBeTruthy();
    expect(within(dialog).queryByRole('link', { name: 'Send on WhatsApp' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('link', { name: 'Send on WhatsApp' })).toBeTruthy();
    expect(sharesRecorded(calls)).toHaveLength(0);
  });

  it('shows the server refusal when sharing is not allowed', async () => {
    mockApi('billing', finalized, (call) =>
      call.url === SHARE_URL ? problem(403, 'FORBIDDEN', 'Forbidden.') : undefined,
    );
    visit();
    const dialog = await openShare();
    expect(await within(dialog).findByRole('heading', { name: 'Access denied' })).toBeTruthy();
  });

  it('hides Share and says why for void invoices and invoices without a stored PDF', async () => {
    for (const [invoice, reason] of [
      [{ ...finalized, status: 'void' as const, voidedAt: NOW }, 'Void invoices cannot be shared.'],
      [
        { ...finalized, pdfState: 'failed' as const },
        'Share becomes available once the invoice PDF is stored.',
      ],
    ] as const) {
      mockApi('billing', invoice);
      visit();
      expect(await screen.findByText(reason)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
      cleanup();
    }
  });

  it('tells staff a draft must be finalized before it can be shared', async () => {
    mockApi('read_only', {
      ...finalized,
      status: 'draft',
      invoiceNumber: null,
      issueDate: null,
      finalizedAt: null,
      pdfState: 'none',
    });
    visit();
    expect(
      await screen.findByText(
        'Drafts cannot be shared. Finalize the invoice to download or share it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});

async function expectNoSeriousViolations(container: Element): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toHaveLength(0);
}
