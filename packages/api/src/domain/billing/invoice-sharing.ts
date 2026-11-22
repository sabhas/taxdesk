import {
  AUDIT_ACTIONS,
  InvoiceShareContextSchema,
  WhatsAppPhoneSchema,
  buildInvoiceShareMessage,
  type InvoiceShareChannel,
  type InvoiceShareContext,
} from '@taxdesk/shared';
import type { Repositories } from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import type { ClientContactRecord } from '../clients/types.js';
import { canReadInvoiceTarget, invoiceNotFound, loadInvoiceTarget } from './billing-access.js';
import type { InvoiceRecord } from './types.js';

export interface InvoiceShareServiceOptions {
  readonly repositories: Repositories;
  readonly clock: () => Date;
}

const DEFAULT_FIRM_NAME = 'TaxDesk';

/**
 * The phone to open WhatsApp with: the primary contact's, otherwise the first
 * contact that has one. `null` lets staff choose the chat themselves.
 */
export function shareRecipientPhone(contacts: readonly ClientContactRecord[]): string | null {
  const ordered = [...contacts].sort(
    (left, right) =>
      Number(right.isPrimary) - Number(left.isPrimary) || left.position - right.position,
  );
  for (const contact of ordered) {
    if (
      contact.phoneNormalized !== null &&
      WhatsAppPhoneSchema.safeParse(contact.phoneNormalized).success
    ) {
      return contact.phoneNormalized;
    }
  }
  return null;
}

/**
 * Sharing an invoice with its client (TD-513; ADR 0012). TaxDesk sends
 * nothing itself: it gives the browser the message and recipient, and records
 * a share the device reports as completed. Anyone who can download the
 * invoice PDF can share it, and only a finalized invoice with a stored PDF.
 */
export class InvoiceShareService {
  constructor(private readonly options: InvoiceShareServiceOptions) {}

  private get repositories(): Repositories {
    return this.options.repositories;
  }

  /** Loads the invoice, checks the actor can read it, and that it can be shared. */
  private async shareable(actor: Actor, invoiceId: string): Promise<InvoiceRecord> {
    const invoice = await this.repositories.invoices.findById(invoiceId);
    if (invoice === null) {
      throw invoiceNotFound(actor);
    }
    const target = await loadInvoiceTarget(this.repositories, invoice);
    if (!canReadInvoiceTarget(actor, target)) {
      throw forbidden();
    }
    if (invoice.status === 'draft' || invoice.invoiceNumber === null) {
      throw new AuthError(409, 'INVOICE_NOT_SHAREABLE', 'Finalize this invoice before sharing it.');
    }
    if (invoice.status === 'void') {
      throw new AuthError(409, 'INVOICE_NOT_SHAREABLE', 'A void invoice cannot be shared.');
    }
    if (invoice.pdfState !== 'ready' || invoice.pdfDocumentId === null) {
      throw new AuthError(
        409,
        'INVOICE_NOT_SHAREABLE',
        'This invoice can be shared once its PDF is stored.',
      );
    }
    return invoice;
  }

  async context(input: {
    readonly actor: Actor;
    readonly invoiceId: string;
  }): Promise<InvoiceShareContext> {
    const invoice = await this.shareable(input.actor, input.invoiceId);
    const invoiceNumber = invoice.invoiceNumber ?? '';
    const firm = await this.repositories.firm.get();
    const firmName = firm?.firmName ?? DEFAULT_FIRM_NAME;
    const contacts = await this.repositories.clients.listContacts([invoice.clientId]);
    return InvoiceShareContextSchema.parse({
      invoiceId: invoice.id,
      invoiceNumber,
      fileName: `${invoiceNumber}.pdf`,
      title: `Invoice ${invoiceNumber} from ${firmName}`.slice(0, 200),
      message: buildInvoiceShareMessage({
        firmName,
        clientName: invoice.clientDisplayName,
        invoiceNumber,
        currency: invoice.currency,
        totalMinor: invoice.totalMinor,
        outstandingMinor: invoice.outstandingMinor,
        dueDate: invoice.dueDate,
      }),
      whatsappPhone: shareRecipientPhone(contacts),
    });
  }

  /** Records a share the device completed. The invoice is rechecked first. */
  async record(input: {
    readonly actor: Actor;
    readonly invoiceId: string;
    readonly channel: InvoiceShareChannel;
    readonly requestId: string;
  }): Promise<void> {
    const invoice = await this.shareable(input.actor, input.invoiceId);
    await appendAuditEvent(this.repositories.audit, this.options.clock(), {
      actorUserId: input.actor.userId,
      action: AUDIT_ACTIONS.invoiceShared,
      entityType: 'invoice',
      entityId: invoice.id,
      requestId: input.requestId,
      metadata: {
        channel: input.channel,
        invoiceNumber: invoice.invoiceNumber,
        clientCode: invoice.clientCode,
      },
    });
  }
}
