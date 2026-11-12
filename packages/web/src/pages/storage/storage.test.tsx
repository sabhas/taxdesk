import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type CurrentSession,
  type ReconciliationRun,
  type RoleKey,
  type StorageConnection,
} from '@taxdesk/shared';
import { App } from '../../App.js';
import { resetStorageCallbacksForTests } from './StorageCallbackPage.js';
import { storageNavigation } from './StorageSettingsPage.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetStorageCallbacksForTests();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const CONNECTION_ID = '0198a000-0000-7000-8000-0000000000e9';
const RUN_ID = '0198a000-0000-7000-8000-0000000000ea';
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

function connection(overrides: Partial<StorageConnection> = {}): StorageConnection {
  return {
    id: CONNECTION_ID,
    providerType: 'onedrive',
    status: 'healthy',
    healthReason: null,
    accountLabel: 'Synthetic Firm Storage',
    connectedAt: NOW,
    connectedByName: 'Test Person',
    lastCheckedAt: NOW,
    lastRefreshedAt: NOW,
    version: 3,
    configured: true,
    permissions: { manage: true },
    ...overrides,
  };
}

const run: ReconciliationRun = {
  id: RUN_ID,
  state: 'completed',
  startedAt: NOW,
  finishedAt: NOW,
  startedByName: 'Test Person',
  connectionStatus: 'healthy',
  checkedCount: 12,
  presentCount: 10,
  missingCount: 2,
  movedCount: 0,
  recoveredCount: 0,
  nextAction: 'review_missing_documents',
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Handler = (request: Recorded) => Response | undefined;

function mockApi(role: RoleKey, handlers: Handler[] = []): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      recorded.push(request);
      for (const handler of handlers) {
        const response = handler(request);
        if (response !== undefined) return Promise.resolve(response);
      }
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      if (input === '/api/v1/storage/reconciliation' && request.method === 'GET') {
        return Promise.resolve(json({ runs: [run] }));
      }
      return Promise.resolve(problem(500, 'INTERNAL_ERROR', `Unmocked ${request.method} ${input}`));
    }),
  );
  return recorded;
}

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
}

describe('storage settings (TD-403, TD-404, TD-410)', () => {
  it('shows a healthy connection and reconciliation history to administrators', async () => {
    mockApi('administrator', [
      (r) => (r.url === '/api/v1/storage/connection' ? json(connection()) : undefined),
    ]);
    window.history.replaceState({}, '', '/settings/storage');
    const rendered = render(<App />);
    expect(await screen.findByText('Synthetic Firm Storage')).toBeInTheDocument();
    expect(screen.getByText('Connected', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(screen.getByText('Microsoft OneDrive')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Document storage' })).toBeInTheDocument();
    expect(
      await screen.findByText(/Review documents marked "Missing in storage"/u),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect storage/u })).not.toBeInTheDocument();
    await expectNoSeriousViolations(rendered.container);
  });

  it('starts consent and sends the browser to the provider', async () => {
    const assign = vi.spyOn(storageNavigation, 'assign').mockImplementation(() => undefined);
    const recorded = mockApi('administrator', [
      (r) =>
        r.url === '/api/v1/storage/connection'
          ? json(
              connection({
                id: null,
                providerType: null,
                status: 'not_connected',
                accountLabel: null,
                connectedAt: null,
                connectedByName: null,
                lastCheckedAt: null,
                lastRefreshedAt: null,
                version: null,
              }),
            )
          : undefined,
      (r) =>
        r.url === '/api/v1/storage/connection/authorize'
          ? json({
              authorizationUrl: 'https://login.example.test/authorize?state=abc',
              expiresAt: NOW,
            })
          : undefined,
    ]);
    window.history.replaceState({}, '', '/settings/storage');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect storage' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://login.example.test/authorize?state=abc');
    });
    const authorize = recorded.find((r) => r.url === '/api/v1/storage/connection/authorize');
    expect(authorize?.method).toBe('POST');
    expect(authorize?.headers['X-Request-Id']).toBeTruthy();
  });

  it('explains reconnect-required health and shows callback outcomes', async () => {
    mockApi('administrator', [
      (r) =>
        r.url === '/api/v1/storage/connection'
          ? json(connection({ status: 'reconnect_required', healthReason: 'consent_revoked' }))
          : undefined,
    ]);
    window.history.replaceState({}, '', '/settings/storage?result=denied');
    render(<App />);
    expect(
      await screen.findByText(/Access to the storage account was withdrawn/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect storage' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Connection not approved' })).toBeInTheDocument();
  });

  it('shows a success banner after connecting', async () => {
    mockApi('administrator', [
      (r) => (r.url === '/api/v1/storage/connection' ? json(connection()) : undefined),
    ]);
    window.history.replaceState({}, '', '/settings/storage?result=connected');
    render(<App />);
    expect(await screen.findByText(/TaxDesk can now store documents/u)).toBeInTheDocument();
  });

  it('disconnects with If-Match and reloads on a version conflict', async () => {
    let gets = 0;
    const recorded = mockApi('administrator', [
      (r) => {
        if (r.url !== '/api/v1/storage/connection') return undefined;
        if (r.method === 'DELETE') {
          return problem(412, 'PRECONDITION_FAILED', 'The connection changed.');
        }
        gets += 1;
        return json(connection({ version: gets === 1 ? 3 : 4 }));
      },
    ]);
    window.history.replaceState({}, '', '/settings/storage');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByRole('heading', { name: 'The connection changed' }),
    ).toBeInTheDocument();
    const deletion = recorded.find((r) => r.method === 'DELETE');
    expect(deletion?.headers['If-Match']).toBe('"3"');
    await waitFor(() => {
      expect(gets).toBe(2);
    });
  });

  it('runs reconciliation and reports the result', async () => {
    mockApi('administrator', [
      (r) => (r.url === '/api/v1/storage/connection' ? json(connection()) : undefined),
      (r) =>
        r.url === '/api/v1/storage/reconciliation' && r.method === 'POST'
          ? json(
              {
                ...run,
                id: '0198a000-0000-7000-8000-0000000000eb',
                missingCount: 0,
                nextAction: 'none',
              },
              201,
            )
          : undefined,
    ]);
    window.history.replaceState({}, '', '/settings/storage');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run reconciliation' }));
    expect(
      await screen.findByText('Reconciliation checked 12 documents: 0 missing, 0 moved.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing to do/u)).toBeInTheDocument();
  });

  it('hides the page from non-administrators', async () => {
    const recorded = mockApi('manager');
    window.history.replaceState({}, '', '/settings/storage');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'You do not have permission' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Document storage' })).not.toBeInTheDocument();
    expect(recorded.some((r) => r.url.startsWith('/api/v1/storage'))).toBe(false);
  });
});

describe('storage consent callback (TD-403)', () => {
  const COMPLETE = '/api/v1/storage/connection/complete';

  function settings(r: Recorded): Response | undefined {
    return r.url === '/api/v1/storage/connection' ? json(connection()) : undefined;
  }

  it('posts the code once (even under StrictMode), strips it from the URL, and shows the result', async () => {
    const recorded = mockApi('administrator', [
      settings,
      (r) => (r.url === COMPLETE ? json({ result: 'connected' }) : undefined),
    ]);
    window.history.replaceState({}, '', '/settings/storage/callback?code=abc123&state=st-1');
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByText(/TaxDesk can now store documents/u)).toBeInTheDocument();
    const posts = recorded.filter((r) => r.url === COMPLETE);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe('POST');
    expect(posts[0]?.headers['X-Request-Id']).toBeTruthy();
    expect(posts[0]?.body).toEqual({ code: 'abc123', state: 'st-1' });
    expect(window.location.pathname).toBe('/settings/storage');
    expect(window.location.search).toBe('?result=connected');
    expect(window.location.href).not.toContain('abc123');
  });

  it('forwards a provider error and shows the outcome the API reports', async () => {
    const recorded = mockApi('administrator', [
      settings,
      (r) => (r.url === COMPLETE ? json({ result: 'denied' }) : undefined),
    ]);
    window.history.replaceState(
      {},
      '',
      '/settings/storage/callback?error=access_denied&error_description=The+user+declined',
    );
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Connection not approved' }),
    ).toBeInTheDocument();
    expect(recorded.find((r) => r.url === COMPLETE)?.body).toEqual({
      error: 'access_denied',
      error_description: 'The user declined',
    });
  });

  it('falls back to a failed result when the API call fails', async () => {
    mockApi('administrator', [
      settings,
      (r) =>
        r.url === COMPLETE ? problem(503, 'STORAGE_UNAVAILABLE', 'Provider down.') : undefined,
    ]);
    window.history.replaceState({}, '', '/settings/storage/callback?code=abc&state=st-2');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Connection failed' })).toBeInTheDocument();
    expect(window.location.search).toBe('?result=failed');
  });

  it('shows an accessible status while finishing', async () => {
    let release: (response: Response) => void = () => undefined;
    mockApi('administrator', [settings]);
    const base = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) =>
      input === COMPLETE
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : base!(input, init),
    );
    window.history.replaceState({}, '', '/settings/storage/callback?code=abc&state=st-3');
    const rendered = render(<App />);
    expect(await screen.findByText('Finishing connection…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Finishing connection…');
    expect(window.location.search).toBe('');
    await expectNoSeriousViolations(rendered.container);
    release(json({ result: 'connected' }));
    expect(await screen.findByText(/TaxDesk can now store documents/u)).toBeInTheDocument();
  });

  it('refuses users without storage.manage and sends nothing', async () => {
    const recorded = mockApi('manager');
    window.history.replaceState({}, '', '/settings/storage/callback?code=abc&state=st-4');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'You do not have permission' }),
    ).toBeInTheDocument();
    expect(recorded.some((r) => r.url === COMPLETE)).toBe(false);
  });
});
