import type { Document, UploadCreateRequest, UploadSession } from '@taxdesk/shared';
import { ApiError, newRequestId } from './api-client.js';
import type { UploadTransport } from './document-api.js';

/**
 * Resumable, chunked document upload (TD-406). The browser sends each chunk
 * to the TaxDesk API, which forwards it to the storage provider's upload
 * session; the browser never talks to the provider.
 *
 * - Chunks are `session.chunkBytes` (5 MiB) except the last one.
 * - A failed chunk is retried with exponential backoff (default 3 retries)
 *   when the failure is transient (network, 429, 5xx except storage needing
 *   an administrator).
 * - A 409 offset mismatch re-reads the session and resumes from the server's
 *   `nextOffset`, so an interrupted upload never resends confirmed bytes.
 * - `pause()` aborts the in-flight request; `start()` again resumes.
 * - `cancel()` aborts and deletes the server-side upload.
 * - Completion is idempotent on the server, so it is retried like a chunk.
 */

export type UploadPhase =
  | 'idle'
  | 'starting'
  | 'uploading'
  | 'retrying'
  | 'completing'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface UploadProgress {
  readonly phase: UploadPhase;
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  /** Retry attempt for the current step (0 when the last request succeeded). */
  readonly attempt: number;
  readonly error: ApiError | null;
}

export class UploadInterruptedError extends Error {
  readonly reason: 'paused' | 'cancelled';

  constructor(reason: 'paused' | 'cancelled') {
    super(reason === 'paused' ? 'The upload is paused.' : 'The upload was cancelled.');
    this.name = 'UploadInterruptedError';
    this.reason = reason;
  }
}

export interface ChunkedUploadOptions {
  readonly transport: UploadTransport;
  readonly onProgress?: (progress: UploadProgress) => void;
  /** Retries per step after the first attempt. */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  /** Injectable delay for tests. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Stable request ID for creating the upload (idempotent across retries). */
  readonly requestId?: string;
}

/** Storage failures an administrator must fix: retrying will not help. */
const NON_RETRYABLE_CODES = new Set([
  'STORAGE_RECONNECT_REQUIRED',
  'STORAGE_NOT_CONNECTED',
  'STORAGE_NOT_CONFIGURED',
]);

export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  if (NON_RETRYABLE_CODES.has(error.code)) {
    return false;
  }
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

function isOffsetConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'UPLOAD_OFFSET_MISMATCH' || error.code === 'UPLOAD_INCOMPLETE')
  );
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Byte range `[start, end)` of the chunk that begins at `offset`. */
export function chunkRange(
  offset: number,
  chunkBytes: number,
  totalBytes: number,
): { readonly start: number; readonly end: number } {
  return { start: offset, end: Math.min(offset + chunkBytes, totalBytes) };
}

const RESYNCED = Symbol('resynced');

export class ChunkedUpload {
  private readonly file: Blob;
  private readonly request: UploadCreateRequest;
  private readonly transport: UploadTransport;
  private readonly onProgress: ((progress: UploadProgress) => void) | undefined;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly requestId: string;
  private session: UploadSession | null = null;
  private controller: AbortController | null = null;
  private interruption: 'paused' | 'cancelled' | null = null;
  private state: UploadProgress;
  private document: Document | null = null;

  constructor(file: Blob, request: UploadCreateRequest, options: ChunkedUploadOptions) {
    this.file = file;
    this.request = request;
    this.transport = options.transport;
    this.onProgress = options.onProgress;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    this.requestId = options.requestId ?? newRequestId();
    this.state = {
      phase: 'idle',
      uploadedBytes: 0,
      totalBytes: file.size,
      attempt: 0,
      error: null,
    };
  }

  get progress(): UploadProgress {
    return this.state;
  }

  get uploadId(): string | null {
    return this.session?.id ?? null;
  }

  private emit(update: Partial<UploadProgress>): void {
    this.state = { ...this.state, ...update };
    this.onProgress?.(this.state);
  }

  private throwIfInterrupted(): void {
    if (this.interruption !== null) {
      throw new UploadInterruptedError(this.interruption);
    }
  }

  /**
   * Runs one step with retries. `onConflict` handles an offset conflict
   * (re-sync) and then returns `RESYNCED` so the caller restarts from the
   * server's offset instead of resending a stale chunk.
   */
  private async withRetries<T>(signal: AbortSignal, step: () => Promise<T>): Promise<T>;
  private async withRetries<T>(
    signal: AbortSignal,
    step: () => Promise<T>,
    onConflict: () => Promise<void>,
  ): Promise<T | typeof RESYNCED>;
  private async withRetries<T>(
    signal: AbortSignal,
    step: () => Promise<T>,
    onConflict?: () => Promise<void>,
  ): Promise<T | typeof RESYNCED> {
    let attempt = 0;
    for (;;) {
      this.throwIfInterrupted();
      try {
        const result = await step();
        if (attempt > 0) {
          this.emit({ attempt: 0, error: null });
        }
        return result;
      } catch (error) {
        this.throwIfInterrupted();
        const conflict = onConflict !== undefined && isOffsetConflict(error);
        if ((!conflict && !isRetryableUploadError(error)) || attempt >= this.maxRetries) {
          throw error;
        }
        attempt += 1;
        if (conflict) {
          await onConflict();
          return RESYNCED;
        } else {
          this.emit({
            phase: 'retrying',
            attempt,
            error: error instanceof ApiError ? error : null,
          });
          try {
            await this.sleep(this.baseDelayMs * 2 ** (attempt - 1), signal);
          } catch {
            this.throwIfInterrupted();
            throw error;
          }
        }
      }
    }
  }

  private async resync(signal: AbortSignal): Promise<void> {
    const current = this.session;
    if (current === null) {
      return;
    }
    const latest = await this.transport.getUpload(current.id, signal);
    this.session = latest;
    this.emit({ uploadedBytes: latest.nextOffset });
  }

  /** Starts or resumes the upload. Resolves with the created document. */
  async start(): Promise<Document> {
    if (this.document !== null) {
      return this.document;
    }
    if (this.interruption === 'cancelled') {
      throw new UploadInterruptedError('cancelled');
    }
    this.interruption = null;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    try {
      if (this.session === null) {
        this.emit({ phase: 'starting', error: null, attempt: 0 });
        this.session = await this.withRetries(signal, () =>
          this.transport.createUpload(this.request, this.requestId),
        );
      } else {
        // Resume: the server knows how many bytes the provider has.
        await this.withRetries(signal, () => this.resync(signal));
      }
      this.emit({ phase: 'uploading', uploadedBytes: this.session.nextOffset, error: null });

      let finished = this.session.nextOffset >= this.file.size;
      let conflicts = 0;
      while (!finished) {
        const session: UploadSession = this.session;
        const { start, end } = chunkRange(session.nextOffset, session.chunkBytes, this.file.size);
        const response = await this.withRetries(
          signal,
          () => this.transport.putChunk(session.id, start, this.file.slice(start, end), signal),
          () => this.resync(signal),
        );
        if (response === RESYNCED) {
          // A conflict re-synced the offset; loop from the server's position.
          conflicts += 1;
          if (conflicts > this.maxRetries) {
            throw new ApiError({
              status: 409,
              code: 'UPLOAD_OFFSET_MISMATCH',
              message: 'The upload could not stay in step with the server. Try again.',
            });
          }
          finished = this.session.nextOffset >= this.file.size;
          continue;
        }
        conflicts = 0;
        this.session = { ...session, nextOffset: response.nextOffset };
        this.emit({ phase: 'uploading', uploadedBytes: response.nextOffset });
        finished = response.complete || response.nextOffset >= this.file.size;
      }

      this.emit({ phase: 'completing' });
      const uploadId = this.session.id;
      const document = await this.withRetries(signal, () =>
        this.transport.complete(uploadId, signal),
      );
      this.document = document;
      this.emit({ phase: 'done', uploadedBytes: this.file.size, error: null, attempt: 0 });
      return document;
    } catch (error) {
      if (error instanceof UploadInterruptedError) {
        this.emit({ phase: error.reason === 'paused' ? 'paused' : 'cancelled' });
        throw error;
      }
      this.emit({ phase: 'failed', error: error instanceof ApiError ? error : null });
      throw error;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  /** Stops after aborting the in-flight request; call `start()` to resume. */
  pause(): void {
    if (this.interruption === 'cancelled' || this.document !== null) {
      return;
    }
    this.interruption = 'paused';
    this.controller?.abort();
    if (this.controller === null) {
      this.emit({ phase: 'paused' });
    }
  }

  /** Aborts and discards the server-side upload. */
  async cancel(): Promise<void> {
    if (this.document !== null) {
      return;
    }
    this.interruption = 'cancelled';
    this.controller?.abort();
    this.emit({ phase: 'cancelled' });
    if (this.session !== null) {
      await this.transport.cancel(this.session.id);
    }
  }
}
