import type {
  DocumentContentType,
  DocumentProviderState,
  DocumentVerificationState,
  ReconciliationNextAction,
  ReconciliationState,
  StorageConnectionStatus,
  StorageHealthReason,
  StorageProviderType,
  UploadState,
} from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
import type {
  DocumentChanges,
  DocumentRecord,
  DocumentUploadChanges,
  DocumentUploadRecord,
} from '../domain/documents/types.js';
import type {
  ReconciliationRunRecord,
  StorageConnectionChanges,
  StorageConnectionRecord,
  StorageOAuthStateRecord,
} from '../domain/storage/types.js';
import {
  DuplicateDocumentUploadError,
  type DocumentRepository,
  type DocumentUploadRepository,
  type ReconciliationRunRepository,
  type StorageConnectionRepository,
  type StorageOAuthStateRepository,
} from './ports.js';

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

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

/** Integer and bigint columns; bigint arrives as a string and must stay a safe integer. */
function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return safe(Number(value), key);
  }
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    return safe(Number(value), key);
  }
  throw new Error(`Expected an integer column "${key}".`);
}

function safe(value: number, key: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`The integer column "${key}" exceeds the safe integer range.`);
  }
  return value;
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

function uniqueConstraintOf(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  ) {
    return String((error as { constraint_name?: unknown }).constraint_name);
  }
  return null;
}

/**
 * Builds `col = $n` assignments from a whitelisted field→column map. Only keys
 * present in `changes` are written; `undefined` values are skipped.
 */
function assignments(
  changes: Readonly<Record<string, unknown>>,
  columns: Readonly<Record<string, string>>,
  firstIndex: number,
): { readonly sql: string[]; readonly values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (!(field in changes)) {
      continue;
    }
    const value = changes[field];
    if (value === undefined) {
      continue;
    }
    values.push(value);
    sql.push(`${column} = $${String(firstIndex + values.length - 1)}`);
  }
  return { sql, values };
}

// ---------------------------------------------------------------------------
// Storage connection (TD-402–TD-404)
// ---------------------------------------------------------------------------

function mapConnection(row: SqlRow): StorageConnectionRecord {
  return {
    id: text(row, 'id'),
    providerType: text(row, 'provider_type') as StorageProviderType,
    status: text(row, 'status') as StorageConnectionStatus,
    healthReason: nullableText(row, 'health_reason') as StorageHealthReason | null,
    externalDriveId: nullableText(row, 'external_drive_id'),
    externalRootFolderId: nullableText(row, 'external_root_folder_id'),
    accountLabel: nullableText(row, 'account_label'),
    tokenCiphertext: nullableText(row, 'token_ciphertext'),
    tokenKeyVersion: nullableInteger(row, 'token_key_version'),
    accessTokenExpiresAt: nullableIso(row['access_token_expires_at']),
    connectedAt: nullableIso(row['connected_at']),
    connectedBy: nullableText(row, 'connected_by'),
    lastCheckedAt: nullableIso(row['last_checked_at']),
    lastRefreshedAt: nullableIso(row['last_refreshed_at']),
    disconnectedAt: nullableIso(row['disconnected_at']),
    disconnectedBy: nullableText(row, 'disconnected_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const CONNECTION_COLUMNS: Readonly<Record<keyof StorageConnectionChanges, string>> = {
  providerType: 'provider_type',
  status: 'status',
  healthReason: 'health_reason',
  externalDriveId: 'external_drive_id',
  externalRootFolderId: 'external_root_folder_id',
  accountLabel: 'account_label',
  tokenCiphertext: 'token_ciphertext',
  tokenKeyVersion: 'token_key_version',
  accessTokenExpiresAt: 'access_token_expires_at',
  connectedAt: 'connected_at',
  connectedBy: 'connected_by',
  lastCheckedAt: 'last_checked_at',
  lastRefreshedAt: 'last_refreshed_at',
  disconnectedAt: 'disconnected_at',
  disconnectedBy: 'disconnected_by',
};

export function createPostgresStorageConnectionRepository(
  executor: SqlExecutor,
): StorageConnectionRepository {
  return {
    get: async () => {
      const rows = await executor.query('SELECT * FROM storage_connections LIMIT 1');
      return rows[0] === undefined ? null : mapConnection(rows[0]);
    },
    lock: async () => {
      const rows = await executor.query('SELECT * FROM storage_connections LIMIT 1 FOR UPDATE');
      return rows[0] === undefined ? null : mapConnection(rows[0]);
    },
    create: async (record) => {
      await executor.query(
        `INSERT INTO storage_connections (
           id, provider_type, status, health_reason, external_drive_id,
           external_root_folder_id, account_label, token_ciphertext, token_key_version,
           access_token_expires_at, connected_at, connected_by, last_checked_at,
           last_refreshed_at, disconnected_at, disconnected_by, created_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          record.id,
          record.providerType,
          record.status,
          record.healthReason,
          record.externalDriveId,
          record.externalRootFolderId,
          record.accountLabel,
          record.tokenCiphertext,
          record.tokenKeyVersion,
          record.accessTokenExpiresAt,
          record.connectedAt,
          record.connectedBy,
          record.lastCheckedAt,
          record.lastRefreshedAt,
          record.disconnectedAt,
          record.disconnectedBy,
          record.createdAt,
          record.updatedAt,
          record.version,
        ],
      );
    },
    update: async ({ id, changes, expectedVersion, at }) => {
      const set = assignments(changes, CONNECTION_COLUMNS, 4);
      const rows = await executor.query(
        `UPDATE storage_connections
         SET ${[...set.sql, 'updated_at = $3', 'version = version + 1'].join(', ')}
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [id, expectedVersion, at, ...set.values],
      );
      return rows[0] === undefined ? null : mapConnection(rows[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

function mapOAuthState(row: SqlRow): StorageOAuthStateRecord {
  return {
    id: text(row, 'id'),
    stateHash: text(row, 'state_hash'),
    codeVerifierCiphertext: text(row, 'code_verifier_ciphertext'),
    keyVersion: integer(row, 'key_version'),
    providerType: text(row, 'provider_type') as StorageProviderType,
    createdBy: text(row, 'created_by'),
    createdAt: iso(row['created_at']),
    expiresAt: iso(row['expires_at']),
    consumedAt: nullableIso(row['consumed_at']),
  };
}

export function createPostgresStorageOAuthStateRepository(
  executor: SqlExecutor,
): StorageOAuthStateRepository {
  return {
    create: async (record) => {
      await executor.query(
        `INSERT INTO storage_oauth_states (
           id, state_hash, code_verifier_ciphertext, key_version, provider_type,
           created_by, created_at, expires_at, consumed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.stateHash,
          record.codeVerifierCiphertext,
          record.keyVersion,
          record.providerType,
          record.createdBy,
          record.createdAt,
          record.expiresAt,
          record.consumedAt,
        ],
      );
    },
    findByStateHash: async (stateHash) => {
      const rows = await executor.query(
        'SELECT * FROM storage_oauth_states WHERE state_hash = $1',
        [stateHash],
      );
      return rows[0] === undefined ? null : mapOAuthState(rows[0]);
    },
    consume: async (id, at) => {
      const rows = await executor.query(
        `UPDATE storage_oauth_states SET consumed_at = $2
         WHERE id = $1 AND consumed_at IS NULL
         RETURNING id`,
        [id, at],
      );
      return rows.length === 1;
    },
    pruneBefore: async (before) => {
      const rows = await executor.query(
        'DELETE FROM storage_oauth_states WHERE expires_at < $1::timestamptz RETURNING id',
        [before],
      );
      return rows.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Documents (TD-405–TD-410)
// ---------------------------------------------------------------------------

function mapDocument(row: SqlRow): DocumentRecord {
  return {
    id: text(row, 'id'),
    clientId: text(row, 'client_id'),
    caseId: nullableText(row, 'case_id'),
    checklistItemId: nullableText(row, 'checklist_item_id'),
    documentType: text(row, 'document_type'),
    fileName: text(row, 'file_name'),
    contentType: text(row, 'content_type') as DocumentContentType,
    sizeBytes: integer(row, 'size_bytes'),
    providerType: text(row, 'provider_type') as StorageProviderType,
    externalItemId: text(row, 'external_item_id'),
    externalDriveId: nullableText(row, 'external_drive_id'),
    externalParentId: nullableText(row, 'external_parent_id'),
    externalEtag: nullableText(row, 'external_etag'),
    verificationState: text(row, 'verification_state') as DocumentVerificationState,
    verificationNote: nullableText(row, 'verification_note'),
    verifiedBy: nullableText(row, 'verified_by'),
    verifiedAt: nullableIso(row['verified_at']),
    providerState: text(row, 'provider_state') as DocumentProviderState,
    lastReconciledAt: nullableIso(row['last_reconciled_at']),
    uploadId: text(row, 'upload_id'),
    uploadedBy: text(row, 'uploaded_by'),
    uploadedAt: iso(row['uploaded_at']),
    deletedAt: nullableIso(row['deleted_at']),
    deletedBy: nullableText(row, 'deleted_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const DOCUMENT_COLUMNS: Readonly<Record<keyof DocumentChanges, string>> = {
  documentType: 'document_type',
  checklistItemId: 'checklist_item_id',
  verificationState: 'verification_state',
  verificationNote: 'verification_note',
  verifiedBy: 'verified_by',
  verifiedAt: 'verified_at',
  providerState: 'provider_state',
  lastReconciledAt: 'last_reconciled_at',
  externalParentId: 'external_parent_id',
  externalEtag: 'external_etag',
  deletedAt: 'deleted_at',
  deletedBy: 'deleted_by',
};

/** Cursor `<uploadedAt ISO>|<id>`, the same encoding as the in-memory repository. */
function decodeCursor(cursor: string | null): { uploadedAt: string; id: string } | null {
  if (cursor === null) {
    return null;
  }
  const [uploadedAt, id] = cursor.split('|');
  if (
    uploadedAt === undefined ||
    id === undefined ||
    Number.isNaN(Date.parse(uploadedAt)) ||
    !/^[0-9a-f-]{36}$/iu.test(id)
  ) {
    return null;
  }
  return { uploadedAt, id };
}

export function createPostgresDocumentRepository(executor: SqlExecutor): DocumentRepository {
  const findOne = async (id: string, lock: boolean): Promise<DocumentRecord | null> => {
    const rows = await executor.query(
      `SELECT * FROM documents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : mapDocument(rows[0]);
  };

  return {
    create: async (record) => {
      try {
        await executor.query(
          `INSERT INTO documents (
             id, client_id, case_id, checklist_item_id, document_type, file_name, content_type,
             size_bytes, provider_type, external_item_id, external_drive_id, external_parent_id,
             external_etag, verification_state, verification_note, verified_by, verified_at,
             provider_state, last_reconciled_at, upload_id, uploaded_by, uploaded_at,
             deleted_at, deleted_by, created_at, updated_at, version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                     $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
          [
            record.id,
            record.clientId,
            record.caseId,
            record.checklistItemId,
            record.documentType,
            record.fileName,
            record.contentType,
            record.sizeBytes,
            record.providerType,
            record.externalItemId,
            record.externalDriveId,
            record.externalParentId,
            record.externalEtag,
            record.verificationState,
            record.verificationNote,
            record.verifiedBy,
            record.verifiedAt,
            record.providerState,
            record.lastReconciledAt,
            record.uploadId,
            record.uploadedBy,
            record.uploadedAt,
            record.deletedAt,
            record.deletedBy,
            record.createdAt,
            record.updatedAt,
            record.version,
          ],
        );
      } catch (error) {
        if (uniqueConstraintOf(error) === 'documents_upload_id_key') {
          throw new DuplicateDocumentUploadError();
        }
        throw error;
      }
    },
    findById: async (id) => await findOne(id, false),
    findByUploadId: async (uploadId) => {
      const rows = await executor.query('SELECT * FROM documents WHERE upload_id = $1', [uploadId]);
      return rows[0] === undefined ? null : mapDocument(rows[0]);
    },
    lockById: async (id) => await findOne(id, true),
    update: async ({ id, changes, expectedVersion, at }) => {
      const set = assignments(changes, DOCUMENT_COLUMNS, 4);
      const rows = await executor.query(
        `UPDATE documents
         SET ${[...set.sql, 'updated_at = $3', 'version = version + 1'].join(', ')}
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [id, expectedVersion, at, ...set.values],
      );
      return rows[0] === undefined ? null : mapDocument(rows[0]);
    },
    list: async (filter) => {
      const cursor = decodeCursor(filter.cursor);
      const rows = await executor.query(
        `SELECT * FROM documents
         WHERE ($1::uuid IS NULL OR client_id = $1::uuid)
           AND ($2::uuid IS NULL OR case_id = $2::uuid)
           AND ($3::uuid IS NULL OR checklist_item_id = $3::uuid)
           AND (
             $4::text = 'all'
             OR ($4::text = 'active' AND deleted_at IS NULL)
             OR ($4::text = 'deleted' AND deleted_at IS NOT NULL)
           )
           AND ($5::text IS NULL OR verification_state = $5::text)
           AND (
             NOT $6::boolean
             OR client_id = ANY ($7::uuid[])
             OR case_id = ANY ($8::uuid[])
           )
           AND (
             $9::timestamptz IS NULL
             OR (uploaded_at, id) < ($9::timestamptz, $10::uuid)
           )
         ORDER BY uploaded_at DESC, id DESC
         LIMIT $11`,
        [
          filter.clientId ?? null,
          filter.caseId ?? null,
          filter.checklistItemId ?? null,
          filter.state,
          filter.verificationState ?? null,
          filter.visibleTo !== undefined,
          [...(filter.visibleTo?.clientIds ?? [])],
          [...(filter.visibleTo?.caseIds ?? [])],
          cursor?.uploadedAt ?? null,
          cursor?.id ?? null,
          filter.limit + 1,
        ],
      );
      const page = rows.slice(0, filter.limit).map(mapDocument);
      const last = page.at(-1);
      return {
        documents: page,
        nextCursor:
          rows.length > filter.limit && last !== undefined ? `${last.uploadedAt}|${last.id}` : null,
      };
    },
    listForChecklistItems: async (itemIds) => {
      if (itemIds.length === 0) {
        return [];
      }
      const rows = await executor.query(
        `SELECT * FROM documents
         WHERE deleted_at IS NULL AND checklist_item_id = ANY ($1::uuid[])
         ORDER BY uploaded_at DESC, id DESC`,
        [[...itemIds]],
      );
      return rows.map(mapDocument);
    },
    listForReconciliation: async ({ afterId, limit }) => {
      const rows = await executor.query(
        `SELECT * FROM documents
         WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id > $1::uuid)
         ORDER BY id
         LIMIT $2`,
        [afterId, limit],
      );
      return rows.map(mapDocument);
    },
  };
}

// ---------------------------------------------------------------------------
// Upload sessions (TD-406)
// ---------------------------------------------------------------------------

function mapUpload(row: SqlRow): DocumentUploadRecord {
  return {
    id: text(row, 'id'),
    documentId: text(row, 'document_id'),
    clientId: text(row, 'client_id'),
    caseId: nullableText(row, 'case_id'),
    checklistItemId: nullableText(row, 'checklist_item_id'),
    documentType: text(row, 'document_type'),
    fileName: text(row, 'file_name'),
    contentType: text(row, 'content_type') as DocumentContentType,
    sizeBytes: integer(row, 'size_bytes'),
    providerType: text(row, 'provider_type') as StorageProviderType,
    sessionCiphertext: nullableText(row, 'session_ciphertext'),
    sessionKeyVersion: nullableInteger(row, 'session_key_version'),
    nextOffset: integer(row, 'next_offset'),
    state: text(row, 'state') as UploadState,
    externalItemId: nullableText(row, 'external_item_id'),
    createdBy: text(row, 'created_by'),
    requestId: text(row, 'request_id'),
    createdAt: iso(row['created_at']),
    expiresAt: iso(row['expires_at']),
    completedAt: nullableIso(row['completed_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

const UPLOAD_COLUMNS: Readonly<Record<keyof DocumentUploadChanges, string>> = {
  sessionCiphertext: 'session_ciphertext',
  sessionKeyVersion: 'session_key_version',
  nextOffset: 'next_offset',
  state: 'state',
  externalItemId: 'external_item_id',
  expiresAt: 'expires_at',
  completedAt: 'completed_at',
};

export function createPostgresDocumentUploadRepository(
  executor: SqlExecutor,
): DocumentUploadRepository {
  const findOne = async (id: string, lock: boolean): Promise<DocumentUploadRecord | null> => {
    const rows = await executor.query(
      `SELECT * FROM document_uploads WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : mapUpload(rows[0]);
  };

  return {
    create: async (record) => {
      await executor.query(
        `INSERT INTO document_uploads (
           id, document_id, client_id, case_id, checklist_item_id, document_type, file_name,
           content_type, size_bytes, provider_type, session_ciphertext, session_key_version,
           next_offset, state, external_item_id, created_by, request_id, created_at, expires_at,
           completed_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                   $18, $19, $20, $21, $22)`,
        [
          record.id,
          record.documentId,
          record.clientId,
          record.caseId,
          record.checklistItemId,
          record.documentType,
          record.fileName,
          record.contentType,
          record.sizeBytes,
          record.providerType,
          record.sessionCiphertext,
          record.sessionKeyVersion,
          record.nextOffset,
          record.state,
          record.externalItemId,
          record.createdBy,
          record.requestId,
          record.createdAt,
          record.expiresAt,
          record.completedAt,
          record.updatedAt,
          record.version,
        ],
      );
    },
    findById: async (id) => await findOne(id, false),
    findByRequest: async (createdBy, requestId) => {
      const rows = await executor.query(
        'SELECT * FROM document_uploads WHERE created_by = $1 AND request_id = $2',
        [createdBy, requestId],
      );
      return rows[0] === undefined ? null : mapUpload(rows[0]);
    },
    lockById: async (id) => await findOne(id, true),
    update: async ({ id, changes, expectedVersion, at }) => {
      const set = assignments(changes, UPLOAD_COLUMNS, 4);
      const rows = await executor.query(
        `UPDATE document_uploads
         SET ${[...set.sql, 'updated_at = $3', 'version = version + 1'].join(', ')}
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [id, expectedVersion, at, ...set.values],
      );
      return rows[0] === undefined ? null : mapUpload(rows[0]);
    },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation runs (TD-410)
// ---------------------------------------------------------------------------

function mapRun(row: SqlRow): ReconciliationRunRecord {
  return {
    id: text(row, 'id'),
    state: text(row, 'state') as ReconciliationState,
    startedBy: text(row, 'started_by'),
    startedAt: iso(row['started_at']),
    finishedAt: iso(row['finished_at']),
    connectionStatus: text(row, 'connection_status') as StorageConnectionStatus,
    checkedCount: integer(row, 'checked_count'),
    presentCount: integer(row, 'present_count'),
    missingCount: integer(row, 'missing_count'),
    movedCount: integer(row, 'moved_count'),
    recoveredCount: integer(row, 'recovered_count'),
    nextAction: text(row, 'next_action') as ReconciliationNextAction,
    requestId: text(row, 'request_id'),
  };
}

export function createPostgresReconciliationRunRepository(
  executor: SqlExecutor,
): ReconciliationRunRepository {
  return {
    append: async (record) => {
      await executor.query(
        `INSERT INTO storage_reconciliation_runs (
           id, state, started_by, started_at, finished_at, connection_status, checked_count,
           present_count, missing_count, moved_count, recovered_count, next_action, request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.state,
          record.startedBy,
          record.startedAt,
          record.finishedAt,
          record.connectionStatus,
          record.checkedCount,
          record.presentCount,
          record.missingCount,
          record.movedCount,
          record.recoveredCount,
          record.nextAction,
          record.requestId,
        ],
      );
    },
    listRecent: async (limit) => {
      const rows = await executor.query(
        `SELECT * FROM storage_reconciliation_runs
         ORDER BY started_at DESC, id DESC
         LIMIT $1`,
        [limit],
      );
      return rows.map(mapRun);
    },
  };
}
