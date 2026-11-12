/* eslint-disable @typescript-eslint/require-await -- the fake implements the async port synchronously */
import {
  StorageProviderError,
  type BeginConnectionInput,
  type CompleteConnectionInput,
  type CreateUploadSessionInput,
  type DocumentStorageProvider,
  type ProviderAccount,
  type ProviderChunkResult,
  type ProviderConnectionGrant,
  type ProviderCredentials,
  type ProviderDownload,
  type ProviderHealth,
  type ProviderItem,
  type ProviderRestoreResult,
  type ProviderUploadSession,
  type StorageProviderErrorKind,
  type UploadChunkInput,
} from './provider.js';

/**
 * In-memory `DocumentStorageProvider` for service and route tests (TD-401).
 * It behaves like the OneDrive adapter at the port level — resumable
 * sessions, offset checks, trash/restore, consent revocation — without any
 * network access. Test controls are exposed on the returned object.
 */

interface StoredItem {
  item: ProviderItem;
  bytes: Uint8Array;
  path: string;
  /** Trash state: items stay recoverable until `purge`. */
  trashed: boolean;
}

interface FakeSession {
  readonly path: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly expiresAt: string;
  received: Uint8Array;
  nextOffset: number;
  cancelled: boolean;
}

export interface FakeStorageProvider extends DocumentStorageProvider {
  /** Items by external ID (inspection only). */
  readonly items: ReadonlyMap<string, { readonly item: ProviderItem; readonly path: string }>;
  /** Number of provider calls by method name. */
  readonly calls: Readonly<Record<string, number>>;
  /** The code `completeConnection` accepts. */
  readonly validCode: string;
  /** Revokes consent: refresh and every credentialed call fail `reconnect_required`. */
  revokeConsent(): void;
  /** Makes the next N calls of any credentialed/session method throw this kind. */
  failNext(kind: StorageProviderErrorKind, times?: number): void;
  /** Expires every access token issued so far (next call answers `unauthorized`). */
  expireAccessTokens(): void;
  /** Deletes an item outside TaxDesk (reconciliation sees it missing). */
  removeExternally(externalItemId: string): void;
  /** Moves an item to another parent outside TaxDesk. */
  moveExternally(externalItemId: string, newParentId: string): void;
  /** Empties the trash so trashed items are no longer recoverable. */
  purgeTrash(): void;
  /** Bytes of a stored item (tests compare downloads). */
  contentOf(externalItemId: string): Uint8Array | null;
}

export interface FakeStorageProviderOptions {
  readonly clock?: () => Date;
  /** Access-token lifetime in seconds (default 3600). */
  readonly accessTokenLifetimeSeconds?: number;
}

const ROOT_FOLDER_ID = 'fake-root';
const DRIVE_ID = 'fake-drive';

export function createFakeStorageProvider(
  options: FakeStorageProviderOptions = {},
): FakeStorageProvider {
  const clock = options.clock ?? (() => new Date());
  const lifetime = options.accessTokenLifetimeSeconds ?? 3600;
  const items = new Map<string, StoredItem>();
  const sessions = new Map<string, FakeSession>();
  const calls: Record<string, number> = {};
  const validAccessTokens = new Set<string>();
  let validRefreshToken: string | null = null;
  let revoked = false;
  let pendingFailure: { kind: StorageProviderErrorKind; times: number } | null = null;
  let counter = 0;

  const account: ProviderAccount = {
    driveId: DRIVE_ID,
    rootFolderId: ROOT_FOLDER_ID,
    accountLabel: 'Fake storage account',
  };

  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${String(counter)}`;
  };

  const count = (method: string): void => {
    calls[method] = (calls[method] ?? 0) + 1;
  };

  const maybeFail = (): void => {
    if (pendingFailure !== null) {
      const { kind } = pendingFailure;
      pendingFailure.times -= 1;
      if (pendingFailure.times <= 0) {
        pendingFailure = null;
      }
      throw new StorageProviderError(kind, `Simulated provider failure (${kind}).`);
    }
  };

  const issueCredentials = (): ProviderCredentials => {
    const accessToken = nextId('access');
    const refreshToken = nextId('refresh');
    validAccessTokens.add(accessToken);
    validRefreshToken = refreshToken;
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(clock().getTime() + lifetime * 1000).toISOString(),
      scopes: ['Files.ReadWrite.AppFolder'],
    };
  };

  const authorize = (credentials: ProviderCredentials): void => {
    maybeFail();
    if (revoked) {
      throw new StorageProviderError('reconnect_required', 'Consent was revoked.');
    }
    if (!validAccessTokens.has(credentials.accessToken)) {
      throw new StorageProviderError('unauthorized', 'The access token was rejected.');
    }
  };

  const findItem = (externalItemId: string): StoredItem | null => items.get(externalItemId) ?? null;

  const parentIdFor = (path: string): string => `folder:${path}`;

  const provider: FakeStorageProvider = {
    providerType: 'fake',
    items,
    calls,
    validCode: 'fake-authorization-code',

    beginConnection(input: BeginConnectionInput) {
      count('beginConnection');
      const url = new URL('https://fake-storage.test/authorize');
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('redirect_uri', input.redirectUri);
      return { authorizationUrl: url.toString() };
    },

    async completeConnection(input: CompleteConnectionInput): Promise<ProviderConnectionGrant> {
      count('completeConnection');
      maybeFail();
      if (input.code !== provider.validCode || input.codeVerifier.length < 43) {
        throw new StorageProviderError('rejected', 'The authorization code was rejected.');
      }
      revoked = false;
      return { credentials: issueCredentials(), account };
    },

    async refreshCredentials(credentials: ProviderCredentials): Promise<ProviderCredentials> {
      count('refreshCredentials');
      maybeFail();
      if (revoked || credentials.refreshToken !== validRefreshToken) {
        throw new StorageProviderError('reconnect_required', 'The refresh token was rejected.');
      }
      validAccessTokens.delete(credentials.accessToken);
      return issueCredentials();
    },

    async checkHealth(credentials: ProviderCredentials): Promise<ProviderHealth> {
      count('checkHealth');
      try {
        authorize(credentials);
      } catch (error) {
        if (error instanceof StorageProviderError) {
          return { kind: 'unhealthy', error };
        }
        throw error;
      }
      return { kind: 'healthy', account };
    },

    async createUploadSession(
      credentials: ProviderCredentials,
      input: CreateUploadSessionInput,
    ): Promise<ProviderUploadSession> {
      count('createUploadSession');
      authorize(credentials);
      const path = [...input.path.segments, input.path.fileName].join('/');
      for (const stored of items.values()) {
        if (stored.path === path && !stored.trashed) {
          throw new StorageProviderError('conflict', 'An item already exists at this location.');
        }
      }
      const handle = `https://fake-storage.test/upload/${nextId('session')}`;
      const expiresAt = new Date(clock().getTime() + 24 * 3600 * 1000).toISOString();
      sessions.set(handle, {
        path,
        fileName: input.path.fileName,
        sizeBytes: input.sizeBytes,
        expiresAt,
        received: new Uint8Array(input.sizeBytes),
        nextOffset: 0,
        cancelled: false,
      });
      return { handle, expiresAt, nextOffset: 0 };
    },

    async uploadChunk(input: UploadChunkInput): Promise<ProviderChunkResult> {
      count('uploadChunk');
      maybeFail();
      const session = sessions.get(input.session.handle);
      if (
        session === undefined ||
        session.cancelled ||
        session.expiresAt <= clock().toISOString()
      ) {
        throw new StorageProviderError('not_found', 'The upload session no longer exists.');
      }
      if (input.totalSize !== session.sizeBytes) {
        throw new StorageProviderError('rejected', 'The total size does not match the session.');
      }
      if (input.offset !== session.nextOffset) {
        throw new StorageProviderError('conflict', 'The chunk offset is not the expected offset.', {
          expectedOffset: session.nextOffset,
        });
      }
      if (input.bytes.length === 0 || input.offset + input.bytes.length > session.sizeBytes) {
        throw new StorageProviderError('rejected', 'The chunk range is invalid.');
      }
      session.received.set(input.bytes, input.offset);
      session.nextOffset = input.offset + input.bytes.length;
      if (session.nextOffset < session.sizeBytes) {
        return { kind: 'partial', nextOffset: session.nextOffset };
      }
      const externalItemId = nextId('item');
      const parentPath = session.path.slice(0, session.path.lastIndexOf('/'));
      const item: ProviderItem = {
        externalItemId,
        driveId: DRIVE_ID,
        parentId: parentIdFor(parentPath),
        name: session.fileName,
        sizeBytes: session.sizeBytes,
        etag: `"${externalItemId}-1"`,
        trashed: false,
      };
      items.set(externalItemId, {
        item,
        bytes: session.received,
        path: session.path,
        trashed: false,
      });
      sessions.delete(input.session.handle);
      return { kind: 'complete', item };
    },

    async getUploadSession(session: ProviderUploadSession): Promise<ProviderUploadSession> {
      count('getUploadSession');
      maybeFail();
      const stored = sessions.get(session.handle);
      if (stored === undefined || stored.cancelled) {
        throw new StorageProviderError('not_found', 'The upload session no longer exists.');
      }
      return { handle: session.handle, expiresAt: stored.expiresAt, nextOffset: stored.nextOffset };
    },

    async cancelUploadSession(session: ProviderUploadSession): Promise<void> {
      count('cancelUploadSession');
      const stored = sessions.get(session.handle);
      if (stored !== undefined) {
        stored.cancelled = true;
      }
    },

    async getItem(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderItem | null> {
      count('getItem');
      authorize(credentials);
      const stored = findItem(externalItemId);
      if (stored === null) {
        return null;
      }
      return { ...stored.item, trashed: stored.trashed };
    },

    async download(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderDownload> {
      count('download');
      authorize(credentials);
      const stored = findItem(externalItemId);
      if (stored === null || stored.trashed) {
        throw new StorageProviderError('not_found', 'The item was not found.');
      }
      const bytes = stored.bytes;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        sizeBytes: bytes.length,
        contentType: null,
      };
    },

    async trash(credentials: ProviderCredentials, externalItemId: string): Promise<void> {
      count('trash');
      authorize(credentials);
      const stored = findItem(externalItemId);
      if (stored === null) {
        throw new StorageProviderError('not_found', 'The item was not found.');
      }
      stored.trashed = true;
    },

    async restore(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderRestoreResult> {
      count('restore');
      authorize(credentials);
      const stored = findItem(externalItemId);
      if (stored === null) {
        return 'not_recoverable';
      }
      stored.trashed = false;
      return 'restored';
    },

    revokeConsent() {
      revoked = true;
    },
    failNext(kind, times = 1) {
      pendingFailure = { kind, times };
    },
    expireAccessTokens() {
      validAccessTokens.clear();
    },
    removeExternally(externalItemId) {
      items.delete(externalItemId);
    },
    moveExternally(externalItemId, newParentId) {
      const stored = items.get(externalItemId);
      if (stored !== undefined) {
        stored.item = { ...stored.item, parentId: newParentId };
      }
    },
    purgeTrash() {
      for (const [id, stored] of items) {
        if (stored.trashed) {
          items.delete(id);
        }
      }
    },
    contentOf(externalItemId) {
      return items.get(externalItemId)?.bytes ?? null;
    },
  };

  return provider;
}
