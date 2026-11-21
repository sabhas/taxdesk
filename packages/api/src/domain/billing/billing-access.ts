import type { Repositories } from '../../repositories/ports.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { canAccessClient, canReadAllClients } from '../clients/client-access.js';
import type { ClientRecord } from '../clients/types.js';
import { canReadCase } from '../cases/case-access.js';
import type { TaxCaseRecord } from '../cases/types.js';
import type { InvoiceRecord } from './types.js';

/**
 * Billing authorization (Epic 5). Every decision derives from the signed-in
 * actor's permissions and the record they reach, never from the request:
 *
 * - read invoices, payments, and PDFs: `billing.read`, and the invoice's
 *   client (and case, when linked) must be readable by the actor;
 * - draft, edit, finalize, record payments, void, and regenerate PDFs:
 *   `billing.manage` on a readable invoice;
 * - reverse a payment: `billing.payments.reverse` (a separate permission, so
 *   recording and reversing can be held by different people).
 *
 * A combined group invoice (TD-511) is readable only when every client and
 * case on its lines is readable too, so it never shows a member's work to
 * someone who cannot see that member. Grouping never grants access.
 *
 * Case status is never consulted: billing and case workflow stay independent.
 */
export interface InvoiceTarget {
  readonly client: ClientRecord;
  readonly taxCase: TaxCaseRecord | null;
  /** Combined invoices: the distinct clients and cases named on its lines. */
  readonly lineClients: readonly ClientRecord[];
  readonly lineCases: readonly TaxCaseRecord[];
}

/** Loads everything an invoice names, for the access checks below. */
export async function loadInvoiceTarget(
  repositories: Pick<Repositories, 'clients' | 'cases' | 'invoices'>,
  invoice: InvoiceRecord,
): Promise<InvoiceTarget> {
  const client = await repositories.clients.findById(invoice.clientId);
  if (client === null) {
    throw new Error('The invoice references a missing client.');
  }
  const taxCase =
    invoice.caseId === null ? null : await repositories.cases.findById(invoice.caseId);
  if (invoice.billingMode !== 'combined') {
    return { client, taxCase, lineClients: [], lineCases: [] };
  }
  const items = await repositories.invoices.listItems(invoice.id);
  const clientIds = [
    ...new Set(items.flatMap((item) => (item.clientId === null ? [] : [item.clientId]))),
  ];
  const caseIds = [
    ...new Set(items.flatMap((item) => (item.caseId === null ? [] : [item.caseId]))),
  ];
  const lineClients = await repositories.clients.findByIds(clientIds);
  if (lineClients.length !== clientIds.length) {
    throw new Error('The invoice references a missing client.');
  }
  const lineCases: TaxCaseRecord[] = [];
  for (const caseId of caseIds) {
    const found = await repositories.cases.findById(caseId);
    if (found === null) {
      throw new Error('The invoice references a missing case.');
    }
    lineCases.push(found);
  }
  return { client, taxCase, lineClients, lineCases };
}

export function canReadInvoiceTarget(actor: Actor, target: InvoiceTarget): boolean {
  if (!hasPermission(actor, 'billing.read') && !hasPermission(actor, 'billing.payments.reverse')) {
    return false;
  }
  if (!canAccessClient(actor, target.client)) {
    return false;
  }
  if (!target.lineClients.every((client) => canAccessClient(actor, client))) {
    return false;
  }
  if (!target.lineCases.every((taxCase) => canReadCase(actor, taxCase))) {
    return false;
  }
  return target.taxCase === null || canReadCase(actor, target.taxCase);
}

export function canManageBilling(actor: Actor, target: InvoiceTarget): boolean {
  return hasPermission(actor, 'billing.manage') && canReadInvoiceTarget(actor, target);
}

export function canReversePayments(actor: Actor, target: InvoiceTarget): boolean {
  return hasPermission(actor, 'billing.payments.reverse') && canReadInvoiceTarget(actor, target);
}

/** Whether the actor sees invoices for every client. */
export function readsAllInvoices(actor: Actor): boolean {
  return canReadAllClients(actor);
}

/**
 * A user who cannot read every client gets the same 403 for a missing invoice
 * as for someone else's, so guessing an ID reveals nothing.
 */
export function invoiceNotFound(actor: Actor): AuthError {
  return readsAllInvoices(actor)
    ? new AuthError(404, 'INVOICE_NOT_FOUND', 'The requested invoice was not found.')
    : forbidden();
}

export function paymentNotFound(actor: Actor): AuthError {
  return readsAllInvoices(actor)
    ? new AuthError(404, 'PAYMENT_NOT_FOUND', 'The requested payment was not found.')
    : forbidden();
}
