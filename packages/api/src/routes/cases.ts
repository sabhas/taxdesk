import { Hono, type Context } from 'hono';
import { type z } from 'zod';
import {
  CHECKLIST_ACTIONS,
  CaseActivityListSchema,
  CaseAssigneeListSchema,
  CaseCreateRequestSchema,
  CaseListQuerySchema,
  CaseListSchema,
  CaseQueueCountsQuerySchema,
  CaseQueueCountsSchema,
  CaseStatusHistorySchema,
  CaseTransitionRequestSchema,
  CaseUpdateRequestSchema,
  ChecklistActionRequestSchema,
  ChecklistRejectRequestSchema,
  TaxCaseSchema,
  UuidSchema,
  UuidV7Schema,
  type PermissionKey,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

export const caseRoutes = new Hono<AppEnv>();

const CASE_READERS: readonly PermissionKey[] = ['cases.read_all', 'cases.read_assigned'];
/** Route-level gate for case work; the service applies the assignment rule. */
const CASE_WORKERS: readonly PermissionKey[] = ['cases.manage', 'cases.work_assigned'];

const read = () => protect({ access: 'any_permission', permissions: CASE_READERS });
const work = () => protect({ access: 'any_permission', permissions: CASE_WORKERS });

function caseIdParam(c: Context<AppEnv>): string {
  const caseId = c.req.param('caseId') ?? '';
  if (!UuidSchema.safeParse(caseId).success) {
    throw new AuthError(404, 'CASE_NOT_FOUND', 'The requested case was not found.');
  }
  return caseId;
}

function itemIdParam(c: Context<AppEnv>): string {
  const itemId = c.req.param('itemId') ?? '';
  if (!UuidSchema.safeParse(itemId).success) {
    throw new AuthError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'The checklist item was not found.');
  }
  return itemId;
}

function parseQuery<T>(c: Context<AppEnv>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the queue filters.', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? 'query' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

caseRoutes.get('/cases', read(), async (c) => {
  const query = parseQuery(c, CaseListQuerySchema);
  const list = await c.get('dependencies').caseService.listCases(c.get('actor'), query);
  c.header('Cache-Control', 'no-store');
  return c.json(CaseListSchema.parse(list));
});

caseRoutes.get('/cases/queue-counts', read(), async (c) => {
  const query = parseQuery(c, CaseQueueCountsQuerySchema);
  const counts = await c.get('dependencies').caseService.queueCounts(c.get('actor'), query);
  c.header('Cache-Control', 'no-store');
  return c.json(CaseQueueCountsSchema.parse(counts));
});

caseRoutes.get('/cases/assignees', read(), async (c) => {
  const assignees = await c.get('dependencies').caseService.listAssignees();
  return c.json(CaseAssigneeListSchema.parse({ assignees }));
});

caseRoutes.post('/cases', work(), async (c) => {
  const request = await parseJsonBody(c, CaseCreateRequestSchema);
  const created = await c.get('dependencies').caseService.createCase({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  setEtag(c, created.version);
  return c.json(TaxCaseSchema.parse(created), 201);
});

caseRoutes.get('/cases/:caseId', read(), async (c) => {
  const found = await c.get('dependencies').caseService.getCase(c.get('actor'), caseIdParam(c));
  setEtag(c, found.version);
  c.header('Cache-Control', 'no-store');
  return c.json(TaxCaseSchema.parse(found));
});

/** Edits case details only. The strict schema rejects any `status` field. */
caseRoutes.patch('/cases/:caseId', work(), async (c) => {
  const caseId = caseIdParam(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, CaseUpdateRequestSchema);
  const updated = await c.get('dependencies').caseService.updateCase({
    actor: c.get('actor'),
    caseId,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, updated.version);
  return c.json(TaxCaseSchema.parse(updated));
});

/** The only way to change a case's status. */
caseRoutes.post('/cases/:caseId/transitions', work(), async (c) => {
  const caseId = caseIdParam(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, CaseTransitionRequestSchema);
  const updated = await c.get('dependencies').caseService.transitionCase({
    actor: c.get('actor'),
    caseId,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, updated.version);
  return c.json(TaxCaseSchema.parse(updated));
});

caseRoutes.get('/cases/:caseId/status-history', read(), async (c) => {
  const history = await c
    .get('dependencies')
    .caseService.statusHistory(c.get('actor'), caseIdParam(c));
  c.header('Cache-Control', 'no-store');
  return c.json(CaseStatusHistorySchema.parse(history));
});

caseRoutes.get('/cases/:caseId/activity', read(), async (c) => {
  const caseId = caseIdParam(c);
  const rawLimit = c.req.query('limit');
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Limit must be between 1 and 100.', {
      errors: [{ field: 'limit', message: 'Limit must be between 1 and 100.' }],
    });
  }
  const cursor = c.req.query('cursor');
  if (cursor !== undefined && !UuidV7Schema.safeParse(cursor).success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'The activity cursor is not valid.', {
      errors: [{ field: 'cursor', message: 'The activity cursor is not valid.' }],
    });
  }
  const activity = await c.get('dependencies').caseService.listActivity({
    actor: c.get('actor'),
    caseId,
    limit,
    cursor: cursor ?? null,
  });
  c.header('Cache-Control', 'no-store');
  return c.json(CaseActivityListSchema.parse(activity));
});

caseRoutes.post(
  '/cases/:caseId/archive',
  protect({ access: 'permission', permission: 'cases.manage' }),
  async (c) => {
    const caseId = caseIdParam(c);
    const expectedVersion = requireIfMatch(c);
    const archived = await c.get('dependencies').caseService.archiveCase({
      actor: c.get('actor'),
      caseId,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, archived.version);
    return c.json(TaxCaseSchema.parse(archived));
  },
);

/**
 * Checklist actions. `If-Match` carries the checklist item's version; the
 * response is the whole case (with its new ETag) so progress stays current.
 */
for (const action of CHECKLIST_ACTIONS) {
  caseRoutes.post(`/cases/:caseId/checklist/:itemId/${action}`, work(), async (c) => {
    const caseId = caseIdParam(c);
    const itemId = itemIdParam(c);
    const expectedVersion = requireIfMatch(c);
    const { comment } = await parseJsonBody(
      c,
      action === 'reject' ? ChecklistRejectRequestSchema : ChecklistActionRequestSchema,
    );
    const updated = await c.get('dependencies').caseService.checklistAction({
      actor: c.get('actor'),
      caseId,
      itemId,
      action,
      comment,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, updated.version);
    return c.json(TaxCaseSchema.parse(updated));
  });
}
