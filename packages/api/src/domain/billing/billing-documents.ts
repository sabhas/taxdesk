import { AUDIT_ACTIONS, newUuidV7, type BillingPdfState } from '@taxdesk/shared';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import type { StorageGateway } from '../../storage/gateway.js';
import {
  isStorageProviderError,
  type ProviderDownload,
  type ProviderItem,
} from '../../storage/provider.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { buildDocumentStoragePath } from '../documents/storage-layout.js';
import {
  canManageBilling,
  canReadInvoiceTarget,
  invoiceNotFound,
  paymentNotFound,
  type InvoiceTarget,
} from './billing-access.js';
import { buildInvoiceLayout, buildReceiptLayout, type PdfLayout } from './pdf/layout.js';
import type { PdfRenderer } from './pdf/renderer.js';
import type { BillingDocumentRecord, InvoiceRecord, PaymentRecord } from './types.js';

export interface BillingDocumentServiceOptions {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly storage: StorageGateway;
  readonly renderer: PdfRenderer;
  readonly clock: () => Date;
}

export interface PdfGenerationResult {
  readonly state: BillingPdfState;
  /** `true` when this call stored a new file; `false` when one already existed. */
  readonly created: boolean;
}

export interface BillingPdfDownload {
  readonly fileName: string;
  readonly download: ProviderDownload;
}

const INVOICE_ENTITY = 'invoice';
const PAYMENT_ENTITY = 'payment';
const DEFAULT_FIRM_NAME = 'TaxDesk';

/**
 * Invoice and receipt PDFs (TD-504, TD-507). Generation is decoupled from the
 * financial commands: finalize and payment commit without storage, then this
 * service renders a snapshot built only from the committed rows and stores it
 * through the provider-neutral gateway. Every step is idempotent: a PDF that
 * is already stored is returned, never re-created, and a failure leaves the
 * financial record untouched with a `failed` state and a retry.
 */
export class BillingDocumentService {
  constructor(private readonly options: BillingDocumentServiceOptions) {}

  private get repositories(): Repositories {
    return this.options.repositories;
  }

  private now(): Date {
    return this.options.clock();
  }

  private async targetOf(invoice: InvoiceRecord): Promise<InvoiceTarget> {
    const client = await this.repositories.clients.findById(invoice.clientId);
    if (client === null) {
      throw new Error('The invoice references a missing client.');
    }
    const taxCase =
      invoice.caseId === null ? null : await this.repositories.cases.findById(invoice.caseId);
    return { client, taxCase };
  }

  private async readableInvoice(
    actor: Actor,
    invoice: InvoiceRecord | null,
  ): Promise<{ invoice: InvoiceRecord; target: InvoiceTarget }> {
    if (invoice === null) {
      throw invoiceNotFound(actor);
    }
    const target = await this.targetOf(invoice);
    if (!canReadInvoiceTarget(actor, target)) {
      throw forbidden();
    }
    return { invoice, target };
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Generates (or returns) the invoice PDF. With `mode: 'best_effort'` a
   * storage failure is recorded and reported as `failed`; with `'explicit'`
   * (the retry action) it is also thrown so the caller can show the notice.
   */
  async generateInvoicePdf(input: {
    readonly actor: Actor;
    readonly invoiceId: string;
    readonly requestId: string;
    readonly mode: 'best_effort' | 'explicit';
  }): Promise<PdfGenerationResult> {
    const { actor } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    const { invoice, target } = await this.readableInvoice(
      actor,
      await this.repositories.invoices.findById(input.invoiceId),
    );
    if (!canManageBilling(actor, target)) {
      throw forbidden();
    }
    if (invoice.invoiceNumber === null || invoice.finalizedAt === null) {
      throw new AuthError(
        409,
        'INVOICE_NOT_FINALIZED',
        'Finalize the invoice before generating its PDF.',
      );
    }
    if (invoice.pdfState === 'ready' && invoice.pdfDocumentId !== null) {
      return { state: 'ready', created: false };
    }
    const invoiceNumber = invoice.invoiceNumber;
    const finalizedAt = invoice.finalizedAt;

    try {
      const items = await this.repositories.invoices.listItems(invoice.id);
      const firm = await this.repositories.firm.get();
      const layout = buildInvoiceLayout({
        firmName: firm?.firmName ?? DEFAULT_FIRM_NAME,
        invoiceNumber,
        currency: invoice.currency,
        issueDate: invoice.issueDate ?? '',
        dueDate: invoice.dueDate,
        finalizedAt,
        client: { clientCode: invoice.clientCode, displayName: invoice.clientDisplayName },
        caseCode: invoice.caseCode,
        items,
        subtotalMinor: invoice.subtotalMinor,
        discountMinor: invoice.discountMinor,
        totalMinor: invoice.totalMinor,
        notes: invoice.notes,
      });
      const stored = await this.store({
        layout,
        fileName: `${invoiceNumber}.pdf`,
        target,
        requestId: input.requestId,
        actor,
      });
      return await this.recordInvoicePdf({ actor, invoice, stored, requestId: input.requestId });
    } catch (error) {
      await this.recordFailure({
        actor,
        invoice,
        payment: null,
        requestId: input.requestId,
      });
      if (input.mode === 'explicit') {
        throw error;
      }
      if (!(error instanceof AuthError) && !isStorageProviderError(error)) {
        throw error;
      }
      return { state: 'failed', created: false };
    }
  }

  async generateReceiptPdf(input: {
    readonly actor: Actor;
    readonly paymentId: string;
    readonly requestId: string;
    readonly mode: 'best_effort' | 'explicit';
  }): Promise<PdfGenerationResult> {
    const { actor } = input;
    if (!hasPermission(actor, 'billing.manage')) {
      throw forbidden();
    }
    const payment = await this.repositories.payments.findById(input.paymentId);
    if (payment === null) {
      throw paymentNotFound(actor);
    }
    const { invoice, target } = await this.readableInvoice(
      actor,
      await this.repositories.invoices.findById(payment.invoiceId),
    );
    if (!canManageBilling(actor, target)) {
      throw forbidden();
    }
    if (payment.receiptPdfState === 'ready' && payment.receiptDocumentId !== null) {
      return { state: 'ready', created: false };
    }
    try {
      const firm = await this.repositories.firm.get();
      const layout = buildReceiptLayout({
        firmName: firm?.firmName ?? DEFAULT_FIRM_NAME,
        receiptNumber: payment.receiptNumber,
        invoiceNumber: invoice.invoiceNumber ?? '',
        currency: invoice.currency,
        recordedAt: payment.createdAt,
        receivedOn: payment.receivedOn,
        method: payment.method,
        reference: payment.reference,
        amountMinor: payment.amountMinor,
        invoiceTotalMinor: invoice.totalMinor,
        client: { clientCode: invoice.clientCode, displayName: invoice.clientDisplayName },
        caseCode: invoice.caseCode,
      });
      const stored = await this.store({
        layout,
        fileName: `${payment.receiptNumber}.pdf`,
        target,
        requestId: input.requestId,
        actor,
      });
      return await this.recordReceiptPdf({
        actor,
        invoice,
        payment,
        stored,
        requestId: input.requestId,
      });
    } catch (error) {
      await this.recordFailure({ actor, invoice, payment, requestId: input.requestId });
      if (input.mode === 'explicit') {
        throw error;
      }
      if (!(error instanceof AuthError) && !isStorageProviderError(error)) {
        throw error;
      }
      return { state: 'failed', created: false };
    }
  }

  /** Renders and uploads one PDF as a single upload-session chunk. */
  private async store(input: {
    readonly layout: PdfLayout;
    readonly fileName: string;
    readonly target: InvoiceTarget;
    readonly requestId: string;
    readonly actor: Actor;
  }): Promise<{
    readonly documentId: string;
    readonly item: ProviderItem;
    readonly sizeBytes: number;
    readonly providerType: BillingDocumentRecord['providerType'];
  }> {
    const bytes = await this.options.renderer.render(input.layout);
    const documentId = newUuidV7(this.now().getTime());
    const path = buildDocumentStoragePath({
      clientCode: input.target.client.clientCode,
      taxYear: input.target.taxCase?.taxYear ?? null,
      caseId: input.target.taxCase?.id ?? null,
      documentId,
      fileName: input.fileName,
    });
    const { item, providerType } = await this.options.storage.run(
      async (context) => {
        const session = await context.provider.createUploadSession(context.credentials, {
          path,
          sizeBytes: bytes.length,
        });
        const result = await context.provider.uploadChunk({
          session,
          offset: 0,
          totalSize: bytes.length,
          bytes,
        });
        if (result.kind !== 'complete') {
          await context.provider.cancelUploadSession(session).catch(() => undefined);
          throw new AuthError(
            503,
            'STORAGE_UNAVAILABLE',
            'Document storage did not accept the file. Try again shortly.',
          );
        }
        return { item: result.item, providerType: context.providerType };
      },
      { requestId: input.requestId, actorUserId: input.actor.userId },
    );
    return { documentId, item, sizeBytes: bytes.length, providerType };
  }

  private async recordInvoicePdf(input: {
    readonly actor: Actor;
    readonly invoice: InvoiceRecord;
    readonly stored: Awaited<ReturnType<BillingDocumentService['store']>>;
    readonly requestId: string;
  }): Promise<PdfGenerationResult> {
    const { actor, invoice, stored } = input;
    return await this.options.unitOfWork.run(async (repositories) => {
      // Re-check under the row lock: a concurrent generation may have won.
      const current = await repositories.invoices.lockById(invoice.id);
      if (current?.pdfState === 'ready' && current.pdfDocumentId !== null) {
        await this.discard(stored.item.externalItemId, input.requestId, actor.userId);
        return { state: 'ready', created: false } as const;
      }
      const at = this.now().toISOString();
      await repositories.billingDocuments.create({
        id: stored.documentId,
        kind: 'invoice',
        invoiceId: invoice.id,
        paymentId: null,
        clientId: invoice.clientId,
        caseId: invoice.caseId,
        providerType: stored.providerType,
        externalItemId: stored.item.externalItemId,
        externalDriveId: stored.item.driveId,
        fileName: `${invoice.invoiceNumber ?? 'invoice'}.pdf`,
        sizeBytes: stored.sizeBytes,
        createdBy: actor.userId,
        createdAt: at,
      });
      await repositories.invoices.setPdf({
        id: invoice.id,
        state: 'ready',
        documentId: stored.documentId,
        at,
      });
      await appendAuditEvent(repositories.audit, this.now(), {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.invoicePdfGenerated,
        entityType: INVOICE_ENTITY,
        entityId: invoice.id,
        requestId: input.requestId,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          clientCode: invoice.clientCode,
          sizeBytes: stored.sizeBytes,
        },
      });
      return { state: 'ready', created: true } as const;
    });
  }

  private async recordReceiptPdf(input: {
    readonly actor: Actor;
    readonly invoice: InvoiceRecord;
    readonly payment: PaymentRecord;
    readonly stored: Awaited<ReturnType<BillingDocumentService['store']>>;
    readonly requestId: string;
  }): Promise<PdfGenerationResult> {
    const { actor, invoice, payment, stored } = input;
    return await this.options.unitOfWork.run(async (repositories) => {
      // Lock the invoice (the same order as every financial command) before the payment.
      await repositories.invoices.lockById(invoice.id);
      const current = await repositories.payments.findById(payment.id);
      if (current?.receiptPdfState === 'ready' && current.receiptDocumentId !== null) {
        await this.discard(stored.item.externalItemId, input.requestId, actor.userId);
        return { state: 'ready', created: false } as const;
      }
      const at = this.now().toISOString();
      await repositories.billingDocuments.create({
        id: stored.documentId,
        kind: 'receipt',
        invoiceId: invoice.id,
        paymentId: payment.id,
        clientId: invoice.clientId,
        caseId: invoice.caseId,
        providerType: stored.providerType,
        externalItemId: stored.item.externalItemId,
        externalDriveId: stored.item.driveId,
        fileName: `${payment.receiptNumber}.pdf`,
        sizeBytes: stored.sizeBytes,
        createdBy: actor.userId,
        createdAt: at,
      });
      await repositories.payments.setReceiptPdf({
        id: payment.id,
        state: 'ready',
        documentId: stored.documentId,
        at,
      });
      await appendAuditEvent(repositories.audit, this.now(), {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.receiptPdfGenerated,
        entityType: PAYMENT_ENTITY,
        entityId: payment.id,
        requestId: input.requestId,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          receiptNumber: payment.receiptNumber,
          clientCode: invoice.clientCode,
          sizeBytes: stored.sizeBytes,
        },
      });
      return { state: 'ready', created: true } as const;
    });
  }

  /** Best-effort cleanup of an upload that lost the race to another generation. */
  private async discard(
    externalItemId: string,
    requestId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.options.storage
      .run(
        async (context) => {
          await context.provider.trash(context.credentials, externalItemId);
        },
        {
          requestId,
          actorUserId,
        },
      )
      .catch(() => undefined);
  }

  /** Marks the PDF `failed` (never touching amounts) and audits it. */
  private async recordFailure(input: {
    readonly actor: Actor;
    readonly invoice: InvoiceRecord;
    readonly payment: PaymentRecord | null;
    readonly requestId: string;
  }): Promise<void> {
    const { actor, invoice, payment } = input;
    await this.options.unitOfWork.run(async (repositories) => {
      await repositories.invoices.lockById(invoice.id);
      const at = this.now().toISOString();
      if (payment === null) {
        const current = await repositories.invoices.findById(invoice.id);
        if (current?.pdfState === 'ready') {
          return;
        }
        await repositories.invoices.setPdf({
          id: invoice.id,
          state: 'failed',
          documentId: null,
          at,
        });
      } else {
        const current = await repositories.payments.findById(payment.id);
        if (current?.receiptPdfState === 'ready') {
          return;
        }
        await repositories.payments.setReceiptPdf({
          id: payment.id,
          state: 'failed',
          documentId: null,
          at,
        });
      }
      await appendAuditEvent(repositories.audit, this.now(), {
        actorUserId: actor.userId,
        action: payment === null ? AUDIT_ACTIONS.invoicePdfFailed : AUDIT_ACTIONS.receiptPdfFailed,
        entityType: payment === null ? INVOICE_ENTITY : PAYMENT_ENTITY,
        entityId: payment === null ? invoice.id : payment.id,
        requestId: input.requestId,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          clientCode: invoice.clientCode,
          ...(payment === null ? {} : { receiptNumber: payment.receiptNumber }),
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  async downloadInvoicePdf(input: {
    readonly actor: Actor;
    readonly invoiceId: string;
    readonly requestId: string;
  }): Promise<BillingPdfDownload> {
    const { invoice } = await this.readableInvoice(
      input.actor,
      await this.repositories.invoices.findById(input.invoiceId),
    );
    if (invoice.pdfState !== 'ready' || invoice.pdfDocumentId === null) {
      throw this.notReady();
    }
    const document = await this.repositories.billingDocuments.findById(invoice.pdfDocumentId);
    if (document === null) {
      throw this.notReady();
    }
    const download = await this.fetch(document, input);
    await appendAuditEvent(this.repositories.audit, this.now(), {
      actorUserId: input.actor.userId,
      action: AUDIT_ACTIONS.invoicePdfDownloaded,
      entityType: INVOICE_ENTITY,
      entityId: invoice.id,
      requestId: input.requestId,
      metadata: { invoiceNumber: invoice.invoiceNumber, clientCode: invoice.clientCode },
    });
    return { fileName: document.fileName, download };
  }

  async downloadReceiptPdf(input: {
    readonly actor: Actor;
    readonly paymentId: string;
    readonly requestId: string;
  }): Promise<BillingPdfDownload> {
    const payment = await this.repositories.payments.findById(input.paymentId);
    if (payment === null) {
      throw paymentNotFound(input.actor);
    }
    const { invoice } = await this.readableInvoice(
      input.actor,
      await this.repositories.invoices.findById(payment.invoiceId),
    );
    if (payment.receiptPdfState !== 'ready' || payment.receiptDocumentId === null) {
      throw this.notReady();
    }
    const document = await this.repositories.billingDocuments.findById(payment.receiptDocumentId);
    if (document === null) {
      throw this.notReady();
    }
    const download = await this.fetch(document, input);
    await appendAuditEvent(this.repositories.audit, this.now(), {
      actorUserId: input.actor.userId,
      action: AUDIT_ACTIONS.receiptPdfDownloaded,
      entityType: PAYMENT_ENTITY,
      entityId: payment.id,
      requestId: input.requestId,
      metadata: {
        invoiceNumber: invoice.invoiceNumber,
        receiptNumber: payment.receiptNumber,
        clientCode: invoice.clientCode,
      },
    });
    return { fileName: document.fileName, download };
  }

  private notReady(): AuthError {
    return new AuthError(
      409,
      'BILLING_PDF_NOT_READY',
      'The PDF is not ready yet. Generate it again, then download it.',
    );
  }

  private async fetch(
    document: BillingDocumentRecord,
    input: { readonly actor: Actor; readonly requestId: string },
  ): Promise<ProviderDownload> {
    try {
      return await this.options.storage.run(
        async (context) =>
          await context.provider.download(context.credentials, document.externalItemId),
        { requestId: input.requestId, actorUserId: input.actor.userId },
      );
    } catch (error) {
      if (isStorageProviderError(error) && error.kind === 'not_found') {
        throw new AuthError(
          404,
          'DOCUMENT_MISSING_IN_STORAGE',
          'The file is missing from document storage. Ask an administrator to check storage.',
        );
      }
      throw error;
    }
  }
}
