import {
  ReconciliationRunListSchema,
  ReconciliationRunSchema,
  StorageAuthorizationResponseSchema,
  StorageCallbackResponseSchema,
  StorageConnectionSchema,
  type ReconciliationRun,
  type ReconciliationRunList,
  type StorageAuthorizationResponse,
  type StorageCallbackRequest,
  type StorageCallbackResponse,
  type StorageConnection,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/**
 * Storage connection and reconciliation clients (Epic 4). Tokens never reach
 * the browser: these calls return connection metadata and health only.
 */

function signalOption(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

export async function getStorageConnection(signal?: AbortSignal): Promise<StorageConnection> {
  return await apiRequest('/api/v1/storage/connection', StorageConnectionSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

/** Starts consent; the caller navigates the browser to `authorizationUrl`. */
export async function authorizeStorage(): Promise<StorageAuthorizationResponse> {
  return await apiRequest(
    '/api/v1/storage/connection/authorize',
    StorageAuthorizationResponseSchema,
    { method: 'POST', sessionScoped: true },
  );
}

export async function checkStorage(): Promise<StorageConnection> {
  return await apiRequest('/api/v1/storage/connection/check', StorageConnectionSchema, {
    method: 'POST',
    sessionScoped: true,
  });
}

export async function disconnectStorage(version: number): Promise<StorageConnection> {
  return await apiRequest('/api/v1/storage/connection', StorageConnectionSchema, {
    method: 'DELETE',
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function listReconciliationRuns(signal?: AbortSignal): Promise<ReconciliationRunList> {
  return await apiRequest('/api/v1/storage/reconciliation', ReconciliationRunListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function runReconciliation(): Promise<ReconciliationRun> {
  return await apiRequest('/api/v1/storage/reconciliation', ReconciliationRunSchema, {
    method: 'POST',
    sessionScoped: true,
  });
}

/** Hands the provider's callback parameters to the API, which completes consent. */
export async function completeStorageConnection(
  request: StorageCallbackRequest,
): Promise<StorageCallbackResponse> {
  return await apiRequest('/api/v1/storage/connection/complete', StorageCallbackResponseSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}
