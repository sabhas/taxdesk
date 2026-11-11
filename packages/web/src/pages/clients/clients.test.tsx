import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type Client,
  type ClientListItem,
  type CurrentSession,
  type RoleKey,
} from '@taxdesk/shared';
import { App } from '../../App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const MANAGER_ID = '0198a000-0000-7000-8000-000000000002';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const NOW = '2026-01-01T00:00:00.000Z';

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
      idleExpiresAt: '2026-01-01T00:30:00.000Z',
      absoluteExpiresAt: '2026-01-01T12:00:00.000Z',
      mfaVerified: true,
    },
  };
}

function client(overrides: Partial<Client> = {}): Client {
  return {
    id: CLIENT_ID,
    clientCode: 'CL-00001',
    type: 'individual',
    legalName: 'Test Individual',
    displayName: 'Test Individual',
    cnicMasked: '•••••-••••567-1',
    ntnMasked: null,
    contacts: [
      {
        id: '0198a000-0000-7000-8000-0000000000d1',
        name: 'Self',
        relationship: null,
        email: 'one@example.test',
        phone: '0300 1112223',
        isPrimary: true,
      },
    ],
    notes: 'Synthetic notes.',
    assignedManager: { id: MANAGER_ID, displayName: 'Manager Person' },
    state: 'active',
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function listItem(source: Client): ClientListItem {
  return {
    id: source.id,
    clientCode: source.clientCode,
    type: source.type,
    legalName: source.legalName,
    displayName: source.displayName,
    cnicMasked: source.cnicMasked,
    ntnMasked: source.ntnMasked,
    primaryContact: source.contacts[0] ?? null,
    assignedManager: source.assignedManager,
    state: source.state,
    updatedAt: source.updatedAt,
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

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Handler = (request: Recorded) => Response | undefined;

/** Routes fetches by method and path; every request is recorded for assertions. */
function mockApi(role: RoleKey, handlers: Handler[]): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      recorded.push(request);
      if (input === '/api/v1/auth/session') {
        return json(sessionFor(role));
      }
      if (input === '/api/v1/clients/assignees') {
        return json({ assignees: [{ id: MANAGER_ID, displayName: 'Manager Person' }] });
      }
      for (const handler of handlers) {
        const response = handler(request);
        if (response !== undefined) {
          return response;
        }
      }
      return problem(500, 'INTERNAL_ERROR', `Unmocked ${request.method} ${input}`);
    }),
  );
  return recorded;
}

function at(path: string): void {
  window.history.replaceState({}, '', path);
}

describe('client list (TD-204)', () => {
  it('lists clients with masked identifiers and no serious accessibility violations', async () => {
    mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/clients?')
          ? json({ clients: [listItem(client())], nextCursor: null })
          : undefined,
    ]);
    at('/clients');
    const rendered = render(<App />);
    expect(await screen.findByRole('link', { name: 'Test Individual' })).toBeInTheDocument();
    expect(screen.getByText('•••••-••••567-1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New client' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page');
    const results = await axe(rendered.container);
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });

  it('sends search and filters to the server and shows a no-results state', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/clients?') ? json({ clients: [], nextCursor: null }) : undefined,
    ]);
    at('/clients');
    render(<App />);
    await screen.findByText('No clients yet');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'traders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No clients match these filters')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'business' } });
    await waitFor(() => {
      const last = recorded.filter((r) => r.url.startsWith('/api/v1/clients?')).at(-1);
      expect(last?.url).toContain('q=traders');
      expect(last?.url).toContain('type=business');
      expect(last?.url).toContain('state=active');
    });
    fireEvent.click(screen.getByRole('button', { name: 'clear all filters' }));
    expect(await screen.findByText('No clients yet')).toBeInTheDocument();
  });

  it('loads the next page with the cursor', async () => {
    const recorded = mockApi('manager', [
      (r) => {
        if (!r.url.startsWith('/api/v1/clients?')) return undefined;
        return r.url.includes('cursor=')
          ? json({
              clients: [
                listItem(
                  client({
                    id: '0198a000-0000-7000-8000-0000000000c2',
                    displayName: 'Second Client',
                    clientCode: 'CL-00002',
                  }),
                ),
              ],
              nextCursor: null,
            })
          : json({ clients: [listItem(client())], nextCursor: 'next-page' });
      },
    ]);
    at('/clients');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more clients' }));
    expect(await screen.findByRole('link', { name: 'Second Client' })).toBeInTheDocument();
    expect(recorded.some((r) => r.url.includes('cursor=next-page'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more clients' })).not.toBeInTheDocument();
  });

  it('tells consultants they see only assigned clients and hides creation', async () => {
    mockApi('consultant', [
      (r) =>
        r.url.startsWith('/api/v1/clients?') ? json({ clients: [], nextCursor: null }) : undefined,
    ]);
    at('/clients');
    render(<App />);
    expect(await screen.findByText(/assigned to you as manager/u)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New client' })).not.toBeInTheDocument();
  });
});

describe('create client (TD-201, TD-202, TD-205)', () => {
  it('shows field-level validation without calling the API', async () => {
    const recorded = mockApi('manager', []);
    at('/clients/new');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check and create client' }));
    const legalName = await screen.findByLabelText('Legal name (required)');
    expect(legalName).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('CNIC (required)')).toHaveAttribute('aria-invalid', 'true');
    expect(legalName).toHaveFocus();
    expect(recorded.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('switches required identifier by type', async () => {
    mockApi('manager', []);
    at('/clients/new');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Client type'), {
      target: { value: 'business' },
    });
    expect(screen.queryByLabelText('CNIC (required)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('NTN (required)')).toBeInTheDocument();
  });

  function fillIndividual(): void {
    fireEvent.change(screen.getByLabelText('Legal name (required)'), {
      target: { value: 'New Individual' },
    });
    fireEvent.change(screen.getByLabelText('CNIC (required)'), {
      target: { value: '42101-7654321-9' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Self' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'one@example.test' } });
  }

  it('requires a reason to override a duplicate warning and sends it', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.url === '/api/v1/clients/duplicate-check'
          ? json({
              blocking: [],
              warnings: [
                {
                  clientId: CLIENT_ID,
                  clientCode: 'CL-00001',
                  displayName: 'Test Individual',
                  state: 'active',
                  reasons: ['email'],
                },
              ],
            })
          : undefined,
      (r) =>
        r.url === '/api/v1/clients' && r.method === 'POST'
          ? json(client({ id: '0198a000-0000-7000-8000-0000000000c9' }), 201)
          : undefined,
      (r) =>
        r.url.startsWith('/api/v1/clients/0198a000-0000-7000-8000-0000000000c9')
          ? r.url.includes('/activity')
            ? json({ events: [], nextCursor: null })
            : json(client({ id: '0198a000-0000-7000-8000-0000000000c9' }))
          : undefined,
    ]);
    at('/clients/new');
    const rendered = render(<App />);
    await screen.findByLabelText('Legal name (required)');
    fillIndividual();
    fireEvent.click(screen.getByRole('button', { name: 'Check and create client' }));
    expect(
      await screen.findByRole('heading', { name: 'This client may already exist' }),
    ).toHaveFocus();
    expect(screen.getByText(/same email/u)).toBeInTheDocument();
    const results = await axe(rendered.container);
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    expect(
      await screen.findByLabelText('Reason for creating a separate client (required)'),
    ).toHaveAttribute('aria-invalid', 'true');
    expect(recorded.filter((r) => r.url === '/api/v1/clients' && r.method === 'POST')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Reason for creating a separate client (required)'), {
      target: { value: 'Spouses share a household email.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create anyway' }));
    expect(await screen.findByText('Client created.')).toBeInTheDocument();
    const created = recorded.find((r) => r.url === '/api/v1/clients' && r.method === 'POST');
    expect(created?.body).toMatchObject({
      type: 'individual',
      cnic: '42101-7654321-9',
      duplicateOverrideReason: 'Spouses share a household email.',
    });
  });

  it('blocks an exact identifier duplicate with no override', async () => {
    mockApi('manager', [
      (r) =>
        r.url === '/api/v1/clients/duplicate-check'
          ? json({
              blocking: [
                {
                  clientId: CLIENT_ID,
                  clientCode: 'CL-00001',
                  displayName: 'Test Individual',
                  state: 'archived',
                  reasons: ['cnic'],
                },
              ],
              warnings: [],
            })
          : undefined,
    ]);
    at('/clients/new');
    render(<App />);
    await screen.findByLabelText('Legal name (required)');
    fillIndividual();
    fireEvent.click(screen.getByRole('button', { name: 'Check and create client' }));
    expect(
      await screen.findByRole('heading', { name: 'This client already exists' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Test Individual \(CL-00001/u }).closest('li'),
    ).toHaveTextContent('same CNIC (archived)');
    expect(screen.queryByRole('button', { name: 'Create anyway' })).not.toBeInTheDocument();
  });

  it('denies the create page to roles without clients.manage', async () => {
    mockApi('read_only', []);
    at('/clients/new');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'You do not have permission' }),
    ).toBeInTheDocument();
  });
});

describe('edit client conflicts (TD-203)', () => {
  it('preserves unsaved input and shows it beside the latest saved version', async () => {
    let getCount = 0;
    const recorded = mockApi('manager', [
      (r) => {
        if (r.url === `/api/v1/clients/${CLIENT_ID}` && r.method === 'GET') {
          getCount += 1;
          return json(
            getCount === 1
              ? client()
              : client({
                  legalName: 'Colleague Saved Name',
                  displayName: 'Colleague Saved Name',
                  version: 2,
                }),
          );
        }
        if (r.url === `/api/v1/clients/${CLIENT_ID}` && r.method === 'PATCH') {
          return r.headers['If-Match'] === '"1"'
            ? problem(412, 'PRECONDITION_FAILED', 'This client changed since you loaded it.')
            : json(client({ legalName: 'My Unsaved Name', version: 3 }));
        }
        if (r.url.startsWith(`/api/v1/clients/${CLIENT_ID}/activity`)) {
          return json({ events: [], nextCursor: null });
        }
        return undefined;
      },
    ]);
    at(`/clients/${CLIENT_ID}/edit`);
    const rendered = render(<App />);
    const legalName = await screen.findByLabelText('Legal name (required)');
    expect(screen.getByLabelText('CNIC')).toHaveValue('');
    expect(screen.getByText(/Stored as •••••-••••567-1/u)).toBeInTheDocument();
    fireEvent.change(legalName, { target: { value: 'My Unsaved Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const heading = await screen.findByRole('heading', { name: 'Someone else saved this client' });
    expect(heading).toHaveFocus();
    const table = screen.getByRole('table', {
      name: 'Your unsaved input compared with the latest saved version',
    });
    const row = within(table).getByRole('row', { name: /Legal name/u });
    expect(row).toHaveTextContent('My Unsaved Name');
    expect(row).toHaveTextContent('Colleague Saved Name');
    expect(row).toHaveTextContent('Differs');
    expect(screen.getByLabelText('Legal name (required)')).toHaveValue('My Unsaved Name');
    const results = await axe(rendered.container);
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Save my changes over the latest' }));
    expect(await screen.findByText('Client saved.')).toBeInTheDocument();
    const patches = recorded.filter((r) => r.method === 'PATCH');
    expect(patches.map((r) => r.headers['If-Match'])).toEqual(['"1"', '"2"']);
    expect(patches[1]?.body).not.toHaveProperty('cnic');
  });

  it('can discard unsaved input in favour of the latest version', async () => {
    let getCount = 0;
    mockApi('manager', [
      (r) => {
        if (r.url === `/api/v1/clients/${CLIENT_ID}` && r.method === 'GET') {
          getCount += 1;
          return json(
            getCount === 1 ? client() : client({ legalName: 'Colleague Saved Name', version: 2 }),
          );
        }
        if (r.method === 'PATCH') {
          return problem(412, 'PRECONDITION_FAILED', 'Stale.');
        }
        return undefined;
      },
    ]);
    at(`/clients/${CLIENT_ID}/edit`);
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Legal name (required)'), {
      target: { value: 'My Unsaved Name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Discard my changes and use the latest' }),
    );
    expect(screen.getByLabelText('Legal name (required)')).toHaveValue('Colleague Saved Name');
  });
});

describe('client detail, archive, and activity (TD-202, TD-206)', () => {
  function detailHandlers(current: { value: Client }): Handler[] {
    return [
      (r) => {
        if (r.url.startsWith(`/api/v1/clients/${CLIENT_ID}/activity`)) {
          return json({
            events: [
              {
                id: '0198a000-0000-7000-8000-0000000000e1',
                occurredAt: NOW,
                action: 'client.updated',
                actor: { id: MANAGER_ID, displayName: 'Manager Person' },
                changedFields: ['cnic', 'notes'],
                cnicMasked: '•••••-••••567-1',
                ntnMasked: null,
                overrideReason: null,
              },
            ],
            nextCursor: null,
          });
        }
        if (r.url === `/api/v1/clients/${CLIENT_ID}/archive` && r.method === 'POST') {
          current.value = client({ state: 'archived', archivedAt: NOW, version: 2 });
          return json(current.value);
        }
        if (r.url === `/api/v1/clients/${CLIENT_ID}`) {
          return json(current.value);
        }
        return undefined;
      },
    ];
  }

  it('shows summary, contacts, assignment, and masked activity', async () => {
    mockApi('read_only', detailHandlers({ value: client() }));
    at(`/clients/${CLIENT_ID}`);
    const rendered = render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Test Individual', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Manager Person').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'one@example.test' })).toBeInTheDocument();
    expect(screen.getByText('Changed: CNIC, Notes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    const results = await axe(rendered.container);
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });

  it('archives only after explicit confirmation, sending the version', async () => {
    const current = { value: client() };
    const recorded = mockApi('manager', detailHandlers(current));
    at(`/clients/${CLIENT_ID}`);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('hidden from default search');
    expect(recorded.some((r) => r.url.endsWith('/archive'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive client' }));
    expect(await screen.findByText('Client archived.')).toBeInTheDocument();
    const archive = recorded.find((r) => r.url.endsWith('/archive'));
    expect(archive?.headers['If-Match']).toBe('"1"');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows the denial without revealing the record', async () => {
    mockApi('consultant', [
      (r) =>
        r.url.startsWith(`/api/v1/clients/${CLIENT_ID}`)
          ? problem(403, 'FORBIDDEN', 'You do not have permission to perform this action.')
          : undefined,
    ]);
    at(`/clients/${CLIENT_ID}`);
    render(<App />);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to clients' })).toBeInTheDocument();
  });
});
