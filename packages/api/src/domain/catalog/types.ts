import type {
  DuplicateCasePolicy,
  WorkflowDefinition,
  WorkflowVersionState,
} from '@taxdesk/shared';

export interface ServiceTypeRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly defaultFeeMinor: number;
  readonly defaultDeadlineOffsetDays: number;
  readonly duplicateCasePolicy: DuplicateCasePolicy;
  readonly defaultWorkflowTemplateId: string | null;
  readonly createdBy: string | null;
  /** Archive timestamp; `null` while the service is active. */
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ServiceTypeChanges {
  readonly name: string;
  readonly description: string;
  readonly defaultFeeMinor: number;
  readonly defaultDeadlineOffsetDays: number;
  readonly duplicateCasePolicy: DuplicateCasePolicy;
  readonly defaultWorkflowTemplateId: string | null;
}

export interface WorkflowTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface WorkflowVersionRecord {
  readonly id: string;
  readonly templateId: string;
  readonly versionNumber: number;
  readonly state: WorkflowVersionState;
  readonly definition: WorkflowDefinition;
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}
