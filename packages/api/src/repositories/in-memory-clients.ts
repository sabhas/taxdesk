/* eslint-disable @typescript-eslint/require-await -- in-memory fakes implement async repository ports synchronously */
import type { DuplicateMatchReason } from '@taxdesk/shared';
import {
  clientSortKey,
  type ClientContactRecord,
  type ClientListFilter,
  type ClientRecord,
  type DuplicateCandidate,
} from '../domain/clients/types.js';
import { DuplicateClientIdentifierError, type ClientRepository } from './ports.js';

export interface InMemoryClientState {
  clients: Map<string, ClientRecord>;
  clientContacts: Map<string, ClientContactRecord[]>;
  clientSequence: number;
}

export function createInMemoryClientState(): InMemoryClientState {
  return { clients: new Map(), clientContacts: new Map(), clientSequence: 0 };
}

function compareCursor(record: ClientRecord, sortKey: string, id: string): number {
  const key = clientSortKey(record.displayName);
  if (key !== sortKey) {
    return key < sortKey ? -1 : 1;
  }
  return record.id === id ? 0 : record.id < id ? -1 : 1;
}

function sortClients(left: ClientRecord, right: ClientRecord): number {
  return compareCursor(left, clientSortKey(right.displayName), right.id);
}

/**
 * Test double with the observable contract of the PostgreSQL client
 * repository, including the deployment-wide unique blind indexes.
 */
export function createInMemoryClientRepository(state: InMemoryClientState): ClientRepository {
  const assertUniqueIdentifiers = (candidate: ClientRecord): void => {
    for (const existing of state.clients.values()) {
      if (existing.id === candidate.id) {
        continue;
      }
      const cnicClash =
        candidate.cnic !== null && existing.cnic?.blindIndex === candidate.cnic.blindIndex;
      const ntnClash =
        candidate.ntn !== null && existing.ntn?.blindIndex === candidate.ntn.blindIndex;
      if (cnicClash || ntnClash) {
        throw new DuplicateClientIdentifierError();
      }
    }
  };

  const contactsFor = (clientId: string): ClientContactRecord[] =>
    state.clientContacts.get(clientId) ?? [];

  const matchesSearch = (record: ClientRecord, filter: ClientListFilter): boolean => {
    const search = filter.search;
    if (search === null) {
      return true;
    }
    if (record.clientCode.includes(search.code)) {
      return true;
    }
    if (
      search.name !== null &&
      (record.normalizedName.includes(search.name) ||
        record.normalizedDisplayName.includes(search.name))
    ) {
      return true;
    }
    const contacts = contactsFor(record.id);
    if (
      search.email !== null &&
      contacts.some((contact) => contact.emailNormalized?.includes(search.email ?? '') === true)
    ) {
      return true;
    }
    if (
      search.phone !== null &&
      contacts.some((contact) => contact.phoneNormalized?.includes(search.phone ?? '') === true)
    ) {
      return true;
    }
    return search.identifierIndexes.some(
      (index) => record.cnic?.blindIndex === index || record.ntn?.blindIndex === index,
    );
  };

  return {
    nextClientNumber: async () => {
      state.clientSequence += 1;
      return state.clientSequence;
    },
    create: async (client, contacts) => {
      if (state.clients.has(client.id)) {
        throw new Error('The client already exists.');
      }
      assertUniqueIdentifiers(client);
      state.clients.set(client.id, { ...client });
      state.clientContacts.set(
        client.id,
        contacts.map((contact) => ({ ...contact })),
      );
    },
    findById: async (id) => {
      const record = state.clients.get(id);
      return record === undefined ? null : { ...record };
    },
    listContacts: async (clientIds) =>
      clientIds
        .flatMap((id) => contactsFor(id))
        .sort((left, right) =>
          left.clientId === right.clientId
            ? left.position - right.position
            : left.clientId < right.clientId
              ? -1
              : 1,
        )
        .map((contact) => ({ ...contact })),
    update: async (input) => {
      const current = state.clients.get(input.id);
      if (current?.version !== input.expectedVersion) {
        return null;
      }
      const next: ClientRecord = {
        ...current,
        ...input.changes,
        updatedAt: input.at,
        version: current.version + 1,
      };
      assertUniqueIdentifiers(next);
      state.clients.set(next.id, next);
      return { ...next };
    },
    replaceContacts: async (clientId, contacts) => {
      state.clientContacts.set(
        clientId,
        contacts.map((contact) => ({ ...contact })),
      );
    },
    setArchived: async (input) => {
      const current = state.clients.get(input.id);
      if (current?.version !== input.expectedVersion) {
        return null;
      }
      const next: ClientRecord = {
        ...current,
        deletedAt: input.archivedAt,
        updatedAt: input.at,
        version: current.version + 1,
      };
      state.clients.set(next.id, next);
      return { ...next };
    },
    list: async (filter) => {
      const after = filter.after;
      const matching = [...state.clients.values()]
        .filter((record) => {
          if (filter.state === 'active' && record.deletedAt !== null) {
            return false;
          }
          if (filter.state === 'archived' && record.deletedAt === null) {
            return false;
          }
          if (filter.type !== null && record.type !== filter.type) {
            return false;
          }
          if (filter.manager === 'unassigned' && record.assignedManagerUserId !== null) {
            return false;
          }
          if (
            filter.manager !== null &&
            filter.manager !== 'unassigned' &&
            record.assignedManagerUserId !== filter.manager
          ) {
            return false;
          }
          if (
            filter.restrictToManagerUserId !== null &&
            record.assignedManagerUserId !== filter.restrictToManagerUserId
          ) {
            return false;
          }
          if (after !== null && compareCursor(record, after.sortKey, after.id) <= 0) {
            return false;
          }
          return matchesSearch(record, filter);
        })
        .sort(sortClients);
      return {
        clients: matching.slice(0, filter.limit).map((record) => ({ ...record })),
        hasMore: matching.length > filter.limit,
      };
    },
    findDuplicateCandidates: async (query) => {
      const emails = new Set(query.emails);
      const phones = new Set(query.phones);
      const candidates: DuplicateCandidate[] = [];
      for (const record of [...state.clients.values()].sort(sortClients)) {
        if (record.id === query.excludeClientId) {
          continue;
        }
        const reasons: DuplicateMatchReason[] = [];
        if (query.cnicIndex !== null && record.cnic?.blindIndex === query.cnicIndex) {
          reasons.push('cnic');
        }
        if (query.ntnIndex !== null && record.ntn?.blindIndex === query.ntnIndex) {
          reasons.push('ntn');
        }
        const contacts = contactsFor(record.id);
        if (contacts.some((c) => c.emailNormalized !== null && emails.has(c.emailNormalized))) {
          reasons.push('email');
        }
        if (contacts.some((c) => c.phoneNormalized !== null && phones.has(c.phoneNormalized))) {
          reasons.push('phone');
        }
        if (
          record.normalizedName === query.normalizedName ||
          record.normalizedDisplayName === query.normalizedName
        ) {
          reasons.push('name');
        }
        if (reasons.length > 0) {
          candidates.push({ client: { ...record }, reasons });
        }
      }
      return candidates;
    },
  };
}
