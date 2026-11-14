/* eslint-disable @typescript-eslint/require-await -- in-memory fakes implement async repository ports synchronously */
import { newUuidV7 } from '@taxdesk/shared';
import type { ImportBatchRecord, ImportRowPlan, ImportRowRecord } from '../domain/imports/types.js';
import type { InMemoryBillingState } from './in-memory-billing.js';
import type { InMemoryCaseState } from './in-memory-cases.js';
import type { InMemoryClientState } from './in-memory-clients.js';
import {
  DuplicateImportLineageError,
  DuplicateImportSourceError,
  type ImportRepository,
} from './ports.js';

export interface InMemoryImportState {
  importBatches: Map<string, ImportBatchRecord>;
  importRows: ImportRowRecord[];
  importBatchSequence: number;
}

export function createInMemoryImportState(): InMemoryImportState {
  return { importBatches: new Map(), importRows: [], importBatchSequence: 0 };
}

function copyRow(row: ImportRowRecord): ImportRowRecord {
  return {
    ...row,
    errors: row.errors.map((error) => ({ ...error })),
    match: row.match === null ? null : { ...row.match },
    decision: row.decision === null ? null : { ...row.decision },
    entity: row.entity === null ? null : { ...row.entity },
  };
}

function byRowNumber(left: ImportRowRecord, right: ImportRowRecord): number {
  return left.rowNumber - right.rowNumber;
}

export function createInMemoryImportRepository(
  state: InMemoryImportState & InMemoryClientState & InMemoryCaseState & InMemoryBillingState,
): ImportRepository {
  const rowsOf = (batchId: string) =>
    state.importRows.filter((row) => row.batchId === batchId).sort(byRowNumber);
  const indexOf = (batchId: string, rowNumber: number) =>
    state.importRows.findIndex((row) => row.batchId === batchId && row.rowNumber === rowNumber);
  const lineageRows = () =>
    state.importRows
      .filter((row) => row.entity !== null && row.committedAt !== null && row.externalRef !== null)
      .sort((left, right) => (right.committedAt ?? '').localeCompare(left.committedAt ?? ''));

  const toRecord = (batch: ImportBatchRecord, plan: ImportRowPlan): ImportRowRecord => ({
    ...plan,
    errors: plan.errors.map((error) => ({ ...error })),
    match: plan.match === null ? null : { ...plan.match },
    id: newUuidV7(),
    batchId: batch.id,
    kind: batch.kind,
    decision: null,
    outcome: null,
    outcomeCode: null,
    entity: null,
    committedAt: null,
    createdAt: batch.createdAt,
    updatedAt: batch.createdAt,
    version: 1,
  });

  return {
    nextBatchNumber: async () => {
      state.importBatchSequence += 1;
      return state.importBatchSequence;
    },
    createBatch: async (batch, rows) => {
      for (const existing of state.importBatches.values()) {
        if (existing.status !== 'discarded' && existing.sourceChecksum === batch.sourceChecksum) {
          throw new DuplicateImportSourceError();
        }
      }
      state.importBatches.set(batch.id, { ...batch, plan: { ...batch.plan } });
      for (const plan of rows) {
        state.importRows.push(toRecord(batch, plan));
      }
    },
    findBatch: async (id) => {
      const batch = state.importBatches.get(id);
      return batch === undefined ? null : { ...batch, plan: { ...batch.plan } };
    },
    lockBatch: async (id) => {
      const batch = state.importBatches.get(id);
      return batch === undefined ? null : { ...batch, plan: { ...batch.plan } };
    },
    findOpenBySourceChecksum: async (checksum) => {
      const batch = [...state.importBatches.values()].find(
        (candidate) => candidate.status !== 'discarded' && candidate.sourceChecksum === checksum,
      );
      return batch === undefined ? null : { ...batch, plan: { ...batch.plan } };
    },
    updateBatch: async ({ id, changes, expectedVersion, at }) => {
      const batch = state.importBatches.get(id);
      if (batch?.version !== expectedVersion) {
        return null;
      }
      const next: ImportBatchRecord = {
        ...batch,
        ...changes,
        plan: { ...changes.plan },
        updatedAt: at,
        version: batch.version + 1,
      };
      state.importBatches.set(id, next);
      return { ...next, plan: { ...next.plan } };
    },
    listBatches: async ({ limit, after }) => {
      const sorted = [...state.importBatches.values()].sort((left, right) =>
        left.createdAt === right.createdAt
          ? right.id.localeCompare(left.id)
          : right.createdAt.localeCompare(left.createdAt),
      );
      const start =
        after === null
          ? sorted
          : sorted.filter(
              (batch) =>
                batch.createdAt < after.createdAt ||
                (batch.createdAt === after.createdAt && batch.id < after.id),
            );
      return {
        batches: start.slice(0, limit).map((batch) => ({ ...batch, plan: { ...batch.plan } })),
        hasMore: start.length > limit,
      };
    },
    listRows: async (filter) => {
      const rows = rowsOf(filter.batchId).filter(
        (row) =>
          (filter.action === null || row.action === filter.action) &&
          (filter.outcome === null || row.outcome === filter.outcome) &&
          (filter.afterRowNumber === null || row.rowNumber > filter.afterRowNumber),
      );
      return {
        rows: rows.slice(0, filter.limit).map(copyRow),
        hasMore: rows.length > filter.limit,
      };
    },
    allRows: async (batchId) => rowsOf(batchId).map(copyRow),
    findRow: async (batchId, rowNumber) => {
      const row = state.importRows[indexOf(batchId, rowNumber)];
      return row === undefined ? null : copyRow(row);
    },
    replanRows: async (batchId, plans, at) => {
      for (const plan of plans) {
        const index = indexOf(batchId, plan.rowNumber);
        const row = state.importRows[index];
        if (row?.outcome !== null) {
          continue;
        }
        state.importRows[index] = {
          ...row,
          ...plan,
          errors: plan.errors.map((error) => ({ ...error })),
          match: plan.match === null ? null : { ...plan.match },
          decision: plan.action === 'review' ? row.decision : null,
          updatedAt: at,
          version: row.version + 1,
        };
      }
    },
    decideRow: async ({ batchId, rowNumber, decision, expectedVersion, at }) => {
      const index = indexOf(batchId, rowNumber);
      const row = state.importRows[index];
      if (row?.version !== expectedVersion || row.outcome !== null) {
        return null;
      }
      const next: ImportRowRecord = {
        ...row,
        decision: { ...decision },
        updatedAt: at,
        version: row.version + 1,
      };
      state.importRows[index] = next;
      return copyRow(next);
    },
    pendingRows: async (batchId, limit) =>
      rowsOf(batchId)
        .filter((row) => row.outcome === null)
        .slice(0, limit)
        .map(copyRow),
    recordOutcome: async ({ batchId, rowNumber, outcome, outcomeCode, entity, at }) => {
      const index = indexOf(batchId, rowNumber);
      const row = state.importRows[index];
      if (row?.outcome !== null) {
        throw new Error('An import row outcome is written once.');
      }
      if (
        outcome === 'created' &&
        state.importRows.some(
          (other) =>
            other.kind === row.kind &&
            other.outcome === 'created' &&
            other.externalRef === row.externalRef,
        )
      ) {
        throw new DuplicateImportLineageError();
      }
      state.importRows[index] = {
        ...row,
        outcome,
        outcomeCode,
        entity: entity === null ? null : { ...entity },
        committedAt: at,
        updatedAt: at,
        version: row.version + 1,
      };
    },
    findLineage: async (kind, externalRef) => {
      const row = lineageRows().find(
        (candidate) => candidate.kind === kind && candidate.externalRef === externalRef,
      );
      return row?.entity == null ? null : { ...row.entity };
    },
    rowTotals: async (batchId) => {
      const totals = {
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        pending: 0,
        createdAmountMinor: 0,
        skippedAmountMinor: 0,
      };
      for (const row of rowsOf(batchId)) {
        if (row.outcome === null) totals.pending += 1;
        else totals[row.outcome] += 1;
        if (row.outcome === 'created') totals.createdAmountMinor += row.amountMinor ?? 0;
        if (row.outcome === 'skipped') totals.skippedAmountMinor += row.amountMinor ?? 0;
      }
      return totals;
    },
    reconciliationTotals: async () => {
      const created = (kind: string) =>
        new Set(
          state.importRows
            .filter((row) => row.kind === kind && row.outcome === 'created' && row.entity !== null)
            .map((row) => row.entity?.entityId ?? ''),
        );
      const importedClients = created('clients');
      const importedCases = created('cases');
      const openingIds = created('opening_balances');
      const clients = [...state.clients.values()];
      const cases = [...state.cases.values()];
      const isActiveCase = (record: (typeof cases)[number]) =>
        record.deletedAt === null && record.currentStatusKind === 'open';
      const opening = [...state.invoices.values()].filter(
        (invoice) => openingIds.has(invoice.id) && invoice.status === 'finalized',
      );
      return {
        clientsTotal: clients.length,
        clientsActive: clients.filter((client) => client.deletedAt === null).length,
        clientsImported: importedClients.size,
        casesActive: cases.filter(isActiveCase).length,
        casesImported: importedCases.size,
        casesImportedStillActive: cases.filter(
          (record) => importedCases.has(record.id) && isActiveCase(record),
        ).length,
        openingInvoices: opening.length,
        openingTotalMinor: opening.reduce((sum, invoice) => sum + invoice.totalMinor, 0),
        openingOutstandingMinor: opening.reduce(
          (sum, invoice) => sum + invoice.outstandingMinor,
          0,
        ),
        committedBatches: [...state.importBatches.values()].filter(
          (batch) => batch.status === 'committed',
        ).length,
        failedRows: state.importRows.filter((row) => row.outcome === 'failed').length,
      };
    },
    sampleLineage: async (limit) =>
      lineageRows()
        .slice(0, limit)
        .map((row) => ({
          kind: row.kind,
          batchCode: state.importBatches.get(row.batchId)?.batchCode ?? '',
          rowNumber: row.rowNumber,
          externalRef: row.externalRef ?? '',
          entity:
            row.entity === null
              ? { entityType: 'client', entityId: '', code: '' }
              : { ...row.entity },
        })),
  };
}
