import type {
  DocumentContentType,
  DocumentListState,
  DocumentProviderState,
  DocumentVerificationState,
  StorageProviderType,
  UploadState,
} from '@taxdesk/shared';

export interface DocumentRecord {
  readonly id: string;
  readonly clientId: string;
  readonly caseId: string | null;
  readonly checklistItemId: string | null;
  readonly documentType: string;
  readonly fileName: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly providerType: StorageProviderType;
  /** Durable provider-neutral reference. Never a path. */
  readonly externalItemId: string;
  readonly externalDriveId: string | null;
  readonly externalParentId: string | null;
  readonly externalEtag: string | null;
  readonly verificationState: DocumentVerificationState;
  readonly verificationNote: string | null;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly providerState: DocumentProviderState;
  readonly lastReconciledAt: string | null;
  readonly uploadId: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Mutable document fields; the repository bumps `version` and `updatedAt`. */
export type DocumentChanges = Partial<
  Pick<
    DocumentRecord,
    | 'documentType'
    | 'checklistItemId'
    | 'verificationState'
    | 'verificationNote'
    | 'verifiedBy'
    | 'verifiedAt'
    | 'providerState'
    | 'lastReconciledAt'
    | 'externalParentId'
    | 'externalEtag'
    | 'deletedAt'
    | 'deletedBy'
  >
>;

export interface DocumentListFilter {
  readonly clientId?: string;
  readonly caseId?: string;
  readonly checklistItemId?: string;
  readonly state: DocumentListState;
  readonly verificationState?: DocumentVerificationState;
  /**
   * Visibility restriction for actors who cannot read every client/case:
   * a document is visible when its client is in `clientIds` or its case is in
   * `caseIds`. `undefined` means no restriction.
   */
  readonly visibleTo?: {
    readonly clientIds: readonly string[];
    readonly caseIds: readonly string[];
  };
  readonly limit: number;
  /** Opaque cursor produced by the repository (uploadedAt + id, newest first). */
  readonly cursor: string | null;
}

export interface DocumentListPage {
  readonly documents: readonly DocumentRecord[];
  readonly nextCursor: string | null;
}

export interface DocumentUploadRecord {
  readonly id: string;
  readonly documentId: string;
  readonly clientId: string;
  readonly caseId: string | null;
  readonly checklistItemId: string | null;
  readonly documentType: string;
  readonly fileName: string;
  readonly contentType: DocumentContentType;
  readonly sizeBytes: number;
  readonly providerType: StorageProviderType;
  /** Encrypted provider upload-session handle (JSON of `ProviderUploadSession`). */
  readonly sessionCiphertext: string | null;
  readonly sessionKeyVersion: number | null;
  readonly nextOffset: number;
  readonly state: UploadState;
  readonly externalItemId: string | null;
  readonly createdBy: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

export type DocumentUploadChanges = Partial<
  Pick<
    DocumentUploadRecord,
    | 'sessionCiphertext'
    | 'sessionKeyVersion'
    | 'nextOffset'
    | 'state'
    | 'externalItemId'
    | 'expiresAt'
    | 'completedAt'
  >
>;
