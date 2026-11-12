import { describe, expect, it } from 'vitest';
import { StorageProviderError, type ProviderCredentials } from '../provider.js';
import {
  GRAPH_API_BASE,
  createOneDriveStorageProvider,
  encodeStoragePath,
  offsetFromRanges,
} from './onedrive-provider.js';
import { oauthEndpoints } from './oauth.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

const ACCESS_TOKEN = 'secret-access-token-abc';
const REFRESH_TOKEN = 'secret-refresh-token-xyz';
const UPLOAD_URL = 'https://api.onedrive.test/up/secret-session-token-123';
const NOW = new Date('2026-11-11T10:00:00.000Z');

const credentials: ProviderCredentials = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  accessTokenExpiresAt: '2026-11-11T11:00:00.000Z',
  scopes: ['Files.ReadWrite.AppFolder'],
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(responders: Responder[], extra: { clientSecret?: string } = {}) {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  const queue = [...responders];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const body =
      init.body === undefined || init.body === null
        ? null
        : typeof init.body === 'string'
          ? init.body
          : `<${String((init.body as Uint8Array).byteLength)} bytes>`;
    const request: RecordedRequest = {
      url: input,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body,
    };
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    }
    return await next(request);
  };
  const provider = createOneDriveStorageProvider({
    clientId: 'client-id-1',
    ...(extra.clientSecret === undefined ? {} : { clientSecret: extra.clientSecret }),
    fetch: fetchImpl,
    clock: () => NOW,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { provider, requests, sleeps };
}

const appRoot = {
  id: 'root-1',
  name: 'TaxDesk',
  parentReference: { driveId: 'drive-1' },
  createdBy: { user: { displayName: 'Firm Owner' } },
};

const driveItem = {
  id: 'item-1',
  name: 'return.pdf',
  size: 10,
  eTag: '"etag-1"',
  parentReference: { driveId: 'drive-1', id: 'folder-1' },
};

async function catchError(promise: Promise<unknown>): Promise<StorageProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the promise to reject.');
}

function assertSafe(error: StorageProviderError): void {
  const text = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, UPLOAD_URL, 'secret-session-token']) {
    expect(text).not.toContain(secret);
  }
}

describe('OneDrive adapter: connection', () => {
  it('builds a PKCE consent URL with the minimal scopes', () => {
    const { provider } = setup([]);
    const { authorizationUrl } = provider.beginConnection({
      state: 'state-1',
      codeChallenge: 'challenge-1',
      redirectUri: 'https://taxdesk.test/settings/storage/callback',
    });
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(oauthEndpoints(undefined).authorize);
    expect(url.pathname).toContain('/consumers/');
    expect(url.searchParams.get('scope')).toBe('Files.ReadWrite.AppFolder offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('exchanges the code and resolves the app folder (never /me/drive)', async () => {
    const { provider, requests } = setup([
      () =>
        json(200, {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3599,
          // Microsoft does not echo offline_access.
          scope: 'Files.ReadWrite.AppFolder',
        }),
      () => json(200, appRoot),
    ]);
    const grant = await provider.completeConnection({
      code: 'code-1',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://taxdesk.test/cb',
    });
    expect(grant.credentials.refreshToken).toBe(REFRESH_TOKEN);
    expect(grant.credentials.accessTokenExpiresAt).toBe('2026-11-11T10:59:59.000Z');
    expect(grant.account).toEqual({
      driveId: 'drive-1',
      rootFolderId: 'root-1',
      accountLabel: 'Firm Owner',
    });
    const tokenBody = new URLSearchParams(requests[0]?.body ?? '');
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code_verifier')).toBe('v'.repeat(43));
    expect(tokenBody.has('client_secret')).toBe(false);
    expect(requests[1]?.url).toBe(`${GRAPH_API_BASE}/me/drive/special/approot`);
    expect(requests.some((request) => request.url.endsWith('/me/drive'))).toBe(false);
  });

  it('sends the client secret only when configured', async () => {
    const { provider, requests } = setup(
      [
        () => json(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
        () => json(200, appRoot),
      ],
      { clientSecret: 'app-secret' },
    );
    await provider.completeConnection({
      code: 'c',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'https://taxdesk.test/cb',
    });
    expect(new URLSearchParams(requests[0]?.body ?? '').get('client_secret')).toBe('app-secret');
  });

  it('rejects a grant without a refresh token', async () => {
    const { provider } = setup([() => json(200, { access_token: 'a', expires_in: 60 })]);
    const error = await catchError(
      provider.completeConnection({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x.test' }),
    );
    expect(error.kind).toBe('rejected');
  });

  it('maps a 403 on the app folder to reconnect_required', async () => {
    const { provider } = setup([
      () => json(200, { access_token: 'a', refresh_token: 'r', expires_in: 60 }),
      () => json(403, { error: { code: 'accessDenied', message: 'path /secret' } }),
    ]);
    const error = await catchError(
      provider.completeConnection({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x.test' }),
    );
    expect(error.kind).toBe('reconnect_required');
    expect(error.message).not.toContain('/secret');
  });

  it('rotates the refresh token and keeps the old one when none is returned', async () => {
    const { provider, requests } = setup([
      () =>
        json(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      () => json(200, { access_token: 'newer-access', expires_in: 3600 }),
    ]);
    const first = await provider.refreshCredentials(credentials);
    expect(first.refreshToken).toBe('new-refresh');
    expect(new URLSearchParams(requests[0]?.body ?? '').get('grant_type')).toBe('refresh_token');
    const second = await provider.refreshCredentials(first);
    expect(second.accessToken).toBe('newer-access');
    expect(second.refreshToken).toBe('new-refresh');
  });

  it.each(['invalid_grant', 'interaction_required', 'consent_required'])(
    'maps %s on refresh to reconnect_required',
    async (code) => {
      const { provider } = setup([
        () => json(400, { error: code, error_description: `AADSTS ${REFRESH_TOKEN}` }),
      ]);
      const error = await catchError(provider.refreshCredentials(credentials));
      expect(error.kind).toBe('reconnect_required');
      assertSafe(error);
    },
  );

  it('maps an invalid client to not_configured and token 5xx to unavailable', async () => {
    const { provider } = setup([
      () => json(401, { error: 'invalid_client' }),
      () => json(503, {}, { 'Retry-After': '30' }),
    ]);
    expect((await catchError(provider.refreshCredentials(credentials))).kind).toBe(
      'not_configured',
    );
    const unavailable = await catchError(provider.refreshCredentials(credentials));
    expect(unavailable.kind).toBe('unavailable');
    expect(unavailable.retryAfterSeconds).toBe(30);
  });

  it('reports health from the app folder', async () => {
    const { provider } = setup([
      () => json(200, appRoot),
      () => json(401, { error: { code: 'InvalidAuthenticationToken' } }),
      () => json(403, { error: { code: 'accessDenied' } }),
    ]);
    expect((await provider.checkHealth(credentials)).kind).toBe('healthy');
    const unauthorized = await provider.checkHealth(credentials);
    expect(unauthorized.kind === 'unhealthy' && unauthorized.error.kind).toBe('unauthorized');
    const revoked = await provider.checkHealth(credentials);
    expect(revoked.kind === 'unhealthy' && revoked.error.kind).toBe('reconnect_required');
  });

  it('maps network failures to unavailable without leaking the URL', async () => {
    const { provider } = setup([
      () => {
        throw new TypeError(`fetch failed: ${UPLOAD_URL}`);
      },
    ]);
    const health = await provider.checkHealth(credentials);
    expect(health.kind === 'unhealthy' && health.error.kind).toBe('unavailable');
    if (health.kind === 'unhealthy') {
      assertSafe(health.error);
    }
  });
});

describe('OneDrive adapter: uploads', () => {
  const path = {
    segments: ['clients', 'CL-00001', '2025', 'case id', 'doc-1'],
    fileName: 'Bank statement #1.pdf',
  };

  it('creates a session under the app folder with conflictBehavior fail', async () => {
    const { provider, requests } = setup([
      () =>
        json(200, {
          uploadUrl: UPLOAD_URL,
          expirationDateTime: '2026-11-12T10:00:00Z',
          nextExpectedRanges: ['0-'],
        }),
    ]);
    const session = await provider.createUploadSession(credentials, { path, sizeBytes: 100 });
    expect(session).toEqual({
      handle: UPLOAD_URL,
      expiresAt: '2026-11-12T10:00:00.000Z',
      nextOffset: 0,
    });
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(
      `${GRAPH_API_BASE}/me/drive/special/approot:/clients/CL-00001/2025/case%20id/doc-1/Bank%20statement%20%231.pdf:/createUploadSession`,
    );
    expect(request?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      item: { '@microsoft.graph.conflictBehavior': 'fail', name: 'Bank statement #1.pdf' },
    });
  });

  it('retries once after lazy app-folder provisioning (404)', async () => {
    const { provider, requests, sleeps } = setup([
      () => json(404, { error: { code: 'itemNotFound' } }),
      () => json(200, { uploadUrl: UPLOAD_URL }),
    ]);
    const session = await provider.createUploadSession(credentials, { path, sizeBytes: 100 });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1500]);
    expect(session.expiresAt).toBe('2026-11-11T11:00:00.000Z');
  });

  it('gives up after one provisioning retry', async () => {
    const { provider } = setup([
      () => json(404, { error: { code: 'itemNotFound' } }),
      () => json(404, { error: { code: 'itemNotFound' } }),
    ]);
    expect(
      (await catchError(provider.createUploadSession(credentials, { path, sizeBytes: 1 }))).kind,
    ).toBe('not_found');
  });

  it('rejects unsafe path segments before calling Graph', () => {
    expect(() => encodeStoragePath({ segments: ['a', '..'], fileName: 'x.pdf' })).toThrow(
      StorageProviderError,
    );
    expect(() => encodeStoragePath({ segments: ['a/b'], fileName: 'x.pdf' })).toThrow(
      StorageProviderError,
    );
  });

  it('sends chunks without the bearer token and reports partial progress', async () => {
    const { provider, requests } = setup([() => json(202, { nextExpectedRanges: ['5242880-'] })]);
    const result = await provider.uploadChunk({
      session: { handle: UPLOAD_URL, expiresAt: '2026-11-12T00:00:00Z', nextOffset: 0 },
      offset: 0,
      totalSize: 6_000_000,
      bytes: new Uint8Array(5_242_880),
    });
    expect(result).toEqual({ kind: 'partial', nextOffset: 5_242_880 });
    const request = requests[0];
    expect(request?.url).toBe(UPLOAD_URL);
    expect(request?.method).toBe('PUT');
    expect(request?.headers.has('Authorization')).toBe(false);
    expect(request?.headers.get('Content-Range')).toBe('bytes 0-5242879/6000000');
  });

  it('returns the item when the final chunk completes', async () => {
    const { provider } = setup([() => json(201, driveItem)]);
    const result = await provider.uploadChunk({
      session: { handle: UPLOAD_URL, expiresAt: '2026-11-12T00:00:00Z', nextOffset: 0 },
      offset: 0,
      totalSize: 10,
      bytes: new Uint8Array(10),
    });
    expect(result).toEqual({
      kind: 'complete',
      item: {
        externalItemId: 'item-1',
        driveId: 'drive-1',
        parentId: 'folder-1',
        name: 'return.pdf',
        sizeBytes: 10,
        etag: '"etag-1"',
        trashed: false,
      },
    });
  });

  it('maps a range mismatch to conflict with the expected offset', async () => {
    const { provider, requests } = setup([
      () => json(416, { error: { code: 'invalidRange' } }),
      () => json(200, { nextExpectedRanges: ['1310720-'] }),
    ]);
    const error = await catchError(
      provider.uploadChunk({
        session: { handle: UPLOAD_URL, expiresAt: '2026-11-12T00:00:00Z', nextOffset: 0 },
        offset: 0,
        totalSize: 5_242_880,
        bytes: new Uint8Array(10),
      }),
    );
    expect(error.kind).toBe('conflict');
    expect(error.expectedOffset).toBe(1_310_720);
    expect(requests[1]?.method).toBe('GET');
    assertSafe(error);
  });

  it('maps an expired session to not_found without leaking its URL', async () => {
    const { provider } = setup([
      () => json(404, { error: { code: 'itemNotFound', message: UPLOAD_URL } }),
    ]);
    const error = await catchError(
      provider.uploadChunk({
        session: { handle: UPLOAD_URL, expiresAt: '2026-11-12T00:00:00Z', nextOffset: 0 },
        offset: 0,
        totalSize: 10,
        bytes: new Uint8Array(10),
      }),
    );
    expect(error.kind).toBe('not_found');
    assertSafe(error);
  });

  it('reads and cancels a session', async () => {
    const { provider, requests } = setup([
      () =>
        json(200, { nextExpectedRanges: ['2048-'], expirationDateTime: '2026-11-13T00:00:00Z' }),
      () => new Response(null, { status: 204 }),
      () => json(404, {}),
    ]);
    const session = { handle: UPLOAD_URL, expiresAt: '2026-11-12T00:00:00.000Z', nextOffset: 0 };
    expect(await provider.getUploadSession(session)).toEqual({
      handle: UPLOAD_URL,
      expiresAt: '2026-11-13T00:00:00.000Z',
      nextOffset: 2048,
    });
    await provider.cancelUploadSession(session);
    await provider.cancelUploadSession(session);
    expect(requests.map((request) => request.method)).toEqual(['GET', 'DELETE', 'DELETE']);
    expect(requests.every((request) => !request.headers.has('Authorization'))).toBe(true);
  });

  it('maps throttling to rate_limited with Retry-After', async () => {
    const { provider } = setup([() => json(429, {}, { 'Retry-After': '12' })]);
    const error = await catchError(
      provider.createUploadSession(credentials, { path, sizeBytes: 10 }),
    );
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(12);
  });
});

describe('OneDrive adapter: items', () => {
  it('reads metadata, treating 404 as gone and probing the app root on 403', async () => {
    const { provider, requests } = setup([
      () => json(200, driveItem),
      () => json(200, { ...driveItem, deleted: { state: 'deleted' } }),
      () => json(404, { error: { code: 'itemNotFound' } }),
      // Item 403 while the app root still answers: only this item is out of reach.
      () => json(403, { error: { code: 'accessDenied' } }),
      () => json(200, appRoot),
      // Item 403 and app root 403: the grant itself is gone.
      () => json(403, { error: { code: 'accessDenied' } }),
      () => json(403, { error: { code: 'accessDenied' } }),
      () => json(503, {}),
    ]);
    expect((await provider.getItem(credentials, 'item-1'))?.parentId).toBe('folder-1');
    expect((await provider.getItem(credentials, 'item-1'))?.trashed).toBe(true);
    expect(await provider.getItem(credentials, 'item-1')).toBeNull();
    expect(await provider.getItem(credentials, 'item-1')).toBeNull();
    expect(requests[4]?.url).toBe(`${GRAPH_API_BASE}/me/drive/special/approot`);
    expect((await catchError(provider.getItem(credentials, 'item-1'))).kind).toBe(
      'reconnect_required',
    );
    expect((await catchError(provider.getItem(credentials, 'item-1'))).kind).toBe('unavailable');
    expect(requests[0]?.url).toContain('/me/drive/items/item-1?$select=');
  });

  it('downloads via the redirect without forwarding the token', async () => {
    const { provider, requests } = setup([
      () =>
        new Response(null, { status: 302, headers: { Location: 'https://dl.onedrive.test/x' } }),
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Length': '3' },
        }),
    ]);
    const download = await provider.download(credentials, 'item-1');
    const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(download.sizeBytes).toBe(3);
    expect(requests[0]?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(requests[1]?.url).toBe('https://dl.onedrive.test/x');
    expect(requests[1]?.headers.has('Authorization')).toBe(false);
  });

  it('streams a direct download and maps a missing item', async () => {
    const { provider } = setup([
      () => new Response(new Uint8Array([9]), { status: 200 }),
      () => json(404, {}),
    ]);
    const download = await provider.download(credentials, 'item-1');
    expect([...new Uint8Array(await new Response(download.body).arrayBuffer())]).toEqual([9]);
    expect((await catchError(provider.download(credentials, 'item-1'))).kind).toBe('not_found');
  });

  it('trashes and restores items', async () => {
    const { provider, requests } = setup([
      () => new Response(null, { status: 204 }),
      () => json(404, {}),
      () => json(200, driveItem),
      () => json(404, {}),
      () => json(400, {}),
      () => json(500, {}),
    ]);
    await provider.trash(credentials, 'item-1');
    expect((await catchError(provider.trash(credentials, 'item-1'))).kind).toBe('not_found');
    expect(await provider.restore(credentials, 'item-1')).toBe('restored');
    expect(await provider.restore(credentials, 'item-1')).toBe('not_recoverable');
    expect(await provider.restore(credentials, 'item-1')).toBe('not_recoverable');
    expect((await catchError(provider.restore(credentials, 'item-1'))).kind).toBe('unavailable');
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[2]?.url).toBe(`${GRAPH_API_BASE}/me/drive/items/item-1/restore`);
  });

  it('never puts tokens or provider text into errors', async () => {
    const leaky = { error: { code: 'generalException', message: `${ACCESS_TOKEN} ${UPLOAD_URL}` } };
    const { provider } = setup([
      () => json(500, leaky),
      () => json(400, leaky),
      () => json(401, leaky),
    ]);
    for (let index = 0; index < 3; index += 1) {
      assertSafe(await catchError(provider.trash(credentials, 'item-1')));
    }
  });
});

describe('offsetFromRanges', () => {
  it('parses open and closed ranges', () => {
    expect(offsetFromRanges(['100-'])).toBe(100);
    expect(offsetFromRanges(['0-99', '200-'])).toBe(0);
    expect(offsetFromRanges([])).toBeUndefined();
    expect(offsetFromRanges(undefined)).toBeUndefined();
  });
});
