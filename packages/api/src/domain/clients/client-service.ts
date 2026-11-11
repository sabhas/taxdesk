import {
  AUDIT_ACTIONS,
  CLIENT_ACTIVITY_ACTIONS,
  CLIENT_FIELDS,
  formatClientCode,
  newUuidV7,
  normalizeClientName,
  normalizeCnic,
  normalizeEmail,
  normalizeNtn,
  normalizePhone,
  type AuditMetadataValue,
  type Client,
  type ClientActivity,
  type ClientActivityAction,
  type ClientActivityList,
  type ClientAssignee,
  type ClientContact,
  type ClientContactInput,
  type ClientCreateRequest,
  type ClientDuplicateCheckResponse,
  type ClientDuplicateMatch,
  type ClientField,
  type ClientList,
  type ClientListItem,
  type ClientListQuery,
  type ClientUpdateRequest,
} from '@taxdesk/shared';
import type {
  IdentifierKind,
  IdentifierProtector,
  ProtectedIdentifier,
} from '../../crypto/identifier-protection.js';
import { base64UrlToBytes, bytesToBase64Url } from '../../crypto/encoding.js';
import {
  DuplicateClientIdentifierError,
  type Repositories,
  type UnitOfWork,
} from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor, UserRecord } from '../auth/types.js';
import {
  canOverrideDuplicateWarning,
  canReadAllClients,
  requireAccessibleClient,
} from './client-access.js';
import {
  clientSortKey,
  type ClientChanges,
  type ClientContactRecord,
  type ClientListCursor,
  type ClientRecord,
  type ClientSearchTerms,
  type DuplicateCandidate,
} from './types.js';

export interface ClientServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly identifiers: IdentifierProtector | null;
  readonly clock: () => Date;
}

const ENTITY_TYPE = 'client';

function stalePrecondition(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'This client changed since you loaded it. Refresh, review the latest values, and save again.',
  );
}

function identifierExists(): AuthError {
  return new AuthError(
    409,
    'CLIENT_IDENTIFIER_EXISTS',
    'A client with this CNIC or NTN already exists. Open the existing client instead.',
  );
}

function protectionUnavailable(): AuthError {
  return new AuthError(
    503,
    'SERVICE_UNAVAILABLE',
    'Client identifier protection is not configured for this deployment.',
  );
}

function encodeCursor(cursor: ClientListCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([cursor.sortKey, cursor.id])));
}

function decodeCursor(value: string): ClientListCursor {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(parsed[1])
    ) {
      return { sortKey: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw new AuthError(400, 'VALIDATION_FAILED', 'The page cursor is not valid.', {
    errors: [{ field: 'cursor', message: 'The page cursor is not valid.' }],
  });
}

function toContactDto(contact: ClientContactRecord): ClientContact {
  return {
    id: contact.id,
    name: contact.name,
    relationship: contact.relationship,
    email: contact.email,
    phone: contact.phone,
    isPrimary: contact.isPrimary,
  };
}

function contactRecords(
  clientId: string,
  contacts: readonly ClientContactInput[],
  now: Date,
): ClientContactRecord[] {
  return contacts.map((contact, position) => ({
    id: newUuidV7(now.getTime()),
    clientId,
    position,
    name: contact.name,
    relationship:
      contact.relationship === undefined || contact.relationship.length === 0
        ? null
        : contact.relationship,
    email: contact.email ?? null,
    emailNormalized: contact.email === undefined ? null : normalizeEmail(contact.email),
    phone: contact.phone ?? null,
    phoneNormalized: contact.phone === undefined ? null : normalizePhone(contact.phone),
    isPrimary: contact.isPrimary,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
  }));
}

/** Contact lists compare by their visible content, ignoring IDs and timestamps. */
function contactsEqual(
  left: readonly ClientContactRecord[],
  right: readonly ClientContactRecord[],
): boolean {
  const fingerprint = (contacts: readonly ClientContactRecord[]) =>
    JSON.stringify(contacts.map((c) => [c.name, c.relationship, c.email, c.phone, c.isPrimary]));
  return fingerprint(left) === fingerprint(right);
}

function displayNameFor(legalName: string, displayName: string | undefined): string {
  return displayName === undefined || displayName.length === 0 ? legalName : displayName;
}

/**
 * Client master records: creation with duplicate detection, optimistic
 * updates, archive/restore, search, and audit-safe activity history. Every
 * rule here is enforced server-side; the web form only mirrors it.
 */
export class ClientService {
  constructor(private readonly dependencies: ClientServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private requireProtector(): IdentifierProtector {
    if (this.dependencies.identifiers === null) {
      throw protectionUnavailable();
    }
    return this.dependencies.identifiers;
  }

  private async protect(kind: IdentifierKind, raw: string): Promise<ProtectedIdentifier> {
    const digits = kind === 'cnic' ? normalizeCnic(raw) : normalizeNtn(raw);
    if (digits === null) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'Check the highlighted fields.', {
        errors: [{ field: kind, message: `Enter a valid ${kind.toUpperCase()}.` }],
      });
    }
    return await this.requireProtector().protect(kind, digits);
  }

  /** Active staff who may be named as a client's assigned manager. */
  async listAssignees(): Promise<ClientAssignee[]> {
    const users = await this.repositories.users.list();
    return users
      .filter((user) => user.status === 'active')
      .map((user) => ({ id: user.id, displayName: user.displayName }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private async assertAssignable(userId: string | null): Promise<void> {
    if (userId === null) {
      return;
    }
    const user = await this.repositories.users.findById(userId);
    if (user?.status !== 'active') {
      throw new AuthError(400, 'ASSIGNEE_INVALID', 'Choose an active staff member as manager.', {
        errors: [{ field: 'assignedManagerUserId', message: 'Choose an active staff member.' }],
      });
    }
  }

  private assigneeLookup(): (id: string | null) => Promise<ClientAssignee | null> {
    const cache = new Map<string, UserRecord | null>();
    return async (id) => {
      if (id === null) {
        return null;
      }
      if (!cache.has(id)) {
        cache.set(id, await this.repositories.users.findById(id));
      }
      const user = cache.get(id) ?? null;
      return user === null ? null : { id: user.id, displayName: user.displayName };
    };
  }

  private async toClient(record: ClientRecord): Promise<Client> {
    const contacts = await this.repositories.clients.listContacts([record.id]);
    const lookup = this.assigneeLookup();
    return {
      id: record.id,
      clientCode: record.clientCode,
      type: record.type,
      legalName: record.legalName,
      displayName: record.displayName,
      cnicMasked: record.cnic?.masked ?? null,
      ntnMasked: record.ntn?.masked ?? null,
      contacts: contacts.map(toContactDto),
      notes: record.notes,
      assignedManager: await lookup(record.assignedManagerUserId),
      state: record.deletedAt === null ? 'active' : 'archived',
      archivedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  async getClient(actor: Actor, clientId: string): Promise<Client> {
    const record = requireAccessibleClient(
      actor,
      await this.repositories.clients.findById(clientId),
    );
    return await this.toClient(record);
  }

  private async searchTerms(q: string): Promise<ClientSearchTerms> {
    const name = normalizeClientName(q);
    const digits = q.replace(/\D/gu, '');
    const phoneShaped = /^[+\d\s()-]+$/u.test(q) && digits.length >= 4;
    const identifierIndexes: string[] = [];
    const protector = this.dependencies.identifiers;
    // Identifier search is exact and only possible through the blind index; it
    // is skipped (not failed) if the deployment lacks the index key.
    if (protector !== null) {
      const cnic = normalizeCnic(q);
      if (cnic !== null) {
        identifierIndexes.push(await protector.blindIndex('cnic', cnic));
      }
      const ntn = normalizeNtn(q);
      if (ntn !== null) {
        identifierIndexes.push(await protector.blindIndex('ntn', ntn));
      }
    }
    return {
      code: q.toUpperCase(),
      name: name.length === 0 ? null : name,
      email: normalizeEmail(q),
      phone: phoneShaped ? normalizePhone(q) : null,
      identifierIndexes,
    };
  }

  async listClients(actor: Actor, query: ClientListQuery): Promise<ClientList> {
    const page = await this.repositories.clients.list({
      search: query.q === undefined ? null : await this.searchTerms(query.q),
      type: query.type ?? null,
      manager: query.manager ?? null,
      state: query.state,
      restrictToManagerUserId: canReadAllClients(actor) ? null : actor.userId,
      limit: query.limit,
      after: query.cursor === undefined ? null : decodeCursor(query.cursor),
    });
    const contacts = await this.repositories.clients.listContacts(
      page.clients.map((client) => client.id),
    );
    const primaryByClient = new Map<string, ClientContactRecord>();
    for (const contact of contacts) {
      const existing = primaryByClient.get(contact.clientId);
      if (existing === undefined || (contact.isPrimary && !existing.isPrimary)) {
        primaryByClient.set(contact.clientId, contact);
      }
    }
    const lookup = this.assigneeLookup();
    const clients: ClientListItem[] = [];
    for (const record of page.clients) {
      const primary = primaryByClient.get(record.id);
      clients.push({
        id: record.id,
        clientCode: record.clientCode,
        type: record.type,
        legalName: record.legalName,
        displayName: record.displayName,
        cnicMasked: record.cnic?.masked ?? null,
        ntnMasked: record.ntn?.masked ?? null,
        primaryContact: primary === undefined ? null : toContactDto(primary),
        assignedManager: await lookup(record.assignedManagerUserId),
        state: record.deletedAt === null ? 'active' : 'archived',
        updatedAt: record.updatedAt,
      });
    }
    const last = page.clients.at(-1);
    return {
      clients,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor({ sortKey: clientSortKey(last.displayName), id: last.id })
          : null,
    };
  }

  private async findDuplicates(
    request: ClientCreateRequest,
    cnic: ProtectedIdentifier | null,
    ntn: ProtectedIdentifier | null,
  ): Promise<{ blocking: DuplicateCandidate[]; warnings: DuplicateCandidate[] }> {
    const emails = request.contacts
      .flatMap((contact) => (contact.email === undefined ? [] : [normalizeEmail(contact.email)]))
      .filter((value, index, all) => all.indexOf(value) === index);
    const phones = request.contacts
      .flatMap((contact) => (contact.phone === undefined ? [] : [normalizePhone(contact.phone)]))
      .filter((value, index, all) => all.indexOf(value) === index);
    const candidates = await this.repositories.clients.findDuplicateCandidates({
      cnicIndex: cnic?.blindIndex ?? null,
      ntnIndex: ntn?.blindIndex ?? null,
      emails,
      phones,
      normalizedName: normalizeClientName(request.legalName),
      excludeClientId: null,
    });
    const blocking = candidates.filter((candidate) =>
      candidate.reasons.some((reason) => reason === 'cnic' || reason === 'ntn'),
    );
    const warnings = candidates.filter((candidate) => !blocking.includes(candidate));
    return { blocking, warnings };
  }

  private async protectCreateIdentifiers(request: ClientCreateRequest): Promise<{
    cnic: ProtectedIdentifier | null;
    ntn: ProtectedIdentifier | null;
  }> {
    const cnic = request.type === 'individual' ? await this.protect('cnic', request.cnic) : null;
    const ntn = request.ntn === undefined ? null : await this.protect('ntn', request.ntn);
    return { cnic, ntn };
  }

  /** Read-only duplicate preview shown before creation. */
  async checkDuplicates(request: ClientCreateRequest): Promise<ClientDuplicateCheckResponse> {
    const { cnic, ntn } = await this.protectCreateIdentifiers(request);
    const { blocking, warnings } = await this.findDuplicates(request, cnic, ntn);
    const toMatch = (candidate: DuplicateCandidate): ClientDuplicateMatch => ({
      clientId: candidate.client.id,
      clientCode: candidate.client.clientCode,
      displayName: candidate.client.displayName,
      state: candidate.client.deletedAt === null ? 'active' : 'archived',
      reasons: [...candidate.reasons],
    });
    return { blocking: blocking.map(toMatch), warnings: warnings.map(toMatch) };
  }

  async createClient(input: {
    readonly actor: Actor;
    readonly request: ClientCreateRequest;
    readonly requestId: string;
  }): Promise<Client> {
    const { actor, request } = input;
    const now = this.dependencies.clock();
    await this.assertAssignable(request.assignedManagerUserId);
    const { cnic, ntn } = await this.protectCreateIdentifiers(request);
    const { blocking, warnings } = await this.findDuplicates(request, cnic, ntn);
    if (blocking.length > 0) {
      throw identifierExists();
    }
    const overrideReason = request.duplicateOverrideReason;
    if (warnings.length > 0) {
      if (overrideReason === undefined) {
        throw new AuthError(
          409,
          'CLIENT_DUPLICATE_WARNING',
          'This client may already exist. Review the possible duplicates before creating it.',
        );
      }
      if (!canOverrideDuplicateWarning(actor)) {
        throw forbidden('Only a manager or administrator can override a duplicate warning.');
      }
    }

    const clientId = newUuidV7(now.getTime());
    const displayName = displayNameFor(request.legalName, request.displayName);
    const created = await this.dependencies.unitOfWork
      .run(async (repositories) => {
        const clientCode = formatClientCode(await repositories.clients.nextClientNumber());
        const record: ClientRecord = {
          id: clientId,
          clientCode,
          type: request.type,
          legalName: request.legalName,
          displayName,
          normalizedName: normalizeClientName(request.legalName),
          normalizedDisplayName: normalizeClientName(displayName),
          cnic,
          ntn,
          identifierKeyVersion:
            cnic === null && ntn === null ? null : this.requireProtector().keyVersion,
          notes: request.notes ?? '',
          assignedManagerUserId: request.assignedManagerUserId,
          createdBy: actor.userId,
          deletedAt: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          version: 1,
        };
        await repositories.clients.create(record, contactRecords(clientId, request.contacts, now));
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.clientCreated,
          entityType: ENTITY_TYPE,
          entityId: clientId,
          requestId: input.requestId,
          metadata: {
            clientCode,
            clientType: request.type,
            cnicMasked: cnic?.masked ?? null,
            ntnMasked: ntn?.masked ?? null,
          },
        });
        if (warnings.length > 0 && overrideReason !== undefined) {
          await appendAuditEvent(repositories.audit, now, {
            actorUserId: actor.userId,
            action: AUDIT_ACTIONS.clientDuplicateOverride,
            entityType: ENTITY_TYPE,
            entityId: clientId,
            requestId: input.requestId,
            metadata: {
              reason: overrideReason,
              matchedClients: warnings
                .map((warning) => warning.client.clientCode)
                .join(',')
                .slice(0, 500),
              matchReasons: [...new Set(warnings.flatMap((warning) => warning.reasons))].join(','),
            },
          });
        }
        return record;
      })
      .catch((error: unknown) => {
        if (error instanceof DuplicateClientIdentifierError) {
          throw identifierExists();
        }
        throw error;
      });
    return await this.toClient(created);
  }

  async updateClient(input: {
    readonly actor: Actor;
    readonly clientId: string;
    readonly request: ClientUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Client> {
    const { actor, request } = input;
    const now = this.dependencies.clock();
    const current = requireAccessibleClient(
      actor,
      await this.repositories.clients.findById(input.clientId),
    );
    if (current.version !== input.expectedVersion) {
      throw stalePrecondition();
    }
    if (current.deletedAt !== null) {
      throw new AuthError(409, 'CLIENT_ARCHIVED', 'Restore this client before editing it.');
    }
    if (request.type !== current.type) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'A client type cannot change.', {
        errors: [{ field: 'type', message: 'A client type cannot change.' }],
      });
    }
    if (request.assignedManagerUserId !== current.assignedManagerUserId) {
      await this.assertAssignable(request.assignedManagerUserId);
    }

    const changed: ClientField[] = [];
    let cnic = current.cnic;
    if (request.type === 'individual' && request.cnic !== undefined) {
      const next = await this.protect('cnic', request.cnic);
      if (next.blindIndex !== current.cnic?.blindIndex) {
        cnic = next;
        changed.push('cnic');
      }
    }
    let ntn = current.ntn;
    if (request.ntn === null) {
      if (current.ntn !== null) {
        ntn = null;
        changed.push('ntn');
      }
    } else if (request.ntn !== undefined) {
      const next = await this.protect('ntn', request.ntn);
      if (next.blindIndex !== current.ntn?.blindIndex) {
        ntn = next;
        changed.push('ntn');
      }
    }

    const displayName = displayNameFor(request.legalName, request.displayName);
    if (request.legalName !== current.legalName) changed.push('legalName');
    if (displayName !== current.displayName) changed.push('displayName');
    if (request.notes !== current.notes) changed.push('notes');
    if (request.assignedManagerUserId !== current.assignedManagerUserId) {
      changed.push('assignedManager');
    }
    const currentContacts = await this.repositories.clients.listContacts([current.id]);
    const nextContacts = contactRecords(current.id, request.contacts, now);
    const contactsChanged = !contactsEqual(currentContacts, nextContacts);
    if (contactsChanged) changed.push('contacts');

    if (changed.length === 0) {
      return await this.toClient(current);
    }
    const ordered = CLIENT_FIELDS.filter((field) => changed.includes(field));

    const changes: ClientChanges = {
      legalName: request.legalName,
      displayName,
      normalizedName: normalizeClientName(request.legalName),
      normalizedDisplayName: normalizeClientName(displayName),
      cnic,
      ntn,
      identifierKeyVersion:
        cnic === null && ntn === null
          ? null
          : changed.includes('cnic') || changed.includes('ntn')
            ? this.requireProtector().keyVersion
            : current.identifierKeyVersion,
      notes: request.notes,
      assignedManagerUserId: request.assignedManagerUserId,
    };

    const updated = await this.dependencies.unitOfWork
      .run(async (repositories) => {
        const next = await repositories.clients.update({
          id: current.id,
          changes,
          expectedVersion: input.expectedVersion,
          at: now.toISOString(),
        });
        if (next === null) {
          throw stalePrecondition();
        }
        if (contactsChanged) {
          await repositories.clients.replaceContacts(current.id, nextContacts);
        }
        const metadata: Record<string, AuditMetadataValue> = {
          clientCode: current.clientCode,
          changedFields: ordered.join(','),
        };
        if (ordered.includes('cnic')) metadata['cnicMasked'] = cnic?.masked ?? null;
        if (ordered.includes('ntn')) metadata['ntnMasked'] = ntn?.masked ?? null;
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.clientUpdated,
          entityType: ENTITY_TYPE,
          entityId: current.id,
          requestId: input.requestId,
          metadata,
        });
        return next;
      })
      .catch((error: unknown) => {
        if (error instanceof DuplicateClientIdentifierError) {
          throw identifierExists();
        }
        throw error;
      });
    return await this.toClient(updated);
  }

  async setArchived(input: {
    readonly actor: Actor;
    readonly clientId: string;
    readonly archived: boolean;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Client> {
    const now = this.dependencies.clock();
    const current = requireAccessibleClient(
      input.actor,
      await this.repositories.clients.findById(input.clientId),
    );
    if (current.version !== input.expectedVersion) {
      throw stalePrecondition();
    }
    if (input.archived && current.deletedAt !== null) {
      throw new AuthError(409, 'CLIENT_ARCHIVED', 'This client is already archived.');
    }
    if (!input.archived && current.deletedAt === null) {
      throw new AuthError(409, 'CLIENT_NOT_ARCHIVED', 'This client is not archived.');
    }
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const next = await repositories.clients.setArchived({
        id: current.id,
        archivedAt: input.archived ? now.toISOString() : null,
        expectedVersion: input.expectedVersion,
        at: now.toISOString(),
      });
      if (next === null) {
        throw stalePrecondition();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: input.archived ? AUDIT_ACTIONS.clientArchived : AUDIT_ACTIONS.clientRestored,
        entityType: ENTITY_TYPE,
        entityId: current.id,
        requestId: input.requestId,
        metadata: { clientCode: current.clientCode },
      });
      return next;
    });
    return await this.toClient(updated);
  }

  /**
   * Client activity, newest first. Only allow-listed metadata is mapped:
   * changed field names, masked identifiers, and an override reason.
   */
  async listActivity(input: {
    readonly actor: Actor;
    readonly clientId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<ClientActivityList> {
    requireAccessibleClient(input.actor, await this.repositories.clients.findById(input.clientId));
    const page = await this.repositories.audit.listForEntity({
      entityType: ENTITY_TYPE,
      entityId: input.clientId,
      limit: input.limit,
      cursor: input.cursor,
    });
    const lookup = this.assigneeLookup();
    const events: ClientActivity[] = [];
    for (const event of page.events) {
      if (!(CLIENT_ACTIVITY_ACTIONS as readonly string[]).includes(event.action)) {
        continue;
      }
      const metadata = event.metadata;
      const changedFields =
        typeof metadata['changedFields'] === 'string'
          ? metadata['changedFields']
              .split(',')
              .filter((field): field is ClientField =>
                (CLIENT_FIELDS as readonly string[]).includes(field),
              )
          : [];
      const masked = (key: string): string | null => {
        const value = metadata[key];
        return typeof value === 'string' ? value : null;
      };
      events.push({
        id: event.id,
        occurredAt: event.occurredAt,
        action: event.action as ClientActivityAction,
        actor: await lookup(event.actorUserId),
        changedFields,
        cnicMasked: masked('cnicMasked'),
        ntnMasked: masked('ntnMasked'),
        overrideReason:
          event.action === AUDIT_ACTIONS.clientDuplicateOverride ? masked('reason') : null,
      });
    }
    return { events, nextCursor: page.nextCursor };
  }
}
