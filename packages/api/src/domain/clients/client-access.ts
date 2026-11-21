import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import type { ClientRepository } from '../../repositories/ports.js';
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

/**
 * The client IDs a group filter selects for the actor (TD-207): the group
 * head and its members, keeping only clients the actor can see. Grouping
 * never widens access, so a hidden member is left out rather than counted.
 * The head itself must be visible, with the usual 404/403 for one that is not.
 */
export async function visibleGroupClientIds(
  clients: Pick<ClientRepository, 'findById' | 'listMembers'>,
  actor: Actor,
  groupClientId: string,
): Promise<string[]> {
  const head = requireAccessibleClient(actor, await clients.findById(groupClientId));
  const members = await clients.listMembers([head.id]);
  return [
    head.id,
    ...members.filter((member) => canAccessClient(actor, member)).map((member) => member.id),
  ];
}
