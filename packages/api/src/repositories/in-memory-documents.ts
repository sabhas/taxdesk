/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-optional-chain -- in-memory fakes implement async repository ports synchronously with explicit null checks */
import type {
  DocumentListFilter,
  DocumentRecord,
  DocumentUploadRecord,
} from '../domain/documents/types.js';
import type {
  ReconciliationRunRecord,
  StorageConnectionRecord,
  StorageOAuthStateRecord,
} from '../domain/storage/types.js';
import {
  DuplicateDocumentUploadError,
  type DocumentRepository,
  type DocumentUploadRepository,
  type ReconciliationRunRepository,
  type StorageConnectionRepository,
  type StorageOAuthStateRepository,
} from './ports.js';

export interface InMemoryDocumentState {
  storageConnection: StorageConnectionRecord | null;
  storageOAuthStates: Map<string, StorageOAuthStateRecord>;
  documents: Map<string, DocumentRecord>;
  documentUploads: Map<string, DocumentUploadRecord>;
  reconciliationRuns: ReconciliationRunRecord[];
}

export function createInMemoryDocumentState(): InMemoryDocumentState {
  return {
    storageConnection: null,
    storageOAuthStates: new Map(),
    documents: new Map(),
    documentUploads: new Map(),
    reconciliationRuns: [],
  };
}

export function createInMemoryStorageConnectionRepository(
  state: InMemoryDocumentState,
): StorageConnectionRepository {
  return {
    get: async () => (state.storageConnection === null ? null : { ...state.storageConnection }),
    lock: async () => (state.storageConnection === null ? null : { ...state.storageConnection }),
    create: async (record) => {
      if (state.storageConnection !== null) {
        throw new Error('A storage connection already exists.');
      }
      state.storageConnection = { ...record };
    },
    update: async ({ id, changes, expectedVersion, at }) => {
      const current = state.storageConnection;
      if (current === null || current.id !== id || current.version !== expectedVersion) {
        return null;
      }
      const next: StorageConnectionRecord = {
        ...current,
        ...changes,
        updatedAt: at,
        version: current.version + 1,
      };
      state.storageConnection = next;
      return { ...next };
    },
  };
}

export function createInMemoryStorageOAuthStateRepository(
  state: InMemoryDocumentState,
): StorageOAuthStateRepository {
  return {
    create: async (record) => {
      for (const existing of state.storageOAuthStates.values()) {
        if (existing.stateHash === record.stateHash) {
          throw new Error('Duplicate OAuth state.');
        }
      }
      state.storageOAuthStates.set(record.id, { ...record });
    },
    findByStateHash: async (stateHash) => {
      for (const record of state.storageOAuthStates.values()) {
        if (record.stateHash === stateHash) {
          return { ...record };
        }
      }
      return null;
    },
    consume: async (id, at) => {
      const record = state.storageOAuthStates.get(id);
      if (record === undefined || record.consumedAt !== null) {
        return false;
      }
      state.storageOAuthStates.set(id, { ...record, consumedAt: at });
      return true;
    },
    pruneBefore: async (before) => {
      let removed = 0;
      for (const [id, record] of state.storageOAuthStates) {
        if (record.expiresAt < before) {
          state.storageOAuthStates.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

function compareNewestFirst(a: DocumentRecord, b: DocumentRecord): number {
  if (a.uploadedAt !== b.uploadedAt) {
    return a.uploadedAt < b.uploadedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Cursor = `<uploadedAt>|<id>` of the last row on the previous page. */
function encodeCursor(record: DocumentRecord): string {
  return `${record.uploadedAt}|${record.id}`;
}

function afterCursor(record: DocumentRecord, cursor: string | null): boolean {
  if (cursor === null) {
    return true;
  }
  const [uploadedAt, id] = cursor.split('|');
  if (uploadedAt === undefined || id === undefined) {
    return true;
  }
  return record.uploadedAt < uploadedAt || (record.uploadedAt === uploadedAt && record.id < id);
}

export function matchesDocumentFilter(record: DocumentRecord, filter: DocumentListFilter): boolean {
  if (filter.clientId !== undefined && record.clientId !== filter.clientId) {
    return false;
  }
  if (filter.caseId !== undefined && record.caseId !== filter.caseId) {
    return false;
  }
  if (filter.checklistItemId !== undefined && record.checklistItemId !== filter.checklistItemId) {
    return false;
  }
  if (filter.state === 'active' && record.deletedAt !== null) {
    return false;
  }
  if (filter.state === 'deleted' && record.deletedAt === null) {
    return false;
  }
  if (
    filter.verificationState !== undefined &&
    record.verificationState !== filter.verificationState
  ) {
    return false;
  }
  if (filter.visibleTo !== undefined) {
    const byClient = filter.visibleTo.clientIds.includes(record.clientId);
    const byCase = record.caseId !== null && filter.visibleTo.caseIds.includes(record.caseId);
    if (!byClient && !byCase) {
      return false;
    }
  }
  return true;
}

export function createInMemoryDocumentRepository(state: InMemoryDocumentState): DocumentRepository {
  return {
    create: async (record) => {
      for (const existing of state.documents.values()) {
        if (existing.uploadId === record.uploadId) {
          throw new DuplicateDocumentUploadError();
        }
      }
      state.documents.set(record.id, { ...record });
    },
    findById: async (id) => {
      const record = state.documents.get(id);
      return record === undefined ? null : { ...record };
    },
    findByUploadId: async (uploadId) => {
      for (const record of state.documents.values()) {
        if (record.uploadId === uploadId) {
          return { ...record };
        }
      }
      return null;
    },
    lockById: async (id) => {
      const record = state.documents.get(id);
      return record === undefined ? null : { ...record };
    },
    update: async ({ id, changes, expectedVersion, at }) => {
      const current = state.documents.get(id);
      if (current === undefined || current.version !== expectedVersion) {
        return null;
      }
      const next: DocumentRecord = {
        ...current,
        ...changes,
        updatedAt: at,
        version: current.version + 1,
      };
      state.documents.set(id, next);
      return { ...next };
    },
    list: async (filter) => {
      const matches = [...state.documents.values()]
        .filter((record) => matchesDocumentFilter(record, filter))
        .sort(compareNewestFirst)
        .filter((record) => afterCursor(record, filter.cursor));
      const page = matches.slice(0, filter.limit).map((record) => ({ ...record }));
      const last = page.at(-1);
      return {
        documents: page,
        nextCursor: matches.length > filter.limit && last !== undefined ? encodeCursor(last) : null,
      };
    },
    listForChecklistItems: async (itemIds) =>
      [...state.documents.values()]
        .filter(
          (record) =>
            record.deletedAt === null &&
            record.checklistItemId !== null &&
            itemIds.includes(record.checklistItemId),
        )
        .sort(compareNewestFirst)
        .map((record) => ({ ...record })),
    listForReconciliation: async ({ afterId, limit }) =>
      [...state.documents.values()]
        .filter((record) => record.deletedAt === null && (afterId === null || record.id > afterId))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map((record) => ({ ...record })),
  };
}

export function createInMemoryDocumentUploadRepository(
  state: InMemoryDocumentState,
): DocumentUploadRepository {
  return {
    create: async (record) => {
      for (const existing of state.documentUploads.values()) {
        if (existing.createdBy === record.createdBy && existing.requestId === record.requestId) {
          throw new Error('Duplicate upload request.');
        }
      }
      state.documentUploads.set(record.id, { ...record });
    },
    findById: async (id) => {
      const record = state.documentUploads.get(id);
      return record === undefined ? null : { ...record };
    },
    findByRequest: async (createdBy, requestId) => {
      for (const record of state.documentUploads.values()) {
        if (record.createdBy === createdBy && record.requestId === requestId) {
          return { ...record };
        }
      }
      return null;
    },
    lockById: async (id) => {
      const record = state.documentUploads.get(id);
      return record === undefined ? null : { ...record };
    },
    update: async ({ id, changes, expectedVersion, at }) => {
      const current = state.documentUploads.get(id);
      if (current === undefined || current.version !== expectedVersion) {
        return null;
      }
      const next: DocumentUploadRecord = {
        ...current,
        ...changes,
        updatedAt: at,
        version: current.version + 1,
      };
      state.documentUploads.set(id, next);
      return { ...next };
    },
  };
}

export function createInMemoryReconciliationRunRepository(
  state: InMemoryDocumentState,
): ReconciliationRunRepository {
  return {
    append: async (record) => {
      state.reconciliationRuns.push({ ...record });
    },
    listRecent: async (limit) =>
      [...state.reconciliationRuns]
        .sort((a, b) =>
          a.startedAt !== b.startedAt ? (a.startedAt < b.startedAt ? 1 : -1) : a.id < b.id ? 1 : -1,
        )
        .slice(0, limit)
        .map((record) => ({ ...record })),
  };
}
