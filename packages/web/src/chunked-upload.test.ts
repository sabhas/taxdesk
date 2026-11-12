import { describe, expect, it } from 'vitest';
import type { Document, UploadCreateRequest, UploadSession } from '@taxdesk/shared';
import { ApiError } from './api-client.js';
import {
  ChunkedUpload,
  UploadInterruptedError,
  chunkRange,
  isRetryableUploadError,
  type UploadProgress,
} from './chunked-upload.js';
import type { UploadTransport } from './document-api.js';

const UPLOAD_ID = '0198a000-0000-7000-8000-0000000000b1';
const DOCUMENT_ID = '0198a000-0000-7000-8000-0000000000d1';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const CHUNK = 4;

const request: UploadCreateRequest = {
  clientId: CLIENT_ID,
  caseId: null,
  checklistItemId: null,
  documentType: 'Bank statement',
  fileName: 'statement.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
};

const document = { id: DOCUMENT_ID, fileName: 'statement.pdf' } as unknown as Document;

function file(size = 10): Blob {
  return new Blob([new Uint8Array(size).fill(1)]);
}

interface FakeServer {
  readonly transport: UploadTransport;
  readonly puts: { offset: number; size: number }[];
  readonly createRequestIds: string[];
  completeCalls: number;
  cancelCalls: number;
  getCalls: number;
  /** Bytes the server holds. */
  serverOffset: number;
  failPut: ((offset: number, call: number) => ApiError | 'hang' | null) | null;
  failComplete: ((call: number) => ApiError | null) | null;
  failCreate: ((call: number) => ApiError | null) | null;
}

function fakeServer(size = 10): FakeServer {
  const session = (): UploadSession => ({
    id: UPLOAD_ID,
    documentId: DOCUMENT_ID,
    state: 'active',
    fileName: 'statement.pdf',
    sizeBytes: size,
    nextOffset: server.serverOffset,
    chunkBytes: CHUNK,
    expiresAt: '2026-06-02T00:00:00.000Z',
  });
  let putCall = 0;
  let createCall = 0;
  const server: FakeServer = {
    puts: [],
    createRequestIds: [],
    completeCalls: 0,
    cancelCalls: 0,
    getCalls: 0,
    serverOffset: 0,
    failPut: null,
    failComplete: null,
    failCreate: null,
    transport: {
      createUpload(_request, requestId) {
        createCall += 1;
        server.createRequestIds.push(requestId);
        const failure = server.failCreate?.(createCall) ?? null;
        return failure === null ? Promise.resolve(session()) : Promise.reject(failure);
      },
      getUpload() {
        server.getCalls += 1;
        return Promise.resolve(session());
      },
      putChunk(_id, offset, chunk, signal) {
        putCall += 1;
        const failure = server.failPut?.(offset, putCall) ?? null;
        if (failure === 'hang') {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'aborted' }));
            });
          });
        }
        if (failure !== null) return Promise.reject(failure);
        server.puts.push({ offset, size: chunk.size });
        if (offset !== server.serverOffset) {
          return Promise.reject(
            new ApiError({ status: 409, code: 'UPLOAD_OFFSET_MISMATCH', message: 'offset' }),
          );
        }
        server.serverOffset = offset + chunk.size;
        return Promise.resolve({
          nextOffset: server.serverOffset,
          complete: server.serverOffset >= size,
        });
      },
      complete() {
        server.completeCalls += 1;
        const failure = server.failComplete?.(server.completeCalls) ?? null;
        return failure === null ? Promise.resolve(document) : Promise.reject(failure);
      },
      cancel() {
        server.cancelCalls += 1;
        return Promise.resolve();
      },
    },
  };
  return server;
}

const network = () => new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline' });
const noSleep = () => Promise.resolve();

describe('chunkRange', () => {
  it('cuts full chunks and a short final chunk', () => {
    expect(chunkRange(0, 4, 10)).toEqual({ start: 0, end: 4 });
    expect(chunkRange(8, 4, 10)).toEqual({ start: 8, end: 10 });
    expect(chunkRange(5 * 1024 * 1024, 5 * 1024 * 1024, 12 * 1024 * 1024)).toEqual({
      start: 5 * 1024 * 1024,
      end: 10 * 1024 * 1024,
    });
  });
});

describe('isRetryableUploadError', () => {
  it('retries transient failures but not storage that needs an administrator', () => {
    expect(isRetryableUploadError(network())).toBe(true);
    expect(
      isRetryableUploadError(
        new ApiError({ status: 503, code: 'STORAGE_UNAVAILABLE', message: '' }),
      ),
    ).toBe(true);
    expect(
      isRetryableUploadError(new ApiError({ status: 429, code: 'TOO_MANY', message: '' })),
    ).toBe(true);
    expect(
      isRetryableUploadError(
        new ApiError({ status: 503, code: 'STORAGE_RECONNECT_REQUIRED', message: '' }),
      ),
    ).toBe(false);
    expect(
      isRetryableUploadError(new ApiError({ status: 400, code: 'VALIDATION_FAILED', message: '' })),
    ).toBe(false);
    expect(isRetryableUploadError(new Error('x'))).toBe(false);
  });
});

describe('ChunkedUpload', () => {
  it('uploads in chunk-sized parts, reports progress, and completes once', async () => {
    const server = fakeServer();
    const progress: UploadProgress[] = [];
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      onProgress: (entry) => progress.push(entry),
      sleep: noSleep,
    });
    await expect(upload.start()).resolves.toBe(document);
    expect(server.puts).toEqual([
      { offset: 0, size: 4 },
      { offset: 4, size: 4 },
      { offset: 8, size: 2 },
    ]);
    expect(server.completeCalls).toBe(1);
    expect(progress.map((entry) => entry.uploadedBytes)).toContain(8);
    expect(upload.progress).toMatchObject({ phase: 'done', uploadedBytes: 10, totalBytes: 10 });
    // A second start after success is a no-op.
    await expect(upload.start()).resolves.toBe(document);
    expect(server.completeCalls).toBe(1);
  });

  it('retries a failed chunk with exponential backoff', async () => {
    const server = fakeServer();
    server.failPut = (_offset, call) => (call === 2 || call === 3 ? network() : null);
    const delays: number[] = [];
    const phases: string[] = [];
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      baseDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      onProgress: (entry) => phases.push(entry.phase),
    });
    await upload.start();
    expect(delays).toEqual([100, 200]);
    expect(phases).toContain('retrying');
    expect(server.puts.map((put) => put.offset)).toEqual([0, 4, 8]);
  });

  it('gives up after the maximum retries and can be retried later', async () => {
    const server = fakeServer();
    let failing = true;
    server.failPut = () =>
      failing ? new ApiError({ status: 503, code: 'STORAGE_UNAVAILABLE', message: 'down' }) : null;
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: noSleep,
      maxRetries: 3,
    });
    await expect(upload.start()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(upload.progress.phase).toBe('failed');

    failing = false;
    await expect(upload.start()).resolves.toBe(document);
    // Resuming re-reads the session instead of creating a new upload.
    expect(server.createRequestIds).toHaveLength(1);
    expect(server.getCalls).toBe(1);
  });

  it('stops immediately when storage needs an administrator', async () => {
    const server = fakeServer();
    server.failPut = () =>
      new ApiError({ status: 503, code: 'STORAGE_RECONNECT_REQUIRED', message: 'reconnect' });
    const delays: number[] = [];
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await expect(upload.start()).rejects.toMatchObject({ code: 'STORAGE_RECONNECT_REQUIRED' });
    expect(delays).toEqual([]);
  });

  it('resumes from the server offset after a 409 instead of resending bytes', async () => {
    const server = fakeServer();
    // The first chunk reached the provider but its response was lost.
    server.failPut = (_offset, call) => {
      if (call === 1) {
        server.serverOffset = 8;
        return network();
      }
      return null;
    };
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: noSleep,
    });
    await upload.start();
    // Retry at 0 → 409 → re-sync to 8 → final chunk only.
    expect(server.puts).toEqual([
      { offset: 0, size: 4 },
      { offset: 8, size: 2 },
    ]);
    expect(server.getCalls).toBe(1);
    expect(server.completeCalls).toBe(1);
  });

  it('pauses by aborting the in-flight chunk and resumes later', async () => {
    const server = fakeServer();
    let hang = true;
    server.failPut = (offset) => (hang && offset === 4 ? 'hang' : null);
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: noSleep,
    });
    const running = upload.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    upload.pause();
    await expect(running).rejects.toBeInstanceOf(UploadInterruptedError);
    expect(upload.progress.phase).toBe('paused');

    hang = false;
    await expect(upload.start()).resolves.toBe(document);
    expect(server.puts.map((put) => put.offset)).toEqual([0, 4, 8]);
  });

  it('cancels the server-side upload', async () => {
    const server = fakeServer();
    server.failPut = (offset) => (offset === 4 ? 'hang' : null);
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: noSleep,
    });
    const running = upload.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await upload.cancel();
    await expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    expect(server.cancelCalls).toBe(1);
    expect(upload.progress.phase).toBe('cancelled');
    await expect(upload.start()).rejects.toBeInstanceOf(UploadInterruptedError);
  });

  it('retries completion safely and reuses one request ID for creation', async () => {
    const server = fakeServer();
    server.failCreate = (call) => (call === 1 ? network() : null);
    server.failComplete = (call) => (call === 1 ? network() : null);
    const upload = new ChunkedUpload(file(), request, {
      transport: server.transport,
      sleep: noSleep,
      requestId: 'stable-request',
    });
    await expect(upload.start()).resolves.toBe(document);
    expect(server.createRequestIds).toEqual(['stable-request', 'stable-request']);
    expect(server.completeCalls).toBe(2);
  });
});
