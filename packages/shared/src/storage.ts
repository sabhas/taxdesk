import { z } from 'zod';
import { UuidV7Schema } from './id.js';

/**
 * Storage connection contracts (Epic 4, TD-402–TD-404, TD-410). One deployment
 * has at most one storage connection. Tokens, provider authorization
 * responses, and upload-session URLs never appear in these shapes: the API
 * returns connection metadata and health only.
 */

/** Providers the deployment can be connected to. `fake` exists for tests only. */
export const STORAGE_PROVIDER_TYPES = ['onedrive', 'fake'] as const;
export const StorageProviderTypeSchema = z.enum(STORAGE_PROVIDER_TYPES);
export type StorageProviderType = z.infer<typeof StorageProviderTypeSchema>;

/**
 * - `not_connected`: no connection has ever been made, or it was disconnected;
 * - `healthy`: the last check or operation succeeded;
 * - `reconnect_required`: consent was revoked or the refresh token expired;
 *   new document operations stop until an administrator reconnects;
 * - `unavailable`: the provider failed transiently (timeouts, 5xx, throttling).
 */
export const STORAGE_CONNECTION_STATUSES = [
  'not_connected',
  'healthy',
  'reconnect_required',
  'unavailable',
] as const;
export const StorageConnectionStatusSchema = z.enum(STORAGE_CONNECTION_STATUSES);
export type StorageConnectionStatus = z.infer<typeof StorageConnectionStatusSchema>;

/** Safe, code-only reasons for an unhealthy connection. Never provider text. */
export const STORAGE_HEALTH_REASONS = [
  'consent_revoked',
  'refresh_failed',
  'provider_unavailable',
  'rate_limited',
  'folder_unavailable',
  'not_configured',
] as const;
export const StorageHealthReasonSchema = z.enum(STORAGE_HEALTH_REASONS);
export type StorageHealthReason = z.infer<typeof StorageHealthReasonSchema>;

/**
 * Whether new document operations (upload, open, delete, restore) may run.
 * A transiently `unavailable` provider is still tried, and the first success
 * marks the connection healthy again; a connection that is missing or needs
 * an administrator to reconnect stops every new operation (TD-404).
 */
export function storageAcceptsOperations(status: StorageConnectionStatus): boolean {
  return status === 'healthy' || status === 'unavailable';
}

export const StorageConnectionSchema = z
  .object({
    /** `null` when the deployment has never been connected. */
    id: UuidV7Schema.nullable(),
    providerType: StorageProviderTypeSchema.nullable(),
    status: StorageConnectionStatusSchema,
    healthReason: StorageHealthReasonSchema.nullable(),
    /** Display label of the connected account (e.g. its display name). Never a token. */
    accountLabel: z.string().max(200).nullable(),
    connectedAt: z.string().datetime().nullable(),
    connectedByName: z.string().max(200).nullable(),
    lastCheckedAt: z.string().datetime().nullable(),
    lastRefreshedAt: z.string().datetime().nullable(),
    /** `null` until a connection row exists. Sent back as `If-Match` for disconnect. */
    version: z.number().int().positive().nullable(),
    /** Whether the server is configured for OAuth (client ID, key, redirect). */
    configured: z.boolean(),
    permissions: z
      .object({
        manage: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type StorageConnection = z.infer<typeof StorageConnectionSchema>;

export const StorageAuthorizationResponseSchema = z
  .object({
    /** Provider consent URL the administrator's browser navigates to. */
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type StorageAuthorizationResponse = z.infer<typeof StorageAuthorizationResponseSchema>;

/**
 * What the provider appended to the redirect URI, forwarded by the web
 * callback page to `POST /api/v1/storage/connection/complete`.
 *
 * The provider redirects the browser to a web route, not to the API: that
 * navigation is cross-site, so the `SameSite=Strict` session cookie is not
 * sent with it. The callback page then posts these values from the app's own
 * origin, where the session cookie applies (ADR 0006).
 */
export const StorageCallbackRequestSchema = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(512).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(2000).optional(),
  })
  .strict();
export type StorageCallbackRequest = z.infer<typeof StorageCallbackRequestSchema>;

/** Outcome of completing a consent; the web shows it on the settings page (`?result=`). */
export const STORAGE_CALLBACK_RESULTS = [
  'connected',
  'denied',
  'expired',
  'invalid_state',
  'failed',
] as const;
export const StorageCallbackResultSchema = z.enum(STORAGE_CALLBACK_RESULTS);
export type StorageCallbackResult = z.infer<typeof StorageCallbackResultSchema>;

export const StorageCallbackResponseSchema = z
  .object({
    result: StorageCallbackResultSchema,
  })
  .strict();
export type StorageCallbackResponse = z.infer<typeof StorageCallbackResponseSchema>;

/** Web route the OAuth callback redirects back to. */
export const STORAGE_SETTINGS_PATH = '/settings/storage';
/** Web route registered as the provider redirect URI (appended to `APP_PUBLIC_URL`). */
export const STORAGE_CALLBACK_PATH = '/settings/storage/callback';

// ---------------------------------------------------------------------------
// Reconciliation (TD-410)
// ---------------------------------------------------------------------------

export const RECONCILIATION_STATES = ['completed', 'failed'] as const;
export const ReconciliationStateSchema = z.enum(RECONCILIATION_STATES);
export type ReconciliationState = z.infer<typeof ReconciliationStateSchema>;

/** The single next step a reconciliation report recommends. */
export const RECONCILIATION_NEXT_ACTIONS = [
  'none',
  'review_missing_documents',
  'reconnect_storage',
  'retry_later',
] as const;
export const ReconciliationNextActionSchema = z.enum(RECONCILIATION_NEXT_ACTIONS);
export type ReconciliationNextAction = z.infer<typeof ReconciliationNextActionSchema>;

export const ReconciliationRunSchema = z
  .object({
    id: UuidV7Schema,
    state: ReconciliationStateSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    startedByName: z.string().max(200).nullable(),
    connectionStatus: StorageConnectionStatusSchema,
    checkedCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    missingCount: z.number().int().nonnegative(),
    movedCount: z.number().int().nonnegative(),
    /** Documents found present again after an earlier run marked them missing. */
    recoveredCount: z.number().int().nonnegative(),
    nextAction: ReconciliationNextActionSchema,
  })
  .strict();
export type ReconciliationRun = z.infer<typeof ReconciliationRunSchema>;

export const ReconciliationRunListSchema = z
  .object({
    runs: z.array(ReconciliationRunSchema),
  })
  .strict();
export type ReconciliationRunList = z.infer<typeof ReconciliationRunListSchema>;
