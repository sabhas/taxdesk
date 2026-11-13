import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { canAccessClient, canReadAllClients } from '../clients/client-access.js';
import type { ClientRecord } from '../clients/types.js';
import { canReadCase } from '../cases/case-access.js';
import type { TaxCaseRecord } from '../cases/types.js';

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
 * Case status is never consulted: billing and case workflow stay independent.
 */
export interface InvoiceTarget {
  readonly client: ClientRecord;
  readonly taxCase: TaxCaseRecord | null;
}

export function canReadInvoiceTarget(actor: Actor, target: InvoiceTarget): boolean {
  if (!hasPermission(actor, 'billing.read') && !hasPermission(actor, 'billing.payments.reverse')) {
    return false;
  }
  if (!canAccessClient(actor, target.client)) {
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
