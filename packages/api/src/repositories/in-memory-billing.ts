/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-optional-chain -- in-memory fakes implement async repository ports synchronously */
import type {
  BillingDocumentRecord,
  InvoiceItemRecord,
  InvoiceRecord,
  PaymentRecord,
  PaymentReversalRecord,
} from '../domain/billing/types.js';
import type { ClientRecord } from '../domain/clients/types.js';
import type { TaxCaseRecord } from '../domain/cases/types.js';
import type {
  BillingDocumentRepository,
  IdempotencyRepository,
  InvoiceRepository,
  NumberSequenceRepository,
  PaymentRepository,
} from './ports.js';

interface IdempotencyEntry {
  readonly requestHash: string;
  response: unknown;
  completed: boolean;
}

export interface InMemoryBillingState {
  invoices: Map<string, InvoiceRecord>;
  invoiceItems: Map<string, InvoiceItemRecord[]>;
  payments: Map<string, PaymentRecord>;
  paymentReversals: PaymentReversalRecord[];
  billingDocuments: Map<string, BillingDocumentRecord>;
  numberSequences: { invoice: number; receipt: number };
  idempotencyKeys: Map<string, IdempotencyEntry>;
}

export function createInMemoryBillingState(): InMemoryBillingState {
  return {
    invoices: new Map(),
    invoiceItems: new Map(),
    payments: new Map(),
    paymentReversals: [],
    billingDocuments: new Map(),
    numberSequences: { invoice: 1, receipt: 1 },
    idempotencyKeys: new Map(),
  };
}

interface JoinState {
  readonly clients: Map<string, ClientRecord>;
  readonly cases: Map<string, TaxCaseRecord>;
}

/** Invoice rows carry read-only client/case join fields; refresh them on read. */
function withJoins(record: InvoiceRecord, joins: JoinState): InvoiceRecord {
  const client = joins.clients.get(record.clientId);
  const taxCase = record.caseId === null ? undefined : joins.cases.get(record.caseId);
  return {
    ...record,
    clientCode: client?.clientCode ?? record.clientCode,
    clientDisplayName: client?.displayName ?? record.clientDisplayName,
    caseCode: taxCase?.caseCode ?? record.caseCode,
    caseServiceName: taxCase?.serviceName ?? record.caseServiceName,
  };
}

export function createInMemoryInvoiceRepository(
  state: InMemoryBillingState,
  joins: JoinState,
): InvoiceRepository {
  const read = (id: string): InvoiceRecord | null => {
    const found = state.invoices.get(id);
    return found === undefined ? null : withJoins(found, joins);
  };
  const store = (record: InvoiceRecord): InvoiceRecord => {
    state.invoices.set(record.id, record);
    return withJoins(record, joins);
  };
  const required = (id: string): InvoiceRecord => {
    const found = state.invoices.get(id);
    if (found === undefined) {
      throw new Error('The invoice does not exist.');
    }
    return found;
  };
  return {
    create: async (record, items) => {
      state.invoices.set(record.id, { ...record });
      state.invoiceItems.set(
        record.id,
        items.map((item) => ({ ...item })),
      );
    },
    findById: async (id) => read(id),
    lockById: async (id) => read(id),
    listItems: async (invoiceId) =>
      (state.invoiceItems.get(invoiceId) ?? [])
        .map((item) => ({ ...item }))
        .sort((left, right) => left.position - right.position),
    replaceDraft: async ({ id, changes, items, expectedVersion, at }) => {
      const current = state.invoices.get(id);
      if (
        current === undefined ||
        current.status !== 'draft' ||
        current.version !== expectedVersion
      ) {
        return null;
      }
      state.invoiceItems.set(
        id,
        items.map((item) => ({ ...item })),
      );
      return store({ ...current, ...changes, updatedAt: at, version: current.version + 1 });
    },
    finalize: async ({ id, finalization, expectedVersion, at }) => {
      const current = state.invoices.get(id);
      if (
        current === undefined ||
        current.status !== 'draft' ||
        current.version !== expectedVersion
      ) {
        return null;
      }
      return store({
        ...current,
        status: 'finalized',
        invoiceNumber: finalization.invoiceNumber,
        issueDate: finalization.issueDate,
        finalizedAt: finalization.finalizedAt,
        finalizedBy: finalization.finalizedBy,
        pdfState: 'pending',
        updatedAt: at,
        version: current.version + 1,
      });
    },
    void: async ({ id, voiding, at }) => {
      const current = required(id);
      return store({
        ...current,
        status: 'void',
        voidReason: voiding.reason,
        voidedAt: voiding.voidedAt,
        voidedBy: voiding.voidedBy,
        updatedAt: at,
        version: current.version + 1,
      });
    },
    applyBalance: async ({ id, balance, at }) => {
      const current = required(id);
      return store({ ...current, ...balance, updatedAt: at, version: current.version + 1 });
    },
    setPdf: async ({ id, state: pdfState, documentId }) => {
      const current = required(id);
      state.invoices.set(id, { ...current, pdfState, pdfDocumentId: documentId });
    },
    list: async (filter) => {
      const matching = [...state.invoices.values()]
        .map((record) => withJoins(record, joins))
        .filter((record) => {
          if (filter.clientId !== undefined && record.clientId !== filter.clientId) {
            return false;
          }
          if (filter.caseId !== undefined && record.caseId !== filter.caseId) {
            return false;
          }
          if (filter.status !== undefined && record.status !== filter.status) {
            return false;
          }
          if (filter.paymentStatus !== undefined && record.paymentStatus !== filter.paymentStatus) {
            return false;
          }
          if (filter.issuedFrom !== undefined && (record.issueDate ?? '') < filter.issuedFrom) {
            return false;
          }
          if (
            filter.issuedTo !== undefined &&
            (record.issueDate === null || record.issueDate > filter.issuedTo)
          ) {
            return false;
          }
          if (filter.dueFrom !== undefined && (record.dueDate ?? '') < filter.dueFrom) {
            return false;
          }
          if (
            filter.dueTo !== undefined &&
            (record.dueDate === null || record.dueDate > filter.dueTo)
          ) {
            return false;
          }
          if (
            filter.visibleClientIds !== undefined &&
            !filter.visibleClientIds.includes(record.clientId)
          ) {
            return false;
          }
          return true;
        })
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? right.id.localeCompare(left.id)
            : right.createdAt.localeCompare(left.createdAt),
        );
      const after = filter.after;
      const remaining =
        after === null
          ? matching
          : matching.filter(
              (record) =>
                record.createdAt < after.createdAt ||
                (record.createdAt === after.createdAt && record.id < after.id),
            );
      return {
        invoices: remaining.slice(0, filter.limit),
        hasMore: remaining.length > filter.limit,
      };
    },
  };
}

export function createInMemoryPaymentRepository(state: InMemoryBillingState): PaymentRepository {
  return {
    create: async (record) => {
      state.payments.set(record.id, { ...record });
    },
    findById: async (id) => {
      const found = state.payments.get(id);
      return found === undefined ? null : { ...found };
    },
    listForInvoice: async (invoiceId) =>
      [...state.payments.values()]
        .filter((payment) => payment.invoiceId === invoiceId)
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .map((payment) => ({ ...payment })),
    setReceiptPdf: async ({ id, state: receiptPdfState, documentId }) => {
      const current = state.payments.get(id);
      if (current === undefined) {
        throw new Error('The payment does not exist.');
      }
      state.payments.set(id, {
        ...current,
        receiptPdfState,
        receiptDocumentId: documentId,
      });
    },
    appendReversal: async (record) => {
      state.paymentReversals.push({ ...record });
    },
    listReversalsForInvoice: async (invoiceId) =>
      state.paymentReversals
        .filter((reversal) => reversal.invoiceId === invoiceId)
        .map((reversal) => ({ ...reversal })),
  };
}

export function createInMemoryBillingDocumentRepository(
  state: InMemoryBillingState,
): BillingDocumentRepository {
  return {
    create: async (record) => {
      state.billingDocuments.set(record.id, { ...record });
    },
    findById: async (id) => {
      const found = state.billingDocuments.get(id);
      return found === undefined ? null : { ...found };
    },
  };
}

export function createInMemoryNumberSequenceRepository(
  state: InMemoryBillingState,
): NumberSequenceRepository {
  return {
    next: async (key) => {
      const value = state.numberSequences[key];
      state.numberSequences[key] = value + 1;
      return value;
    },
  };
}

export function createInMemoryIdempotencyRepository(
  state: InMemoryBillingState,
): IdempotencyRepository {
  const keyOf = (actorUserId: string, scope: string, key: string): string =>
    `${actorUserId}\u0000${scope}\u0000${key}`;
  return {
    begin: async ({ actorUserId, scope, key, requestHash }) => {
      const id = keyOf(actorUserId, scope, key);
      const existing = state.idempotencyKeys.get(id);
      if (existing === undefined) {
        state.idempotencyKeys.set(id, { requestHash, response: null, completed: false });
        return { kind: 'new' };
      }
      if (existing.requestHash !== requestHash) {
        return { kind: 'conflict' };
      }
      // The in-memory unit of work has no rollback, so a claim whose work threw
      // is simply reused. PostgreSQL rolls the claim back with the transaction.
      return existing.completed ? { kind: 'replay', response: existing.response } : { kind: 'new' };
    },
    complete: async ({ actorUserId, scope, key, response }) => {
      const entry = state.idempotencyKeys.get(keyOf(actorUserId, scope, key));
      if (entry === undefined) {
        throw new Error('The idempotency key was never claimed.');
      }
      entry.response = structuredClone(response);
      entry.completed = true;
    },
  };
}
