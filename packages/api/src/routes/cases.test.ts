/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  STARTER_WORKFLOW_DEFINITION,
  type RoleKey,
  type WorkflowDefinition,
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

let counter = 0;
const PASSWORD = 'correct horse battery staple';

interface CallOptions {
  method?: string;
  body?: unknown;
  cookie: string;
  ifMatch?: string | number;
}

interface Called {
  status: number;
  etag: string | null;
  data: Record<string, any>;
}

type Actor = RoleKey | 'consultant2';

interface World {
  harness: TestHarness;
  app: Hono<AppEnv>;
  cookies: Record<Actor, string>;
  ids: Record<Actor, string>;
  call: (path: string, options: Omit<CallOptions, 'cookie'> & { as: Actor }) => Promise<Called>;
}

async function world(): Promise<World> {
  // 2026-06-01 09:00 in Karachi.
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z') });
  await seedFirm(harness);
  const app = createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
  const cookies = {} as Record<Actor, string>;
  const ids = {} as Record<Actor, string>;
  const people: [Actor, RoleKey][] = [
    ['administrator', 'administrator'],
    ['manager', 'manager'],
    ['consultant', 'consultant'],
    ['consultant2', 'consultant'],
    ['billing', 'billing'],
    ['read_only', 'read_only'],
  ];
  for (const [name, role] of people) {
    const { user } = await seedUser(harness, {
      username: `staff-${name.replace('_', '-')}`,
      displayName: `Staff ${name}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[name] = (await sessionCookieFor(harness, user)).cookie;
    ids[name] = user.id;
  }
  const call = async (
    path: string,
    options: Omit<CallOptions, 'cookie'> & { as: Actor },
  ): Promise<Called> => {
    // Separate requests happen at separate instants; keeps UUIDv7 order stable.
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': `cases-${String(++counter)}`,
      Cookie: cookies[options.as],
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.ifMatch !== undefined) {
      headers['If-Match'] =
        typeof options.ifMatch === 'number' ? `"${String(options.ifMatch)}"` : options.ifMatch;
    }
    const response = await app.request(
      path,
      {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const text = await response.text();
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      data: text.length === 0 ? {} : (JSON.parse(text) as Record<string, any>),
    };
  };
  return { harness, app, cookies, ids, call };
}

let cnicCounter = 1;

async function createClient(w: World, assignedManager: Actor | null = 'consultant') {
  const cnic = `35202-${String(1_000_000 + cnicCounter++).padStart(7, '0')}-1`;
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

async function publishedTemplate(
  w: World,
  definition: WorkflowDefinition = STARTER_WORKFLOW_DEFINITION,
  name = 'Annual return',
) {
  const created = await w.call('/api/v1/workflow-templates', {
    as: 'manager',
    method: 'POST',
    body: { name, definition },
  });
  expect(created.status).toBe(201);
  const draftId = created.data['draft'].id as string;
  const published = await w.call(
    `/api/v1/workflow-templates/${created.data['id'] as string}/versions/${draftId}/publish`,
    { as: 'manager', method: 'POST', ifMatch: 1 },
  );
  expect(published.status).toBe(200);
  return { templateId: created.data['id'] as string, versionId: draftId };
}

async function createService(w: World, overrides: Record<string, unknown> = {}) {
  const result = await w.call('/api/v1/service-types', {
    as: 'manager',
    method: 'POST',
    body: {
      name: 'Individual income tax return',
      defaultFeeMinor: 1_500_000,
      defaultDeadlineOffsetDays: 30,
      duplicateCasePolicy: 'warn',
      defaultWorkflowTemplateId: null,
      ...overrides,
    },
  });
  expect(result.status).toBe(201);
  return result.data;
}

async function setup(w: World) {
  const template = await publishedTemplate(w);
  const service = await createService(w, { defaultWorkflowTemplateId: template.templateId });
  const client = await createClient(w);
  return { template, service, client };
}

function caseBody(
  w: World,
  fixture: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    clientId: fixture.client['id'],
    serviceTypeId: fixture.service['id'],
    taxYear: 2026,
    workflowVersionId: fixture.template.versionId,
    dueDate: '2026-09-30',
    primaryConsultantUserId: w.ids.consultant,
    reviewerUserId: w.ids.consultant2,
    ...overrides,
  };
}

async function openCase(
  w: World,
  fixture: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
) {
  const result = await w.call('/api/v1/cases', {
    as: 'manager',
    method: 'POST',
    body: caseBody(w, fixture, overrides),
  });
  expect(result.status).toBe(201);
  return result.data;
}

/** Runs the preparer/reviewer steps that satisfy every required item. */
async function satisfyChecklist(w: World, taxCase: Record<string, any>) {
  let latest = taxCase;
  for (const item of taxCase['checklist'] as Record<string, any>[]) {
    if (!item['required']) continue;
    const completed = await w.call(
      `/api/v1/cases/${latest['id'] as string}/checklist/${item['id'] as string}/complete`,
      { as: 'consultant', method: 'POST', body: {}, ifMatch: item['version'] as number },
    );
    expect(completed.status).toBe(200);
    latest = completed.data;
    if (item['reviewRequired']) {
      const current = (latest['checklist'] as Record<string, any>[]).find(
        (entry) => entry['id'] === item['id'],
      )!;
      const verified = await w.call(
        `/api/v1/cases/${latest['id'] as string}/checklist/${item['id'] as string}/verify`,
        { as: 'consultant2', method: 'POST', body: {}, ifMatch: current['version'] as number },
      );
      expect(verified.status).toBe(200);
      latest = verified.data;
    }
  }
  return latest;
}

async function move(
  w: World,
  taxCase: Record<string, any>,
  toStatus: string,
  as: Actor = 'consultant',
) {
  return await w.call(`/api/v1/cases/${taxCase['id'] as string}/transitions`, {
    as,
    method: 'POST',
    body: { toStatus, note: `Moved to ${toStatus}` },
    ifMatch: taxCase['version'] as number,
  });
}

describe('service types (TD-301)', () => {
  it('lets a manager create, edit, archive, restore, and list services', async () => {
    const w = await world();
    const service = await createService(w);
    expect(service).toMatchObject({
      defaultFeeMinor: 1_500_000,
      defaultDeadlineOffsetDays: 30,
      duplicateCasePolicy: 'warn',
      state: 'active',
      version: 1,
    });

    const id = service['id'] as string;
    const noIfMatch = await w.call(`/api/v1/service-types/${id}`, {
      as: 'manager',
      method: 'PATCH',
      body: { ...service, defaultFeeMinor: 2_000_000 },
    });
    expect(noIfMatch.status).toBe(428);
    const editBody = {
      name: 'Individual return',
      description: 'Salaried individuals',
      defaultFeeMinor: 2_000_000,
      defaultDeadlineOffsetDays: 45,
      duplicateCasePolicy: 'block',
      defaultWorkflowTemplateId: null,
    };
    const edited = await w.call(`/api/v1/service-types/${id}`, {
      as: 'manager',
      method: 'PATCH',
      body: editBody,
      ifMatch: 1,
    });
    expect(edited.status).toBe(200);
    expect(edited.etag).toBe('"2"');
    const stale = await w.call(`/api/v1/service-types/${id}`, {
      as: 'manager',
      method: 'PATCH',
      body: editBody,
      ifMatch: 1,
    });
    expect(stale.status).toBe(412);

    const archived = await w.call(`/api/v1/service-types/${id}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 2,
    });
    expect(archived.data['state']).toBe('archived');
    expect((await w.call('/api/v1/service-types', { as: 'manager' })).data['serviceTypes']).toEqual(
      [],
    );
    const all = await w.call('/api/v1/service-types?state=all', { as: 'consultant' });
    expect(all.data['serviceTypes']).toHaveLength(1);
    const restored = await w.call(`/api/v1/service-types/${id}/restore`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 3,
    });
    expect(restored.data['state']).toBe('active');

    const actions = w.harness.state.auditEvents
      .filter((event) => event.entityId === id)
      .map((event) => event.action);
    expect(actions).toEqual([
      'service_type.created',
      'service_type.updated',
      'service_type.archived',
      'service_type.restored',
    ]);
  });

  it('rejects duplicate active names and non-manager writes', async () => {
    const w = await world();
    await createService(w);
    const duplicate = await w.call('/api/v1/service-types', {
      as: 'manager',
      method: 'POST',
      body: {
        name: 'INDIVIDUAL income tax return',
        defaultFeeMinor: 0,
        defaultDeadlineOffsetDays: 0,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: null,
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data['code']).toBe('SERVICE_TYPE_NAME_EXISTS');
    for (const role of ['consultant', 'billing', 'read_only'] as const) {
      const denied = await w.call('/api/v1/service-types', {
        as: role,
        method: 'POST',
        body: {
          name: 'X',
          defaultFeeMinor: 0,
          defaultDeadlineOffsetDays: 0,
          duplicateCasePolicy: 'warn',
          defaultWorkflowTemplateId: null,
        },
      });
      expect(denied.status, role).toBe(403);
    }
    const fractional = await w.call('/api/v1/service-types', {
      as: 'manager',
      method: 'POST',
      body: {
        name: 'Y',
        defaultFeeMinor: 10.5,
        defaultDeadlineOffsetDays: 0,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: null,
      },
    });
    expect(fractional.status).toBe(400);
  });

  it('keeps the service name and fee a case copied when the service later changes', async () => {
    const w = await world();
    const fixture = await setup(w);
    const taxCase = await openCase(w, fixture);
    await w.call(`/api/v1/service-types/${fixture.service['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: 1,
      body: {
        name: 'Renamed service',
        description: '',
        defaultFeeMinor: 9_900_000,
        defaultDeadlineOffsetDays: 10,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: null,
      },
    });
    const reread = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    expect(reread.data['service']).toEqual({
      id: fixture.service['id'],
      name: 'Individual income tax return',
      feeMinor: 1_500_000,
    });
  });
});

describe('workflow and checklist templates (TD-302, TD-303)', () => {
  it('validates before publishing and freezes published versions', async () => {
    const w = await world();
    const broken: WorkflowDefinition = structuredClone(STARTER_WORKFLOW_DEFINITION);
    broken.statuses = broken.statuses.map((status) => ({ ...status, initial: false }));
    broken.statuses.push({
      key: 'orphan',
      name: 'Orphan',
      kind: 'open',
      initial: false,
      requiresChecklistComplete: false,
    });
    const created = await w.call('/api/v1/workflow-templates', {
      as: 'manager',
      method: 'POST',
      body: { name: 'Draft template', definition: broken },
    });
    expect(created.status).toBe(201);
    const templateId = created.data['id'] as string;
    const draftId = created.data['draft'].id as string;
    const draftPath = `/api/v1/workflow-templates/${templateId}/versions/${draftId}`;

    const draft = await w.call(draftPath, { as: 'consultant' });
    expect(draft.data['state']).toBe('draft');
    expect(draft.data['issues'].length).toBeGreaterThan(0);

    const refused = await w.call(`${draftPath}/publish`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 1,
    });
    expect(refused.status).toBe(400);
    expect(refused.data['code']).toBe('WORKFLOW_INVALID');
    const fieldMessages = (refused.data['errors'] as { message: string }[]).map((e) => e.message);
    expect(fieldMessages).toContain('Mark exactly one status as the initial status.');

    const fixed = await w.call(draftPath, {
      as: 'manager',
      method: 'PUT',
      ifMatch: 1,
      body: { definition: STARTER_WORKFLOW_DEFINITION },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.data['issues']).toEqual([]);
    const published = await w.call(`${draftPath}/publish`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 2,
    });
    expect(published.status).toBe(200);
    expect(published.data).toMatchObject({ state: 'published', versionNumber: 1 });
    expect(published.data['publishedBy']).toEqual({
      id: w.ids.manager,
      displayName: 'Staff manager',
    });

    const edit = await w.call(draftPath, {
      as: 'manager',
      method: 'PUT',
      ifMatch: 3,
      body: { definition: STARTER_WORKFLOW_DEFINITION },
    });
    expect(edit.status).toBe(409);
    expect(edit.data['code']).toBe('WORKFLOW_VERSION_PUBLISHED');

    const forbidden = await w.call(`/api/v1/workflow-templates/${templateId}/versions`, {
      as: 'consultant',
      method: 'POST',
    });
    expect(forbidden.status).toBe(403);
  });

  it('publishes a new version without changing cases opened on the old one', async () => {
    const w = await world();
    const fixture = await setup(w);
    const taxCase = await openCase(w, fixture);
    const templateId = fixture.template.templateId;

    const v2 = await w.call(`/api/v1/workflow-templates/${templateId}/versions`, {
      as: 'manager',
      method: 'POST',
    });
    expect(v2.status).toBe(201);
    expect(v2.data['versionNumber']).toBe(2);
    const again = await w.call(`/api/v1/workflow-templates/${templateId}/versions`, {
      as: 'manager',
      method: 'POST',
    });
    expect(again.data['code']).toBe('WORKFLOW_DRAFT_EXISTS');

    const changed: WorkflowDefinition = structuredClone(STARTER_WORKFLOW_DEFINITION);
    changed.checklist = [
      {
        key: 'engagement_letter',
        label: 'Signed engagement letter',
        documentType: null,
        required: true,
        reviewRequired: false,
        instructions: '',
      },
    ];
    const v2Path = `/api/v1/workflow-templates/${templateId}/versions/${v2.data['id'] as string}`;
    await w.call(v2Path, {
      as: 'manager',
      method: 'PUT',
      ifMatch: 1,
      body: { definition: changed },
    });
    await w.call(`${v2Path}/publish`, { as: 'manager', method: 'POST', ifMatch: 2 });

    const template = await w.call(`/api/v1/workflow-templates/${templateId}`, { as: 'manager' });
    expect(template.data['latestPublished'].versionNumber).toBe(2);
    expect(template.data['versions']).toHaveLength(2);

    const existing = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, { as: 'manager' });
    expect(existing.data['workflow'].versionNumber).toBe(1);
    expect((existing.data['checklist'] as { key: string }[]).map((item) => item.key)).toEqual(
      STARTER_WORKFLOW_DEFINITION.checklist.map((item) => item.key),
    );

    const v1 = await w.call(
      `/api/v1/workflow-templates/${templateId}/versions/${fixture.template.versionId}`,
      { as: 'manager' },
    );
    expect(v1.data['definition']).toEqual(STARTER_WORKFLOW_DEFINITION);
  });
});

describe('creating a tax case (TD-304)', () => {
  it('requires the core fields and copies the workflow and checklist snapshot', async () => {
    const w = await world();
    const fixture = await setup(w);
    const missing = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: { ...caseBody(w, fixture), dueDate: undefined },
    });
    expect(missing.status).toBe(400);

    const created = await openCase(w, fixture);
    expect(created).toMatchObject({
      caseCode: 'TC-00001',
      taxYear: 2026,
      dueDate: '2026-09-30',
      status: { key: 'intake', name: 'Intake', kind: 'open' },
      primaryConsultant: { id: w.ids.consultant },
      reviewer: { id: w.ids.consultant2 },
      workflow: { versionNumber: 1, templateName: 'Annual return' },
      checklistProgress: {
        total: 4,
        required: 3,
        completed: 0,
        verified: 0,
        requiredOutstanding: 3,
      },
    });
    expect(created['workflow'].statuses).toEqual(STARTER_WORKFLOW_DEFINITION.statuses);
    const history = await w.call(`/api/v1/cases/${created['id'] as string}/status-history`, {
      as: 'manager',
    });
    expect(history.data['entries']).toHaveLength(1);
    expect(history.data['entries'][0]).toMatchObject({ from: null, to: { key: 'intake' } });
  });

  it('warns on a duplicate active case and accepts an audited override', async () => {
    const w = await world();
    const fixture = await setup(w);
    const first = await openCase(w, fixture);
    const warned = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture),
    });
    expect(warned.status).toBe(409);
    expect(warned.data['code']).toBe('CASE_DUPLICATE_WARNING');
    expect(warned.data['detail']).toContain(first['caseCode'] as string);

    const overridden = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: {
        ...caseBody(w, fixture),
        duplicateOverrideReason: 'Amended return for the same year.',
      },
    });
    expect(overridden.status).toBe(201);
    const override = w.harness.state.auditEvents.find(
      (event) => event.action === 'case.duplicate_override',
    );
    expect(override?.metadata).toMatchObject({ matchedCases: 'TC-00001' });

    // A different tax year is not a duplicate.
    const otherYear = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture, { taxYear: 2025 }),
    });
    expect(otherYear.status).toBe(201);
  });

  it('blocks a duplicate when the service policy says so', async () => {
    const w = await world();
    const template = await publishedTemplate(w);
    const service = await createService(w, { duplicateCasePolicy: 'block' });
    const client = await createClient(w);
    const fixture = { template, service, client };
    await openCase(w, fixture);
    const blocked = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: { ...caseBody(w, fixture), duplicateOverrideReason: 'Trying to override anyway.' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.data['code']).toBe('CASE_DUPLICATE_BLOCKED');
  });

  it('applies assignment rules to who may open and assign a case', async () => {
    const w = await world();
    const fixture = await setup(w);
    const assignOthers = await w.call('/api/v1/cases', {
      as: 'consultant',
      method: 'POST',
      body: caseBody(w, fixture),
    });
    expect(assignOthers.status).toBe(403);
    const self = await w.call('/api/v1/cases', {
      as: 'consultant',
      method: 'POST',
      body: caseBody(w, fixture, { reviewerUserId: null }),
    });
    expect(self.status).toBe(201);
    // consultant2 does not manage this client, so cannot see or use it.
    const unseenClient = await w.call('/api/v1/cases', {
      as: 'consultant2',
      method: 'POST',
      body: caseBody(w, fixture, {
        primaryConsultantUserId: w.ids.consultant2,
        reviewerUserId: null,
        taxYear: 2024,
      }),
    });
    expect(unseenClient.status).toBe(403);
    for (const role of ['billing', 'read_only'] as const) {
      const denied = await w.call('/api/v1/cases', {
        as: role,
        method: 'POST',
        body: caseBody(w, fixture),
      });
      expect(denied.status, role).toBe(403);
    }
    const billingAssignee = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture, { primaryConsultantUserId: w.ids.billing, taxYear: 2023 }),
    });
    expect(billingAssignee.status).toBe(400);
    expect(billingAssignee.data['code']).toBe('ASSIGNEE_INVALID');
    const sameReviewer = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture, { reviewerUserId: w.ids.consultant, taxYear: 2023 }),
    });
    expect(sameReviewer.status).toBe(400);
  });

  it('refuses draft workflow versions and archived services', async () => {
    const w = await world();
    const fixture = await setup(w);
    const draft = await w.call(
      `/api/v1/workflow-templates/${fixture.template.templateId}/versions`,
      {
        as: 'manager',
        method: 'POST',
      },
    );
    const usingDraft = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture, { workflowVersionId: draft.data['id'] }),
    });
    expect(usingDraft.data['code']).toBe('WORKFLOW_VERSION_NOT_PUBLISHED');
    await w.call(`/api/v1/service-types/${fixture.service['id'] as string}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: 1,
    });
    const archivedService = await w.call('/api/v1/cases', {
      as: 'manager',
      method: 'POST',
      body: caseBody(w, fixture),
    });
    expect(archivedService.data['code']).toBe('SERVICE_TYPE_ARCHIVED');
  });
});

describe('case details and editing (TD-305)', () => {
  it('requires If-Match, audits edits, and enforces assignment rules', async () => {
    const w = await world();
    const fixture = await setup(w);
    const taxCase = await openCase(w, fixture);
    const path = `/api/v1/cases/${taxCase['id'] as string}`;
    const edit = {
      dueDate: '2026-10-15',
      notes: 'Client travelling in September.',
      primaryConsultantUserId: w.ids.consultant,
      reviewerUserId: w.ids.consultant2,
    };

    expect((await w.call(path, { as: 'manager', method: 'PATCH', body: edit })).status).toBe(428);
    const byConsultant = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: edit,
      ifMatch: 1,
    });
    expect(byConsultant.status).toBe(200);
    expect(byConsultant.data).toMatchObject({ dueDate: '2026-10-15', version: 2 });

    const reassign = await w.call(path, {
      as: 'consultant',
      method: 'PATCH',
      body: { ...edit, reviewerUserId: null },
      ifMatch: 2,
    });
    expect(reassign.status).toBe(403);
    const byManager = await w.call(path, {
      as: 'manager',
      method: 'PATCH',
      body: { ...edit, reviewerUserId: null },
      ifMatch: 2,
    });
    expect(byManager.status).toBe(200);
    expect(byManager.data['reviewer']).toBeNull();

    for (const role of ['billing', 'read_only'] as const) {
      expect((await w.call(path, { as: role })).status, role).toBe(200);
      const denied = await w.call(path, { as: role, method: 'PATCH', body: edit, ifMatch: 3 });
      expect(denied.status, role).toBe(403);
    }
    // consultant2 was removed as reviewer, so the case is no longer visible.
    expect((await w.call(path, { as: 'consultant2' })).status).toBe(403);

    const activity = await w.call(`${path}/activity`, { as: 'manager' });
    const events = activity.data['events'] as Record<string, any>[];
    expect(events.map((event) => event['action'])).toEqual([
      'case.updated',
      'case.updated',
      'case.created',
    ]);
    expect(events[0]).toMatchObject({ changedFields: ['reviewer'], reviewer: null });
    expect(events[1]).toMatchObject({ changedFields: ['dueDate', 'notes'], dueDate: '2026-10-15' });
    expect(JSON.stringify(w.harness.state.auditEvents)).not.toContain('travelling');
  });

  it('hides a missing case from consultants with the same 403 as an unassigned one', async () => {
    const w = await world();
    const missing = '0198a000-0000-7000-8000-00000000ffff';
    expect((await w.call(`/api/v1/cases/${missing}`, { as: 'consultant' })).status).toBe(403);
    expect((await w.call(`/api/v1/cases/${missing}`, { as: 'manager' })).status).toBe(404);
  });
});

describe('status transitions and checklist (TD-306, TD-307)', () => {
  it('validates transitions and gates Filed on a complete, verified checklist', async () => {
    const w = await world();
    const fixture = await setup(w);
    let taxCase = await openCase(w, fixture);

    const skip = await move(w, taxCase, 'filed');
    expect(skip.status).toBe(409);
    expect(skip.data['code']).toBe('TRANSITION_NOT_ALLOWED');

    const direct = await w.call(`/api/v1/cases/${taxCase['id'] as string}`, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: 1,
      body: {
        dueDate: '2026-09-30',
        notes: '',
        primaryConsultantUserId: w.ids.consultant,
        reviewerUserId: w.ids.consultant2,
        status: 'completed',
      },
    });
    expect(direct.status).toBe(400);

    for (const step of ['collecting_documents', 'in_preparation', 'in_review']) {
      const moved = await move(w, taxCase, step);
      expect(moved.status, step).toBe(200);
      taxCase = moved.data;
    }
    const toFiled = (taxCase['availableTransitions'] as Record<string, any>[]).find(
      (transition) => transition['to'].key === 'filed',
    );
    expect(toFiled?.['blockedReason']).toContain('3 required checklist items');
    const gated = await move(w, taxCase, 'filed');
    expect(gated.status).toBe(409);
    expect(gated.data['code']).toBe('CHECKLIST_INCOMPLETE');

    expect((await move(w, taxCase, 'in_review', 'billing')).status).toBe(403);

    taxCase = await satisfyChecklist(w, taxCase);
    expect(taxCase['checklistProgress']).toMatchObject({ requiredOutstanding: 0, verified: 2 });
    const filed = await move(w, taxCase, 'filed');
    expect(filed.status).toBe(200);
    expect(filed.data['status']).toEqual({ key: 'filed', name: 'Filed', kind: 'filed' });
    expect(filed.data['allowedActions'].prepareChecklist).toBe(false);

    const history = await w.call(`/api/v1/cases/${taxCase['id'] as string}/status-history`, {
      as: 'read_only',
    });
    const entries = history.data['entries'] as Record<string, any>[];
    expect(entries.map((entry) => entry['to'].key)).toEqual([
      'intake',
      'collecting_documents',
      'in_preparation',
      'in_review',
      'filed',
    ]);
    expect(entries.at(-1)).toMatchObject({
      from: { key: 'in_review', name: 'In review' },
      note: 'Moved to filed',
      actor: { id: w.ids.consultant },
    });
    expect(w.harness.state.caseStatusHistory).toHaveLength(5);
  });

  it('separates preparer completion from reviewer verification', async () => {
    const w = await world();
    const fixture = await setup(w);
    const taxCase = await openCase(w, fixture);
    const item = (taxCase['checklist'] as Record<string, any>[]).find(
      (entry) => entry['reviewRequired'],
    )!;
    const base = `/api/v1/cases/${taxCase['id'] as string}/checklist/${item['id'] as string}`;

    expect(
      (
        await w.call(`${base}/complete`, {
          as: 'consultant2',
          method: 'POST',
          body: {},
          ifMatch: 1,
        })
      ).status,
    ).toBe(403); // the reviewer is not the preparer
    const completed = await w.call(`${base}/complete`, {
      as: 'consultant',
      method: 'POST',
      body: { comment: 'All four accounts collected.' },
      ifMatch: 1,
    });
    expect(completed.status).toBe(200);
    const ownReview = await w.call(`${base}/verify`, {
      as: 'manager',
      method: 'POST',
      body: {},
      ifMatch: 2,
    });
    expect(ownReview.status).toBe(200); // a manager may review another person's work

    const reopened = await w.call(`${base}/reopen`, {
      as: 'manager',
      method: 'POST',
      body: {},
      ifMatch: 3,
    });
    expect(reopened.status).toBe(200);
    const byManager = await w.call(`${base}/complete`, {
      as: 'manager',
      method: 'POST',
      body: {},
      ifMatch: 4,
    });
    expect(byManager.status).toBe(200);
    const selfVerify = await w.call(`${base}/verify`, {
      as: 'manager',
      method: 'POST',
      body: {},
      ifMatch: 5,
    });
    expect(selfVerify.status).toBe(409);
    expect(selfVerify.data['code']).toBe('CHECKLIST_ACTION_NOT_ALLOWED');

    const noComment = await w.call(`${base}/reject`, {
      as: 'consultant2',
      method: 'POST',
      body: { comment: ' ' },
      ifMatch: 5,
    });
    expect(noComment.status).toBe(400);
    const rejected = await w.call(`${base}/reject`, {
      as: 'consultant2',
      method: 'POST',
      body: { comment: 'Statement for June is missing.' },
      ifMatch: 5,
    });
    expect(rejected.status).toBe(200);
    const rejectedItem = (rejected.data['checklist'] as Record<string, any>[]).find(
      (entry) => entry['id'] === item['id'],
    );
    expect(rejectedItem).toMatchObject({
      state: 'rejected',
      reviewComment: 'Statement for June is missing.',
      reviewedBy: { id: w.ids.consultant2 },
    });
    expect(rejected.data['checklistProgress'].verified).toBe(0);

    const activity = await w.call(`/api/v1/cases/${taxCase['id'] as string}/activity`, {
      as: 'manager',
    });
    expect((activity.data['events'] as Record<string, any>[])[0]).toMatchObject({
      action: 'case.checklist_rejected',
      checklistItem: item['label'],
    });
  });
});

describe('work queues (TD-308)', () => {
  it('lists my, team, unassigned, due-soon, and overdue work with matching counts', async () => {
    const w = await world();
    const fixture = await setup(w);
    // Today in the firm calendar is 2026-06-01.
    await openCase(w, fixture, { dueDate: '2026-05-20', taxYear: 2021 }); // overdue
    await openCase(w, fixture, { dueDate: '2026-06-05', taxYear: 2022 }); // due soon
    await openCase(w, fixture, {
      dueDate: '2026-09-30',
      taxYear: 2023,
      primaryConsultantUserId: null,
      reviewerUserId: null,
    }); // unassigned
    await openCase(w, fixture, {
      dueDate: '2026-09-30',
      taxYear: 2024,
      primaryConsultantUserId: w.ids.consultant2,
      reviewerUserId: null,
    });

    const counts = await w.call('/api/v1/cases/queue-counts', { as: 'manager' });
    expect(counts.data).toEqual({ my: 0, team: 4, unassigned: 1, due_soon: 1, overdue: 1 });
    for (const view of ['team', 'unassigned', 'due_soon', 'overdue'] as const) {
      const list = await w.call(`/api/v1/cases?view=${view}`, { as: 'manager' });
      expect(list.data['total'], view).toBe(counts.data[view]);
      expect(list.data['cases'], view).toHaveLength(counts.data[view] as number);
    }
    const overdue = await w.call('/api/v1/cases?view=overdue', { as: 'manager' });
    expect(overdue.data['cases'][0]).toMatchObject({ urgency: 'overdue', taxYear: 2021 });

    const mine = await w.call('/api/v1/cases/queue-counts', { as: 'consultant' });
    expect(mine.data).toEqual({ my: 2, team: 2, unassigned: 0, due_soon: 1, overdue: 1 });
    const theirs = await w.call('/api/v1/cases?view=team', { as: 'consultant2' });
    expect(theirs.data['total']).toBe(3); // reviewer on two, primary on one

    const filtered = await w.call(
      `/api/v1/cases?view=team&taxYear=2024&assignee=${w.ids.consultant2}&service=${fixture.service['id'] as string}&status=intake`,
      { as: 'manager' },
    );
    expect(filtered.data['total']).toBe(1);
    const filteredCounts = await w.call(`/api/v1/cases/queue-counts?taxYear=2021`, {
      as: 'manager',
    });
    expect(filteredCounts.data).toEqual({ my: 0, team: 1, unassigned: 0, due_soon: 0, overdue: 1 });
    const byReviewer = await w.call(`/api/v1/cases?reviewer=${w.ids.consultant2}`, {
      as: 'manager',
    });
    expect(byReviewer.data['total']).toBe(2);
    expect((await w.call('/api/v1/cases?view=nope', { as: 'manager' })).status).toBe(400);
  });

  it('pages with a cursor in due-date order', async () => {
    const w = await world();
    const fixture = await setup(w);
    for (const [index, dueDate] of ['2026-08-03', '2026-08-01', '2026-08-02'].entries()) {
      await openCase(w, fixture, { dueDate, taxYear: 2020 + index });
    }
    const first = await w.call('/api/v1/cases?limit=2', { as: 'manager' });
    expect((first.data['cases'] as { dueDate: string }[]).map((c) => c.dueDate)).toEqual([
      '2026-08-01',
      '2026-08-02',
    ]);
    expect(first.data['total']).toBe(3);
    const second = await w.call(
      `/api/v1/cases?limit=2&cursor=${first.data['nextCursor'] as string}`,
      { as: 'manager' },
    );
    expect((second.data['cases'] as { dueDate: string }[]).map((c) => c.dueDate)).toEqual([
      '2026-08-03',
    ]);
    expect(second.data['nextCursor']).toBeNull();
  });
});

describe('history, archive, and concurrency (TD-309, TD-310)', () => {
  it('runs a case from creation through completion and archive', async () => {
    const w = await world();
    const fixture = await setup(w);
    let taxCase = await openCase(w, fixture);
    const path = `/api/v1/cases/${taxCase['id'] as string}`;
    expect(
      (await w.call(`${path}/archive`, { as: 'manager', method: 'POST', ifMatch: 1 })).data['code'],
    ).toBe('CASE_NOT_CLOSED');

    taxCase = await satisfyChecklist(w, taxCase);
    for (const step of [
      'collecting_documents',
      'in_preparation',
      'in_review',
      'filed',
      'completed',
    ]) {
      const moved = await move(w, taxCase, step);
      expect(moved.status, step).toBe(200);
      taxCase = moved.data;
    }
    expect(taxCase['status'].kind).toBe('completed');
    expect(taxCase['availableTransitions']).toEqual([]);
    expect(taxCase['allowedActions']).toMatchObject({ edit: false, archive: false });
    const closedEdit = await w.call(path, {
      as: 'manager',
      method: 'PATCH',
      ifMatch: taxCase['version'] as number,
      body: {
        dueDate: '2026-12-01',
        notes: '',
        primaryConsultantUserId: null,
        reviewerUserId: null,
      },
    });
    expect(closedEdit.data['code']).toBe('CASE_CLOSED');

    const asManager = await w.call(path, { as: 'manager' });
    expect(asManager.data['allowedActions'].archive).toBe(true);
    expect(
      (
        await w.call(`${path}/archive`, {
          as: 'consultant',
          method: 'POST',
          ifMatch: asManager.data['version'],
        })
      ).status,
    ).toBe(403);
    const archived = await w.call(`${path}/archive`, {
      as: 'manager',
      method: 'POST',
      ifMatch: asManager.data['version'] as number,
    });
    expect(archived.status).toBe(200);
    expect(archived.data['state']).toBe('archived');

    const history = await w.call(`${path}/status-history`, { as: 'manager' });
    expect(history.data['entries']).toHaveLength(6);
    expect((await w.call('/api/v1/cases?view=archived', { as: 'manager' })).data['total']).toBe(1);
    expect((await w.call('/api/v1/cases?view=closed', { as: 'manager' })).data['total']).toBe(0);
    const activity = await w.call(`${path}/activity?limit=100`, { as: 'manager' });
    expect((activity.data['events'] as { action: string }[])[0]?.action).toBe('case.archived');
  });

  it('returns 412 for concurrent edits, transitions, and checklist verification', async () => {
    const w = await world();
    const fixture = await setup(w);
    const taxCase = await openCase(w, fixture);
    const path = `/api/v1/cases/${taxCase['id'] as string}`;
    const edit = (notes: string) => ({
      dueDate: '2026-09-30',
      notes,
      primaryConsultantUserId: w.ids.consultant,
      reviewerUserId: w.ids.consultant2,
    });

    // Two people loaded version 1 and both save.
    const [firstEdit, secondEdit] = await Promise.all([
      w.call(path, { as: 'manager', method: 'PATCH', body: edit('First'), ifMatch: 1 }),
      w.call(path, { as: 'consultant', method: 'PATCH', body: edit('Second'), ifMatch: 1 }),
    ]);
    expect([firstEdit.status, secondEdit.status].sort()).toEqual([200, 412]);

    const current = await w.call(path, { as: 'manager' });
    const version = current.data['version'] as number;
    const [moveA, moveB] = await Promise.all([
      w.call(`${path}/transitions`, {
        as: 'manager',
        method: 'POST',
        body: { toStatus: 'collecting_documents' },
        ifMatch: version,
      }),
      w.call(`${path}/transitions`, {
        as: 'consultant',
        method: 'POST',
        body: { toStatus: 'cancelled' },
        ifMatch: version,
      }),
    ]);
    expect([moveA.status, moveB.status].sort()).toEqual([200, 412]);
    expect(
      w.harness.state.caseStatusHistory.filter((e) => e.caseId === taxCase['id']),
    ).toHaveLength(2);

    const item = (taxCase['checklist'] as Record<string, any>[]).find((e) => e['reviewRequired'])!;
    const base = `${path}/checklist/${item['id'] as string}`;
    await w.call(`${base}/complete`, { as: 'consultant', method: 'POST', body: {}, ifMatch: 1 });
    const [verify, reject] = await Promise.all([
      w.call(`${base}/verify`, { as: 'consultant2', method: 'POST', body: {}, ifMatch: 2 }),
      w.call(`${base}/reject`, {
        as: 'manager',
        method: 'POST',
        body: { comment: 'Not legible' },
        ifMatch: 2,
      }),
    ]);
    expect([verify.status, reject.status].sort()).toEqual([200, 412]);
  });
});
