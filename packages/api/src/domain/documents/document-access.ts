import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { canAccessClient, canReadAllClients } from '../clients/client-access.js';
import type { ClientRecord } from '../clients/types.js';
import {
  canReadCase,
  canReviewChecklist,
  canWorkCase,
  readsAllCases,
} from '../cases/case-access.js';
import type { TaxCaseRecord } from '../cases/types.js';

/**
 * Document authorization (TD-407). Every decision derives from the
 * authenticated actor's permissions and assignments; the request never names
 * a scope. A document's target is its client and, optionally, its case.
 *
 * - read / list / open: `documents.read` and either access to the client
 *   (`clients.read_all` or assigned manager) or read access to the linked
 *   case (`cases.read_all` or assigned to it);
 * - upload / edit / delete: `documents.manage` and, for a case document, the
 *   case-work rule (`canWorkCase`); for a client-level document, the client's
 *   assigned manager or a `clients.manage` holder who can see the client;
 * - review (verify / reject / reset): `documents.manage` and, for a case
 *   document, the reviewer rule (`canReviewChecklist`, which includes
 *   `cases.manage`); for a client-level document, `clients.manage`;
 * - restore: `documents.manage` plus `cases.manage` or `clients.manage`
 *   (managers and administrators), on a readable document.
 */
export interface DocumentTarget {
  readonly client: ClientRecord;
  readonly taxCase: TaxCaseRecord | null;
}

export function canReadDocumentTarget(actor: Actor, target: DocumentTarget): boolean {
  if (!hasPermission(actor, 'documents.read')) {
    return false;
  }
  if (canAccessClient(actor, target.client)) {
    return true;
  }
  return target.taxCase !== null && canReadCase(actor, target.taxCase);
}

export function canWriteDocumentTarget(actor: Actor, target: DocumentTarget): boolean {
  if (!hasPermission(actor, 'documents.manage')) {
    return false;
  }
  if (target.taxCase !== null) {
    return canWorkCase(actor, target.taxCase);
  }
  return (
    target.client.assignedManagerUserId === actor.userId ||
    (hasPermission(actor, 'clients.manage') && canAccessClient(actor, target.client))
  );
}

export function canReviewDocumentTarget(actor: Actor, target: DocumentTarget): boolean {
  if (!hasPermission(actor, 'documents.manage')) {
    return false;
  }
  if (target.taxCase !== null) {
    return canReviewChecklist(actor, target.taxCase);
  }
  return hasPermission(actor, 'clients.manage') && canAccessClient(actor, target.client);
}

export function canRestoreDocumentTarget(actor: Actor, target: DocumentTarget): boolean {
  return (
    hasPermission(actor, 'documents.manage') &&
    (hasPermission(actor, 'cases.manage') || hasPermission(actor, 'clients.manage')) &&
    canReadDocumentTarget(actor, target)
  );
}

/** Whether the actor sees every document without an assignment restriction. */
export function readsAllDocuments(actor: Actor): boolean {
  return canReadAllClients(actor) || readsAllCases(actor);
}

/**
 * A user who cannot see every record gets the same 403 for a missing
 * document as for someone else's, so guessing an ID reveals nothing.
 */
export function documentNotFound(actor: Actor): AuthError {
  return readsAllDocuments(actor)
    ? new AuthError(404, 'DOCUMENT_NOT_FOUND', 'The requested document was not found.')
    : forbidden();
}
