import {
  AUDIT_ACTIONS,
  newUuidV7,
  type ServiceType,
  type ServiceTypeCreateRequest,
  type ServiceTypeListQuery,
  type ServiceTypeUpdateRequest,
} from '@taxdesk/shared';
import {
  DuplicateNameError,
  type Repositories,
  type UnitOfWork,
} from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { AuthError } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import type { ServiceTypeChanges, ServiceTypeRecord } from './types.js';

export interface CatalogServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
}

const ENTITY_TYPE = 'service_type';

const FIELDS = [
  'name',
  'description',
  'defaultFeeMinor',
  'defaultDeadlineOffsetDays',
  'duplicateCasePolicy',
  'defaultWorkflowTemplateId',
] as const satisfies readonly (keyof ServiceTypeChanges)[];

export function serviceTypeNotFound(): AuthError {
  return new AuthError(404, 'SERVICE_TYPE_NOT_FOUND', 'The requested service was not found.');
}

function stale(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'This service changed since you loaded it. Refresh, review the latest values, and save again.',
  );
}

function nameExists(): AuthError {
  return new AuthError(
    409,
    'SERVICE_TYPE_NAME_EXISTS',
    'An active service already uses this name.',
    {
      errors: [{ field: 'name', message: 'An active service already uses this name.' }],
    },
  );
}

async function mapDuplicateName<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof DuplicateNameError) {
      throw nameExists();
    }
    throw error;
  }
}

/**
 * The deployment-wide service catalog (TD-301). Services are archived, never
 * deleted; a case keeps the name and fee it copied when it was opened.
 */
export class ServiceTypeService {
  constructor(private readonly dependencies: CatalogServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private async toDto(record: ServiceTypeRecord): Promise<ServiceType> {
    const template =
      record.defaultWorkflowTemplateId === null
        ? null
        : await this.repositories.workflowTemplates.findTemplate(record.defaultWorkflowTemplateId);
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      defaultFeeMinor: record.defaultFeeMinor,
      defaultDeadlineOffsetDays: record.defaultDeadlineOffsetDays,
      duplicateCasePolicy: record.duplicateCasePolicy,
      defaultWorkflowTemplate: template === null ? null : { id: template.id, name: template.name },
      state: record.deletedAt === null ? 'active' : 'archived',
      archivedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  private async assertTemplate(templateId: string | null): Promise<void> {
    if (templateId === null) {
      return;
    }
    if ((await this.repositories.workflowTemplates.findTemplate(templateId)) === null) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'Choose an existing workflow template.', {
        errors: [
          { field: 'defaultWorkflowTemplateId', message: 'Choose an existing workflow template.' },
        ],
      });
    }
  }

  async list(query: ServiceTypeListQuery): Promise<ServiceType[]> {
    const records = await this.repositories.serviceTypes.list(query.state);
    return await Promise.all(records.map((record) => this.toDto(record)));
  }

  async get(id: string): Promise<ServiceType> {
    const record = await this.repositories.serviceTypes.findById(id);
    if (record === null) {
      throw serviceTypeNotFound();
    }
    return await this.toDto(record);
  }

  async create(input: {
    readonly actor: Actor;
    readonly request: ServiceTypeCreateRequest;
    readonly requestId: string;
  }): Promise<ServiceType> {
    const now = this.dependencies.clock();
    await this.assertTemplate(input.request.defaultWorkflowTemplateId);
    const record: ServiceTypeRecord = {
      id: newUuidV7(now.getTime()),
      name: input.request.name,
      description: input.request.description,
      defaultFeeMinor: input.request.defaultFeeMinor,
      defaultDeadlineOffsetDays: input.request.defaultDeadlineOffsetDays,
      duplicateCasePolicy: input.request.duplicateCasePolicy,
      defaultWorkflowTemplateId: input.request.defaultWorkflowTemplateId,
      createdBy: input.actor.userId,
      deletedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      version: 1,
    };
    await mapDuplicateName(
      this.dependencies.unitOfWork.run(async (repositories) => {
        await repositories.serviceTypes.create(record);
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action: AUDIT_ACTIONS.serviceTypeCreated,
          entityType: ENTITY_TYPE,
          entityId: record.id,
          requestId: input.requestId,
          metadata: { name: record.name, defaultFeeMinor: record.defaultFeeMinor },
        });
      }),
    );
    return await this.toDto(record);
  }

  async update(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly request: ServiceTypeUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<ServiceType> {
    const now = this.dependencies.clock();
    const current = await this.repositories.serviceTypes.findById(input.id);
    if (current === null) {
      throw serviceTypeNotFound();
    }
    if (current.version !== input.expectedVersion) {
      throw stale();
    }
    if (current.deletedAt !== null) {
      throw new AuthError(409, 'SERVICE_TYPE_ARCHIVED', 'Restore this service before editing it.');
    }
    if (input.request.defaultWorkflowTemplateId !== current.defaultWorkflowTemplateId) {
      await this.assertTemplate(input.request.defaultWorkflowTemplateId);
    }
    const changes: ServiceTypeChanges = { ...input.request };
    const changed = FIELDS.filter((field) => changes[field] !== current[field]);
    if (changed.length === 0) {
      return await this.toDto(current);
    }
    const updated = await mapDuplicateName(
      this.dependencies.unitOfWork.run(async (repositories) => {
        const next = await repositories.serviceTypes.update({
          id: current.id,
          changes,
          expectedVersion: input.expectedVersion,
          at: now.toISOString(),
        });
        if (next === null) {
          throw stale();
        }
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action: AUDIT_ACTIONS.serviceTypeUpdated,
          entityType: ENTITY_TYPE,
          entityId: current.id,
          requestId: input.requestId,
          metadata: { name: next.name, changedFields: changed.join(',') },
        });
        return next;
      }),
    );
    return await this.toDto(updated);
  }

  async setArchived(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly archived: boolean;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<ServiceType> {
    const now = this.dependencies.clock();
    const current = await this.repositories.serviceTypes.findById(input.id);
    if (current === null) {
      throw serviceTypeNotFound();
    }
    if (current.version !== input.expectedVersion) {
      throw stale();
    }
    if (input.archived && current.deletedAt !== null) {
      throw new AuthError(409, 'SERVICE_TYPE_ARCHIVED', 'This service is already archived.');
    }
    if (!input.archived && current.deletedAt === null) {
      throw new AuthError(409, 'SERVICE_TYPE_NOT_ARCHIVED', 'This service is not archived.');
    }
    const updated = await mapDuplicateName(
      this.dependencies.unitOfWork.run(async (repositories) => {
        const next = await repositories.serviceTypes.setArchived({
          id: current.id,
          archivedAt: input.archived ? now.toISOString() : null,
          expectedVersion: input.expectedVersion,
          at: now.toISOString(),
        });
        if (next === null) {
          throw stale();
        }
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actor.userId,
          action: input.archived
            ? AUDIT_ACTIONS.serviceTypeArchived
            : AUDIT_ACTIONS.serviceTypeRestored,
          entityType: ENTITY_TYPE,
          entityId: current.id,
          requestId: input.requestId,
          metadata: { name: current.name },
        });
        return next;
      }),
    );
    return await this.toDto(updated);
  }
}
