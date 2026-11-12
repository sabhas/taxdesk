import {
  AUDIT_ACTIONS,
  DOCUMENT_LIMITS,
  documentSatisfiesChecklist,
  isTerminalStatusKind,
  newUuidV7,
  storageAcceptsOperations,
  type AuditMetadataValue,
  type Document,
  type DocumentList,
  type DocumentListQuery,
  type DocumentReviewRequest,
  type DocumentUpdateRequest,
  type ReconciliationNextAction,
  type ReconciliationRun,
  type StorageConnectionStatus,
  type UploadChunkResponse,
  type UploadCreateRequest,
  type UploadSession,
} from '@taxdesk/shared';
import type { SecretCipher } from '../../crypto/cipher.js';
import {
  DuplicateDocumentUploadError,
  type Repositories,
  type UnitOfWork,
} from '../../repositories/ports.js';
import type { StorageAuditContext, StorageGateway } from '../../storage/gateway.js';
import {
  isStorageProviderError,
  type StorageProviderError,
  type ProviderDownload,
  type ProviderItem,
  type ProviderUploadSession,
} from '../../storage/provider.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { readsAllCases } from '../cases/case-access.js';
import type { TaxCaseRecord } from '../cases/types.js';
import { canAccessClient } from '../clients/client-access.js';
import type { ClientRecord } from '../clients/types.js';
import { personLookup } from '../people.js';
import type { ReconciliationRunRecord } from '../storage/types.js';
import {
  canReadDocumentTarget,
  canRestoreDocumentTarget,
  canReviewDocumentTarget,
  canWriteDocumentTarget,
  documentNotFound,
  type DocumentTarget,
} from './document-access.js';
import { buildDocumentStoragePath } from './storage-layout.js';
import type {
  DocumentChanges,
  DocumentListFilter,
  DocumentRecord,
  DocumentUploadRecord,
} from './types.js';

export interface DocumentServiceOptions {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly storage: StorageGateway;
  /** Encrypts provider upload-session handles at rest; `null` when the storage key is unset. */
  readonly cipher: SecretCipher | null;
  readonly clock: () => Date;
  readonly maxUploadBytes: number;
}

const DOCUMENT_ENTITY = 'document';
const CASE_ENTITY = 'tax_case';
const RECONCILIATION_ENTITY = 'storage_reconciliation';
const RECONCILIATION_BATCH = 100;
const RECENT_RUNS = 10;

function stale(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'This document changed since you loaded it. Refresh, review the latest values, and try again.',
  );
}

function validation(field: string, message: string): AuthError {
  return new AuthError(400, 'VALIDATION_FAILED', message, { errors: [{ field, message }] });
}

function linkInvalid(field: string, message: string): AuthError {
  return new AuthError(400, 'DOCUMENT_LINK_INVALID', message, { errors: [{ field, message }] });
}

function uploadNotFound(): AuthError {
  return new AuthError(404, 'UPLOAD_NOT_FOUND', 'The upload was not found.');
}

function uploadNotActive(): AuthError {
  return new AuthError(
    409,
    'UPLOAD_NOT_ACTIVE',
    'This upload is no longer active. Start the upload again.',
  );
}

function offsetMismatch(): AuthError {
  return new AuthError(
    409,
    'UPLOAD_OFFSET_MISMATCH',
    'The upload is at a different position. Check its progress and resume.',
  );
}

function missingInStorage(): AuthError {
  return new AuthError(
    409,
    'DOCUMENT_MISSING_IN_STORAGE',
    'The file is missing from document storage. Ask an administrator to run reconciliation.',
  );
}

/**
 * Maps a provider error the gateway did not translate (for example from the
 * static test gateway) onto a safe 503, so a raw provider message never
 * reaches a response.
 */
function storageFailure(error: StorageProviderError): AuthError {
  switch (error.kind) {
    case 'reconnect_required':
    case 'unauthorized':
      return new AuthError(
        503,
        'STORAGE_RECONNECT_REQUIRED',
        'Document storage needs to be reconnected by an administrator.',
      );
    case 'not_configured':
      return new AuthError(503, 'STORAGE_NOT_CONFIGURED', 'Document storage is not configured.');
    default:
      return new AuthError(
        503,
        'STORAGE_UNAVAILABLE',
        'Document storage is temporarily unavailable. Try again shortly.',
        error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds },
      );
  }
}

function asStorageFailure(error: unknown): never {
  if (isStorageProviderError(error)) {
    throw storageFailure(error);
  }
  throw error;
}

/**
 * Documents (TD-405–TD-410): uploads, protected access, metadata and
 * checklist links, soft delete/restore, and reconciliation. File bytes pass
 * through to the provider and back; they are never stored, logged, or
 * audited. Provider handles (upload-session URLs) are encrypted at rest and
 * never returned.
 */
export class DocumentService {
  constructor(private readonly options: DocumentServiceOptions) {}

  private get repositories(): Repositories {
    return this.options.repositories;
  }

  private now(): Date {
    return this.options.clock();
  }

  private requireCipher(): SecretCipher {
    if (this.options.cipher === null) {
      throw new AuthError(503, 'STORAGE_NOT_CONFIGURED', 'Document storage is not configured.');
    }
    return this.options.cipher;
  }

  private async storageAvailable(): Promise<boolean> {
    const status = await this.options.storage.currentStatus();
    return storageAcceptsOperations(status.status);
  }

  // -------------------------------------------------------------------------
  // Targets and authorization
  // -------------------------------------------------------------------------

  private async loadTarget(
    clientId: string,
    caseId: string | null,
  ): Promise<DocumentTarget | null> {
    const client = await this.repositories.clients.findById(clientId);
    if (client === null) {
      return null;
    }
    if (caseId === null) {
      return { client, taxCase: null };
    }
    const taxCase = await this.repositories.cases.findById(caseId);
    if (taxCase === null) {
      return null;
    }
    return { client, taxCase };
  }

  private async readableDocument(
    actor: Actor,
    id: string,
  ): Promise<{
    readonly record: DocumentRecord;
    readonly target: DocumentTarget;
  }> {
    const record = await this.repositories.documents.findById(id);
    if (record === null) {
      throw documentNotFound(actor);
    }
    const target = await this.loadTarget(record.clientId, record.caseId);
    if (target === null || !canReadDocumentTarget(actor, target)) {
      throw documentNotFound(actor);
    }
    return { record, target };
  }

  /** Rules shared by upload and metadata edits: the target accepts changes. */
  private assertTargetOpen(target: DocumentTarget): void {
    if (target.client.deletedAt !== null) {
      throw new AuthError(409, 'CLIENT_ARCHIVED', 'This client is archived.');
    }
    if (target.taxCase !== null) {
      if (target.taxCase.deletedAt !== null) {
        throw new AuthError(409, 'CASE_ARCHIVED', 'This case is archived and read-only.');
      }
      if (isTerminalStatusKind(target.taxCase.currentStatusKind)) {
        throw new AuthError(
          409,
          'CASE_CLOSED',
          `This case is ${target.taxCase.currentStatusName.toLowerCase()}, so its documents cannot change.`,
        );
      }
    }
  }

  private permissionsFor(actor: Actor, record: DocumentRecord, target: DocumentTarget) {
    const deleted = record.deletedAt !== null;
    const caseArchived = target.taxCase?.deletedAt != null;
    const open = this.targetAcceptsUploads(target);
    const write = canWriteDocumentTarget(actor, target) && open;
    return {
      open: !deleted,
      edit: write && !deleted,
      review: canReviewDocumentTarget(actor, target) && open && !deleted,
      delete: write && !deleted,
      restore: deleted && !caseArchived && canRestoreDocumentTarget(actor, target),
    };
  }

  /**
   * A checklist item that names a document type only accepts documents of
   * that type (case-insensitive, trimmed), so a link always means "this
   * requirement is evidenced" (TD-408).
   */
  private static assertTypeMatchesItem(
    documentType: string,
    item: { readonly documentType: string | null; readonly label: string },
  ): void {
    if (
      item.documentType !== null &&
      item.documentType.trim().toLowerCase() !== documentType.trim().toLowerCase()
    ) {
      throw linkInvalid(
        'documentType',
        `"${item.label}" needs a ${item.documentType} document; change the document type or choose another item.`,
      );
    }
  }

  private async toDocument(
    actor: Actor,
    record: DocumentRecord,
    target: DocumentTarget,
    lookup = personLookup(this.repositories.users),
  ): Promise<Document> {
    let checklistItemLabel: string | null = null;
    if (record.checklistItemId !== null && record.caseId !== null) {
      const items = await this.repositories.cases.listItems([record.caseId]);
      checklistItemLabel = items.find((item) => item.id === record.checklistItemId)?.label ?? null;
    }
    return {
      id: record.id,
      clientId: record.clientId,
      clientCode: target.client.clientCode,
      clientName: target.client.displayName,
      caseId: record.caseId,
      caseCode: target.taxCase?.caseCode ?? null,
      checklistItemId: record.checklistItemId,
      checklistItemLabel,
      documentType: record.documentType,
      fileName: record.fileName,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      verificationState: record.verificationState,
      verificationNote: record.verificationNote,
      verifiedByName: (await lookup(record.verifiedBy))?.displayName ?? null,
      verifiedAt: record.verifiedAt,
      providerState: record.providerState,
      lastReconciledAt: record.lastReconciledAt,
      uploadedByName: (await lookup(record.uploadedBy))?.displayName ?? null,
      uploadedAt: record.uploadedAt,
      deletedAt: record.deletedAt,
      deletedByName: (await lookup(record.deletedBy))?.displayName ?? null,
      version: record.version,
      permissions: this.permissionsFor(actor, record, target),
    };
  }

  private auditMetadata(
    record: Pick<DocumentRecord, 'documentType' | 'contentType' | 'sizeBytes'>,
    target: DocumentTarget,
    extra: Readonly<Record<string, AuditMetadataValue>> = {},
  ): Record<string, AuditMetadataValue> {
    return {
      clientCode: target.client.clientCode,
      caseCode: target.taxCase?.caseCode ?? null,
      documentType: record.documentType,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Uploads (TD-405, TD-406)
  // -------------------------------------------------------------------------

  private toUploadSession(record: DocumentUploadRecord): UploadSession {
    return {
      id: record.id,
      documentId: record.documentId,
      state: record.state,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      nextOffset: record.nextOffset,
      chunkBytes: DOCUMENT_LIMITS.chunkBytes,
      expiresAt: record.expiresAt,
    };
  }

  /** Resolves and authorizes the target of a new upload (before any provider call). */
  private async resolveUploadTarget(
    actor: Actor,
    request: UploadCreateRequest,
  ): Promise<DocumentTarget> {
    const client = await this.repositories.clients.findById(request.clientId);
    if (client === null) {
      throw documentNotFound(actor);
    }
    let taxCase: TaxCaseRecord | null = null;
    const caseId = request.caseId ?? null;
    if (caseId !== null) {
      taxCase = await this.repositories.cases.findById(caseId);
      if (taxCase === null) {
        throw readsAllCases(actor) ? linkInvalid('caseId', 'The case was not found.') : forbidden();
      }
      if (taxCase.clientId !== client.id) {
        throw linkInvalid('caseId', 'The case belongs to a different client.');
      }
    }
    const target: DocumentTarget = { client, taxCase };
    if (!canReadDocumentTarget(actor, target) || !canWriteDocumentTarget(actor, target)) {
      throw forbidden('You cannot add documents to this record.');
    }
    this.assertTargetOpen(target);
    const checklistItemId = request.checklistItemId ?? null;
    if (checklistItemId !== null) {
      const items = taxCase === null ? [] : await this.repositories.cases.listItems([taxCase.id]);
      const item = items.find((candidate) => candidate.id === checklistItemId);
      if (item === undefined) {
        throw linkInvalid('checklistItemId', 'The checklist item does not belong to this case.');
      }
      DocumentService.assertTypeMatchesItem(request.documentType, item);
    }
    return target;
  }

  async createUpload(input: {
    readonly actor: Actor;
    readonly request: UploadCreateRequest;
    readonly requestId: string;
  }): Promise<{ readonly upload: UploadSession; readonly created: boolean }> {
    const { actor, request, requestId } = input;
    const existing = await this.repositories.documentUploads.findByRequest(actor.userId, requestId);
    if (existing !== null) {
      DocumentService.assertSameUploadRequest(existing, request);
      return { upload: this.toUploadSession(existing), created: false };
    }
    if (request.sizeBytes > this.options.maxUploadBytes) {
      throw new AuthError(
        400,
        'DOCUMENT_TOO_LARGE',
        `The file is larger than the ${String(Math.floor(this.options.maxUploadBytes / (1024 * 1024)))} MiB limit.`,
        { errors: [{ field: 'sizeBytes', message: 'The file is too large.' }] },
      );
    }
    const target = await this.resolveUploadTarget(actor, request);
    const cipher = this.requireCipher();
    const now = this.now();
    const documentId = newUuidV7(now.getTime());
    const path = buildDocumentStoragePath({
      clientCode: target.client.clientCode,
      taxYear: target.taxCase?.taxYear ?? null,
      caseId: target.taxCase?.id ?? null,
      documentId,
      fileName: request.fileName,
    });
    const audit: StorageAuditContext = { requestId, actorUserId: actor.userId };

    const { session, providerType } = await this.options.storage
      .run(
        async (context) => ({
          session: await context.provider.createUploadSession(context.credentials, {
            path,
            sizeBytes: request.sizeBytes,
          }),
          providerType: context.providerType,
        }),
        audit,
      )
      .catch(asStorageFailure);

    const at = this.now().toISOString();
    const record: DocumentUploadRecord = {
      id: newUuidV7(now.getTime()),
      documentId,
      clientId: target.client.id,
      caseId: target.taxCase?.id ?? null,
      checklistItemId: request.checklistItemId ?? null,
      documentType: request.documentType.trim(),
      fileName: request.fileName,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
      providerType,
      sessionCiphertext: await cipher.encrypt(JSON.stringify(session)),
      sessionKeyVersion: cipher.keyVersion,
      nextOffset: session.nextOffset,
      state: 'active',
      externalItemId: null,
      createdBy: actor.userId,
      requestId,
      createdAt: at,
      expiresAt: session.expiresAt,
      completedAt: null,
      updatedAt: at,
      version: 1,
    };
    try {
      await this.repositories.documentUploads.create(record);
    } catch (error) {
      // A concurrent retry with the same request ID won the insert: keep its
      // upload and abandon this provider session.
      const raced = await this.repositories.documentUploads.findByRequest(actor.userId, requestId);
      if (raced === null) {
        throw error;
      }
      await this.cancelProviderSession(session);
      DocumentService.assertSameUploadRequest(raced, request);
      return { upload: this.toUploadSession(raced), created: false };
    }
    return { upload: this.toUploadSession(record), created: true };
  }

  /** A repeated request ID must carry the same request; otherwise it is a conflict. */
  private static assertSameUploadRequest(
    existing: DocumentUploadRecord,
    request: UploadCreateRequest,
  ): void {
    const same =
      existing.clientId === request.clientId &&
      existing.caseId === (request.caseId ?? null) &&
      existing.checklistItemId === (request.checklistItemId ?? null) &&
      existing.fileName === request.fileName &&
      existing.sizeBytes === request.sizeBytes &&
      existing.contentType === request.contentType &&
      existing.documentType === request.documentType.trim();
    if (!same) {
      throw new AuthError(
        409,
        'CONFLICT',
        'This request ID was already used for a different upload. Retry with a new request ID.',
      );
    }
  }

  private async cancelProviderSession(session: ProviderUploadSession): Promise<void> {
    try {
      await this.options.storage.runWithoutCredentials(async (provider) => {
        await provider.cancelUploadSession(session);
      });
    } catch {
      // Best effort: an abandoned provider session expires on its own.
    }
  }

  private async decryptSession(record: DocumentUploadRecord): Promise<ProviderUploadSession> {
    if (record.sessionCiphertext === null) {
      throw uploadNotActive();
    }
    const plaintext = await this.requireCipher().decrypt(record.sessionCiphertext);
    return JSON.parse(plaintext) as ProviderUploadSession;
  }

  /** The upload, if the actor started it (or can still write its target). */
  /**
   * Loads an upload and re-runs the target's authorization (and, unless
   * cancelling, its open-state checks) on every request, so a user removed
   * from the case — or a case closed or archived mid-upload — cannot finish
   * creating a document (TD-407).
   */
  private async ownedUpload(
    actor: Actor,
    uploadId: string,
    options: { readonly requireOpen: boolean } = { requireOpen: true },
  ): Promise<DocumentUploadRecord> {
    const record = await this.repositories.documentUploads.findById(uploadId);
    if (record === null) {
      throw uploadNotFound();
    }
    const target = await this.loadTarget(record.clientId, record.caseId);
    if (
      target === null ||
      !canReadDocumentTarget(actor, target) ||
      !canWriteDocumentTarget(actor, target)
    ) {
      if (record.createdBy === actor.userId) {
        throw forbidden('You can no longer add documents to this record.');
      }
      throw uploadNotFound();
    }
    if (options.requireOpen) {
      this.assertTargetOpen(target);
    }
    return record;
  }

  private async setUploadState(
    record: DocumentUploadRecord,
    state: 'expired' | 'failed' | 'cancelled',
  ): Promise<void> {
    await this.repositories.documentUploads.update({
      id: record.id,
      changes: { state, sessionCiphertext: null, sessionKeyVersion: null },
      expectedVersion: record.version,
      at: this.now().toISOString(),
    });
  }

  private async expireIfDue(record: DocumentUploadRecord): Promise<DocumentUploadRecord> {
    if (
      record.state === 'active' &&
      record.externalItemId === null &&
      record.expiresAt <= this.now().toISOString()
    ) {
      await this.setUploadState(record, 'expired');
      return { ...record, state: 'expired' };
    }
    return record;
  }

  async getUpload(actor: Actor, uploadId: string): Promise<UploadSession> {
    let record = await this.expireIfDue(await this.ownedUpload(actor, uploadId));
    if (record.state !== 'active' || record.externalItemId !== null) {
      return this.toUploadSession(record);
    }
    // Resynchronize with the provider so a client can resume after an
    // interruption from the byte the provider actually holds.
    const session = await this.decryptSession(record);
    try {
      const status = await this.options.storage.runWithoutCredentials(
        async (provider) => await provider.getUploadSession(session),
      );
      if (status.nextOffset !== record.nextOffset) {
        const updated = await this.repositories.documentUploads.update({
          id: record.id,
          changes: { nextOffset: status.nextOffset },
          expectedVersion: record.version,
          at: this.now().toISOString(),
        });
        record = updated ?? { ...record, nextOffset: status.nextOffset };
      }
    } catch (error) {
      if (isStorageProviderError(error) && error.kind === 'not_found') {
        await this.setUploadState(record, 'expired');
        return this.toUploadSession({ ...record, state: 'expired' });
      }
      asStorageFailure(error);
    }
    return this.toUploadSession(record);
  }

  async uploadChunk(input: {
    readonly actor: Actor;
    readonly uploadId: string;
    readonly offset: number;
    readonly bytes: Uint8Array;
    readonly requestId: string;
  }): Promise<UploadChunkResponse> {
    const record = await this.expireIfDue(await this.ownedUpload(input.actor, input.uploadId));
    if (record.state !== 'active') {
      throw uploadNotActive();
    }
    if (input.offset !== record.nextOffset || record.externalItemId !== null) {
      throw offsetMismatch();
    }
    const length = input.bytes.length;
    const end = input.offset + length;
    if (length === 0 || end > record.sizeBytes) {
      throw validation('body', 'The chunk is empty or runs past the end of the file.');
    }
    if (length !== DOCUMENT_LIMITS.chunkBytes && end !== record.sizeBytes) {
      throw validation('body', 'Send 5 MiB chunks; only the final chunk may be shorter.');
    }
    if (length > DOCUMENT_LIMITS.chunkBytes) {
      throw validation('body', 'The chunk is larger than 5 MiB.');
    }
    const session = await this.decryptSession(record);
    let result;
    try {
      result = await this.options.storage.runWithoutCredentials(
        async (provider) =>
          await provider.uploadChunk({
            session,
            offset: input.offset,
            totalSize: record.sizeBytes,
            bytes: input.bytes,
          }),
        { requestId: input.requestId, actorUserId: input.actor.userId },
      );
    } catch (error) {
      if (isStorageProviderError(error)) {
        if (error.kind === 'not_found') {
          await this.setUploadState(record, 'expired');
          throw uploadNotActive();
        }
        if (error.kind === 'conflict') {
          if (error.expectedOffset !== undefined && error.expectedOffset !== record.nextOffset) {
            await this.repositories.documentUploads.update({
              id: record.id,
              changes: { nextOffset: error.expectedOffset },
              expectedVersion: record.version,
              at: this.now().toISOString(),
            });
          }
          throw offsetMismatch();
        }
        if (error.kind === 'rejected') {
          throw validation('body', 'Document storage refused this chunk.');
        }
      }
      asStorageFailure(error);
    }
    const complete = result.kind === 'complete';
    const nextOffset = result.kind === 'complete' ? record.sizeBytes : result.nextOffset;
    const updated = await this.repositories.documentUploads.update({
      id: record.id,
      changes: {
        nextOffset,
        ...(result.kind === 'complete' ? { externalItemId: result.item.externalItemId } : {}),
      },
      expectedVersion: record.version,
      at: this.now().toISOString(),
    });
    if (updated === null) {
      throw offsetMismatch();
    }
    return { nextOffset, complete };
  }

  /**
   * Completes an upload idempotently (TD-406): verifies the provider object
   * and creates exactly one document. A repeat returns the same document.
   */
  async completeUpload(input: {
    readonly actor: Actor;
    readonly uploadId: string;
    readonly requestId: string;
  }): Promise<{ readonly document: Document; readonly created: boolean }> {
    const { actor } = input;
    // A repeat of an already-completed upload returns its document even if the
    // case has closed since; authorization is still re-checked.
    const peek = await this.repositories.documentUploads.findById(input.uploadId);
    const record = await this.ownedUpload(actor, input.uploadId, {
      requireOpen: peek?.state !== 'completed',
    });
    const target = await this.loadTarget(record.clientId, record.caseId);
    if (target === null) {
      throw uploadNotFound();
    }
    if (record.state === 'completed') {
      const existing = await this.repositories.documents.findByUploadId(record.id);
      if (existing === null) {
        throw uploadNotActive();
      }
      return { document: await this.toDocument(actor, existing, target), created: false };
    }
    if (record.state !== 'active') {
      throw uploadNotActive();
    }
    if (record.externalItemId === null) {
      throw new AuthError(
        409,
        'UPLOAD_INCOMPLETE',
        'Upload every part of the file before completing it.',
      );
    }
    const externalItemId = record.externalItemId;
    const audit: StorageAuditContext = { requestId: input.requestId, actorUserId: actor.userId };
    const item = await this.options.storage
      .run(
        async (context) => await context.provider.getItem(context.credentials, externalItemId),
        audit,
      )
      .catch(asStorageFailure);
    if (item === null || !this.itemMatches(item, record)) {
      await this.setUploadState(record, 'failed');
      if (item !== null) {
        await this.options.storage
          .run(async (context) => {
            await context.provider.trash(context.credentials, externalItemId);
          }, audit)
          .catch(() => undefined);
      }
      throw new AuthError(
        409,
        'UPLOAD_VERIFICATION_FAILED',
        'Document storage did not confirm the uploaded file. Upload it again.',
      );
    }
    const verified = item;

    const now = this.now();
    const at = now.toISOString();
    const outcome = await this.options.unitOfWork.run(async (repositories) => {
      const locked = await repositories.documentUploads.lockById(record.id);
      if (locked === null) {
        throw uploadNotFound();
      }
      if (locked.state === 'completed') {
        const existing = await repositories.documents.findByUploadId(locked.id);
        if (existing !== null) {
          return { document: existing, created: false };
        }
      }
      if (locked.state !== 'active' && locked.state !== 'completed') {
        throw uploadNotActive();
      }
      // Re-check authorization and open state at the moment of creation.
      const client = await repositories.clients.findById(locked.clientId);
      const taxCase =
        locked.caseId === null ? null : await repositories.cases.lockById(locked.caseId);
      if (client === null || (locked.caseId !== null && taxCase === null)) {
        throw uploadNotFound();
      }
      const current: DocumentTarget = { client, taxCase };
      if (!canReadDocumentTarget(actor, current) || !canWriteDocumentTarget(actor, current)) {
        throw forbidden('You can no longer add documents to this record.');
      }
      this.assertTargetOpen(current);
      const document: DocumentRecord = {
        id: locked.documentId,
        clientId: locked.clientId,
        caseId: locked.caseId,
        checklistItemId: locked.checklistItemId,
        documentType: locked.documentType,
        fileName: locked.fileName,
        contentType: locked.contentType,
        sizeBytes: locked.sizeBytes,
        providerType: locked.providerType,
        externalItemId: verified.externalItemId,
        externalDriveId: verified.driveId,
        externalParentId: verified.parentId,
        externalEtag: verified.etag,
        verificationState: 'pending',
        verificationNote: null,
        verifiedBy: null,
        verifiedAt: null,
        providerState: 'present',
        lastReconciledAt: null,
        uploadId: locked.id,
        uploadedBy: locked.createdBy,
        uploadedAt: at,
        deletedAt: null,
        deletedBy: null,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      try {
        await repositories.documents.create(document);
      } catch (error) {
        if (error instanceof DuplicateDocumentUploadError) {
          const existing = await repositories.documents.findByUploadId(locked.id);
          if (existing !== null) {
            return { document: existing, created: false };
          }
        }
        throw error;
      }
      const completed = await repositories.documentUploads.update({
        id: locked.id,
        changes: {
          state: 'completed',
          completedAt: at,
          sessionCiphertext: null,
          sessionKeyVersion: null,
        },
        expectedVersion: locked.version,
        at,
      });
      if (completed === null) {
        throw uploadNotActive();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentUploaded,
        entityType: DOCUMENT_ENTITY,
        entityId: document.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(document, target, {
          uploadId: locked.id,
          checklistItemId: document.checklistItemId,
        }),
      });
      return { document, created: true };
    });
    return {
      document: await this.toDocument(actor, outcome.document, target),
      created: outcome.created,
    };
  }

  private itemMatches(item: ProviderItem, record: DocumentUploadRecord): boolean {
    return (
      !item.trashed &&
      item.externalItemId === record.externalItemId &&
      item.sizeBytes === record.sizeBytes
    );
  }

  async cancelUpload(input: {
    readonly actor: Actor;
    readonly uploadId: string;
    readonly requestId: string;
  }): Promise<void> {
    const record = await this.ownedUpload(input.actor, input.uploadId, { requireOpen: false });
    if (record.state === 'cancelled' || record.state === 'expired' || record.state === 'failed') {
      return;
    }
    if (record.state === 'completed') {
      throw uploadNotActive();
    }
    if (record.sessionCiphertext !== null) {
      await this.cancelProviderSession(await this.decryptSession(record));
    }
    const updated = await this.repositories.documentUploads.update({
      id: record.id,
      changes: { state: 'cancelled', sessionCiphertext: null, sessionKeyVersion: null },
      expectedVersion: record.version,
      at: this.now().toISOString(),
    });
    if (updated === null) {
      throw uploadNotActive();
    }
    const target = await this.loadTarget(record.clientId, record.caseId);
    await appendAuditEvent(this.repositories.audit, this.now(), {
      actorUserId: input.actor.userId,
      action: AUDIT_ACTIONS.documentUploadCancelled,
      entityType: DOCUMENT_ENTITY,
      entityId: record.documentId,
      requestId: input.requestId,
      metadata:
        target === null
          ? { uploadId: record.id }
          : this.auditMetadata(record, target, { uploadId: record.id }),
    });
  }

  // -------------------------------------------------------------------------
  // Listing and reading (TD-407, TD-408)
  // -------------------------------------------------------------------------

  /** IDs of the client's cases the actor is assigned to (any state). */
  private async assignedCaseIds(actor: Actor, clientId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const view of ['team', 'closed', 'archived'] as const) {
      const page = await this.repositories.cases.list({
        view,
        today: '0000-01-01',
        dueSoonUntil: '0000-01-01',
        actorUserId: actor.userId,
        restrictToAssignedUserId: actor.userId,
        serviceTypeId: null,
        statusKey: null,
        primaryConsultantUserId: null,
        reviewerUserId: null,
        taxYear: null,
        clientId,
        limit: 500,
        after: null,
      });
      for (const record of page.cases) {
        ids.add(record.id);
      }
    }
    return [...ids];
  }

  async listDocuments(actor: Actor, query: DocumentListQuery): Promise<DocumentList> {
    let client: ClientRecord | null = null;
    let taxCase: TaxCaseRecord | null = null;
    if (query.caseId !== undefined) {
      taxCase = await this.repositories.cases.findById(query.caseId);
      if (taxCase === null) {
        throw readsAllCases(actor)
          ? new AuthError(404, 'CASE_NOT_FOUND', 'The requested case was not found.')
          : forbidden();
      }
      if (query.clientId !== undefined && query.clientId !== taxCase.clientId) {
        throw linkInvalid('caseId', 'The case belongs to a different client.');
      }
      client = await this.repositories.clients.findById(taxCase.clientId);
    } else if (query.clientId !== undefined) {
      client = await this.repositories.clients.findById(query.clientId);
    }
    if (client === null) {
      throw documentNotFound(actor);
    }
    const listTarget: DocumentTarget = { client, taxCase };
    let visibleTo: DocumentListFilter['visibleTo'];
    if (!canReadDocumentTarget(actor, listTarget)) {
      throw forbidden();
    }
    if (taxCase === null && !canAccessClient(actor, client)) {
      // Not the client's manager: only documents on cases assigned to the actor.
      visibleTo = { clientIds: [], caseIds: await this.assignedCaseIds(actor, client.id) };
    }
    const page = await this.repositories.documents.list({
      clientId: client.id,
      ...(taxCase === null ? {} : { caseId: taxCase.id }),
      ...(query.checklistItemId === undefined ? {} : { checklistItemId: query.checklistItemId }),
      state: query.state,
      ...(query.verificationState === undefined
        ? {}
        : { verificationState: query.verificationState }),
      ...(visibleTo === undefined ? {} : { visibleTo }),
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
    const lookup = personLookup(this.repositories.users);
    const caseCache = new Map<string, TaxCaseRecord | null>();
    if (taxCase !== null) {
      caseCache.set(taxCase.id, taxCase);
    }
    const documents: Document[] = [];
    for (const record of page.documents) {
      let recordCase: TaxCaseRecord | null = null;
      if (record.caseId !== null) {
        if (!caseCache.has(record.caseId)) {
          caseCache.set(record.caseId, await this.repositories.cases.findById(record.caseId));
        }
        recordCase = caseCache.get(record.caseId) ?? null;
      }
      const target: DocumentTarget = { client, taxCase: recordCase };
      if (!canReadDocumentTarget(actor, target)) {
        continue;
      }
      documents.push(await this.toDocument(actor, record, target, lookup));
    }
    return {
      documents,
      nextCursor: page.nextCursor,
      storageAvailable: await this.storageAvailable(),
      maxUploadBytes: this.options.maxUploadBytes,
      permissions: {
        upload: canWriteDocumentTarget(actor, listTarget) && this.targetAcceptsUploads(listTarget),
      },
    };
  }

  private targetAcceptsUploads(target: DocumentTarget): boolean {
    try {
      this.assertTargetOpen(target);
      return true;
    } catch {
      return false;
    }
  }

  async getDocument(actor: Actor, id: string): Promise<Document> {
    const { record, target } = await this.readableDocument(actor, id);
    return await this.toDocument(actor, record, target);
  }

  /**
   * Opens a document (TD-407): re-checks access on every request, records a
   * `document.opened` audit event (no content), and streams the bytes.
   */
  async openDocument(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly requestId: string;
  }): Promise<{ readonly document: DocumentRecord; readonly download: ProviderDownload }> {
    const { actor } = input;
    const { record, target } = await this.readableDocument(actor, input.id);
    if (record.deletedAt !== null) {
      throw new AuthError(409, 'DOCUMENT_DELETED', 'This document was deleted.');
    }
    const audit: StorageAuditContext = { requestId: input.requestId, actorUserId: actor.userId };
    let download: ProviderDownload;
    try {
      download = await this.options.storage.run(
        async (context) =>
          await context.provider.download(context.credentials, record.externalItemId),
        audit,
      );
    } catch (error) {
      if (isStorageProviderError(error) && error.kind === 'not_found') {
        await this.markMissing(record, target, actor.userId, input.requestId);
        throw missingInStorage();
      }
      asStorageFailure(error);
    }
    await appendAuditEvent(this.repositories.audit, this.now(), {
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.documentOpened,
      entityType: DOCUMENT_ENTITY,
      entityId: record.id,
      requestId: input.requestId,
      metadata: this.auditMetadata(record, target),
    });
    return { document: record, download };
  }

  // -------------------------------------------------------------------------
  // Metadata, review, and checklist links (TD-408)
  // -------------------------------------------------------------------------

  private async lockedForChange(
    repositories: Repositories,
    id: string,
    expectedVersion: number,
  ): Promise<DocumentRecord> {
    const locked = await repositories.documents.lockById(id);
    if (locked === null) {
      throw stale();
    }
    if (locked.version !== expectedVersion) {
      throw stale();
    }
    if (locked.deletedAt !== null) {
      throw new AuthError(409, 'DOCUMENT_DELETED', 'This document was deleted.');
    }
    return locked;
  }

  async updateDocument(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly request: DocumentUpdateRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Document> {
    const { actor, request } = input;
    const { target } = await this.readableDocument(actor, input.id);
    if (!canWriteDocumentTarget(actor, target)) {
      throw forbidden('You cannot change this document.');
    }
    this.assertTargetOpen(target);
    const now = this.now();
    const at = now.toISOString();
    const saved = await this.options.unitOfWork.run(async (repositories) => {
      const locked = await this.lockedForChange(repositories, input.id, input.expectedVersion);
      const changes: { -readonly [K in keyof DocumentChanges]: DocumentChanges[K] } = {};
      const fields: string[] = [];
      if (request.documentType !== undefined && request.documentType !== locked.documentType) {
        changes.documentType = request.documentType;
        fields.push('documentType');
      }
      if (
        request.checklistItemId !== undefined &&
        request.checklistItemId !== locked.checklistItemId
      ) {
        if (request.checklistItemId !== null) {
          if (locked.caseId === null) {
            throw linkInvalid(
              'checklistItemId',
              'A client-level document cannot be linked to a checklist item.',
            );
          }
          const items = await repositories.cases.listItems([locked.caseId]);
          if (!items.some((item) => item.id === request.checklistItemId)) {
            throw linkInvalid(
              'checklistItemId',
              'The checklist item does not belong to this case.',
            );
          }
        }
        changes.checklistItemId = request.checklistItemId;
        fields.push('checklistItemId');
      }
      if (fields.length === 0) {
        return locked;
      }
      const linkedItemId =
        changes.checklistItemId !== undefined ? changes.checklistItemId : locked.checklistItemId;
      if (linkedItemId !== null && locked.caseId !== null) {
        const linkedItem = (await repositories.cases.listItems([locked.caseId])).find(
          (candidate) => candidate.id === linkedItemId,
        );
        if (linkedItem !== undefined) {
          DocumentService.assertTypeMatchesItem(
            changes.documentType ?? locked.documentType,
            linkedItem,
          );
        }
      }
      const updated = await repositories.documents.update({
        id: locked.id,
        changes,
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        throw stale();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentUpdated,
        entityType: DOCUMENT_ENTITY,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(updated, target, { fields: fields.join(',') }),
      });
      if (fields.includes('checklistItemId') && locked.checklistItemId !== null) {
        await reopenChecklistItemIfUnsatisfied(repositories, now, {
          caseId: locked.caseId,
          itemId: locked.checklistItemId,
          actorUserId: actor.userId,
          requestId: input.requestId,
        });
      }
      return updated;
    });
    return await this.toDocument(actor, saved, target);
  }

  async reviewDocument(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly request: DocumentReviewRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Document> {
    const { actor, request } = input;
    const { target } = await this.readableDocument(actor, input.id);
    if (!canReviewDocumentTarget(actor, target)) {
      throw forbidden('You cannot review this document.');
    }
    this.assertTargetOpen(target);
    const now = this.now();
    const at = now.toISOString();
    const saved = await this.options.unitOfWork.run(async (repositories) => {
      const locked = await this.lockedForChange(repositories, input.id, input.expectedVersion);
      if (
        request.decision === 'verified' &&
        (locked.providerState === 'missing' || locked.verificationState === 'missing_provider')
      ) {
        throw missingInStorage();
      }
      const reviewed = request.decision !== 'pending';
      const updated = await repositories.documents.update({
        id: locked.id,
        changes: {
          verificationState: request.decision,
          verificationNote:
            reviewed && request.note !== undefined && request.note.length > 0 ? request.note : null,
          verifiedBy: reviewed ? actor.userId : null,
          verifiedAt: reviewed ? at : null,
        },
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        throw stale();
      }
      const action =
        request.decision === 'verified'
          ? AUDIT_ACTIONS.documentVerified
          : request.decision === 'rejected'
            ? AUDIT_ACTIONS.documentRejected
            : AUDIT_ACTIONS.documentReviewReset;
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action,
        entityType: DOCUMENT_ENTITY,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(updated, target, {
          checklistItemId: updated.checklistItemId,
        }),
      });
      if (request.decision !== 'verified' && locked.checklistItemId !== null) {
        await reopenChecklistItemIfUnsatisfied(repositories, now, {
          caseId: locked.caseId,
          itemId: locked.checklistItemId,
          actorUserId: actor.userId,
          requestId: input.requestId,
        });
      }
      return updated;
    });
    return await this.toDocument(actor, saved, target);
  }

  // -------------------------------------------------------------------------
  // Soft delete and restore (TD-409)
  // -------------------------------------------------------------------------

  async deleteDocument(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Document> {
    const { actor } = input;
    const { record, target } = await this.readableDocument(actor, input.id);
    if (!canWriteDocumentTarget(actor, target)) {
      throw forbidden('You cannot delete this document.');
    }
    this.assertTargetOpen(target);
    if (record.deletedAt !== null) {
      throw new AuthError(409, 'DOCUMENT_DELETED', 'This document was already deleted.');
    }
    if (record.version !== input.expectedVersion) {
      throw stale();
    }
    const audit: StorageAuditContext = { requestId: input.requestId, actorUserId: actor.userId };
    const now = this.now();
    const at = now.toISOString();
    // Order: lock and version-check the row (412 before any provider call),
    // trash the provider object, then soft-delete in the same transaction. A
    // provider failure throws out of the transaction, so nothing is written.
    const saved = await this.options.unitOfWork.run(async (repositories) => {
      const locked = await this.lockedForChange(repositories, input.id, input.expectedVersion);
      let alreadyGone = false;
      try {
        await this.options.storage.run(async (context) => {
          await context.provider.trash(context.credentials, locked.externalItemId);
        }, audit);
      } catch (error) {
        if (isStorageProviderError(error) && error.kind === 'not_found') {
          alreadyGone = true;
        } else {
          asStorageFailure(error);
        }
      }
      const updated = await repositories.documents.update({
        id: locked.id,
        changes: {
          deletedAt: at,
          deletedBy: actor.userId,
          ...(alreadyGone ? { providerState: 'missing' as const } : {}),
        },
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        throw stale();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentDeleted,
        entityType: DOCUMENT_ENTITY,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(updated, target, { providerObjectMissing: alreadyGone }),
      });
      if (locked.checklistItemId !== null) {
        await reopenChecklistItemIfUnsatisfied(repositories, now, {
          caseId: locked.caseId,
          itemId: locked.checklistItemId,
          actorUserId: actor.userId,
          requestId: input.requestId,
        });
      }
      return updated;
    });
    return await this.toDocument(actor, saved, target);
  }

  async restoreDocument(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<Document> {
    const { actor } = input;
    const { record, target } = await this.readableDocument(actor, input.id);
    if (!canRestoreDocumentTarget(actor, target)) {
      throw forbidden('Only a manager or administrator can restore documents.');
    }
    if (target.taxCase?.deletedAt != null) {
      throw new AuthError(409, 'CASE_ARCHIVED', 'This case is archived and read-only.');
    }
    if (record.deletedAt === null) {
      throw new AuthError(409, 'DOCUMENT_NOT_DELETED', 'This document is not deleted.');
    }
    if (record.version !== input.expectedVersion) {
      throw stale();
    }
    const audit: StorageAuditContext = { requestId: input.requestId, actorUserId: actor.userId };
    const item = await this.options.storage
      .run(async (context) => {
        const restored = await context.provider.restore(context.credentials, record.externalItemId);
        if (restored === 'not_recoverable') {
          return null;
        }
        return await context.provider.getItem(context.credentials, record.externalItemId);
      }, audit)
      .catch((error: unknown) => {
        if (isStorageProviderError(error) && error.kind === 'not_found') {
          return null;
        }
        return asStorageFailure(error);
      });
    if (item === null || item.trashed) {
      throw new AuthError(
        409,
        'DOCUMENT_NOT_RECOVERABLE',
        'The file is no longer recoverable from document storage, so the document cannot be restored.',
      );
    }
    const now = this.now();
    const at = now.toISOString();
    const saved = await this.options.unitOfWork.run(async (repositories) => {
      const locked = await repositories.documents.lockById(input.id);
      if (locked === null) {
        throw stale();
      }
      if (locked.version !== input.expectedVersion) {
        throw stale();
      }
      const updated = await repositories.documents.update({
        id: locked.id,
        changes: {
          deletedAt: null,
          deletedBy: null,
          providerState: 'present',
          externalParentId: item.parentId ?? locked.externalParentId,
          externalEtag: item.etag,
          ...(locked.verificationState === 'missing_provider'
            ? {
                verificationState: 'pending' as const,
                verifiedBy: null,
                verifiedAt: null,
              }
            : {}),
        },
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        throw stale();
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentRestored,
        entityType: DOCUMENT_ENTITY,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: this.auditMetadata(updated, target),
      });
      return updated;
    });
    return await this.toDocument(actor, saved, target);
  }

  // -------------------------------------------------------------------------
  // Reconciliation (TD-410)
  // -------------------------------------------------------------------------

  /** Marks a document missing in storage (never deletes it). */
  private async markMissing(
    record: DocumentRecord,
    target: DocumentTarget | null,
    actorUserId: string | null,
    requestId: string,
  ): Promise<void> {
    const now = this.now();
    const at = now.toISOString();
    await this.options.unitOfWork.run(async (repositories) => {
      const locked = await repositories.documents.lockById(record.id);
      if (locked === null || locked.providerState === 'missing') {
        return;
      }
      const updated = await repositories.documents.update({
        id: locked.id,
        changes: {
          providerState: 'missing',
          verificationState: 'missing_provider',
          verifiedBy: null,
          verifiedAt: null,
          lastReconciledAt: at,
        },
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        return;
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId,
        action: AUDIT_ACTIONS.documentMissing,
        entityType: DOCUMENT_ENTITY,
        entityId: locked.id,
        requestId,
        metadata:
          target === null
            ? { documentType: locked.documentType }
            : this.auditMetadata(locked, target),
      });
      if (locked.checklistItemId !== null) {
        await reopenChecklistItemIfUnsatisfied(repositories, now, {
          caseId: locked.caseId,
          itemId: locked.checklistItemId,
          actorUserId,
          requestId,
        });
      }
    });
  }

  private async toRun(record: ReconciliationRunRecord): Promise<ReconciliationRun> {
    const lookup = personLookup(this.repositories.users);
    return {
      id: record.id,
      state: record.state,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      startedByName: (await lookup(record.startedBy))?.displayName ?? null,
      connectionStatus: record.connectionStatus,
      checkedCount: record.checkedCount,
      presentCount: record.presentCount,
      missingCount: record.missingCount,
      movedCount: record.movedCount,
      recoveredCount: record.recoveredCount,
      nextAction: record.nextAction,
    };
  }

  async listReconciliationRuns(): Promise<ReconciliationRun[]> {
    const records = await this.repositories.reconciliationRuns.listRecent(RECENT_RUNS);
    return await Promise.all(records.map(async (record) => await this.toRun(record)));
  }

  private static failureAction(status: StorageConnectionStatus): ReconciliationNextAction {
    return status === 'unavailable' ? 'retry_later' : 'reconnect_storage';
  }

  /**
   * Administrator-triggered reconciliation over every stored external ID.
   * Missing and moved objects are marked, never deleted; documents found
   * again after an earlier run are recovered to `pending`.
   */
  async runReconciliation(input: {
    readonly actor: Actor;
    readonly requestId: string;
  }): Promise<ReconciliationRun> {
    const { actor, requestId } = input;
    const startedAt = this.now().toISOString();
    const counts = { checked: 0, present: 0, missing: 0, moved: 0, recovered: 0 };
    let state: 'completed' | 'failed' = 'completed';
    let connectionStatus = (await this.options.storage.currentStatus()).status;
    const audit: StorageAuditContext = { requestId, actorUserId: actor.userId };

    if (!storageAcceptsOperations(connectionStatus)) {
      state = 'failed';
    } else {
      let afterId: string | null = null;
      try {
        for (;;) {
          const batch = await this.repositories.documents.listForReconciliation({
            afterId,
            limit: RECONCILIATION_BATCH,
          });
          if (batch.length === 0) {
            break;
          }
          const items = await this.options.storage.run(async (context) => {
            const found = new Map<string, ProviderItem | null>();
            for (const record of batch) {
              found.set(
                record.id,
                await context.provider.getItem(context.credentials, record.externalItemId),
              );
            }
            return found;
          }, audit);
          for (const record of batch) {
            counts.checked += 1;
            await this.reconcileOne(record, items.get(record.id) ?? null, counts, actor, requestId);
          }
          afterId = batch.at(-1)?.id ?? null;
          if (batch.length < RECONCILIATION_BATCH) {
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof AuthError) && !isStorageProviderError(error)) {
          throw error;
        }
        state = 'failed';
      }
      connectionStatus = (await this.options.storage.currentStatus()).status;
    }

    const nextAction: ReconciliationNextAction =
      state === 'failed'
        ? DocumentService.failureAction(connectionStatus)
        : counts.missing > 0
          ? 'review_missing_documents'
          : 'none';
    const now = this.now();
    const run: ReconciliationRunRecord = {
      id: newUuidV7(now.getTime()),
      state,
      startedBy: actor.userId,
      startedAt,
      finishedAt: now.toISOString(),
      connectionStatus,
      checkedCount: counts.checked,
      presentCount: counts.present,
      missingCount: counts.missing,
      movedCount: counts.moved,
      recoveredCount: counts.recovered,
      nextAction,
      requestId,
    };
    await this.options.unitOfWork.run(async (repositories) => {
      await repositories.reconciliationRuns.append(run);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.storageReconciliationRun,
        entityType: RECONCILIATION_ENTITY,
        entityId: run.id,
        requestId,
        metadata: {
          state,
          connectionStatus,
          checkedCount: counts.checked,
          missingCount: counts.missing,
          movedCount: counts.moved,
          recoveredCount: counts.recovered,
          nextAction,
        },
      });
    });
    return await this.toRun(run);
  }

  private async reconcileOne(
    record: DocumentRecord,
    item: ProviderItem | null,
    counts: { checked: number; present: number; missing: number; moved: number; recovered: number },
    actor: Actor,
    requestId: string,
  ): Promise<void> {
    const now = this.now();
    const at = now.toISOString();
    if (item === null || item.trashed) {
      counts.missing += 1;
      await this.markMissing(
        record,
        await this.loadTarget(record.clientId, record.caseId),
        actor.userId,
        requestId,
      );
      return;
    }
    const moved =
      record.externalParentId !== null &&
      item.parentId !== null &&
      item.parentId !== record.externalParentId;
    const recovered = record.providerState === 'missing';
    if (moved) {
      counts.moved += 1;
    } else {
      counts.present += 1;
    }
    if (recovered) {
      counts.recovered += 1;
    }
    const nextProviderState = moved ? 'moved' : 'present';
    const target = await this.loadTarget(record.clientId, record.caseId);
    await this.options.unitOfWork.run(async (repositories) => {
      const locked = await repositories.documents.lockById(record.id);
      if (locked === null) {
        return;
      }
      const changes: { -readonly [K in keyof DocumentChanges]: DocumentChanges[K] } = {
        providerState: nextProviderState,
        lastReconciledAt: at,
        externalEtag: item.etag,
      };
      if (recovered && locked.verificationState === 'missing_provider') {
        changes.verificationState = 'pending';
        changes.verifiedBy = null;
        changes.verifiedAt = null;
      }
      const updated = await repositories.documents.update({
        id: locked.id,
        changes,
        expectedVersion: locked.version,
        at,
      });
      if (updated === null) {
        return;
      }
      const action = recovered
        ? AUDIT_ACTIONS.documentRecovered
        : moved && locked.providerState !== 'moved'
          ? AUDIT_ACTIONS.documentMoved
          : null;
      if (action !== null) {
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: actor.userId,
          action,
          entityType: DOCUMENT_ENTITY,
          entityId: locked.id,
          requestId,
          metadata:
            target === null
              ? { documentType: locked.documentType, providerState: nextProviderState }
              : this.auditMetadata(locked, target, { providerState: nextProviderState }),
        });
      }
    });
  }
}

/**
 * Reopens a completed or verified document-backed checklist item when its
 * last satisfying document stops counting (rejected, reset, deleted, missing,
 * or unlinked). Runs inside the caller's transaction and only while the
 * case's checklist is open (TD-408).
 */
export async function reopenChecklistItemIfUnsatisfied(
  repositories: Repositories,
  now: Date,
  input: {
    readonly caseId: string | null;
    readonly itemId: string;
    readonly actorUserId: string | null;
    readonly requestId: string;
  },
): Promise<boolean> {
  if (input.caseId === null) {
    return false;
  }
  const taxCase = await repositories.cases.lockById(input.caseId);
  if (taxCase === null) {
    return false;
  }
  if (taxCase.deletedAt !== null || taxCase.currentStatusKind !== 'open') {
    return false;
  }
  const item = (await repositories.cases.listItems([taxCase.id])).find(
    (candidate) => candidate.id === input.itemId,
  );
  if (
    item === undefined ||
    !item.required ||
    item.documentType === null ||
    (item.state !== 'completed' && item.state !== 'verified')
  ) {
    return false;
  }
  const linked = await repositories.documents.listForChecklistItems([item.id]);
  if (linked.some((document) => documentSatisfiesChecklist(document))) {
    return false;
  }
  const at = now.toISOString();
  const reopened = await repositories.cases.updateItem({
    caseId: taxCase.id,
    itemId: item.id,
    changes: {
      state: 'open',
      completedBy: null,
      completedAt: null,
      preparerComment: item.preparerComment,
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: '',
    },
    expectedVersion: item.version,
    at,
  });
  if (reopened === null) {
    return false;
  }
  await appendAuditEvent(repositories.audit, now, {
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.caseChecklistReopened,
    entityType: CASE_ENTITY,
    entityId: taxCase.id,
    requestId: input.requestId,
    metadata: {
      caseCode: taxCase.caseCode,
      itemId: item.id,
      checklistItem: item.label,
      reason: 'document',
    },
  });
  return true;
}

/** Whether an item needs a verified linked document before it can be completed. */
export function checklistItemNeedsDocument(item: {
  readonly required: boolean;
  readonly documentType: string | null;
}): boolean {
  return item.required && item.documentType !== null;
}
