import { Hono, type Context } from 'hono';
import {
  ServiceTypeCreateRequestSchema,
  ServiceTypeListQuerySchema,
  ServiceTypeListSchema,
  ServiceTypeSchema,
  ServiceTypeUpdateRequestSchema,
  UuidSchema,
  WorkflowDraftUpdateRequestSchema,
  WorkflowTemplateCreateRequestSchema,
  WorkflowTemplateListSchema,
  WorkflowTemplateSchema,
  WorkflowTemplateUpdateRequestSchema,
  WorkflowVersionSchema,
  type PermissionKey,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError, type AuthErrorCode } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

export const catalogRoutes = new Hono<AppEnv>();

/**
 * Anyone who works with cases can read the catalog (to open a case and to
 * understand its workflow); only `services.manage` changes it.
 */
const CATALOG_READERS: readonly PermissionKey[] = [
  'services.manage',
  'cases.read_all',
  'cases.read_assigned',
];

const read = () => protect({ access: 'any_permission', permissions: CATALOG_READERS });
const manage = () => protect({ access: 'permission', permission: 'services.manage' });

function idParam(c: Context<AppEnv>, name: string, code: AuthErrorCode, what: string): string {
  const value = c.req.param(name) ?? '';
  if (!UuidSchema.safeParse(value).success) {
    throw new AuthError(404, code, `The requested ${what} was not found.`);
  }
  return value;
}

const serviceId = (c: Context<AppEnv>) =>
  idParam(c, 'serviceTypeId', 'SERVICE_TYPE_NOT_FOUND', 'service');
const templateId = (c: Context<AppEnv>) =>
  idParam(c, 'templateId', 'WORKFLOW_TEMPLATE_NOT_FOUND', 'workflow template');
const versionId = (c: Context<AppEnv>) =>
  idParam(c, 'versionId', 'WORKFLOW_VERSION_NOT_FOUND', 'workflow version');

// ---------------------------------------------------------------------------
// Service types (TD-301)
// ---------------------------------------------------------------------------

catalogRoutes.get('/service-types', read(), async (c) => {
  const parsed = ServiceTypeListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the filters.', {
      errors: [{ field: 'state', message: 'Use active, archived, or all.' }],
    });
  }
  const serviceTypes = await c.get('dependencies').serviceTypeService.list(parsed.data);
  c.header('Cache-Control', 'no-store');
  return c.json(ServiceTypeListSchema.parse({ serviceTypes }));
});

catalogRoutes.post('/service-types', manage(), async (c) => {
  const request = await parseJsonBody(c, ServiceTypeCreateRequestSchema);
  const service = await c.get('dependencies').serviceTypeService.create({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  setEtag(c, service.version);
  return c.json(ServiceTypeSchema.parse(service), 201);
});

catalogRoutes.get('/service-types/:serviceTypeId', read(), async (c) => {
  const service = await c.get('dependencies').serviceTypeService.get(serviceId(c));
  setEtag(c, service.version);
  c.header('Cache-Control', 'no-store');
  return c.json(ServiceTypeSchema.parse(service));
});

catalogRoutes.patch('/service-types/:serviceTypeId', manage(), async (c) => {
  const id = serviceId(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, ServiceTypeUpdateRequestSchema);
  const service = await c.get('dependencies').serviceTypeService.update({
    actor: c.get('actor'),
    id,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, service.version);
  return c.json(ServiceTypeSchema.parse(service));
});

for (const [action, archived] of [
  ['archive', true],
  ['restore', false],
] as const) {
  catalogRoutes.post(`/service-types/:serviceTypeId/${action}`, manage(), async (c) => {
    const id = serviceId(c);
    const expectedVersion = requireIfMatch(c);
    const service = await c.get('dependencies').serviceTypeService.setArchived({
      actor: c.get('actor'),
      id,
      archived,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, service.version);
    return c.json(ServiceTypeSchema.parse(service));
  });
}

// ---------------------------------------------------------------------------
// Workflow and checklist templates (TD-302, TD-303)
// ---------------------------------------------------------------------------

catalogRoutes.get('/workflow-templates', read(), async (c) => {
  const templates = await c.get('dependencies').workflowTemplateService.list();
  c.header('Cache-Control', 'no-store');
  return c.json(WorkflowTemplateListSchema.parse({ templates }));
});

catalogRoutes.post('/workflow-templates', manage(), async (c) => {
  const request = await parseJsonBody(c, WorkflowTemplateCreateRequestSchema);
  const template = await c.get('dependencies').workflowTemplateService.create({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  setEtag(c, template.version);
  return c.json(WorkflowTemplateSchema.parse(template), 201);
});

catalogRoutes.get('/workflow-templates/:templateId', read(), async (c) => {
  const template = await c.get('dependencies').workflowTemplateService.get(templateId(c));
  setEtag(c, template.version);
  c.header('Cache-Control', 'no-store');
  return c.json(WorkflowTemplateSchema.parse(template));
});

catalogRoutes.patch('/workflow-templates/:templateId', manage(), async (c) => {
  const id = templateId(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, WorkflowTemplateUpdateRequestSchema);
  const template = await c.get('dependencies').workflowTemplateService.updateTemplate({
    actor: c.get('actor'),
    templateId: id,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, template.version);
  return c.json(WorkflowTemplateSchema.parse(template));
});

catalogRoutes.post('/workflow-templates/:templateId/versions', manage(), async (c) => {
  const draft = await c.get('dependencies').workflowTemplateService.createDraft({
    actor: c.get('actor'),
    templateId: templateId(c),
    requestId: c.get('requestId'),
  });
  setEtag(c, draft.version);
  return c.json(WorkflowVersionSchema.parse(draft), 201);
});

catalogRoutes.get('/workflow-templates/:templateId/versions/:versionId', read(), async (c) => {
  const version = await c
    .get('dependencies')
    .workflowTemplateService.getVersion(templateId(c), versionId(c));
  setEtag(c, version.version);
  c.header('Cache-Control', 'no-store');
  return c.json(WorkflowVersionSchema.parse(version));
});

catalogRoutes.put('/workflow-templates/:templateId/versions/:versionId', manage(), async (c) => {
  const template = templateId(c);
  const version = versionId(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, WorkflowDraftUpdateRequestSchema);
  const draft = await c.get('dependencies').workflowTemplateService.updateDraft({
    actor: c.get('actor'),
    templateId: template,
    versionId: version,
    definition: request.definition,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, draft.version);
  return c.json(WorkflowVersionSchema.parse(draft));
});

catalogRoutes.post(
  '/workflow-templates/:templateId/versions/:versionId/publish',
  manage(),
  async (c) => {
    const template = templateId(c);
    const version = versionId(c);
    const expectedVersion = requireIfMatch(c);
    const published = await c.get('dependencies').workflowTemplateService.publish({
      actor: c.get('actor'),
      templateId: template,
      versionId: version,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, published.version);
    return c.json(WorkflowVersionSchema.parse(published));
  },
);
