import type { StorageConnectionStatus, StorageProviderType } from '@taxdesk/shared';
import type { DocumentStorageProvider, ProviderAccount, ProviderCredentials } from './provider.js';

/**
 * What the document domain sees of the storage connection. Implemented by
 * `StorageConnectionService` (TD-402–TD-404); tests may use
 * `testing/static-storage-gateway.ts`.
 *
 * The document service never decrypts tokens or refreshes credentials itself:
 * it asks the gateway to run one provider operation.
 */
export interface StorageOperationContext {
  readonly provider: DocumentStorageProvider;
  /** Fresh, decrypted credentials for this one operation. Never log or return them. */
  readonly credentials: ProviderCredentials;
  readonly account: ProviderAccount;
  readonly providerType: StorageProviderType;
}

export interface StorageGatewayStatus {
  readonly status: StorageConnectionStatus;
  readonly providerType: StorageProviderType | null;
}

/**
 * Who triggered a provider operation, for the audit event written when the
 * operation changes the connection's health. Optional: omitted context is
 * audited as a system change with request ID `storage-gateway`.
 */
export interface StorageAuditContext {
  readonly requestId?: string;
  readonly actorUserId?: string | null;
}

export interface StorageGateway {
  /** Current connection status from the database; no provider call. */
  currentStatus(): Promise<StorageGatewayStatus>;

  /**
   * Runs one provider operation with fresh credentials.
   *
   * - Before running, throws `AuthError(503, STORAGE_NOT_CONNECTED |
   *   STORAGE_RECONNECT_REQUIRED | STORAGE_NOT_CONFIGURED)` when the connection is
   *   not usable, so new document operations stop safely (TD-404).
   * - Refreshes credentials atomically (row lock) when the access token is
   *   expired or about to expire, and once more if the provider answers
   *   `unauthorized`.
   * - When the operation (or refresh) throws a `StorageProviderError` of kind
   *   `reconnect_required`, marks the connection `reconnect_required`
   *   (audited) and throws `AuthError(503, STORAGE_RECONNECT_REQUIRED)`.
   * - `unavailable` / `rate_limited` mark the connection `unavailable` and
   *   throw `AuthError(503, STORAGE_UNAVAILABLE)` (with `retryAfterSeconds`).
   * - Other provider errors (`not_found`, `conflict`, `rejected`) are rethrown
   *   unchanged for the caller to interpret.
   * - A successful operation on an `unavailable` connection marks it healthy.
   */
  run<T>(
    operation: (context: StorageOperationContext) => Promise<T>,
    audit?: StorageAuditContext,
  ): Promise<T>;

  /**
   * Runs an operation that needs only the provider (e.g. upload chunks, whose
   * session URL is pre-authenticated). Same status precondition and error
   * mapping as `run`, but no credential refresh.
   */
  runWithoutCredentials<T>(
    operation: (provider: DocumentStorageProvider) => Promise<T>,
    audit?: StorageAuditContext,
  ): Promise<T>;
}
