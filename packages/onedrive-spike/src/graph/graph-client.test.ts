import { describe, expect, it } from 'vitest';
import {
  AppFolderDriveClient,
  GRAPH_API_BASE,
  GraphRequestError,
  contentRangeHeader,
} from './graph-client.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function createFetch(handler: (request: RecordedRequest) => Response): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    return handler(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(handler: (request: RecordedRequest) => Response) {
  const { fetchImpl, requests } = createFetch(handler);
  let accessToken = 'access-token-1';
  const client = new AppFolderDriveClient({ fetchImpl, getAccessToken: () => accessToken });
  return {
    client,
    requests,
    rotateToken: (next: string) => {
      accessToken = next;
    },
  };
}

describe('contentRangeHeader', () => {
  it('describes an inclusive chunk range against the total size', () => {
    expect(contentRangeHeader(0, 5_242_880, 1_310_720)).toBe('bytes 0-1310719/5242880');
    expect(contentRangeHeader(3_932_160, 5_242_880, 1_310_720)).toBe(
      'bytes 3932160-5242879/5242880',
    );
  });
});

describe('AppFolderDriveClient', () => {
  it('uploads a small file with a single authenticated PUT to the app folder', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ id: 'item-1', name: 'small.bin', size: 4 }),
    );

    const item = await client.putFile('small.bin', new Uint8Array([1, 2, 3, 4]));

    expect(item).toEqual({ id: 'item-1', name: 'small.bin', size: 4 });
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url).toBe(`${GRAPH_API_BASE}/me/drive/special/approot:/small.bin:/content`);
    expect(requests[0]?.headers['authorization']).toBe('Bearer access-token-1');
    expect(requests[0]?.headers['content-type']).toBe('application/octet-stream');
  });

  it('reads the access token lazily so a refreshed token is used', async () => {
    const { client, requests, rotateToken } = createClient(() =>
      jsonResponse({ id: 'item-1', name: 'small.bin', size: 0 }),
    );

    await client.putFile('small.bin', new Uint8Array(0));
    rotateToken('access-token-2');
    await client.putFile('small.bin', new Uint8Array(0));

    expect(requests[0]?.headers['authorization']).toBe('Bearer access-token-1');
    expect(requests[1]?.headers['authorization']).toBe('Bearer access-token-2');
  });

  it('reduces a Graph rejection to a status and error code without the provider message', async () => {
    const { client } = createClient(() =>
      jsonResponse(
        {
          error: {
            code: 'InvalidAuthenticationToken',
            message: 'Access token has expired or is not yet valid. Bearer eyJ0eXAiOiJKV1Q',
          },
        },
        401,
      ),
    );

    const error = await client
      .putFile('small.bin', new Uint8Array(1))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphRequestError);
    expect((error as GraphRequestError).httpStatus).toBe(401);
    expect((error as GraphRequestError).code).toBe('InvalidAuthenticationToken');
    expect((error as GraphRequestError).message).not.toContain('eyJ0eXAiOiJKV1Q');
  });

  it('creates a resumable upload session with a replace conflict behaviour', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ uploadUrl: 'https://upload.example.com/session-1' }),
    );

    const uploadUrl = await client.createUploadSession('chunked.bin');

    expect(uploadUrl).toBe('https://upload.example.com/session-1');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      `${GRAPH_API_BASE}/me/drive/special/approot:/chunked.bin:/createUploadSession`,
    );
    expect(requests[0]?.headers['authorization']).toBe('Bearer access-token-1');
    expect(requests[0]?.body).toContain('replace');
  });

  it('uploads a chunk to the pre-authenticated session URL without a bearer token', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ nextExpectedRanges: ['1310720-'] }, 202),
    );

    const result = await client.uploadChunk(
      'https://upload.example.com/session-1',
      new Uint8Array(1_310_720),
      0,
      5_242_880,
    );

    expect(result.item).toBeUndefined();
    expect(result.nextExpectedRanges).toEqual(['1310720-']);
    expect(requests[0]?.url).toBe('https://upload.example.com/session-1');
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.headers['authorization']).toBeUndefined();
    expect(requests[0]?.headers['content-range']).toBe('bytes 0-1310719/5242880');
    expect(requests[0]?.headers['content-length']).toBe('1310720');
  });

  it('returns the drive item when the final chunk completes the session', async () => {
    const { client } = createClient(() =>
      jsonResponse({ id: 'item-9', name: 'chunked.bin', size: 5_242_880 }, 201),
    );

    const result = await client.uploadChunk(
      'https://upload.example.com/session-1',
      new Uint8Array(10),
      5_242_870,
      5_242_880,
    );

    expect(result.item).toEqual({ id: 'item-9', name: 'chunked.bin', size: 5_242_880 });
    expect(result.nextExpectedRanges).toBeUndefined();
  });

  it('reports the ranges an interrupted session still expects', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ nextExpectedRanges: ['1310720-'] }),
    );

    const status = await client.getUploadSessionStatus('https://upload.example.com/session-1');

    expect(status.nextExpectedRanges).toEqual(['1310720-']);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('reads item metadata by app-folder path', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ id: 'item-2', name: 'chunked.bin', size: 12 }),
    );

    const item = await client.getItemByPath('chunked.bin');

    expect(item).toEqual({ id: 'item-2', name: 'chunked.bin', size: 12 });
    expect(requests[0]?.url).toBe(`${GRAPH_API_BASE}/me/drive/special/approot:/chunked.bin`);
  });

  it('downloads item content as bytes', async () => {
    const { client, requests } = createClient(() => new Response(new Uint8Array([7, 8, 9])));

    const content = await client.downloadItem('item-2');

    expect(Array.from(content)).toEqual([7, 8, 9]);
    expect(requests[0]?.url).toBe(`${GRAPH_API_BASE}/me/drive/items/item-2/content`);
    expect(requests[0]?.headers['authorization']).toBe('Bearer access-token-1');
  });

  it('deletes a synthetic test file', async () => {
    const { client, requests } = createClient(() => new Response(null, { status: 204 }));

    await client.deleteItem('item-2');

    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(`${GRAPH_API_BASE}/me/drive/items/item-2`);
  });

  it('probes the application folder rather than the drive resource', async () => {
    const { client, requests } = createClient(() =>
      jsonResponse({ id: 'app-root', name: 'TaxDesk Spike', folder: { childCount: 2 } }),
    );

    await expect(client.getAppRoot()).resolves.toEqual({ isFolder: true, childCount: 2 });
    expect(requests[0]?.url).toBe(`${GRAPH_API_BASE}/me/drive/special/approot`);
    expect(requests[0]?.headers['authorization']).toBe('Bearer access-token-1');
  });

  it('reports an app root that is not a folder', async () => {
    const { client } = createClient(() => jsonResponse({ id: 'app-root', name: 'TaxDesk Spike' }));

    await expect(client.getAppRoot()).resolves.toEqual({ isFolder: false, childCount: undefined });
  });

  it('surfaces the access-denied a drive-scoped request would have caused', async () => {
    const { client } = createClient(() =>
      jsonResponse({ error: { code: 'accessDenied', message: 'Access denied' } }, 403),
    );

    const error = await client.getAppRoot().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphRequestError);
    expect((error as GraphRequestError).httpStatus).toBe(403);
    expect((error as GraphRequestError).code).toBe('accessDenied');
  });

  it('rejects an unexpected app-root payload instead of trusting it', async () => {
    const { client } = createClient(() => jsonResponse({ id: 'app-root' }));

    const error = await client.getAppRoot().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphRequestError);
    expect((error as GraphRequestError).code).toBe('unexpected_app_root_response');
  });
});
