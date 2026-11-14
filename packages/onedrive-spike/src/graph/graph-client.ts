import { z } from 'zod';

/**
 * Minimal Microsoft Graph app-folder client for the TD-005 spike.
 *
 * It only touches `/me/drive/special/approot`, which is exactly what the
 * `Files.ReadWrite.AppFolder` delegated scope allows, and it never sends the
 * bearer token to an upload-session URL (those URLs are pre-authenticated).
 */

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Graph documents 4 MiB as the practical ceiling for a single `PUT …/content`
 * request; larger files must use an upload session. Chunk sizes must be a
 * multiple of 320 KiB.
 */
export const GRAPH_SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export const GRAPH_UPLOAD_CHUNK_MULTIPLE_BYTES = 320 * 1024;

const DriveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().min(0),
});

export type DriveItem = z.infer<typeof DriveItemSchema>;

const AppRootSchema = z.object({
  name: z.string().min(1),
  folder: z
    .object({
      childCount: z.number().int().min(0).optional(),
    })
    .optional(),
});

/**
 * Facts about the application's own OneDrive folder. The spike deliberately does
 * not read `/me/drive`: the `Files.ReadWrite.AppFolder` scope does not grant the
 * drive resource (it answers 403 `accessDenied`), only this folder and its
 * children.
 */
export interface AppRootInfo {
  readonly isFolder: boolean;
  readonly childCount: number | undefined;
}

const UploadSessionSchema = z.object({
  uploadUrl: z.url(),
  expirationDateTime: z.string().optional(),
});

const UploadChunkResponseSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  size: z.number().int().min(0).optional(),
  nextExpectedRanges: z.array(z.string().min(1)).optional(),
  expirationDateTime: z.string().optional(),
});

export interface UploadChunkResult {
  readonly nextExpectedRanges: readonly string[] | undefined;
  readonly item: DriveItem | undefined;
}

export interface UploadSessionStatus {
  readonly nextExpectedRanges: readonly string[];
  readonly expirationDateTime: string | undefined;
}

/**
 * A Graph request failure reduced to status and Graph error code. The provider
 * message is deliberately dropped: it can echo request URLs and file paths.
 */
export class GraphRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(`Microsoft Graph request failed with ${code} (HTTP ${String(httpStatus)}).`);
    this.name = 'GraphRequestError';
  }
}

function readJsonBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readGraphErrorCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error;
      if (typeof code === 'string' && code.length > 0 && code.length <= 120) {
        return code;
      }
    }
  }
  return 'unknown_graph_error';
}

/** Returns the inclusive byte range a chunk covers. */
export function contentRangeHeader(
  rangeStart: number,
  totalSize: number,
  chunkSize: number,
): string {
  const rangeEnd = Math.min(rangeStart + chunkSize, totalSize) - 1;
  return `bytes ${String(rangeStart)}-${String(rangeEnd)}/${String(totalSize)}`;
}

export class AppFolderDriveClient {
  constructor(
    private readonly deps: {
      readonly fetchImpl: typeof fetch;
      /** Read lazily so a refreshed access token is used for later requests. */
      readonly getAccessToken: () => string;
    },
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.deps.getAccessToken()}`);
    const response = await this.deps.fetchImpl(`${GRAPH_API_BASE}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const payload = readJsonBody(await response.text());
      throw new GraphRequestError(response.status, readGraphErrorCode(payload));
    }
    return response;
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    return readJsonBody(await response.text());
  }

  /**
   * Resolves the app folder itself. This is the one resource the app-folder
   * scope is guaranteed to reach, so it is both the consent probe and the
   * operation that makes OneDrive provision the folder before any write.
   */
  async getAppRoot(): Promise<AppRootInfo> {
    const parsed = AppRootSchema.safeParse(await this.requestJson('/me/drive/special/approot'));
    if (!parsed.success) {
      throw new GraphRequestError(200, 'unexpected_app_root_response');
    }
    return {
      isFolder: parsed.data.folder !== undefined,
      childCount: parsed.data.folder?.childCount,
    };
  }

  /** Single-request upload for files at or below the simple-upload limit. */
  async putFile(name: string, content: Uint8Array): Promise<DriveItem> {
    const parsed = DriveItemSchema.safeParse(
      await this.requestJson(`/me/drive/special/approot:/${encodeURIComponent(name)}:/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      }),
    );
    if (!parsed.success) {
      throw new GraphRequestError(200, 'unexpected_upload_response');
    }
    return parsed.data;
  }

  /** Creates a resumable upload session and returns its pre-authenticated URL. */
  async createUploadSession(name: string): Promise<string> {
    const parsed = UploadSessionSchema.safeParse(
      await this.requestJson(
        `/me/drive/special/approot:/${encodeURIComponent(name)}:/createUploadSession`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item: { '@microsoft.graph.conflictBehavior': 'replace', name },
          }),
        },
      ),
    );
    if (!parsed.success) {
      throw new GraphRequestError(200, 'unexpected_upload_session_response');
    }
    return parsed.data.uploadUrl;
  }

  /** Reads the ranges a resumed upload session still expects. */
  async getUploadSessionStatus(uploadUrl: string): Promise<UploadSessionStatus> {
    const response = await this.deps.fetchImpl(uploadUrl, { method: 'GET' });
    if (!response.ok) {
      const payload = readJsonBody(await response.text());
      throw new GraphRequestError(response.status, readGraphErrorCode(payload));
    }
    const parsed = UploadChunkResponseSchema.safeParse(readJsonBody(await response.text()));
    if (!parsed.success) {
      throw new GraphRequestError(response.status, 'unexpected_upload_status_response');
    }
    return {
      nextExpectedRanges: parsed.data.nextExpectedRanges ?? [],
      expirationDateTime: parsed.data.expirationDateTime,
    };
  }

  /**
   * Uploads one chunk. The session URL is pre-authenticated, so no bearer token
   * is attached and a captured URL cannot be replayed against another drive.
   */
  async uploadChunk(
    uploadUrl: string,
    chunk: Uint8Array,
    rangeStart: number,
    totalSize: number,
  ): Promise<UploadChunkResult> {
    const response = await this.deps.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.byteLength),
        'Content-Range': contentRangeHeader(rangeStart, totalSize, chunk.byteLength),
      },
      body: chunk,
    });
    const payload = readJsonBody(await response.text());
    if (!response.ok) {
      throw new GraphRequestError(response.status, readGraphErrorCode(payload));
    }
    const parsed = UploadChunkResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new GraphRequestError(response.status, 'unexpected_upload_chunk_response');
    }
    const item = DriveItemSchema.safeParse(parsed.data);
    return {
      nextExpectedRanges: parsed.data.nextExpectedRanges,
      item: item.success ? item.data : undefined,
    };
  }

  async downloadItem(itemId: string): Promise<Uint8Array> {
    const response = await this.request(`/me/drive/items/${encodeURIComponent(itemId)}/content`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Reads a drive item's metadata by app-folder path, without its content. */
  async getItemByPath(name: string): Promise<DriveItem> {
    const parsed = DriveItemSchema.safeParse(
      await this.requestJson(`/me/drive/special/approot:/${encodeURIComponent(name)}`),
    );
    if (!parsed.success) {
      throw new GraphRequestError(200, 'unexpected_drive_item_response');
    }
    return parsed.data;
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.request(`/me/drive/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  }
}
