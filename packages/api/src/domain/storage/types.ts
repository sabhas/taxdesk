import type {
  ReconciliationNextAction,
  ReconciliationState,
  StorageConnectionStatus,
  StorageHealthReason,
  StorageProviderType,
} from '@taxdesk/shared';

/** The deployment's single storage connection row (`storage_connections`). */
export interface StorageConnectionRecord {
  readonly id: string;
  readonly providerType: StorageProviderType;
  readonly status: StorageConnectionStatus;
  readonly healthReason: StorageHealthReason | null;
  readonly externalDriveId: string | null;
  readonly externalRootFolderId: string | null;
  readonly accountLabel: string | null;
  /** AES-256-GCM ciphertext of the `ProviderCredentials` JSON; `null` when disconnected. */
  readonly tokenCiphertext: string | null;
  readonly tokenKeyVersion: number | null;
  readonly accessTokenExpiresAt: string | null;
  readonly connectedAt: string | null;
  readonly connectedBy: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastRefreshedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly disconnectedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** Fields a connection write may change; the repository bumps `version`. */
export type StorageConnectionChanges = Partial<
  Omit<StorageConnectionRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'>
>;

export interface StorageOAuthStateRecord {
  readonly id: string;
  /** SHA-256 digest of the random state; the state itself is never stored. */
  readonly stateHash: string;
  readonly codeVerifierCiphertext: string;
  readonly keyVersion: number;
  readonly providerType: StorageProviderType;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface ReconciliationRunRecord {
  readonly id: string;
  readonly state: ReconciliationState;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly connectionStatus: StorageConnectionStatus;
  readonly checkedCount: number;
  readonly presentCount: number;
  readonly missingCount: number;
  readonly movedCount: number;
  readonly recoveredCount: number;
  readonly nextAction: ReconciliationNextAction;
  readonly requestId: string;
}
