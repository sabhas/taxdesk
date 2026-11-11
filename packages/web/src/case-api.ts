import {
  CaseActivityListSchema,
  CaseAssigneeListSchema,
  CaseListSchema,
  CaseQueueCountsSchema,
  CaseStatusHistorySchema,
  ServiceTypeListSchema,
  ServiceTypeSchema,
  TaxCaseSchema,
  WorkflowTemplateListSchema,
  WorkflowTemplateSchema,
  WorkflowVersionSchema,
  type CaseActivityList,
  type CaseAssigneeList,
  type CaseCreateRequestInput,
  type CaseList,
  type CaseQueueCounts,
  type CaseStatusHistory,
  type CaseUpdateRequest,
  type CaseView,
  type ChecklistAction,
  type ServiceType,
  type ServiceTypeCreateRequest,
  type ServiceTypeList,
  type TaxCase,
  type WorkflowDefinition,
  type WorkflowTemplate,
  type WorkflowTemplateList,
  type WorkflowVersion,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/**
 * Thin clients for the service catalog, workflow templates, and tax cases.
 * The API enforces every rule; these only shape requests.
 */

function signalOption(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

const read = (signal?: AbortSignal) => ({ sessionScoped: true, ...signalOption(signal) });

// ---------------------------------------------------------------------------
// Service types
// ---------------------------------------------------------------------------

export async function listServiceTypes(
  state: 'active' | 'archived' | 'all' = 'active',
  signal?: AbortSignal,
): Promise<ServiceTypeList> {
  return await apiRequest(
    `/api/v1/service-types?state=${state}`,
    ServiceTypeListSchema,
    read(signal),
  );
}

export async function createServiceType(request: ServiceTypeCreateRequest): Promise<ServiceType> {
  return await apiRequest('/api/v1/service-types', ServiceTypeSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function updateServiceType(
  id: string,
  request: ServiceTypeCreateRequest,
  version: number,
): Promise<ServiceType> {
  return await apiRequest(`/api/v1/service-types/${encodeURIComponent(id)}`, ServiceTypeSchema, {
    method: 'PATCH',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function setServiceTypeArchived(
  id: string,
  archived: boolean,
  version: number,
): Promise<ServiceType> {
  return await apiRequest(
    `/api/v1/service-types/${encodeURIComponent(id)}/${archived ? 'archive' : 'restore'}`,
    ServiceTypeSchema,
    { method: 'POST', ifMatch: version, sessionScoped: true },
  );
}

// ---------------------------------------------------------------------------
// Workflow templates
// ---------------------------------------------------------------------------

function templatePath(templateId: string, suffix = ''): string {
  return `/api/v1/workflow-templates/${encodeURIComponent(templateId)}${suffix}`;
}

function versionPath(templateId: string, versionId: string, suffix = ''): string {
  return templatePath(templateId, `/versions/${encodeURIComponent(versionId)}${suffix}`);
}

export async function listWorkflowTemplates(signal?: AbortSignal): Promise<WorkflowTemplateList> {
  return await apiRequest('/api/v1/workflow-templates', WorkflowTemplateListSchema, read(signal));
}

export async function getWorkflowTemplate(
  templateId: string,
  signal?: AbortSignal,
): Promise<WorkflowTemplate> {
  return await apiRequest(templatePath(templateId), WorkflowTemplateSchema, read(signal));
}

export async function createWorkflowTemplate(request: {
  name: string;
  description: string;
  definition: WorkflowDefinition;
}): Promise<WorkflowTemplate> {
  return await apiRequest('/api/v1/workflow-templates', WorkflowTemplateSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function getWorkflowVersion(
  templateId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<WorkflowVersion> {
  return await apiRequest(versionPath(templateId, versionId), WorkflowVersionSchema, read(signal));
}

export async function createWorkflowDraft(templateId: string): Promise<WorkflowVersion> {
  return await apiRequest(templatePath(templateId, '/versions'), WorkflowVersionSchema, {
    method: 'POST',
    sessionScoped: true,
  });
}

export async function saveWorkflowDraft(
  templateId: string,
  versionId: string,
  definition: WorkflowDefinition,
  version: number,
): Promise<WorkflowVersion> {
  return await apiRequest(versionPath(templateId, versionId), WorkflowVersionSchema, {
    method: 'PUT',
    body: { definition },
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function publishWorkflowVersion(
  templateId: string,
  versionId: string,
  version: number,
): Promise<WorkflowVersion> {
  return await apiRequest(versionPath(templateId, versionId, '/publish'), WorkflowVersionSchema, {
    method: 'POST',
    ifMatch: version,
    sessionScoped: true,
  });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CaseFilters {
  readonly service?: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly reviewer?: string;
  readonly taxYear?: string;
  readonly client?: string;
}

function filterParameters(filters: CaseFilters): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(filters) as [keyof CaseFilters, string | undefined][]) {
    if (value !== undefined && value.length > 0) {
      parameters.set(key, value);
    }
  }
  return parameters;
}

function casePath(caseId: string, suffix = ''): string {
  return `/api/v1/cases/${encodeURIComponent(caseId)}${suffix}`;
}

export async function listCases(
  input: CaseFilters & { view: CaseView; limit?: number; cursor?: string | null },
  signal?: AbortSignal,
): Promise<CaseList> {
  const { view, limit, cursor, ...filters } = input;
  const parameters = filterParameters(filters);
  parameters.set('view', view);
  parameters.set('limit', String(limit ?? 25));
  if (cursor !== undefined && cursor !== null) parameters.set('cursor', cursor);
  return await apiRequest(`/api/v1/cases?${parameters.toString()}`, CaseListSchema, read(signal));
}

export async function getQueueCounts(
  filters: CaseFilters,
  signal?: AbortSignal,
): Promise<CaseQueueCounts> {
  const query = filterParameters(filters).toString();
  return await apiRequest(
    `/api/v1/cases/queue-counts${query.length === 0 ? '' : `?${query}`}`,
    CaseQueueCountsSchema,
    read(signal),
  );
}

export async function listCaseAssignees(signal?: AbortSignal): Promise<CaseAssigneeList> {
  return await apiRequest('/api/v1/cases/assignees', CaseAssigneeListSchema, read(signal));
}

export async function createCase(request: CaseCreateRequestInput): Promise<TaxCase> {
  return await apiRequest('/api/v1/cases', TaxCaseSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function getCase(caseId: string, signal?: AbortSignal): Promise<TaxCase> {
  return await apiRequest(casePath(caseId), TaxCaseSchema, read(signal));
}

export async function updateCase(
  caseId: string,
  request: CaseUpdateRequest,
  version: number,
): Promise<TaxCase> {
  return await apiRequest(casePath(caseId), TaxCaseSchema, {
    method: 'PATCH',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function transitionCase(
  caseId: string,
  toStatus: string,
  note: string,
  version: number,
): Promise<TaxCase> {
  return await apiRequest(casePath(caseId, '/transitions'), TaxCaseSchema, {
    method: 'POST',
    body: { toStatus, note },
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function checklistAction(
  caseId: string,
  itemId: string,
  action: ChecklistAction,
  comment: string,
  itemVersion: number,
): Promise<TaxCase> {
  return await apiRequest(
    casePath(caseId, `/checklist/${encodeURIComponent(itemId)}/${action}`),
    TaxCaseSchema,
    { method: 'POST', body: { comment }, ifMatch: itemVersion, sessionScoped: true },
  );
}

export async function archiveCase(caseId: string, version: number): Promise<TaxCase> {
  return await apiRequest(casePath(caseId, '/archive'), TaxCaseSchema, {
    method: 'POST',
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function getCaseStatusHistory(
  caseId: string,
  signal?: AbortSignal,
): Promise<CaseStatusHistory> {
  return await apiRequest(
    casePath(caseId, '/status-history'),
    CaseStatusHistorySchema,
    read(signal),
  );
}

export async function listCaseActivity(
  caseId: string,
  input: { cursor?: string | null; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CaseActivityList> {
  const parameters = new URLSearchParams();
  parameters.set('limit', String(input.limit ?? 20));
  if (input.cursor !== undefined && input.cursor !== null) parameters.set('cursor', input.cursor);
  return await apiRequest(
    `${casePath(caseId, '/activity')}?${parameters.toString()}`,
    CaseActivityListSchema,
    read(signal),
  );
}
