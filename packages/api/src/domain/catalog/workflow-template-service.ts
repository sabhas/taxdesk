import {
  AUDIT_ACTIONS,
  newUuidV7,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowTemplate,
  type WorkflowTemplateCreateRequest,
  type WorkflowTemplateSummary,
  type WorkflowTemplateUpdateRequest,
  type WorkflowVersion,
  type WorkflowVersionSummary,
} from '@taxdesk/shared';
import {
  DraftExistsError,
  DuplicateNameError,
  type Repositories,
} from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { AuthError } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { personLookup } from '../people.js';
import type { CatalogServiceDependencies } from './service-type-service.js';
import type { WorkflowTemplateRecord, WorkflowVersionRecord } from './types.js';

const ENTITY_TYPE = 'workflow_template';

export function templateNotFound(): AuthError {
  return new AuthError(
    404,
    'WORKFLOW_TEMPLATE_NOT_FOUND',
    'The requested workflow template was not found.',
  );
}

function versionNotFound(): AuthError {
  return new AuthError(
    404,
    'WORKFLOW_VERSION_NOT_FOUND',
    'The requested workflow version was not found.',
  );
}

function stale(what: string): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    `This ${what} changed since you loaded it. Refresh, review the latest values, and save again.`,
  );
}

function published(): AuthError {
  return new AuthError(
    409,
    'WORKFLOW_VERSION_PUBLISHED',
    'Published versions cannot change. Start a new draft to make changes.',
  );
}

function draftExists(): AuthError {
  return new AuthError(
    409,
    'WORKFLOW_DRAFT_EXISTS',
    'This template already has a draft. Edit or publish it first.',
  );
}

async function mapStorageErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DuplicateNameError) {
      throw new AuthError(
        409,
        'WORKFLOW_TEMPLATE_NAME_EXISTS',
        'A workflow template already uses this name.',
        { errors: [{ field: 'name', message: 'A workflow template already uses this name.' }] },
      );
    }
    if (error instanceof DraftExistsError) {
      throw draftExists();
    }
    throw error;
  }
}

function summaryOf(version: WorkflowVersionRecord): WorkflowVersionSummary {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    state: version.state,
    publishedAt: version.publishedAt,
  };
}

/**
 * Workflow and checklist templates (TD-302, TD-303). A version is edited only
 * while it is a draft. Publishing freezes it; changes after that go into a new
 * draft copied from the latest published version, so cases opened from an
 * older version keep exactly what they started with.
 */
export class WorkflowTemplateService {
  constructor(private readonly dependencies: CatalogServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private summarize(
    template: WorkflowTemplateRecord,
    versions: readonly WorkflowVersionRecord[],
  ): WorkflowTemplateSummary {
    const own = versions.filter((version) => version.templateId === template.id);
    const latestPublished = own.filter((version) => version.state === 'published').at(-1);
    const draft = own.find((version) => version.state === 'draft');
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      latestPublished: latestPublished === undefined ? null : summaryOf(latestPublished),
      draft: draft === undefined ? null : summaryOf(draft),
      updatedAt: template.updatedAt,
      version: template.version,
    };
  }

  async list(): Promise<WorkflowTemplateSummary[]> {
    const templates = await this.repositories.workflowTemplates.listTemplates();
    const versions = await this.repositories.workflowTemplates.listVersions(
      templates.map((template) => template.id),
    );
    return templates.map((template) => this.summarize(template, versions));
  }

  private async requireTemplate(id: string): Promise<WorkflowTemplateRecord> {
    const template = await this.repositories.workflowTemplates.findTemplate(id);
    if (template === null) {
      throw templateNotFound();
    }
    return template;
  }

  async get(id: string): Promise<WorkflowTemplate> {
    const template = await this.requireTemplate(id);
    const versions = await this.repositories.workflowTemplates.listVersions([id]);
    return {
      ...this.summarize(template, versions),
      versions: versions.map(summaryOf).reverse(),
      createdAt: template.createdAt,
    };
  }

  private async toVersion(
    template: WorkflowTemplateRecord,
    record: WorkflowVersionRecord,
  ): Promise<WorkflowVersion> {
    return {
      id: record.id,
      templateId: record.templateId,
      templateName: template.name,
      versionNumber: record.versionNumber,
      state: record.state,
      definition: record.definition,
      issues: validateWorkflowDefinition(record.definition),
      publishedAt: record.publishedAt,
      publishedBy: await personLookup(this.repositories.users)(record.publishedBy),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  private async requireVersion(
    templateId: string,
    versionId: string,
  ): Promise<{ template: WorkflowTemplateRecord; version: WorkflowVersionRecord }> {
    const template = await this.requireTemplate(templateId);
    const version = await this.repositories.workflowTemplates.findVersion(versionId);
    if (version?.templateId !== templateId) {
      throw versionNotFound();
    }
    return { template, version };
  }

  async getVersion(templateId: string, versionId: string): Promise<WorkflowVersion> {
    const { template, version } = await this.requireVersion(templateId, versionId);
    return await this.toVersion(template, version);
  }

  async create(input: {
    readonly actor: Actor;
    readonly request: WorkflowTemplateCreateRequest;
    readonly requestId: string;
  }): Promise<WorkflowTemplate> {
    const now = this.dependencies.clock();
    const at = now.toISOString();
    const template: WorkflowTemplateRecord = {
      id: newUuidV7(now.getTime()),
      name: input.request.name,
      description: input.request.description,
      createdBy: input.actor.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const draft: WorkflowVersionRecord = {
      id: newUuidV7(now.getTime()),
      templateId: template.id,
      versionNumber: 1,
      state: 'draft',
      definition: input.request.definition,
      publishedAt: null,
      publishedBy: null,
      createdBy: input.actor.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    await mapStorageErrors(
      this.dependencies.unitOfWork.run(async (repositories) => {
        await repositories.workflowTemplates.create(template, draft);
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action: AUDIT_ACTIONS.workflowTemplateCreated,
          entityType: ENTITY_TYPE,
          entityId: template.id,
          requestId: input.requestId,
          metadata: { name: template.name, draftVersionNumber: 1 },
        });
      }),
    );
    return await this.get(template.id);
  }

  async updateTemplate(input: {
    readonly actor: Actor;
    readonly templateId: string;
    readonly request: WorkflowTemplateUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<WorkflowTemplate> {
    const now = this.dependencies.clock();
    const current = await this.requireTemplate(input.templateId);
    if (current.version !== input.expectedVersion) {
      throw stale('template');
    }
    const changed = [
      ...(input.request.name === current.name ? [] : ['name']),
      ...(input.request.description === current.description ? [] : ['description']),
    ];
    if (changed.length > 0) {
      await mapStorageErrors(
        this.dependencies.unitOfWork.run(async (repositories) => {
          const next = await repositories.workflowTemplates.updateTemplate({
            id: current.id,
            name: input.request.name,
            description: input.request.description,
            expectedVersion: input.expectedVersion,
            at: now.toISOString(),
          });
          if (next === null) {
            throw stale('template');
          }
          await appendAuditEvent(repositories.audit, now, {
            actorUserId: input.actor.userId,
            action: AUDIT_ACTIONS.workflowTemplateUpdated,
            entityType: ENTITY_TYPE,
            entityId: current.id,
            requestId: input.requestId,
            metadata: { name: next.name, changedFields: changed.join(',') },
          });
        }),
      );
    }
    return await this.get(current.id);
  }

  /** Starts the next draft from the latest published version. */
  async createDraft(input: {
    readonly actor: Actor;
    readonly templateId: string;
    readonly requestId: string;
  }): Promise<WorkflowVersion> {
    const now = this.dependencies.clock();
    const template = await this.requireTemplate(input.templateId);
    const versions = await this.repositories.workflowTemplates.listVersions([template.id]);
    if (versions.some((version) => version.state === 'draft')) {
      throw draftExists();
    }
    const latest = versions.at(-1);
    if (latest === undefined) {
      throw versionNotFound();
    }
    const at = now.toISOString();
    const draft: WorkflowVersionRecord = {
      id: newUuidV7(now.getTime()),
      templateId: template.id,
      versionNumber: latest.versionNumber + 1,
      state: 'draft',
      definition: structuredClone(latest.definition),
      publishedAt: null,
      publishedBy: null,
      createdBy: input.actor.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    await mapStorageErrors(
      this.dependencies.unitOfWork.run(async (repositories) => {
        await repositories.workflowTemplates.createVersion(draft);
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action: AUDIT_ACTIONS.workflowDraftCreated,
          entityType: ENTITY_TYPE,
          entityId: template.id,
          requestId: input.requestId,
          metadata: {
            versionId: draft.id,
            versionNumber: draft.versionNumber,
            basedOnVersionNumber: latest.versionNumber,
          },
        });
      }),
    );
    return await this.toVersion(template, draft);
  }

  async updateDraft(input: {
    readonly actor: Actor;
    readonly templateId: string;
    readonly versionId: string;
    readonly definition: WorkflowDefinition;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<WorkflowVersion> {
    const now = this.dependencies.clock();
    const { template, version } = await this.requireVersion(input.templateId, input.versionId);
    if (version.state !== 'draft') {
      throw published();
    }
    if (version.version !== input.expectedVersion) {
      throw stale('draft');
    }
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const next = await repositories.workflowTemplates.updateDraft({
        id: version.id,
        definition: input.definition,
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stale('draft');
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.workflowDraftUpdated,
        entityType: ENTITY_TYPE,
        entityId: template.id,
        requestId: input.requestId,
        metadata: { versionId: version.id, versionNumber: version.versionNumber },
      });
      return next;
    });
    return await this.toVersion(template, updated);
  }

  async publish(input: {
    readonly actor: Actor;
    readonly templateId: string;
    readonly versionId: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<WorkflowVersion> {
    const now = this.dependencies.clock();
    const { template, version } = await this.requireVersion(input.templateId, input.versionId);
    if (version.state !== 'draft') {
      throw published();
    }
    if (version.version !== input.expectedVersion) {
      throw stale('draft');
    }
    const issues = validateWorkflowDefinition(version.definition);
    if (issues.length > 0) {
      throw new AuthError(400, 'WORKFLOW_INVALID', 'Fix the workflow problems before publishing.', {
        errors: issues.map((issue) => ({ field: issue.path, message: issue.message })),
      });
    }
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const next = await repositories.workflowTemplates.publish({
        id: version.id,
        publishedBy: input.actor.userId,
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stale('draft');
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.workflowVersionPublished,
        entityType: ENTITY_TYPE,
        entityId: template.id,
        requestId: input.requestId,
        metadata: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          statuses: version.definition.statuses.length,
          checklistItems: version.definition.checklist.length,
        },
      });
      return next;
    });
    return await this.toVersion(template, updated);
  }
}
