import type { AuthRuntimeConfig } from '../config.js';
import { createOneDriveStorageProvider } from './onedrive/onedrive-provider.js';
import type { DocumentStorageProvider } from './provider.js';

/**
 * Builds the deployment's storage adapter from configuration. Returns `null`
 * when no provider is configured; the storage routes then answer 503
 * `STORAGE_NOT_CONFIGURED` instead of guessing.
 *
 * This is the only module outside `storage/onedrive/` allowed to import the
 * OneDrive adapter (`storage/boundary.test.ts`).
 */
export function createStorageProviderFromConfig(
  config: AuthRuntimeConfig,
): DocumentStorageProvider | null {
  if (config.onedriveClientId === undefined) {
    return null;
  }
  return createOneDriveStorageProvider({
    clientId: config.onedriveClientId,
    clientSecret: config.onedriveClientSecret,
    authority: config.onedriveAuthority,
  });
}
