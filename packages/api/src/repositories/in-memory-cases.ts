/* eslint-disable @typescript-eslint/require-await -- in-memory fakes implement async repository ports synchronously */
import type { ClientRecord } from '../domain/clients/types.js';
import type {
  ServiceTypeRecord,
  WorkflowTemplateRecord,
  WorkflowVersionRecord,
} from '../domain/catalog/types.js';
import {
  compareCaseOrder,
  matchesCaseFilter,
  type CaseChecklistItemRecord,
  type CaseStatusHistoryRecord,
  type TaxCaseRecord,
} from '../domain/cases/types.js';
import {
  DraftExistsError,
  DuplicateNameError,
  type CaseRepository,
  type ServiceTypeRepository,
  type WorkflowTemplateRepository,
} from './ports.js';

export interface InMemoryCaseState {
  serviceTypes: Map<string, ServiceTypeRecord>;
  workflowTemplates: Map<string, WorkflowTemplateRecord>;
  workflowVersions: Map<string, WorkflowVersionRecord>;
  cases: Map<string, TaxCaseRecord>;
  caseStatusHistory: CaseStatusHistoryRecord[];
  caseChecklistItems: Map<string, CaseChecklistItemRecord>;
  caseSequence: number;
}

export function createInMemoryCaseState(): InMemoryCaseState {
  return {
    serviceTypes: new Map(),
    workflowTemplates: new Map(),
    workflowVersions: new Map(),
    cases: new Map(),
    caseStatusHistory: [],
    caseChecklistItems: new Map(),
    caseSequence: 0,
  };
}

const byName = (left: { name: string }, right: { name: string }) =>
  left.name.toLowerCase().localeCompare(right.name.toLowerCase());

export function createInMemoryServiceTypeRepository(
  state: InMemoryCaseState,
): ServiceTypeRepository {
  const assertUniqueName = (candidate: ServiceTypeRecord): void => {
    if (candidate.deletedAt !== null) {
      return;
    }
    for (const existing of state.serviceTypes.values()) {
      if (
        existing.id !== candidate.id &&
        existing.deletedAt === null &&
        existing.name.toLowerCase() === candidate.name.toLowerCase()
      ) {
        throw new DuplicateNameError();
      }
    }
  };
  const write = (
    id: string,
    expectedVersion: number,
    at: string,
    patch: Partial<ServiceTypeRecord>,
  ): ServiceTypeRecord | null => {
    const current = state.serviceTypes.get(id);
    if (current?.version !== expectedVersion) {
      return null;
    }
    const next: ServiceTypeRecord = {
      ...current,
      ...patch,
      updatedAt: at,
      version: current.version + 1,
    };
    assertUniqueName(next);
    state.serviceTypes.set(id, next);
    return { ...next };
  };
  return {
    create: async (record) => {
      assertUniqueName(record);
      state.serviceTypes.set(record.id, { ...record });
    },
    findById: async (id) => {
      const record = state.serviceTypes.get(id);
      return record === undefined ? null : { ...record };
    },
    list: async (filter) =>
      [...state.serviceTypes.values()]
        .filter(
          (record) => filter === 'all' || (filter === 'active') === (record.deletedAt === null),
        )
        .sort(byName)
        .map((record) => ({ ...record })),
    update: async (input) => write(input.id, input.expectedVersion, input.at, input.changes),
    setArchived: async (input) =>
      write(input.id, input.expectedVersion, input.at, { deletedAt: input.archivedAt }),
  };
}

export function createInMemoryWorkflowTemplateRepository(
  state: InMemoryCaseState,
): WorkflowTemplateRepository {
  const assertUniqueName = (candidate: WorkflowTemplateRecord): void => {
    for (const existing of state.workflowTemplates.values()) {
      if (
        existing.id !== candidate.id &&
        existing.name.toLowerCase() === candidate.name.toLowerCase()
      ) {
        throw new DuplicateNameError();
      }
    }
  };
  const copyVersion = (record: WorkflowVersionRecord): WorkflowVersionRecord => ({
    ...record,
    definition: structuredClone(record.definition),
  });
  const insertVersion = (record: WorkflowVersionRecord): void => {
    for (const existing of state.workflowVersions.values()) {
      if (existing.templateId !== record.templateId) continue;
      if (existing.state === 'draft' && record.state === 'draft') {
        throw new DraftExistsError();
      }
      if (existing.versionNumber === record.versionNumber) {
        throw new DraftExistsError();
      }
    }
    state.workflowVersions.set(record.id, copyVersion(record));
  };
  const writeDraft = (
    id: string,
    expectedVersion: number,
    at: string,
    patch: Partial<WorkflowVersionRecord>,
  ): WorkflowVersionRecord | null => {
    const current = state.workflowVersions.get(id);
    if (current?.version !== expectedVersion || current.state !== 'draft') {
      return null;
    }
    const next: WorkflowVersionRecord = {
      ...current,
      ...patch,
      updatedAt: at,
      version: current.version + 1,
    };
    state.workflowVersions.set(id, copyVersion(next));
    return copyVersion(next);
  };
  return {
    create: async (template, draft) => {
      assertUniqueName(template);
      state.workflowTemplates.set(template.id, { ...template });
      insertVersion(draft);
    },
    findTemplate: async (id) => {
      const record = state.workflowTemplates.get(id);
      return record === undefined ? null : { ...record };
    },
    listTemplates: async () =>
      [...state.workflowTemplates.values()].sort(byName).map((record) => ({ ...record })),
    updateTemplate: async (input) => {
      const current = state.workflowTemplates.get(input.id);
      if (current?.version !== input.expectedVersion) {
        return null;
      }
      const next: WorkflowTemplateRecord = {
        ...current,
        name: input.name,
        description: input.description,
        updatedAt: input.at,
        version: current.version + 1,
      };
      assertUniqueName(next);
      state.workflowTemplates.set(next.id, next);
      return { ...next };
    },
    listVersions: async (templateIds) =>
      [...state.workflowVersions.values()]
        .filter((record) => templateIds.includes(record.templateId))
        .sort((left, right) =>
          left.templateId === right.templateId
            ? left.versionNumber - right.versionNumber
            : left.templateId < right.templateId
              ? -1
              : 1,
        )
        .map(copyVersion),
    findVersion: async (id) => {
      const record = state.workflowVersions.get(id);
      return record === undefined ? null : copyVersion(record);
    },
    createVersion: async (record) => {
      insertVersion(record);
    },
    updateDraft: async (input) =>
      writeDraft(input.id, input.expectedVersion, input.at, {
        definition: structuredClone(input.definition),
      }),
    publish: async (input) =>
      writeDraft(input.id, input.expectedVersion, input.at, {
        state: 'published',
        publishedAt: input.at,
        publishedBy: input.publishedBy,
      }),
  };
}

/**
 * Case test double. It mirrors the PostgreSQL rules that matter to the
 * service: case reads join the client's code and display name, history is
 * append-only, and a stale version writes nothing.
 */
export function createInMemoryCaseRepository(
  state: InMemoryCaseState,
  clients: Map<string, ClientRecord>,
): CaseRepository {
  const itemsFor = (caseId: string): CaseChecklistItemRecord[] =>
    [...state.caseChecklistItems.values()].filter((item) => item.caseId === caseId);
  const withClient = (record: TaxCaseRecord): TaxCaseRecord => {
    const client = clients.get(record.clientId);
    return {
      ...record,
      workflowSnapshot: structuredClone(record.workflowSnapshot),
      clientCode: client?.clientCode ?? record.clientCode,
      clientDisplayName: client?.displayName ?? record.clientDisplayName,
    };
  };
  const writeCase = (
    id: string,
    expectedVersion: number,
    at: string,
    patch: Partial<TaxCaseRecord>,
  ): TaxCaseRecord | null => {
    const current = state.cases.get(id);
    if (current?.version !== expectedVersion || current.deletedAt !== null) {
      return null;
    }
    const next: TaxCaseRecord = {
      ...current,
      ...patch,
      updatedAt: at,
      version: current.version + 1,
    };
    state.cases.set(id, next);
    return withClient(next);
  };
  return {
    nextCaseNumber: async () => {
      state.caseSequence += 1;
      return state.caseSequence;
    },
    lockClientForCaseCreation: async () => {
      // Single-threaded test process: nothing to serialize.
    },
    findActiveDuplicates: async (input) =>
      [...state.cases.values()]
        .filter(
          (record) =>
            record.clientId === input.clientId &&
            record.serviceTypeId === input.serviceTypeId &&
            record.taxYear === input.taxYear &&
            record.deletedAt === null &&
            record.currentStatusKind !== 'completed' &&
            record.currentStatusKind !== 'cancelled',
        )
        .sort(compareCaseOrder)
        .map(withClient),
    create: async (record, initialStatus, items) => {
      if (state.cases.has(record.id)) {
        throw new Error('The case already exists.');
      }
      state.caseStatusHistory.push({ ...initialStatus });
      state.cases.set(record.id, {
        ...record,
        workflowSnapshot: structuredClone(record.workflowSnapshot),
      });
      for (const item of items) {
        state.caseChecklistItems.set(item.id, { ...item });
      }
    },
    findById: async (id) => {
      const record = state.cases.get(id);
      return record === undefined ? null : withClient(record);
    },
    findByCode: async (caseCode) => {
      const record = [...state.cases.values()].find((taxCase) => taxCase.caseCode === caseCode);
      return record === undefined ? null : withClient(record);
    },
    lockById: async (id) => {
      const record = state.cases.get(id);
      return record === undefined ? null : withClient(record);
    },
    updateDetails: async (input) =>
      writeCase(input.id, input.expectedVersion, input.at, input.changes),
    transition: async (input) => {
      const entry = input.entry;
      const current = state.cases.get(entry.caseId);
      if (current?.version !== input.expectedVersion || current.deletedAt !== null) {
        return null;
      }
      if (current.currentStatusKey !== entry.fromStatusKey) {
        throw new Error('A tax case status changes only through a recorded transition');
      }
      state.caseStatusHistory.push({ ...entry });
      return writeCase(entry.caseId, input.expectedVersion, input.at, {
        currentStatusKey: entry.toStatusKey,
        currentStatusName: entry.toStatusName,
        currentStatusKind: entry.toStatusKind,
        currentStatusHistoryId: entry.id,
      });
    },
    archive: async (input) => {
      const current = state.cases.get(input.id);
      if (
        current?.currentStatusKind !== 'completed' &&
        current?.currentStatusKind !== 'cancelled'
      ) {
        if (current?.version === input.expectedVersion) {
          throw new Error('Only completed or cancelled cases can be archived.');
        }
      }
      return writeCase(input.id, input.expectedVersion, input.at, { deletedAt: input.at });
    },
    listItems: async (caseIds) =>
      [...state.caseChecklistItems.values()]
        .filter((item) => caseIds.includes(item.caseId))
        .sort((left, right) =>
          left.caseId === right.caseId
            ? left.position - right.position
            : left.caseId < right.caseId
              ? -1
              : 1,
        )
        .map((item) => ({ ...item })),
    updateItem: async (input) => {
      const current = state.caseChecklistItems.get(input.itemId);
      if (current?.caseId !== input.caseId || current.version !== input.expectedVersion) {
        return null;
      }
      if (
        input.changes.reviewedBy !== null &&
        input.changes.reviewedBy === input.changes.completedBy
      ) {
        throw new Error('A reviewer never verifies their own work.');
      }
      const next: CaseChecklistItemRecord = {
        ...current,
        ...input.changes,
        updatedAt: input.at,
        version: current.version + 1,
      };
      state.caseChecklistItems.set(next.id, next);
      return { ...next };
    },
    listStatusHistory: async (caseId) =>
      state.caseStatusHistory
        .filter((entry) => entry.caseId === caseId)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((entry) => ({ ...entry })),
    list: async (filter) => {
      const after = filter.after;
      const matching = [...state.cases.values()]
        .filter((record) => matchesCaseFilter(record, filter, itemsFor(record.id)))
        .filter(
          (record) =>
            after === null ||
            record.dueDate > after.dueDate ||
            (record.dueDate === after.dueDate && record.id > after.id),
        )
        .sort(compareCaseOrder);
      return {
        cases: matching.slice(0, filter.limit).map(withClient),
        hasMore: matching.length > filter.limit,
      };
    },
    count: async (filter) =>
      [...state.cases.values()].filter((record) =>
        matchesCaseFilter(record, filter, itemsFor(record.id)),
      ).length,
  };
}
