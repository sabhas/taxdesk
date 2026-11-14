import {
  AUDIT_ACTIONS,
  FIRM_CURRENCY,
  calculateInvoiceTotals,
  formatCaseCode,
  formatClientCode,
  formatInvoiceNumber,
  newUuidV7,
  normalizeClientName,
  normalizeEmail,
  normalizePhone,
} from '@taxdesk/shared';
import type { Repositories } from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import type {
  CaseChecklistItemRecord,
  CaseStatusHistoryRecord,
  TaxCaseRecord,
} from '../cases/types.js';
import type { ClientContactRecord, ClientRecord } from '../clients/types.js';
import type { InvoiceItemRecord, InvoiceRecord } from '../billing/types.js';
import type { Execution } from './planner.js';
import type { ImportEntityRef } from './types.js';

export interface ExecutionContext {
  readonly repositories: Repositories;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly batchCode: string;
  readonly rowNumber: number;
  readonly identifierKeyVersion: number | null;
}

/** Raised when a record changed between planning and writing (optimistic check). */
export class ImportRowConflictError extends Error {
  constructor() {
    super('The record changed while the row was being imported.');
    this.name = 'ImportRowConflictError';
  }
}

/**
 * Writes one planned row with the same records, invariants, and audit events
 * as the interactive services. Audit metadata adds the batch code and row
 * number so every imported record traces back to its source row; it never
 * carries cell values beyond what the interactive services already record.
 */
export async function executeRow(
  execution: Execution,
  context: ExecutionContext,
): Promise<ImportEntityRef> {
  switch (execution.kind) {
    case 'client_create':
      return await createClient(execution, context);
    case 'client_update':
      return await updateClient(execution, context);
    case 'case_create':
      return await createCase(execution, context);
    case 'invoice_create':
      return await createOpeningInvoice(execution, context);
  }
}

function importMetadata(context: ExecutionContext): Record<string, string | number> {
  return { importBatch: context.batchCode, importRow: context.rowNumber };
}

async function createClient(
  execution: Extract<Execution, { kind: 'client_create' }>,
  context: ExecutionContext,
): Promise<ImportEntityRef> {
  const { repositories, now } = context;
  const at = now.toISOString();
  const { input } = execution;
  const id = newUuidV7(now.getTime());
  const clientCode = formatClientCode(await repositories.clients.nextClientNumber());
  const record: ClientRecord = {
    id,
    clientCode,
    type: input.type,
    legalName: input.legalName,
    displayName: input.displayName,
    normalizedName: normalizeClientName(input.legalName),
    normalizedDisplayName: normalizeClientName(input.displayName),
    cnic: execution.cnic,
    ntn: execution.ntn,
    identifierKeyVersion:
      execution.cnic === null && execution.ntn === null ? null : context.identifierKeyVersion,
    notes: input.notes,
    assignedManagerUserId: execution.managerUserId,
    createdBy: context.actorUserId,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
  const contacts: ClientContactRecord[] =
    input.contact === null
      ? []
      : [
          {
            id: newUuidV7(now.getTime()),
            clientId: id,
            position: 0,
            name: input.contact.name,
            relationship: input.contact.relationship,
            email: input.contact.email,
            emailNormalized:
              input.contact.email === null ? null : normalizeEmail(input.contact.email),
            phone: input.contact.phone,
            phoneNormalized:
              input.contact.phone === null ? null : normalizePhone(input.contact.phone),
            isPrimary: true,
            createdAt: at,
            updatedAt: at,
            version: 1,
          },
        ];
  await repositories.clients.create(record, contacts);
  await appendAuditEvent(repositories.audit, now, {
    actorUserId: context.actorUserId,
    action: AUDIT_ACTIONS.clientCreated,
    entityType: 'client',
    entityId: id,
    requestId: context.requestId,
    metadata: {
      clientCode,
      clientType: input.type,
      cnicMasked: execution.cnic?.masked ?? null,
      ntnMasked: execution.ntn?.masked ?? null,
      ...importMetadata(context),
    },
  });
  return { entityType: 'client', entityId: id, code: clientCode };
}

async function updateClient(
  execution: Extract<Execution, { kind: 'client_update' }>,
  context: ExecutionContext,
): Promise<ImportEntityRef> {
  const { repositories, now } = context;
  const { client, input } = execution;
  const updated = await repositories.clients.update({
    id: client.id,
    changes: {
      legalName: input.legalName,
      displayName: input.displayName,
      normalizedName: normalizeClientName(input.legalName),
      normalizedDisplayName: normalizeClientName(input.displayName),
      cnic: client.cnic,
      ntn: client.ntn,
      identifierKeyVersion: client.identifierKeyVersion,
      notes: input.notes,
      assignedManagerUserId: execution.managerUserId,
    },
    expectedVersion: client.version,
    at: now.toISOString(),
  });
  if (updated === null) {
    throw new ImportRowConflictError();
  }
  await appendAuditEvent(repositories.audit, now, {
    actorUserId: context.actorUserId,
    action: AUDIT_ACTIONS.clientUpdated,
    entityType: 'client',
    entityId: client.id,
    requestId: context.requestId,
    metadata: {
      clientCode: client.clientCode,
      changedFields: execution.changedFields.join(','),
      ...importMetadata(context),
    },
  });
  return { entityType: 'client', entityId: client.id, code: client.clientCode };
}

async function createCase(
  execution: Extract<Execution, { kind: 'case_create' }>,
  context: ExecutionContext,
): Promise<ImportEntityRef> {
  const { repositories, now } = context;
  const at = now.toISOString();
  const caseId = newUuidV7(now.getTime());
  const { client, service, template, version, initial, status } = execution;
  const history: CaseStatusHistoryRecord = {
    id: newUuidV7(now.getTime()),
    caseId,
    fromStatusKey: null,
    fromStatusName: null,
    toStatusKey: initial.key,
    toStatusName: initial.name,
    toStatusKind: initial.kind,
    note: '',
    actorUserId: context.actorUserId,
    requestId: context.requestId,
    occurredAt: at,
  };
  const items: CaseChecklistItemRecord[] = version.definition.checklist.map((item, position) => ({
    id: newUuidV7(now.getTime()),
    caseId,
    position,
    itemKey: item.key,
    label: item.label,
    documentType: item.documentType,
    required: item.required,
    reviewRequired: item.reviewRequired,
    instructions: item.instructions,
    state: 'open',
    completedBy: null,
    completedAt: null,
    preparerComment: '',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: '',
    createdAt: at,
    updatedAt: at,
    version: 1,
  }));
  await repositories.cases.lockClientForCaseCreation(client.id);
  const record: TaxCaseRecord = {
    id: caseId,
    caseCode: formatCaseCode(await repositories.cases.nextCaseNumber()),
    clientId: client.id,
    clientCode: client.clientCode,
    clientDisplayName: client.displayName,
    serviceTypeId: service.id,
    serviceName: service.name,
    serviceFeeMinor: service.defaultFeeMinor,
    taxYear: execution.taxYear,
    workflowVersionId: version.id,
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    workflowVersionNumber: version.versionNumber,
    workflowSnapshot: {
      statuses: version.definition.statuses,
      transitions: version.definition.transitions,
    },
    currentStatusKey: initial.key,
    currentStatusName: initial.name,
    currentStatusKind: initial.kind,
    currentStatusHistoryId: history.id,
    dueDate: execution.dueDate,
    primaryConsultantUserId: execution.primaryUserId,
    reviewerUserId: execution.reviewerUserId,
    notes: execution.notes,
    createdBy: context.actorUserId,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
  await repositories.cases.create(record, history, items);
  await appendAuditEvent(repositories.audit, now, {
    actorUserId: context.actorUserId,
    action: AUDIT_ACTIONS.caseCreated,
    entityType: 'tax_case',
    entityId: caseId,
    requestId: context.requestId,
    metadata: {
      caseCode: record.caseCode,
      clientId: client.id,
      serviceName: service.name,
      taxYear: execution.taxYear,
      workflowVersionId: version.id,
      toStatus: initial.name,
      dueDate: execution.dueDate,
      primaryConsultantUserId: execution.primaryUserId,
      reviewerUserId: execution.reviewerUserId,
      ...importMetadata(context),
    },
  });
  if (status.key !== initial.key) {
    // Imported mid-workflow: history records the move from the initial
    // status, so the case's history stays complete and append-only.
    const moved = await repositories.cases.transition({
      entry: {
        // UUIDv7 order is history order; one millisecond later keeps this row
        // strictly after the initial-status row created in the same instant.
        id: newUuidV7(now.getTime() + 1),
        caseId,
        fromStatusKey: initial.key,
        fromStatusName: initial.name,
        toStatusKey: status.key,
        toStatusName: status.name,
        toStatusKind: status.kind,
        note: `Imported at this status (${context.batchCode}, row ${String(context.rowNumber)}).`,
        actorUserId: context.actorUserId,
        requestId: context.requestId,
        occurredAt: at,
      },
      expectedVersion: 1,
      at,
    });
    if (moved === null) {
      throw new ImportRowConflictError();
    }
    await appendAuditEvent(repositories.audit, now, {
      actorUserId: context.actorUserId,
      action: AUDIT_ACTIONS.caseStatusChanged,
      entityType: 'tax_case',
      entityId: caseId,
      requestId: context.requestId,
      metadata: {
        caseCode: record.caseCode,
        fromStatus: initial.name,
        toStatus: status.name,
        ...importMetadata(context),
      },
    });
  }
  return { entityType: 'tax_case', entityId: caseId, code: record.caseCode };
}

async function createOpeningInvoice(
  execution: Extract<Execution, { kind: 'invoice_create' }>,
  context: ExecutionContext,
): Promise<ImportEntityRef> {
  const { repositories, now } = context;
  const at = now.toISOString();
  const { client, taxCase, input } = execution;
  const totals = calculateInvoiceTotals(
    [{ description: input.description, quantity: 1, unitAmountMinor: input.amountMinor }],
    0,
  );
  if (!totals.ok) {
    throw new ImportRowConflictError();
  }
  const id = newUuidV7(now.getTime());
  const draft: InvoiceRecord = {
    id,
    clientId: client.id,
    clientCode: client.clientCode,
    clientDisplayName: client.displayName,
    caseId: taxCase?.id ?? null,
    caseCode: taxCase?.caseCode ?? null,
    caseServiceName: taxCase?.serviceName ?? null,
    currency: FIRM_CURRENCY,
    status: 'draft',
    invoiceNumber: null,
    issueDate: input.asOfDate,
    dueDate: input.dueDate,
    subtotalMinor: totals.totals.subtotalMinor,
    discountMinor: 0,
    totalMinor: totals.totals.totalMinor,
    paidMinor: 0,
    outstandingMinor: totals.totals.totalMinor,
    paymentStatus: 'unpaid',
    notes: `Opening balance imported from ${context.batchCode}, row ${String(context.rowNumber)}.`,
    finalizedAt: null,
    finalizedBy: null,
    voidReason: null,
    voidedAt: null,
    voidedBy: null,
    pdfState: 'none',
    pdfDocumentId: null,
    createdBy: context.actorUserId,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
  const item: InvoiceItemRecord = {
    id: newUuidV7(now.getTime()),
    invoiceId: id,
    position: 1,
    description: input.description,
    quantity: 1,
    unitAmountMinor: input.amountMinor,
    lineTotalMinor: totals.totals.lineTotalsMinor[0] ?? input.amountMinor,
    createdAt: at,
  };
  await repositories.invoices.create(draft, [item]);
  const number = await repositories.numberSequences.next('invoice');
  const invoiceNumber = formatInvoiceNumber(number, (await repositories.firm.get())?.invoicePrefix);
  const finalized = await repositories.invoices.finalize({
    id,
    finalization: {
      invoiceNumber,
      issueDate: input.asOfDate,
      finalizedAt: at,
      finalizedBy: context.actorUserId,
    },
    expectedVersion: 1,
    at,
  });
  if (finalized === null) {
    throw new ImportRowConflictError();
  }
  await appendAuditEvent(repositories.audit, now, {
    actorUserId: context.actorUserId,
    action: AUDIT_ACTIONS.invoiceFinalized,
    entityType: 'invoice',
    entityId: id,
    requestId: context.requestId,
    metadata: {
      clientCode: client.clientCode,
      caseCode: taxCase?.caseCode ?? null,
      invoiceNumber,
      totalMinor: finalized.totalMinor,
      currency: finalized.currency,
      source: 'opening_balance_import',
      ...importMetadata(context),
    },
  });
  return { entityType: 'invoice', entityId: id, code: invoiceNumber };
}
