import type { ClientType, DuplicateMatchReason } from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
import type { ProtectedIdentifier } from '../crypto/identifier-protection.js';
import type {
  ClientContactRecord,
  ClientRecord,
  DuplicateCandidate,
} from '../domain/clients/types.js';
import { DuplicateClientIdentifierError, type ClientRepository } from './ports.js';

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected a string column "${key}".`);
  }
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected a nullable string column "${key}".`);
  }
  return value;
}

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  // bigint sequence values arrive as strings.
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return Number(value);
  }
  throw new Error(`Expected an integer column "${key}".`);
}

function nullableInteger(row: SqlRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : integer(row, key);
}

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  throw new Error('Expected a timestamp column.');
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function identifier(row: SqlRow, prefix: 'cnic' | 'ntn'): ProtectedIdentifier | null {
  const ciphertext = nullableText(row, `${prefix}_ciphertext`);
  if (ciphertext === null) {
    return null;
  }
  return {
    ciphertext,
    blindIndex: text(row, `${prefix}_blind_index`),
    masked: text(row, `${prefix}_masked`),
  };
}

function mapClient(row: SqlRow): ClientRecord {
  return {
    id: text(row, 'id'),
    clientCode: text(row, 'client_code'),
    type: text(row, 'client_type') as ClientType,
    legalName: text(row, 'legal_name'),
    displayName: text(row, 'display_name'),
    normalizedName: text(row, 'normalized_name'),
    normalizedDisplayName: text(row, 'normalized_display_name'),
    cnic: identifier(row, 'cnic'),
    ntn: identifier(row, 'ntn'),
    identifierKeyVersion: nullableInteger(row, 'identifier_key_version'),
    notes: text(row, 'notes'),
    assignedManagerUserId: nullableText(row, 'assigned_manager_user_id'),
    createdBy: nullableText(row, 'created_by'),
    deletedAt: nullableIso(row['deleted_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapContact(row: SqlRow): ClientContactRecord {
  const isPrimary = row['is_primary'];
  if (typeof isPrimary !== 'boolean') {
    throw new Error('Expected a boolean column "is_primary".');
  }
  return {
    id: text(row, 'id'),
    clientId: text(row, 'client_id'),
    position: integer(row, 'position'),
    name: text(row, 'name'),
    relationship: nullableText(row, 'relationship'),
    email: nullableText(row, 'email'),
    emailNormalized: nullableText(row, 'email_normalized'),
    phone: nullableText(row, 'phone'),
    phoneNormalized: nullableText(row, 'phone_normalized'),
    isPrimary,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const IDENTIFIER_CONSTRAINTS = new Set([
  'clients_cnic_blind_index_key',
  'clients_ntn_blind_index_key',
]);

/** Maps a unique violation on a blind index to the domain's duplicate error. */
async function guardIdentifiers<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === '23505' &&
      IDENTIFIER_CONSTRAINTS.has(String((error as { constraint_name?: unknown }).constraint_name))
    ) {
      throw new DuplicateClientIdentifierError();
    }
    throw error;
  }
}

/** Escapes LIKE wildcards so a search term always matches literally. */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

async function insertContacts(
  executor: SqlExecutor,
  contacts: readonly ClientContactRecord[],
): Promise<void> {
  for (const contact of contacts) {
    await executor.query(
      `INSERT INTO client_contacts (
         id, client_id, position, name, relationship, email, email_normalized,
         phone, phone_normalized, is_primary, created_at, updated_at, version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        contact.id,
        contact.clientId,
        contact.position,
        contact.name,
        contact.relationship,
        contact.email,
        contact.emailNormalized,
        contact.phone,
        contact.phoneNormalized,
        contact.isPrimary,
        contact.createdAt,
        contact.updatedAt,
        contact.version,
      ],
    );
  }
}

export function createPostgresClientRepository(executor: SqlExecutor): ClientRepository {
  return {
    nextClientNumber: async () => {
      const rows = await executor.query("SELECT nextval('client_code_seq') AS value");
      const row = rows[0];
      if (row === undefined) {
        throw new Error('The client code sequence returned no value.');
      }
      return integer(row, 'value');
    },
    create: async (client, contacts) => {
      await guardIdentifiers(async () => {
        await executor.query(
          `INSERT INTO clients (
             id, client_code, client_type, legal_name, display_name, normalized_name,
             normalized_display_name, cnic_ciphertext, cnic_blind_index, cnic_masked,
             ntn_ciphertext, ntn_blind_index, ntn_masked, identifier_key_version, notes,
             assigned_manager_user_id, created_by, deleted_at, created_at, updated_at, version
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19, $20, $21)`,
          [
            client.id,
            client.clientCode,
            client.type,
            client.legalName,
            client.displayName,
            client.normalizedName,
            client.normalizedDisplayName,
            client.cnic?.ciphertext ?? null,
            client.cnic?.blindIndex ?? null,
            client.cnic?.masked ?? null,
            client.ntn?.ciphertext ?? null,
            client.ntn?.blindIndex ?? null,
            client.ntn?.masked ?? null,
            client.identifierKeyVersion,
            client.notes,
            client.assignedManagerUserId,
            client.createdBy,
            client.deletedAt,
            client.createdAt,
            client.updatedAt,
            client.version,
          ],
        );
      });
      await insertContacts(executor, contacts);
    },
    findById: async (id) => {
      const rows = await executor.query('SELECT * FROM clients WHERE id = $1', [id]);
      return rows[0] === undefined ? null : mapClient(rows[0]);
    },
    listContacts: async (clientIds) => {
      if (clientIds.length === 0) {
        return [];
      }
      const rows = await executor.query(
        `SELECT * FROM client_contacts
         WHERE client_id = ANY ($1::uuid[])
         ORDER BY client_id, position`,
        [clientIds],
      );
      return rows.map(mapContact);
    },
    update: async (input) =>
      await guardIdentifiers(async () => {
        const changes = input.changes;
        const rows = await executor.query(
          `UPDATE clients
           SET legal_name = $3,
               display_name = $4,
               normalized_name = $5,
               normalized_display_name = $6,
               cnic_ciphertext = $7,
               cnic_blind_index = $8,
               cnic_masked = $9,
               ntn_ciphertext = $10,
               ntn_blind_index = $11,
               ntn_masked = $12,
               identifier_key_version = $13,
               notes = $14,
               assigned_manager_user_id = $15,
               updated_at = $16,
               version = version + 1
           WHERE id = $1 AND version = $2
           RETURNING *`,
          [
            input.id,
            input.expectedVersion,
            changes.legalName,
            changes.displayName,
            changes.normalizedName,
            changes.normalizedDisplayName,
            changes.cnic?.ciphertext ?? null,
            changes.cnic?.blindIndex ?? null,
            changes.cnic?.masked ?? null,
            changes.ntn?.ciphertext ?? null,
            changes.ntn?.blindIndex ?? null,
            changes.ntn?.masked ?? null,
            changes.identifierKeyVersion,
            changes.notes,
            changes.assignedManagerUserId,
            input.at,
          ],
        );
        return rows[0] === undefined ? null : mapClient(rows[0]);
      }),
    replaceContacts: async (clientId, contacts) => {
      await executor.query('DELETE FROM client_contacts WHERE client_id = $1', [clientId]);
      await insertContacts(executor, contacts);
    },
    setArchived: async (input) => {
      const rows = await executor.query(
        `UPDATE clients
         SET deleted_at = $3, updated_at = $4, version = version + 1
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [input.id, input.expectedVersion, input.archivedAt, input.at],
      );
      return rows[0] === undefined ? null : mapClient(rows[0]);
    },
    list: async (filter) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];
      const parameter = (value: unknown): string => {
        parameters.push(value);
        return `$${String(parameters.length)}`;
      };

      if (filter.state === 'active') {
        conditions.push('c.deleted_at IS NULL');
      } else if (filter.state === 'archived') {
        conditions.push('c.deleted_at IS NOT NULL');
      }
      if (filter.type !== null) {
        conditions.push(`c.client_type = ${parameter(filter.type)}`);
      }
      if (filter.manager === 'unassigned') {
        conditions.push('c.assigned_manager_user_id IS NULL');
      } else if (filter.manager !== null) {
        conditions.push(`c.assigned_manager_user_id = ${parameter(filter.manager)}::uuid`);
      }
      if (filter.restrictToManagerUserId !== null) {
        conditions.push(
          `c.assigned_manager_user_id = ${parameter(filter.restrictToManagerUserId)}::uuid`,
        );
      }
      if (filter.after !== null) {
        conditions.push(
          `(lower(c.display_name) COLLATE "C", c.id) > (${parameter(filter.after.sortKey)} COLLATE "C", ${parameter(filter.after.id)}::uuid)`,
        );
      }
      const search = filter.search;
      if (search !== null) {
        const alternatives = [`c.client_code LIKE ${parameter(likeContains(search.code))}`];
        if (search.name !== null) {
          const name = parameter(likeContains(search.name));
          alternatives.push(
            `c.normalized_name LIKE ${name}`,
            `c.normalized_display_name LIKE ${name}`,
          );
        }
        if (search.email !== null) {
          alternatives.push(
            `EXISTS (SELECT 1 FROM client_contacts e WHERE e.client_id = c.id AND e.email_normalized LIKE ${parameter(likeContains(search.email))})`,
          );
        }
        if (search.phone !== null) {
          alternatives.push(
            `EXISTS (SELECT 1 FROM client_contacts p WHERE p.client_id = c.id AND p.phone_normalized LIKE ${parameter(likeContains(search.phone))})`,
          );
        }
        if (search.identifierIndexes.length > 0) {
          const indexes = parameter(search.identifierIndexes);
          alternatives.push(
            `c.cnic_blind_index = ANY (${indexes}::text[])`,
            `c.ntn_blind_index = ANY (${indexes}::text[])`,
          );
        }
        conditions.push(`(${alternatives.join(' OR ')})`);
      }

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = await executor.query(
        `SELECT c.* FROM clients c
         ${where}
         ORDER BY lower(c.display_name) COLLATE "C", c.id
         LIMIT ${parameter(filter.limit + 1)}`,
        parameters,
      );
      return {
        clients: rows.slice(0, filter.limit).map(mapClient),
        hasMore: rows.length > filter.limit,
      };
    },
    findDuplicateCandidates: async (query) => {
      const rows = await executor.query(
        `SELECT c.*,
                (c.cnic_blind_index = $1) AS match_cnic,
                (c.ntn_blind_index = $2) AS match_ntn,
                EXISTS (SELECT 1 FROM client_contacts e
                        WHERE e.client_id = c.id AND e.email_normalized = ANY ($3::text[])) AS match_email,
                EXISTS (SELECT 1 FROM client_contacts p
                        WHERE p.client_id = c.id AND p.phone_normalized = ANY ($4::text[])) AS match_phone,
                (c.normalized_name = $5 OR c.normalized_display_name = $5) AS match_name
         FROM clients c
         WHERE ($6::uuid IS NULL OR c.id <> $6::uuid)
           AND (
             c.cnic_blind_index = $1
             OR c.ntn_blind_index = $2
             OR c.normalized_name = $5
             OR c.normalized_display_name = $5
             OR EXISTS (SELECT 1 FROM client_contacts e
                        WHERE e.client_id = c.id AND e.email_normalized = ANY ($3::text[]))
             OR EXISTS (SELECT 1 FROM client_contacts p
                        WHERE p.client_id = c.id AND p.phone_normalized = ANY ($4::text[]))
           )
         ORDER BY lower(c.display_name) COLLATE "C", c.id
         LIMIT 50`,
        [
          query.cnicIndex,
          query.ntnIndex,
          query.emails,
          query.phones,
          query.normalizedName,
          query.excludeClientId,
        ],
      );
      return rows.map((row): DuplicateCandidate => {
        const reasons: DuplicateMatchReason[] = [];
        if (row['match_cnic'] === true) reasons.push('cnic');
        if (row['match_ntn'] === true) reasons.push('ntn');
        if (row['match_email'] === true) reasons.push('email');
        if (row['match_phone'] === true) reasons.push('phone');
        if (row['match_name'] === true) reasons.push('name');
        return { client: mapClient(row), reasons };
      });
    },
  };
}
