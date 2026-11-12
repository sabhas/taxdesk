import { AuthError } from '../domain/auth/errors.js';
import type { StorageGateway } from '../storage/gateway.js';
import type { DocumentStorageProvider, ProviderConnectionGrant } from '../storage/provider.js';

/**
 * A minimal `StorageGateway` over an already-granted connection, for unit
 * tests that exercise the document domain without the connection service.
 * Pass `grant: null` to simulate a deployment that is not connected.
 */
export function createStaticStorageGateway(
  provider: DocumentStorageProvider,
  grant: ProviderConnectionGrant | null,
): StorageGateway {
  const requireGrant = (): ProviderConnectionGrant => {
    if (grant === null) {
      throw new AuthError(503, 'STORAGE_NOT_CONNECTED', 'Document storage is not connected.');
    }
    return grant;
  };
  return {
    currentStatus: () =>
      Promise.resolve({
        status: grant === null ? 'not_connected' : 'healthy',
        providerType: grant === null ? null : provider.providerType,
      }),
    run: async (operation) => {
      const current = requireGrant();
      return await operation({
        provider,
        credentials: current.credentials,
        account: current.account,
        providerType: provider.providerType,
      });
    },
    runWithoutCredentials: async (operation) => {
      requireGrant();
      return await operation(provider);
    },
  };
}
