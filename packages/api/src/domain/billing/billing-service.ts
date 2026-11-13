import {
  AUDIT_ACTIONS,
  FIRM_CURRENCY,
  addDaysToDate,
  calculateInvoiceTotals,
  calendarDateIn,
  formatInvoiceNumber,
  formatReceiptNumber,
  newUuidV7,
  paymentStatusFor,
  type Invoice,
  type InvoiceDraftCreateRequest,
  type InvoiceDraftUpdateRequest,
  type InvoiceItemInput,
  type InvoiceList,
  type InvoiceListQuery,
  type InvoiceSummary,
  type Payment,
  type PaymentList,
  type PaymentOutcome,
  type RecordPaymentRequest,
  type ReversePaymentRequest,
  type VoidInvoiceRequest,
  type AuditMetadataValue,
} from '@taxdesk/shared';
import { base64UrlToBytes, bytesToBase64Url } from '../../crypto/encoding.js';
import { sha256Hex } from '../../crypto/token.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { requireAccessibleClient } from '../clients/client-access.js';
import { requireReadableCase } from '../cases/case-access.js';
import { personLookup } from '../people.js';
import {
  canManageBilling,
  canReadInvoiceTarget,
  canReversePayments,
  invoiceNotFound,
  paymentNotFound,
  readsAllInvoices,
  type InvoiceTarget,
} from './billing-access.js';
import type {
  InvoiceItemRecord,
  InvoiceListCursor,
  InvoiceRecord,
  PaymentRecord,
  PaymentReversalRecord,
} from './types.js';

export interface BillingServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly clock: () => Date;
}

const INVOICE_ENTITY = 'invoice';
const PAYMENT_ENTITY = 'payment';
const DEFAULT_TIMEZONE = 'Asia/Karachi';

function stale(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'This invoice changed since you loaded it. Refresh, review the latest values, and try again.',
  );
}

function validation(field: string, message: string): AuthError {
  return new AuthError(400, 'VALIDATION_FAILED', message, { errors: [{ field, message }] });
}

function encodeCursor(cursor: InvoiceListCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([cursor.createdAt, cursor.id])));
}

function decodeCursor(value: string): InvoiceListCursor {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw validation('cursor', 'The page cursor is not valid.');
}

interface IdempotentResult<T> {
  readonly value: T;
  /** `true` when the stored outcome of an earlier identical request was returned. */
  readonly replayed: boolean;
}

/**
 * Invoices, payments, reversals, and voids (TD-501–TD-510). Every financial
 * command runs in one transaction that first claims its idempotency key, then
 * row-locks the invoice, re-checks every rule under the lock, and writes the
 * records and their audit event together. A retry returns the stored outcome;
 * it never writes a second financial entry.
 */
export class BillingService {
  constructor(private readonly dependencies: BillingServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private now(): Date {
    return this.dependencies.clock();
  }

  private async firmToday(repositories: Repositories = this.repositories): Promise<string> {
    const firm = await repositories.firm.get();
    return calendarDateIn(firm?.timezone ?? DEFAULT_TIMEZONE, this.now());
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private summary(record: InvoiceRecord): InvoiceSummary {
    return {
      id: record.id,
      invoiceNumber: record.invoiceNumber,
      status: record.status,
      paymentStatus: record.paymentStatus,
      currency: FIRM_CURRENCY,
      client: {
        id: record.clientId,
        clientCode: record.clientCode,
        displayName: record.clientDisplayName,
      },
      case:
        record.caseId === null
          ? null
          : {
              id: record.caseId,
              caseCode: record.caseCode ?? '',
              serviceName: record.caseServiceName ?? '',
            },
      issueDate: record.issueDate,
      dueDate: record.dueDate,
      subtotalMinor: record.subtotalMinor,
      discountMinor: record.discountMinor,
      totalMinor: record.totalMinor,
      paidMinor: record.paidMinor,
      outstandingMinor: record.outstandingMinor,
      pdfState: record.pdfState,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  private toInvoice(record: InvoiceRecord, items: readonly InvoiceItemRecord[]): Invoice {
    return {
      ...this.summary(record),
      items: items.map((item) => ({
        id: item.id,
        position: item.position,
        description: item.description,
        quantity: item.quantity,
        unitAmountMinor: item.unitAmountMinor,
        lineTotalMinor: item.lineTotalMinor,
      })),
      notes: record.notes,
      finalizedAt: record.finalizedAt,
      voidReason: record.voidReason,
      voidedAt: record.voidedAt,
    };
  }

  private async invoiceView(repositories: Repositories, record: InvoiceRecord): Promise<Invoice> {
    return this.toInvoice(record, await repositories.invoices.listItems(record.id));
  }

  private async toPayments(
    repositories: Repositories,
    payments: readonly PaymentRecord[],
    reversals: readonly PaymentReversalRecord[],
  ): Promise<Payment[]> {
    const lookup = personLookup(repositories.users);
    const result: Payment[] = [];
    for (const payment of payments) {
      const own = reversals.filter((reversal) => reversal.paymentId === payment.id);
      const reversalViews = [];
      for (const reversal of own) {
        reversalViews.push({
          id: reversal.id,
          amountMinor: reversal.amountMinor,
          reason: reversal.reason,
          reversedByName: (await lookup(reversal.reversedBy))?.displayName ?? null,
          reversedAt: reversal.createdAt,
        });
      }
      result.push({
        id: payment.id,
        invoiceId: payment.invoiceId,
        receiptNumber: payment.receiptNumber,
        amountMinor: payment.amountMinor,
        method: payment.method,
        receivedOn: payment.receivedOn,
        reference: payment.reference,
        recordedByName: (await lookup(payment.recordedBy))?.displayName ?? null,
        recordedAt: payment.createdAt,
        reversedMinor: own.reduce((sum, reversal) => sum + reversal.amountMinor, 0),
        reversals: reversalViews,
        receiptPdfState: payment.receiptPdfState,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  private async targetOf(
    repositories: Repositories,
    record: InvoiceRecord,
  ): Promise<InvoiceTarget> {
    const client = await repositories.clients.findById(record.clientId);
    if (client === null) {
      throw new Error('The invoice references a missing client.');
    }
    const taxCase =
      record.caseId === null ? null : await repositories.cases.findById(record.caseId);
    return { client, taxCase };
  }

  /** Loads an invoice the actor may read, or throws the not-found/forbidden error. */
  private async readableInvoice(
    repositories: Repositories,
    actor: Actor,
    record: InvoiceRecord | null,
  ): Promise<{ record: InvoiceRecord; target: InvoiceTarget }> {
    if (record === null) {
      throw invoiceNotFound(actor);
    }
    const target = await this.targetOf(repositories, record);
    if (!canReadInvoiceTarget(actor, target)) {
      throw forbidden();
    }
    return { record, target };
  }

  private requireManage(actor: Actor, target: InvoiceTarget): void {
    if (!canManageBilling(actor, target)) {
      throw forbidden();
    }
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  private async idempotent<T>(
    repositories: Repositories,
    input: {
      readonly actor: Actor;
      readonly scope: string;
      readonly key: string;
      readonly request: unknown;
      readonly resourceId: string | null;
    },
    work: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const claim = await repositories.idempotency.begin({
      actorUserId: input.actor.userId,
      scope: input.scope,
      key: input.key,
      requestHash: await sha256Hex(JSON.stringify(input.request)),
      at: this.now().toISOString(),
    });
    if (claim.kind === 'conflict') {
      throw new AuthError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different request. Start the action again.',
      );
    }
    if (claim.kind === 'replay') {
      return { value: claim.response as T, replayed: true };
    }
    const value = await work();
    await repositories.idempotency.complete({
      actorUserId: input.actor.userId,
      scope: input.scope,
      key: input.key,
      resourceId: input.resourceId,
      response: value,
    });
    return { value, replayed: false };
  }

  private auditMetadata(
    record: InvoiceRecord,
    extra: Readonly<Record<string, AuditMetadataValue>> = {},
  ): Record<string, AuditMetadataValue> {
    return {
      clientCode: record.clientCode,
      caseCode: record.caseCode,
      invoiceNumber: record.invoiceNumber,
      totalMinor: record.totalMinor,
      currency: record.currency,
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Drafts (TD-502)
  // -------------------------------------------------------------------------

  async createDraft(input: {
    readonly actor: Actor;
    readonly request: InvoiceDraftCreateRequest;
    readonly requestId: string;
  }): Promise<Invoice> {
    const { actor, request } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    return await this.dependencies.unitOfWork.run(async (repositories) => {
      let taxCase = null;
      let clientId: string;
      if (request.caseId !== undefined) {
        taxCase = requireReadableCase(actor, await repositories.cases.findById(request.caseId));
        clientId = taxCase.clientId;
      } else {
        clientId = request.clientId ?? '';
      }
      const client = requireAccessibleClient(actor, await repositories.clients.findById(clientId));
      const target: InvoiceTarget = { client, taxCase };
      this.requireManage(actor, target);
      if (client.deletedAt !== null) {
        throw new AuthError(409, 'CLIENT_ARCHIVED', 'Restore the client before billing them.');
      }
      if (taxCase !== null && taxCase.deletedAt !== null) {
        throw new AuthError(409, 'CASE_ARCHIVED', 'Restore the case before billing it.');
      }

      const defaultItems: InvoiceItemInput[] =
        taxCase === null
          ? []
          : [
              {
                description: `${taxCase.serviceName} (tax year ${String(taxCase.taxYear)})`.slice(
                  0,
                  300,
                ),
                quantity: 1,
                unitAmountMinor: taxCase.serviceFeeMinor,
              },
            ];
      const totals = calculateInvoiceTotals(defaultItems, 0);
      if (!totals.ok) {
        throw validation(totals.field, totals.message);
      }
      const now = this.now();
      const at = now.toISOString();
      const id = newUuidV7(now.getTime());
      const record: InvoiceRecord = {
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
        issueDate: null,
        dueDate: null,
        subtotalMinor: totals.totals.subtotalMinor,
        discountMinor: 0,
        totalMinor: totals.totals.totalMinor,
        paidMinor: 0,
        outstandingMinor: totals.totals.totalMinor,
        paymentStatus: 'unpaid',
        notes: '',
        finalizedAt: null,
        finalizedBy: null,
        voidReason: null,
        voidedAt: null,
        voidedBy: null,
        pdfState: 'none',
        pdfDocumentId: null,
        createdBy: actor.userId,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      const items = this.itemRecords(id, defaultItems, totals.totals.lineTotalsMinor, at);
      await repositories.invoices.create(record, items);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.invoiceDrafted,
        entityType: INVOICE_ENTITY,
        entityId: id,
        requestId: input.requestId,
        metadata: this.auditMetadata(record, { source: taxCase === null ? 'client' : 'case' }),
      });
      return this.toInvoice(record, items);
    });
  }

  private itemRecords(
    invoiceId: string,
    items: readonly InvoiceItemInput[],
    lineTotals: readonly number[],
    at: string,
  ): InvoiceItemRecord[] {
    return items.map((item, index) => ({
      id: newUuidV7(this.now().getTime()),
      invoiceId,
      position: index + 1,
      description: item.description.trim(),
      quantity: item.quantity,
      unitAmountMinor: item.unitAmountMinor,
      lineTotalMinor: lineTotals[index] ?? 0,
      createdAt: at,
    }));
  }

  async getInvoice(actor: Actor, id: string): Promise<Invoice> {
    const repositories = this.repositories;
    const { record } = await this.readableInvoice(
      repositories,
      actor,
      await repositories.invoices.findById(id),
    );
    return await this.invoiceView(repositories, record);
  }

  async updateDraft(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly request: InvoiceDraftUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Invoice> {
    const { actor, request } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    const totals = calculateInvoiceTotals(request.items, request.discountMinor);
    if (!totals.ok) {
      throw validation(totals.field, totals.message);
    }
    return await this.dependencies.unitOfWork.run(async (repositories) => {
      const { record, target } = await this.readableInvoice(
        repositories,
        actor,
        await repositories.invoices.lockById(input.id),
      );
      this.requireManage(actor, target);
      if (record.status !== 'draft') {
        throw new AuthError(
          409,
          'INVOICE_NOT_DRAFT',
          'Only a draft invoice can be edited. A finalized invoice is a financial record.',
        );
      }
      if (record.version !== input.expectedVersion) {
        throw stale();
      }
      const before = await repositories.invoices.listItems(record.id);
      const at = this.now().toISOString();
      const items = this.itemRecords(record.id, request.items, totals.totals.lineTotalsMinor, at);
      const updated = await repositories.invoices.replaceDraft({
        id: record.id,
        changes: {
          subtotalMinor: totals.totals.subtotalMinor,
          discountMinor: totals.totals.discountMinor,
          totalMinor: totals.totals.totalMinor,
          outstandingMinor: totals.totals.totalMinor,
          issueDate: request.issueDate,
          dueDate: request.dueDate,
          notes: request.notes,
        },
        items,
        expectedVersion: input.expectedVersion,
        at,
      });
      if (updated === null) {
        throw stale();
      }
      const changed: string[] = [];
      const sameItems =
        before.length === items.length &&
        before.every((item, index) => {
          const next = items[index];
          return (
            next?.description === item.description &&
            next.quantity === item.quantity &&
            next.unitAmountMinor === item.unitAmountMinor
          );
        });
      if (!sameItems) {
        changed.push('items');
      }
      if (record.discountMinor !== updated.discountMinor) {
        changed.push('discount');
      }
      if (record.issueDate !== updated.issueDate) {
        changed.push('issueDate');
      }
      if (record.dueDate !== updated.dueDate) {
        changed.push('dueDate');
      }
      if (record.notes !== updated.notes) {
        changed.push('notes');
      }
      await appendAuditEvent(repositories.audit, this.now(), {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.invoiceUpdated,
        entityType: INVOICE_ENTITY,
        entityId: record.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(updated, { changedFields: changed.join(',') }),
      });
      return this.toInvoice(updated, items);
    });
  }

  // -------------------------------------------------------------------------
  // Finalize (TD-503)
  // -------------------------------------------------------------------------

  async finalizeInvoice(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<IdempotentResult<Invoice>> {
    const { actor } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    return await this.dependencies.unitOfWork.run(
      async (repositories) =>
        await this.idempotent(
          repositories,
          {
            actor,
            scope: `invoice.finalize:${input.id}`,
            key: input.idempotencyKey,
            request: { id: input.id, expectedVersion: input.expectedVersion },
            resourceId: input.id,
          },
          async () => {
            const { record, target } = await this.readableInvoice(
              repositories,
              actor,
              await repositories.invoices.lockById(input.id),
            );
            this.requireManage(actor, target);
            if (record.status !== 'draft') {
              throw new AuthError(
                409,
                'INVOICE_NOT_DRAFT',
                'This invoice is already finalized or void.',
              );
            }
            if (record.version !== input.expectedVersion) {
              throw stale();
            }
            const items = await repositories.invoices.listItems(record.id);
            if (items.length === 0 || record.totalMinor <= 0) {
              throw new AuthError(
                409,
                'INVOICE_EMPTY',
                'Add at least one line item with a total above zero before finalizing.',
              );
            }
            const issueDate = record.issueDate ?? (await this.firmToday(repositories));
            if (record.dueDate !== null && record.dueDate < issueDate) {
              throw validation(
                'dueDate',
                'The due date is before today. Update the due date before finalizing.',
              );
            }
            const number = await repositories.numberSequences.next('invoice');
            const at = this.now().toISOString();
            const finalized = await repositories.invoices.finalize({
              id: record.id,
              finalization: {
                invoiceNumber: formatInvoiceNumber(number),
                issueDate,
                finalizedAt: at,
                finalizedBy: actor.userId,
              },
              expectedVersion: input.expectedVersion,
              at,
            });
            if (finalized === null) {
              throw stale();
            }
            await appendAuditEvent(repositories.audit, this.now(), {
              actorUserId: actor.userId,
              action: AUDIT_ACTIONS.invoiceFinalized,
              entityType: INVOICE_ENTITY,
              entityId: finalized.id,
              requestId: input.requestId,
              metadata: this.auditMetadata(finalized),
            });
            return this.toInvoice(finalized, items);
          },
        ),
    );
  }

  // -------------------------------------------------------------------------
  // List and detail (TD-505)
  // -------------------------------------------------------------------------

  async listInvoices(actor: Actor, query: InvoiceListQuery): Promise<InvoiceList> {
    const repositories = this.repositories;
    if (query.clientId !== undefined) {
      requireAccessibleClient(actor, await repositories.clients.findById(query.clientId));
    }
    if (query.caseId !== undefined) {
      requireReadableCase(actor, await repositories.cases.findById(query.caseId));
    }
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const page = await repositories.invoices.list({
      ...(query.clientId === undefined ? {} : { clientId: query.clientId }),
      ...(query.caseId === undefined ? {} : { caseId: query.caseId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.paymentStatus === undefined ? {} : { paymentStatus: query.paymentStatus }),
      ...(query.issuedFrom === undefined ? {} : { issuedFrom: query.issuedFrom }),
      ...(query.issuedTo === undefined ? {} : { issuedTo: query.issuedTo }),
      ...(query.dueFrom === undefined ? {} : { dueFrom: query.dueFrom }),
      ...(query.dueTo === undefined ? {} : { dueTo: query.dueTo }),
      // Deny by default: a role that cannot read every client sees no invoices.
      ...(readsAllInvoices(actor) ? {} : { visibleClientIds: [] }),
      limit: query.limit,
      after,
    });
    const last = page.invoices.at(-1);
    return {
      invoices: page.invoices.map((record) => this.summary(record)),
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async listPayments(actor: Actor, invoiceId: string): Promise<PaymentList> {
    const repositories = this.repositories;
    const { record } = await this.readableInvoice(
      repositories,
      actor,
      await repositories.invoices.findById(invoiceId),
    );
    return {
      payments: await this.toPayments(
        repositories,
        await repositories.payments.listForInvoice(record.id),
        await repositories.payments.listReversalsForInvoice(record.id),
      ),
    };
  }

  /** A payment with its invoice's current balance (after a receipt PDF attempt). */
  async getPaymentOutcome(actor: Actor, paymentId: string): Promise<PaymentOutcome> {
    const repositories = this.repositories;
    const payment = await repositories.payments.findById(paymentId);
    if (payment === null) {
      throw paymentNotFound(actor);
    }
    const { record } = await this.readableInvoice(
      repositories,
      actor,
      await repositories.invoices.findById(payment.invoiceId),
    );
    return await this.outcome(repositories, payment.id, record);
  }

  // -------------------------------------------------------------------------
  // Payments (TD-506, TD-507)
  // -------------------------------------------------------------------------

  async recordPayment(input: {
    readonly actor: Actor;
    readonly invoiceId: string;
    readonly request: RecordPaymentRequest;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<IdempotentResult<PaymentOutcome>> {
    const { actor, request } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    const today = await this.firmToday();
    if (request.receivedOn > addDaysToDate(today, 1)) {
      throw validation('receivedOn', 'The received date cannot be in the future.');
    }
    return await this.dependencies.unitOfWork.run(
      async (repositories) =>
        await this.idempotent(
          repositories,
          {
            actor,
            scope: `payment.record:${input.invoiceId}`,
            key: input.idempotencyKey,
            request,
            resourceId: input.invoiceId,
          },
          async () => {
            const { record, target } = await this.readableInvoice(
              repositories,
              actor,
              await repositories.invoices.lockById(input.invoiceId),
            );
            this.requireManage(actor, target);
            this.requireFinalized(record);
            if (request.amountMinor > record.outstandingMinor) {
              throw new AuthError(
                409,
                'PAYMENT_EXCEEDS_OUTSTANDING',
                'The payment is more than the amount outstanding on this invoice.',
                {
                  errors: [
                    {
                      field: 'amountMinor',
                      message: 'Enter an amount up to the outstanding balance.',
                    },
                  ],
                },
              );
            }
            const now = this.now();
            const at = now.toISOString();
            const receipt = await repositories.numberSequences.next('receipt');
            const payment: PaymentRecord = {
              id: newUuidV7(now.getTime()),
              invoiceId: record.id,
              receiptNumber: formatReceiptNumber(receipt),
              amountMinor: request.amountMinor,
              method: request.method,
              receivedOn: request.receivedOn,
              reference: request.reference,
              recordedBy: actor.userId,
              receiptPdfState: 'pending',
              receiptDocumentId: null,
              createdAt: at,
              updatedAt: at,
              version: 1,
            };
            await repositories.payments.create(payment);
            const paid = record.paidMinor + request.amountMinor;
            const updated = await repositories.invoices.applyBalance({
              id: record.id,
              balance: {
                paidMinor: paid,
                outstandingMinor: record.totalMinor - paid,
                paymentStatus: paymentStatusFor(record.totalMinor, paid),
              },
              at,
            });
            await appendAuditEvent(repositories.audit, now, {
              actorUserId: actor.userId,
              action: AUDIT_ACTIONS.paymentRecorded,
              entityType: PAYMENT_ENTITY,
              entityId: payment.id,
              requestId: input.requestId,
              metadata: {
                invoiceNumber: record.invoiceNumber,
                receiptNumber: payment.receiptNumber,
                clientCode: record.clientCode,
                amountMinor: payment.amountMinor,
                method: payment.method,
                currency: record.currency,
              },
            });
            return await this.outcome(repositories, payment.id, updated);
          },
        ),
    );
  }

  private requireFinalized(record: InvoiceRecord): void {
    if (record.status === 'void') {
      throw new AuthError(409, 'INVOICE_VOID', 'This invoice is void.');
    }
    if (record.status !== 'finalized') {
      throw new AuthError(
        409,
        'INVOICE_NOT_FINALIZED',
        'Finalize the invoice before recording payments.',
      );
    }
  }

  private async outcome(
    repositories: Repositories,
    paymentId: string,
    invoice: InvoiceRecord,
  ): Promise<PaymentOutcome> {
    const payment = await repositories.payments.findById(paymentId);
    if (payment === null) {
      throw new Error('The payment disappeared inside its own transaction.');
    }
    const [view] = await this.toPayments(
      repositories,
      [payment],
      await repositories.payments.listReversalsForInvoice(invoice.id),
    );
    if (view === undefined) {
      throw new Error('The payment could not be mapped.');
    }
    return { payment: view, invoice: await this.invoiceView(repositories, invoice) };
  }

  // -------------------------------------------------------------------------
  // Reversal (TD-508)
  // -------------------------------------------------------------------------

  async reversePayment(input: {
    readonly actor: Actor;
    readonly paymentId: string;
    readonly request: ReversePaymentRequest;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<IdempotentResult<PaymentOutcome>> {
    const { actor, request } = input;
    if (!hasPermission(actor, 'billing.payments.reverse')) {
      throw forbidden();
    }
    return await this.dependencies.unitOfWork.run(
      async (repositories) =>
        await this.idempotent(
          repositories,
          {
            actor,
            scope: `payment.reverse:${input.paymentId}`,
            key: input.idempotencyKey,
            request,
            resourceId: input.paymentId,
          },
          async () => {
            const payment = await repositories.payments.findById(input.paymentId);
            if (payment === null) {
              throw paymentNotFound(actor);
            }
            // Lock the invoice before summing reversals, so two reversals of one
            // payment queue instead of both seeing the same unreversed value.
            const { record, target } = await this.readableInvoice(
              repositories,
              actor,
              await repositories.invoices.lockById(payment.invoiceId),
            );
            if (!canReversePayments(actor, target)) {
              throw forbidden();
            }
            const reversals = await repositories.payments.listReversalsForInvoice(record.id);
            const reversed = reversals
              .filter((reversal) => reversal.paymentId === payment.id)
              .reduce((sum, reversal) => sum + reversal.amountMinor, 0);
            const unreversed = payment.amountMinor - reversed;
            if (request.amountMinor > unreversed) {
              throw new AuthError(
                409,
                'REVERSAL_EXCEEDS_PAYMENT',
                'The reversal is more than the unreversed value of this payment.',
                {
                  errors: [
                    {
                      field: 'amountMinor',
                      message: 'Enter an amount up to the unreversed value of the payment.',
                    },
                  ],
                },
              );
            }
            const now = this.now();
            const at = now.toISOString();
            await repositories.payments.appendReversal({
              id: newUuidV7(now.getTime()),
              paymentId: payment.id,
              invoiceId: record.id,
              amountMinor: request.amountMinor,
              reason: request.reason,
              reversedBy: actor.userId,
              createdAt: at,
            });
            const paid = record.paidMinor - request.amountMinor;
            const updated = await repositories.invoices.applyBalance({
              id: record.id,
              balance: {
                paidMinor: paid,
                outstandingMinor: record.totalMinor - paid,
                paymentStatus: paymentStatusFor(record.totalMinor, paid),
              },
              at,
            });
            await appendAuditEvent(repositories.audit, now, {
              actorUserId: actor.userId,
              action: AUDIT_ACTIONS.paymentReversed,
              entityType: PAYMENT_ENTITY,
              entityId: payment.id,
              requestId: input.requestId,
              metadata: {
                invoiceNumber: record.invoiceNumber,
                receiptNumber: payment.receiptNumber,
                clientCode: record.clientCode,
                amountMinor: request.amountMinor,
                currency: record.currency,
                reason: request.reason,
              },
            });
            return await this.outcome(repositories, payment.id, updated);
          },
        ),
    );
  }

  // -------------------------------------------------------------------------
  // Void (TD-509)
  // -------------------------------------------------------------------------

  async voidInvoice(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly request: VoidInvoiceRequest;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<IdempotentResult<Invoice>> {
    const { actor, request } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    return await this.dependencies.unitOfWork.run(
      async (repositories) =>
        await this.idempotent(
          repositories,
          {
            actor,
            scope: `invoice.void:${input.id}`,
            key: input.idempotencyKey,
            request: {
              id: input.id,
              expectedVersion: input.expectedVersion,
              reason: request.reason,
            },
            resourceId: input.id,
          },
          async () => {
            const { record, target } = await this.readableInvoice(
              repositories,
              actor,
              await repositories.invoices.lockById(input.id),
            );
            this.requireManage(actor, target);
            if (record.status === 'void') {
              throw new AuthError(409, 'INVOICE_VOID', 'This invoice is already void.');
            }
            if (record.version !== input.expectedVersion) {
              throw stale();
            }
            if (record.paidMinor > 0) {
              throw new AuthError(
                409,
                'INVOICE_HAS_ACTIVE_PAYMENTS',
                'This invoice has payments. Reverse them first, then void the invoice.',
              );
            }
            const now = this.now();
            const at = now.toISOString();
            const voided = await repositories.invoices.void({
              id: record.id,
              voiding: { reason: request.reason, voidedAt: at, voidedBy: actor.userId },
              expectedVersion: input.expectedVersion,
              at,
            });
            await appendAuditEvent(repositories.audit, now, {
              actorUserId: actor.userId,
              action: AUDIT_ACTIONS.invoiceVoided,
              entityType: INVOICE_ENTITY,
              entityId: voided.id,
              requestId: input.requestId,
              metadata: this.auditMetadata(voided, {
                reason: request.reason,
                wasFinalized: record.status === 'finalized',
              }),
            });
            return await this.invoiceView(repositories, voided);
          },
        ),
    );
  }
}
