import type { StorageProviderType } from '@taxdesk/shared';

/**
 * The provider-neutral document storage port (TD-401). Domain services depend
 * only on this module; Microsoft Graph and OneDrive types live in
 * `storage/onedrive/` and never leak into case, client, document, or billing
 * code (`storage/boundary.test.ts` enforces this).
 *
 * Credentials are opaque to callers: the storage connection service encrypts
 * them at rest, refreshes them, and hands a decrypted copy to the adapter for
 * one operation at a time. Nothing returned here may be sent to a browser
 * except `ProviderItem` fields the document service maps explicitly.
 */

/** Opaque, provider-specific credential bundle (tokens + expiry). Never logged. */
export interface ProviderCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** UTC ISO timestamp the access token expires at. */
  readonly accessTokenExpiresAt: string;
  /** Granted scopes as returned by the provider, for diagnostics only. */
  readonly scopes: readonly string[];
}

/** Where the deployment's files live inside the provider account. */
export interface ProviderAccount {
  readonly driveId: string | null;
  /** The app-scoped root folder every TaxDesk path is relative to. */
  readonly rootFolderId: string;
  /** A display label such as the account owner's name. Never an email or token. */
  readonly accountLabel: string | null;
}

export interface ProviderConnectionGrant {
  readonly credentials: ProviderCredentials;
  readonly account: ProviderAccount;
}

/**
 * A storage location made of path segments relative to the provider's app
 * root. Built only by `buildDocumentStoragePath` from stable record IDs; the
 * adapter turns it into its own addressing scheme. Business logic never stores
 * or compares paths: the external item ID is the durable reference.
 */
export interface StoragePath {
  readonly segments: readonly string[];
  readonly fileName: string;
}

/** Provider metadata for one stored object. */
export interface ProviderItem {
  readonly externalItemId: string;
  readonly driveId: string | null;
  readonly parentId: string | null;
  readonly name: string;
  readonly sizeBytes: number;
  readonly etag: string | null;
  /** Whether the item sits in the provider's recycle bin / trash. */
  readonly trashed: boolean;
}

/**
 * An in-progress resumable upload. `handle` is secret (a pre-authenticated
 * URL for OneDrive): callers encrypt it at rest and never return it.
 */
export interface ProviderUploadSession {
  readonly handle: string;
  readonly expiresAt: string;
  readonly nextOffset: number;
}

export type ProviderChunkResult =
  | { readonly kind: 'partial'; readonly nextOffset: number }
  | { readonly kind: 'complete'; readonly item: ProviderItem };

export interface ProviderDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
}

export type ProviderHealth =
  | { readonly kind: 'healthy'; readonly account: ProviderAccount }
  | { readonly kind: 'unhealthy'; readonly error: StorageProviderError };

export type ProviderRestoreResult = 'restored' | 'not_recoverable';

/**
 * Error categories every adapter maps provider failures onto. Messages are
 * fixed, safe strings; adapters never copy provider response bodies, URLs, or
 * tokens into them.
 */
export const STORAGE_PROVIDER_ERROR_KINDS = [
  /** Consent revoked, refresh token expired/invalid: an administrator must reconnect. */
  'reconnect_required',
  /** Access token rejected but a refresh may fix it. */
  'unauthorized',
  /** Timeouts, 5xx, network failures. Retry later. */
  'unavailable',
  /** 429 / throttling. */
  'rate_limited',
  /** The item or upload session no longer exists. */
  'not_found',
  /** A name conflict or an offset mismatch on a chunk. */
  'conflict',
  /** The provider refused the request as invalid (bad range, too large). */
  'rejected',
  /** The deployment lacks the configuration this adapter needs. */
  'not_configured',
] as const;

export type StorageProviderErrorKind = (typeof STORAGE_PROVIDER_ERROR_KINDS)[number];

export class StorageProviderError extends Error {
  readonly kind: StorageProviderErrorKind;
  /** Seconds to wait before retrying, when the provider said so. */
  readonly retryAfterSeconds: number | undefined;
  /** For `conflict` on a chunk: the offset the provider expects next, if known. */
  readonly expectedOffset: number | undefined;

  constructor(
    kind: StorageProviderErrorKind,
    message: string,
    options: { readonly retryAfterSeconds?: number; readonly expectedOffset?: number } = {},
  ) {
    super(message);
    this.name = 'StorageProviderError';
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.expectedOffset = options.expectedOffset;
  }
}

export function isStorageProviderError(error: unknown): error is StorageProviderError {
  return error instanceof StorageProviderError;
}

export interface BeginConnectionInput {
  /** Random state echoed back to the callback. */
  readonly state: string;
  /** PKCE S256 challenge. */
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface CompleteConnectionInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface CreateUploadSessionInput {
  readonly path: StoragePath;
  readonly sizeBytes: number;
}

export interface UploadChunkInput {
  readonly session: ProviderUploadSession;
  readonly offset: number;
  readonly totalSize: number;
  readonly bytes: Uint8Array;
}

/**
 * Methods for connection, upload, completion, download, metadata, health, and
 * trash. Every data method takes the decrypted credentials for one call.
 */
export interface DocumentStorageProvider {
  readonly providerType: StorageProviderType;

  // Connection (TD-403)
  /** Consent URL for an administrator. Pure; makes no network call. */
  beginConnection(input: BeginConnectionInput): { readonly authorizationUrl: string };
  /** Exchanges the authorization code and resolves the app root folder. */
  completeConnection(input: CompleteConnectionInput): Promise<ProviderConnectionGrant>;
  /** Rotates credentials. Throws `reconnect_required` when consent is gone. */
  refreshCredentials(credentials: ProviderCredentials): Promise<ProviderCredentials>;

  // Health (TD-404)
  checkHealth(credentials: ProviderCredentials): Promise<ProviderHealth>;

  // Upload and completion (TD-406)
  createUploadSession(
    credentials: ProviderCredentials,
    input: CreateUploadSessionInput,
  ): Promise<ProviderUploadSession>;
  /** Sends one chunk. Upload-session URLs are pre-authenticated, so no credentials. */
  uploadChunk(input: UploadChunkInput): Promise<ProviderChunkResult>;
  /** Where a session stands (resume after interruption). */
  getUploadSession(session: ProviderUploadSession): Promise<ProviderUploadSession>;
  cancelUploadSession(session: ProviderUploadSession): Promise<void>;

  // Metadata and download (TD-406, TD-407, TD-410)
  /** `null` when the item no longer exists (not when access failed). */
  getItem(credentials: ProviderCredentials, externalItemId: string): Promise<ProviderItem | null>;
  download(credentials: ProviderCredentials, externalItemId: string): Promise<ProviderDownload>;

  // Trash (TD-409)
  trash(credentials: ProviderCredentials, externalItemId: string): Promise<void>;
  restore(credentials: ProviderCredentials, externalItemId: string): Promise<ProviderRestoreResult>;
}
