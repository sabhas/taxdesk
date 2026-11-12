import { z } from 'zod';
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
  type StoragePath,
  type UploadChunkInput,
} from '../provider.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  discard,
  errorForResponse,
  providerError,
  readErrorCode,
  readJson,
  safeFetch,
  type FetchLike,
} from './http.js';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshCredentials,
  type OneDriveOAuthConfig,
} from './oauth.js';

/**
 * OneDrive (Microsoft Graph) adapter for `DocumentStorageProvider`.
 *
 * TD-005 findings it relies on:
 * - `Files.ReadWrite.AppFolder` reaches only `/me/drive/special/approot` and
 *   its children; `/me/drive` answers 403, so it is never called.
 * - OneDrive provisions the app folder lazily: the first write can answer
 *   404 `itemNotFound`, so creating an upload session retries once.
 * - Upload-session URLs are pre-authenticated: chunks are sent without the
 *   bearer token, and the URL is treated as a secret.
 * - Chunks must be multiples of 320 KiB (TaxDesk uses 5 MiB).
 *
 * Only `storage/provider-factory.ts` may import this module.
 */

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const APP_ROOT_PATH = '/me/drive/special/approot';
const ITEM_SELECT = 'id,name,size,eTag,parentReference,deleted';
const DEFAULT_PROVISIONING_RETRY_DELAY_MS = 1500;
/** Used when Graph omits the session expiry; deliberately short. */
const FALLBACK_SESSION_LIFETIME_MS = 60 * 60 * 1000;

export interface OneDriveProviderOptions extends OneDriveOAuthConfig {
  readonly fetch?: FetchLike;
  readonly clock?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Delay before retrying a write that hit lazy app-folder provisioning. */
  readonly provisioningRetryDelayMs?: number;
  readonly requestTimeoutMs?: number;
}

const ParentReferenceSchema = z
  .object({
    driveId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  })
  .passthrough();

const IdentitySchema = z
  .object({
    user: z.object({ displayName: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const AppRootSchema = z
  .object({
    id: z.string().min(1),
    parentReference: ParentReferenceSchema.optional(),
    createdBy: IdentitySchema.optional(),
  })
  .passthrough();

const DriveItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    eTag: z.string().optional(),
    parentReference: ParentReferenceSchema.optional(),
    deleted: z.unknown().optional(),
  })
  .passthrough();

const UploadSessionResponseSchema = z
  .object({
    uploadUrl: z.string().url(),
    expirationDateTime: z.string().optional(),
    nextExpectedRanges: z.array(z.string()).optional(),
  })
  .passthrough();

const UploadStatusSchema = z
  .object({
    expirationDateTime: z.string().optional(),
    nextExpectedRanges: z.array(z.string()).optional(),
  })
  .passthrough();

/** First byte of the first expected range (`"5242880-"` or `"0-1023"`). */
export function offsetFromRanges(ranges: readonly string[] | undefined): number | undefined {
  const first = ranges?.[0];
  if (first === undefined) {
    return undefined;
  }
  const match = /^(\d+)-/u.exec(first);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** `/a/b/c/file.pdf` with each segment percent-encoded. */
export function encodeStoragePath(path: StoragePath): string {
  for (const segment of [...path.segments, path.fileName]) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/')) {
      throw new StorageProviderError('rejected', 'The storage path is not valid.');
    }
  }
  return [...path.segments, path.fileName].map((segment) => encodeURIComponent(segment)).join('/');
}

function toProviderItem(item: z.infer<typeof DriveItemSchema>): ProviderItem {
  return {
    externalItemId: item.id,
    driveId: item.parentReference?.driveId ?? null,
    parentId: item.parentReference?.id ?? null,
    name: item.name,
    sizeBytes: item.size,
    etag: item.eTag ?? null,
    trashed: item.deleted !== undefined && item.deleted !== null,
  };
}

function parseOrUnavailable<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw providerError('unavailable');
  }
  return parsed.data;
}

function contentRange(offset: number, length: number, total: number): string {
  return `bytes ${String(offset)}-${String(offset + length - 1)}/${String(total)}`;
}

export function createOneDriveStorageProvider(
  options: OneDriveProviderOptions,
): DocumentStorageProvider {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const clock = options.clock ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const retryDelay = options.provisioningRetryDelayMs ?? DEFAULT_PROVISIONING_RETRY_DELAY_MS;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const oauthConfig: OneDriveOAuthConfig = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authority: options.authority,
  };
  const tokenDeps = { fetchImpl, clock, timeoutMs };

  const graph = async (
    credentials: ProviderCredentials,
    path: string,
    init: RequestInit = {},
    requestTimeout: number | null = timeoutMs,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('Accept', 'application/json');
    return await safeFetch(
      fetchImpl,
      `${GRAPH_API_BASE}${path}`,
      { ...init, headers },
      requestTimeout,
    );
  };

  const getAppRoot = async (credentials: ProviderCredentials): Promise<ProviderAccount> => {
    const response = await graph(credentials, APP_ROOT_PATH);
    if (!response.ok) {
      await discard(response);
      // The app-folder scope is gone (revoked or never granted).
      throw errorForResponse(
        response,
        clock(),
        response.status === 403 ? 'reconnect_required' : undefined,
      );
    }
    const root = parseOrUnavailable(AppRootSchema, await readJson(response));
    const label = root.createdBy?.user?.displayName?.trim();
    return {
      driveId: root.parentReference?.driveId ?? null,
      rootFolderId: root.id,
      accountLabel: label === undefined || label.length === 0 ? null : label.slice(0, 200),
    };
  };

  const readUploadStatus = async (handle: string): Promise<z.infer<typeof UploadStatusSchema>> => {
    const response = await safeFetch(fetchImpl, handle, { method: 'GET' }, timeoutMs);
    if (!response.ok) {
      await discard(response);
      throw errorForResponse(response, clock());
    }
    return parseOrUnavailable(UploadStatusSchema, await readJson(response));
  };

  const itemPath = (externalItemId: string): string =>
    `/me/drive/items/${encodeURIComponent(externalItemId)}`;

  return {
    providerType: 'onedrive',

    beginConnection(input: BeginConnectionInput) {
      return { authorizationUrl: buildAuthorizationUrl(oauthConfig, input) };
    },

    async completeConnection(input: CompleteConnectionInput): Promise<ProviderConnectionGrant> {
      const credentials = await exchangeAuthorizationCode(oauthConfig, tokenDeps, input);
      const account = await getAppRoot(credentials);
      return { credentials, account };
    },

    async refreshCredentials(credentials: ProviderCredentials): Promise<ProviderCredentials> {
      return await refreshCredentials(oauthConfig, tokenDeps, credentials);
    },

    async checkHealth(credentials: ProviderCredentials): Promise<ProviderHealth> {
      try {
        return { kind: 'healthy', account: await getAppRoot(credentials) };
      } catch (error) {
        if (error instanceof StorageProviderError) {
          return { kind: 'unhealthy', error };
        }
        throw error;
      }
    },

    async createUploadSession(
      credentials: ProviderCredentials,
      input: CreateUploadSessionInput,
    ): Promise<ProviderUploadSession> {
      const path = `${APP_ROOT_PATH}:/${encodeStoragePath(input.path)}:/createUploadSession`;
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'fail', name: input.path.fileName },
        }),
      };
      let response = await graph(credentials, path, init);
      if (response.status === 404) {
        // Lazy app-folder provisioning (TD-005 run 1): retry the write once.
        await discard(response);
        await sleep(retryDelay);
        response = await graph(credentials, path, init);
      }
      if (!response.ok) {
        await discard(response);
        throw errorForResponse(response, clock());
      }
      const session = parseOrUnavailable(UploadSessionResponseSchema, await readJson(response));
      return {
        handle: session.uploadUrl,
        expiresAt:
          session.expirationDateTime !== undefined &&
          !Number.isNaN(Date.parse(session.expirationDateTime))
            ? new Date(session.expirationDateTime).toISOString()
            : new Date(clock().getTime() + FALLBACK_SESSION_LIFETIME_MS).toISOString(),
        nextOffset: offsetFromRanges(session.nextExpectedRanges) ?? 0,
      };
    },

    async uploadChunk(input: UploadChunkInput): Promise<ProviderChunkResult> {
      if (
        input.bytes.length === 0 ||
        input.offset < 0 ||
        input.offset + input.bytes.length > input.totalSize
      ) {
        throw providerError('rejected');
      }
      // Pre-authenticated URL: never attach the bearer token.
      const response = await safeFetch(
        fetchImpl,
        input.session.handle,
        {
          method: 'PUT',
          headers: {
            'Content-Length': String(input.bytes.length),
            'Content-Range': contentRange(input.offset, input.bytes.length, input.totalSize),
          },
          body: input.bytes,
        },
        timeoutMs,
      );
      if (response.status === 409 || response.status === 416) {
        const payload = await readJson(response);
        if (readErrorCode(payload) === 'nameAlreadyExists') {
          throw providerError('conflict');
        }
        // Range mismatch: ask the session where it stands.
        let expectedOffset: number | undefined;
        try {
          expectedOffset = offsetFromRanges(
            (await readUploadStatus(input.session.handle)).nextExpectedRanges,
          );
        } catch {
          expectedOffset = undefined;
        }
        throw providerError('conflict', expectedOffset === undefined ? {} : { expectedOffset });
      }
      if (!response.ok) {
        await discard(response);
        throw errorForResponse(response, clock());
      }
      const payload = await readJson(response);
      if (response.status === 202) {
        const status = parseOrUnavailable(UploadStatusSchema, payload);
        return {
          kind: 'partial',
          nextOffset:
            offsetFromRanges(status.nextExpectedRanges) ?? input.offset + input.bytes.length,
        };
      }
      return {
        kind: 'complete',
        item: toProviderItem(parseOrUnavailable(DriveItemSchema, payload)),
      };
    },

    async getUploadSession(session: ProviderUploadSession): Promise<ProviderUploadSession> {
      const status = await readUploadStatus(session.handle);
      return {
        handle: session.handle,
        expiresAt:
          status.expirationDateTime !== undefined &&
          !Number.isNaN(Date.parse(status.expirationDateTime))
            ? new Date(status.expirationDateTime).toISOString()
            : session.expiresAt,
        nextOffset: offsetFromRanges(status.nextExpectedRanges) ?? session.nextOffset,
      };
    },

    async cancelUploadSession(session: ProviderUploadSession): Promise<void> {
      const response = await safeFetch(fetchImpl, session.handle, { method: 'DELETE' }, timeoutMs);
      await discard(response);
      // An already-gone session is the goal state.
      if (!response.ok && response.status !== 404) {
        throw errorForResponse(response, clock());
      }
    },

    async getItem(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderItem | null> {
      const response = await graph(
        credentials,
        `${itemPath(externalItemId)}?$select=${ITEM_SELECT}`,
      );
      if (response.status === 404 || response.status === 410) {
        await discard(response);
        return null;
      }
      // A 403 on one item is ambiguous: the item may have been moved out of
      // the app folder (only the folder is in scope), or the grant itself may
      // be gone. Probe the app root: if it still answers, only this item is
      // out of reach and counts as missing; if not, `getAppRoot` throws the
      // connection-level error (reconnect_required on 403) so one moved file
      // never takes the whole connection down, and a lost grant still does.
      if (response.status === 403) {
        await discard(response);
        await getAppRoot(credentials);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw errorForResponse(
          response,
          clock(),
          response.status === 403 ? 'reconnect_required' : undefined,
        );
      }
      return toProviderItem(parseOrUnavailable(DriveItemSchema, await readJson(response)));
    },

    async download(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderDownload> {
      // Follow the redirect manually so the bearer token never reaches the
      // pre-authenticated download host.
      const first = await graph(
        credentials,
        `${itemPath(externalItemId)}/content`,
        { method: 'GET', redirect: 'manual' },
        timeoutMs,
      );
      let response = first;
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get('Location');
        await discard(first);
        if (location === null) {
          throw providerError('unavailable');
        }
        response = await safeFetch(fetchImpl, location, { method: 'GET' }, null);
      }
      if (!response.ok || response.body === null) {
        await discard(response);
        throw errorForResponse(response, clock(), response.ok ? 'unavailable' : undefined);
      }
      const length = Number(response.headers.get('Content-Length'));
      return {
        body: response.body as ReadableStream<Uint8Array>,
        sizeBytes: Number.isSafeInteger(length) && length >= 0 ? length : null,
        contentType: response.headers.get('Content-Type'),
      };
    },

    async trash(credentials: ProviderCredentials, externalItemId: string): Promise<void> {
      const response = await graph(credentials, itemPath(externalItemId), { method: 'DELETE' });
      await discard(response);
      if (!response.ok) {
        throw errorForResponse(response, clock());
      }
    },

    async restore(
      credentials: ProviderCredentials,
      externalItemId: string,
    ): Promise<ProviderRestoreResult> {
      const response = await graph(credentials, `${itemPath(externalItemId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      await discard(response);
      if (response.ok) {
        return 'restored';
      }
      if (response.status === 400 || response.status === 404 || response.status === 410) {
        return 'not_recoverable';
      }
      throw errorForResponse(response, clock());
    },
  };
}
