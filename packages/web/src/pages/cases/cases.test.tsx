import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import {
  STARTER_WORKFLOW_DEFINITION,
  checklistProgress,
  permissionsForRoles,
  type CaseListItem,
  type CurrentSession,
  type RoleKey,
  type ServiceType,
  type TaxCase,
  type WorkflowTemplate,
  type WorkflowVersion,
} from '@taxdesk/shared';
import { App } from '../../App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const REVIEWER_ID = '0198a000-0000-7000-8000-000000000002';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const SERVICE_ID = '0198a000-0000-7000-8000-0000000000e1';
const TEMPLATE_ID = '0198a000-0000-7000-8000-0000000000f1';
const VERSION_ID = '0198a000-0000-7000-8000-0000000000f2';
const CASE_ID = '0198a000-0000-7000-8000-0000000000a1';
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

const service: ServiceType = {
  id: SERVICE_ID,
  name: 'Individual return',
  description: '',
  defaultFeeMinor: 1_500_000,
  defaultDeadlineOffsetDays: 30,
  duplicateCasePolicy: 'warn',
  defaultWorkflowTemplate: { id: TEMPLATE_ID, name: 'Annual return' },
  state: 'active',
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
};

const people = [
  { id: USER_ID, displayName: 'Test Person' },
  { id: REVIEWER_ID, displayName: 'Review Person' },
];

/**
 * A small stateful stand-in for the case API. It applies the same rules the
 * server does for the paths a browser exercises (transitions, the checklist
 * gate, preparer/reviewer steps) so the UI can be driven end to end.
 */
function caseBackend() {
  const definition = STARTER_WORKFLOW_DEFINITION;
  let current: TaxCase | null = null;

  const refresh = (record: TaxCase): TaxCase => {
    const progress = checklistProgress(record.checklist);
    const open = record.status.kind === 'open';
    const transitions = definition.transitions
      .filter((transition) => transition.from === record.status.key)
      .map((transition) => {
        const target = definition.statuses.find((status) => status.key === transition.to)!;
        return {
          to: { key: target.key, name: target.name, kind: target.kind },
          blockedReason:
            target.requiresChecklistComplete && progress.requiredOutstanding > 0
              ? `${String(progress.requiredOutstanding)} required checklist items are not complete and verified.`
              : null,
        };
      });
    return {
      ...record,
      checklistProgress: progress,
      availableTransitions: record.state === 'archived' ? [] : transitions,
      allowedActions: {
        edit: open,
        assign: open,
        transition: transitions.length > 0,
        prepareChecklist: open,
        reviewChecklist: open,
        archive:
          record.state === 'active' &&
          (record.status.kind === 'completed' || record.status.kind === 'cancelled'),
      },
    };
  };

  const create = (body: Record<string, unknown>): TaxCase => {
    const initial = definition.statuses.find((status) => status.initial)!;
    current = refresh({
      id: CASE_ID,
      caseCode: 'TC-00001',
      client: { id: CLIENT_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
      service: { id: SERVICE_ID, name: service.name, feeMinor: service.defaultFeeMinor },
      taxYear: body['taxYear'] as number,
      workflow: {
        templateId: TEMPLATE_ID,
        versionId: VERSION_ID,
        templateName: 'Annual return',
        versionNumber: 1,
        statuses: definition.statuses,
        transitions: definition.transitions,
      },
      status: { key: initial.key, name: initial.name, kind: initial.kind },
      dueDate: body['dueDate'] as string,
      urgency: null,
      primaryConsultant: people[0]!,
      reviewer: body['reviewerUserId'] === REVIEWER_ID ? people[1]! : null,
      notes: '',
      checklist: definition.checklist.map((item, index) => ({
        id: `0198a000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
        key: item.key,
        label: item.label,
        documentType: item.documentType,
        required: item.required,
        reviewRequired: item.reviewRequired,
        instructions: item.instructions,
        state: 'open',
        completedBy: null,
        completedAt: null,
        preparerComment: '',
        reviewedBy: null,
        reviewedAt: null,
        reviewComment: '',
        version: 1,
      })),
      checklistProgress: checklistProgress([]),
      availableTransitions: [],
      allowedActions: {
        edit: true,
        assign: true,
        transition: true,
        prepareChecklist: true,
        reviewChecklist: true,
        archive: false,
      },
      state: 'active',
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    });
    return current;
  };

  const handle = (
    method: string,
    url: string,
    body: Record<string, unknown>,
  ): Response | undefined => {
    if (method === 'POST' && url === '/api/v1/cases') {
      return json(create(body), 201);
    }
    if (current === null) return undefined;
    const record = current;
    if (method === 'GET' && url === `/api/v1/cases/${CASE_ID}`) return json(record);
    if (url === `/api/v1/cases/${CASE_ID}/status-history`) return json({ entries: [] });
    if (url.startsWith(`/api/v1/cases/${CASE_ID}/activity`)) {
      return json({ events: [], nextCursor: null });
    }
    if (method === 'POST' && url === `/api/v1/cases/${CASE_ID}/transitions`) {
      const target = record.availableTransitions.find(
        (transition) => transition.to.key === body['toStatus'],
      );
      if (target === undefined) return problem(409, 'TRANSITION_NOT_ALLOWED', 'Not allowed.');
      if (target.blockedReason !== null) {
        return problem(409, 'CHECKLIST_INCOMPLETE', target.blockedReason);
      }
      current = refresh({ ...record, status: target.to, version: record.version + 1 });
      return json(current);
    }
    if (method === 'POST' && url === `/api/v1/cases/${CASE_ID}/archive`) {
      current = refresh({
        ...record,
        state: 'archived',
        archivedAt: NOW,
        version: record.version + 1,
      });
      return json(current);
    }
    const match = /\/checklist\/([^/]+)\/(complete|verify|reject|reopen)$/u.exec(url);
    if (method === 'POST' && match !== null) {
      const [, itemId, action] = match;
      current = refresh({
        ...record,
        checklist: record.checklist.map((item) => {
          if (item.id !== itemId) return item;
          const state =
            action === 'complete'
              ? 'completed'
              : action === 'verify'
                ? 'verified'
                : action === 'reject'
                  ? 'rejected'
                  : 'open';
          return {
            ...item,
            state,
            completedBy: action === 'complete' ? people[0]! : item.completedBy,
            completedAt: action === 'complete' ? NOW : item.completedAt,
            reviewedBy: action === 'verify' || action === 'reject' ? people[1]! : null,
            reviewedAt: action === 'verify' || action === 'reject' ? NOW : null,
            reviewComment: typeof body['comment'] === 'string' ? body['comment'] : '',
            version: item.version + 1,
          };
        }),
      });
      return json(current);
    }
    return undefined;
  };

  return { handle, current: () => current };
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type Handler = (request: Recorded) => Response | undefined;

const template: WorkflowTemplate = {
  id: TEMPLATE_ID,
  name: 'Annual return',
  description: '',
  latestPublished: { id: VERSION_ID, versionNumber: 1, state: 'published', publishedAt: NOW },
  draft: null,
  updatedAt: NOW,
  version: 1,
  versions: [{ id: VERSION_ID, versionNumber: 1, state: 'published', publishedAt: NOW }],
  createdAt: NOW,
};

function mockApi(role: RoleKey, handlers: Handler[] = []): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      recorded.push(request);
      for (const handler of handlers) {
        const response = handler(request);
        if (response !== undefined) return response;
      }
      if (input === '/api/v1/auth/session') return json(sessionFor(role));
      if (input.startsWith('/api/v1/service-types')) return json({ serviceTypes: [service] });
      if (input === '/api/v1/workflow-templates') {
        return json({
          templates: [
            {
              id: template.id,
              name: template.name,
              description: template.description,
              latestPublished: template.latestPublished,
              draft: template.draft,
              updatedAt: template.updatedAt,
              version: template.version,
            },
          ],
        });
      }
      if (input === '/api/v1/cases/assignees') return json({ assignees: people });
      if (input.startsWith('/api/v1/cases/queue-counts')) {
        return json({ my: 1, team: 2, unassigned: 0, due_soon: 1, overdue: 1 });
      }
      if (input.startsWith('/api/v1/clients?')) {
        return json({
          clients: [
            {
              id: CLIENT_ID,
              clientCode: 'CL-00001',
              type: 'individual',
              legalName: 'Synthetic Client',
              displayName: 'Synthetic Client',
              cnicMasked: '•••••-••••567-1',
              ntnMasked: null,
              primaryContact: null,
              assignedManager: null,
              state: 'active',
              updatedAt: NOW,
            },
          ],
          nextCursor: null,
        });
      }
      return problem(500, 'INTERNAL_ERROR', `Unmocked ${request.method} ${input}`);
    }),
  );
  return recorded;
}

function at(path: string): void {
  window.history.replaceState({}, '', path);
}

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
}

function listItem(overrides: Partial<CaseListItem> = {}): CaseListItem {
  return {
    id: CASE_ID,
    caseCode: 'TC-00001',
    client: { id: CLIENT_ID, clientCode: 'CL-00001', displayName: 'Synthetic Client' },
    serviceName: 'Individual return',
    taxYear: 2026,
    status: { key: 'intake', name: 'Intake', kind: 'open' },
    dueDate: '2026-05-20',
    urgency: 'overdue',
    primaryConsultant: people[0]!,
    reviewer: null,
    state: 'active',
    updatedAt: NOW,
    ...overrides,
  };
}

describe('case queues (TD-308)', () => {
  it('shows queue counts and an accessible list, sending filters to the server', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/cases?')
          ? json({ cases: [listItem()], nextCursor: null, total: 1 })
          : undefined,
    ]);
    at('/cases');
    const rendered = render(<App />);
    expect(await screen.findByRole('link', { name: 'TC-00001' })).toBeInTheDocument();
    expect(screen.getByText('Overdue', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    const queues = screen.getByRole('navigation', { name: 'Case queues' });
    expect(within(queues).getByRole('button', { name: /Team/u })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(queues).getByLabelText('2 cases')).toBeInTheDocument();
    await expectNoSeriousViolations(rendered.container);

    fireEvent.click(within(queues).getByRole('button', { name: /Overdue/u }));
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: SERVICE_ID } });
    await waitFor(() => {
      const list = recorded.filter((r) => r.url.startsWith('/api/v1/cases?')).at(-1);
      expect(list?.url).toContain('view=overdue');
      expect(list?.url).toContain(`service=${SERVICE_ID}`);
      const counts = recorded.filter((r) => r.url.startsWith('/api/v1/cases/queue-counts')).at(-1);
      expect(counts?.url).toContain(`service=${SERVICE_ID}`);
    });
  });

  it('defaults consultants to My work and hides configuration navigation', async () => {
    const recorded = mockApi('consultant', [
      (r) =>
        r.url.startsWith('/api/v1/cases?')
          ? json({ cases: [], nextCursor: null, total: 0 })
          : undefined,
    ]);
    at('/cases');
    render(<App />);
    expect(await screen.findByText('Nothing in My work')).toBeInTheDocument();
    expect(recorded.find((r) => r.url.startsWith('/api/v1/cases?'))?.url).toContain('view=my');
    expect(screen.queryByRole('link', { name: 'Services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Workflows' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cases' })).toBeInTheDocument();
  });
});

describe('case lifecycle in the browser (TD-304–TD-310)', () => {
  it('opens a case from a client and runs it through completion and archive', async () => {
    const backend = caseBackend();
    const recorded = mockApi('manager', [(r) => backend.handle(r.method, r.url, r.body)]);
    at(`/cases/new?client=${CLIENT_ID}`);
    const rendered = render(<App />);

    const serviceSelect = await screen.findByLabelText('Service');
    await screen.findByRole('option', { name: 'Individual return' });
    fireEvent.change(serviceSelect, { target: { value: SERVICE_ID } });
    // The service fills its default workflow and a due date from its offset.
    expect(screen.getByLabelText('Workflow')).toHaveValue(VERSION_ID);
    expect(screen.getByLabelText<HTMLInputElement>('Due date').value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );
    fireEvent.change(screen.getByLabelText('Primary consultant'), { target: { value: USER_ID } });
    fireEvent.change(screen.getByLabelText('Reviewer (optional)'), {
      target: { value: REVIEWER_ID },
    });
    await expectNoSeriousViolations(rendered.container);
    fireEvent.click(screen.getByRole('button', { name: 'Open case' }));

    expect(await screen.findByText('Case TC-00001 opened.')).toBeInTheDocument();
    const create = recorded.find((r) => r.method === 'POST' && r.url === '/api/v1/cases');
    expect(create?.body).toMatchObject({
      clientId: CLIENT_ID,
      serviceTypeId: SERVICE_ID,
      workflowVersionId: VERSION_ID,
      primaryConsultantUserId: USER_ID,
      reviewerUserId: REVIEWER_ID,
    });
    expect(create?.headers['X-Request-Id']).toBeDefined();

    // Filed is blocked until the checklist is complete and verified.
    const move = async (name: string) => {
      fireEvent.click(await screen.findByRole('button', { name }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: `Move to ${name}` }));
      await screen.findByText(`Status changed to ${name}.`);
    };
    await move('Collecting documents');
    await move('In preparation');
    await move('In review');
    expect(screen.getByRole('button', { name: 'Filed' })).toBeDisabled();
    expect(screen.getByText(/3 required checklist items/u)).toBeInTheDocument();
    await expectNoSeriousViolations(rendered.container);

    for (const item of STARTER_WORKFLOW_DEFINITION.checklist.filter((entry) => entry.required)) {
      fireEvent.click(screen.getByRole('button', { name: `Complete ${item.label}` }));
      let dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));
      await screen.findByText(`Complete: ${item.label}.`);
      if (item.reviewRequired) {
        fireEvent.click(screen.getByRole('button', { name: `Verify ${item.label}` }));
        dialog = await screen.findByRole('alertdialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
        await screen.findByText(`Verify: ${item.label}.`);
      }
    }
    expect(screen.getByText(/all required items done/u)).toBeInTheDocument();

    await move('Filed');
    expect(screen.getByText(/The checklist is locked/u)).toBeInTheDocument();
    await move('Completed');
    expect(backend.current()?.status.kind).toBe('completed');

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive case' }));
    expect(await screen.findByText('Case archived. Its history is kept.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    const transitions = recorded.filter((r) => r.url.endsWith('/transitions'));
    expect(transitions.every((r) => typeof r.headers['If-Match'] === 'string')).toBe(true);
  });

  it('requires a comment to return an item and explains a stale-version conflict', async () => {
    const backend = caseBackend();
    backend.handle('POST', '/api/v1/cases', {
      taxYear: 2026,
      dueDate: '2026-09-30',
      reviewerUserId: REVIEWER_ID,
    });
    let conflict = true;
    mockApi('manager', [
      (r) => {
        if (r.url.endsWith('/transitions') && conflict) {
          conflict = false;
          return problem(412, 'PRECONDITION_FAILED', 'Stale.');
        }
        return backend.handle(r.method, r.url, r.body);
      },
    ]);
    at(`/cases/${CASE_ID}`);
    render(<App />);

    const item = STARTER_WORKFLOW_DEFINITION.checklist.find((entry) => entry.reviewRequired)!;
    fireEvent.click(await screen.findByRole('button', { name: `Complete ${item.label}` }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Complete' }),
    );
    await screen.findByText(`Complete: ${item.label}.`);
    fireEvent.click(screen.getByRole('button', { name: `Return ${item.label}` }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Return' }));
    expect(await within(dialog).findByText('Explain what needs to change.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Wrong year' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Return' }));
    expect(await screen.findByText('Reviewer: Wrong year')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collecting documents' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Move to Collecting documents',
      }),
    );
    expect(await screen.findByText('This case changed')).toBeInTheDocument();
  });

  it('shows read-only users the case without work actions', async () => {
    const backend = caseBackend();
    backend.handle('POST', '/api/v1/cases', { taxYear: 2026, dueDate: '2026-09-30' });
    const readOnly = backend.current()!;
    mockApi('read_only', [
      (r) =>
        r.url === `/api/v1/cases/${CASE_ID}`
          ? json({
              ...readOnly,
              allowedActions: {
                edit: false,
                assign: false,
                transition: false,
                prepareChecklist: false,
                reviewChecklist: false,
                archive: false,
              },
            })
          : backend.handle(r.method, r.url, r.body),
    ]);
    at(`/cases/${CASE_ID}`);
    const rendered = render(<App />);
    expect(
      await screen.findByText('Only assigned staff or a manager can move this case.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Complete/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    await expectNoSeriousViolations(rendered.container);
  });
});

describe('service and workflow configuration (TD-301–TD-303)', () => {
  it('creates a service with the fee converted to minor units', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.method === 'POST' && r.url === '/api/v1/service-types'
          ? json(
              { ...service, id: '0198a000-0000-7000-8000-0000000000e2', name: 'Sales tax return' },
              201,
            )
          : undefined,
    ]);
    at('/services');
    const rendered = render(<App />);
    expect(
      await screen.findByRole('button', { name: 'Edit Individual return' }),
    ).toBeInTheDocument();
    await expectNoSeriousViolations(rendered.container);
    fireEvent.click(screen.getByRole('button', { name: 'New service' }));
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Sales tax return' },
    });
    fireEvent.change(screen.getByLabelText(/Default fee/u), { target: { value: '12,500.50' } });
    fireEvent.change(screen.getByLabelText('Default deadline (days)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Duplicate open cases'), { target: { value: 'block' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create service' }));
    expect(await screen.findByText('Service created.')).toBeInTheDocument();
    const create = recorded.find((r) => r.method === 'POST' && r.url === '/api/v1/service-types');
    expect(create?.body).toMatchObject({
      name: 'Sales tax return',
      defaultFeeMinor: 1_250_050,
      defaultDeadlineOffsetDays: 15,
      duplicateCasePolicy: 'block',
    });
  });

  it('shows draft validation issues and blocks publishing until they are fixed', async () => {
    const draftVersion: WorkflowVersion = {
      id: VERSION_ID,
      templateId: TEMPLATE_ID,
      templateName: 'Annual return',
      versionNumber: 1,
      state: 'draft',
      definition: STARTER_WORKFLOW_DEFINITION,
      issues: [],
      publishedAt: null,
      publishedBy: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    const recorded = mockApi('manager', [
      (r) =>
        r.url === `/api/v1/workflow-templates/${TEMPLATE_ID}`
          ? json({
              ...template,
              latestPublished: null,
              draft: { id: VERSION_ID, versionNumber: 1, state: 'draft', publishedAt: null },
              versions: [{ id: VERSION_ID, versionNumber: 1, state: 'draft', publishedAt: null }],
            })
          : undefined,
      (r) =>
        r.url === `/api/v1/workflow-templates/${TEMPLATE_ID}/versions/${VERSION_ID}`
          ? json(
              r.method === 'PUT'
                ? { ...draftVersion, definition: r.body['definition'], version: 2 }
                : draftVersion,
            )
          : undefined,
    ]);
    at(`/workflows/${TEMPLATE_ID}`);
    const rendered = render(<App />);
    const publish = await screen.findByRole('button', { name: 'Publish version 1' });
    expect(publish).toBeEnabled();
    await expectNoSeriousViolations(rendered.container);

    // Making a second status initial is caught before the server is asked.
    const radios = screen.getAllByRole('radio', { name: 'Initial' });
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'From Intake to Collecting documents' }));
    expect(await screen.findByText('Fix these before publishing')).toBeInTheDocument();
    expect(
      screen.getByText(/cannot be reached from the initial status|has no way forward/u),
    ).toBeInTheDocument();
    expect(publish).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    const save = recorded.find((r) => r.method === 'PUT');
    expect(save?.headers['If-Match']).toBe('"1"');
  });
});
