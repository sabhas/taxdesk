import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import type { ClientRecord } from './types.js';

/**
 * Client visibility rule. `clients.read_all` (administrator, manager, billing,
 * read-only) sees every client; a holder of only `clients.read` (consultant)
 * sees clients whose assigned manager is the signed-in user. The route guard
 * has already required `clients.read`.
 */
export function canReadAllClients(actor: Actor): boolean {
  return hasPermission(actor, 'clients.read_all');
}

export function canAccessClient(actor: Actor, client: ClientRecord): boolean {
  return canReadAllClients(actor) || client.assignedManagerUserId === actor.userId;
}

/**
 * Resolves a looked-up client for the actor. A user who cannot see every
 * client gets the same 403 for a missing client as for someone else's, so a
 * guessed identifier never reveals whether a record exists.
 */
export function requireAccessibleClient(actor: Actor, client: ClientRecord | null): ClientRecord {
  if (client === null) {
    if (canReadAllClients(actor)) {
      throw new AuthError(404, 'CLIENT_NOT_FOUND', 'The requested client was not found.');
    }
    throw forbidden();
  }
  if (!canAccessClient(actor, client)) {
    throw forbidden();
  }
  return client;
}

/** Overriding a non-exact duplicate warning is limited to managers and administrators. */
export function canOverrideDuplicateWarning(actor: Actor): boolean {
  return hasPermission(actor, 'clients.manage');
}
