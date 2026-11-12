import {
  DocumentListSchema,
  DocumentSchema,
  UploadChunkResponseSchema,
  UploadSessionSchema,
  type Document,
  type DocumentList,
  type DocumentListState,
  type DocumentReviewRequest,
  type DocumentUpdateRequest,
  type UploadChunkResponse,
  type UploadCreateRequest,
  type UploadSession,
} from '@taxdesk/shared';
import { apiRequest, apiRequestVoid } from './api-client.js';

/**
 * Document and upload clients (Epic 4). The API enforces every rule; these
 * only shape requests. File bytes go to the TaxDesk API only, never to the
 * storage provider directly.
 */

function signalOption(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

export interface DocumentListParams {
  readonly clientId?: string;
  readonly caseId?: string;
  readonly state?: DocumentListState;
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listDocuments(
  params: DocumentListParams,
  signal?: AbortSignal,
): Promise<DocumentList> {
  const query = new URLSearchParams();
  if (params.clientId !== undefined) query.set('clientId', params.clientId);
  if (params.caseId !== undefined) query.set('caseId', params.caseId);
  if (params.state !== undefined) query.set('state', params.state);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor !== undefined) query.set('cursor', params.cursor);
  return await apiRequest(`/api/v1/documents?${query.toString()}`, DocumentListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

function documentPath(id: string, suffix = ''): string {
  return `/api/v1/documents/${encodeURIComponent(id)}${suffix}`;
}

/** Same-origin download URL; the API rechecks access and records the open. */
export function documentContentPath(id: string): string {
  return documentPath(id, '/content');
}

export async function updateDocument(
  id: string,
  request: DocumentUpdateRequest,
  version: number,
): Promise<Document> {
  return await apiRequest(documentPath(id), DocumentSchema, {
    method: 'PATCH',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function reviewDocument(
  id: string,
  request: DocumentReviewRequest,
  version: number,
): Promise<Document> {
  return await apiRequest(documentPath(id, '/review'), DocumentSchema, {
    method: 'POST',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function deleteDocument(id: string, version: number): Promise<Document> {
  return await apiRequest(documentPath(id), DocumentSchema, {
    method: 'DELETE',
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function restoreDocument(id: string, version: number): Promise<Document> {
  return await apiRequest(documentPath(id, '/restore'), DocumentSchema, {
    method: 'POST',
    ifMatch: version,
    sessionScoped: true,
  });
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function uploadPath(id: string, suffix = ''): string {
  return `/api/v1/documents/uploads/${encodeURIComponent(id)}${suffix}`;
}

/** The transport the chunked uploader drives; injectable for tests. */
export interface UploadTransport {
  createUpload(request: UploadCreateRequest, requestId: string): Promise<UploadSession>;
  getUpload(id: string, signal?: AbortSignal): Promise<UploadSession>;
  putChunk(
    id: string,
    offset: number,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<UploadChunkResponse>;
  complete(id: string, signal?: AbortSignal): Promise<Document>;
  cancel(id: string): Promise<void>;
}

export const httpUploadTransport: UploadTransport = {
  async createUpload(request, requestId) {
    return await apiRequest('/api/v1/documents/uploads', UploadSessionSchema, {
      method: 'POST',
      body: request,
      requestId,
      sessionScoped: true,
    });
  },
  async getUpload(id, signal) {
    return await apiRequest(uploadPath(id), UploadSessionSchema, {
      sessionScoped: true,
      ...signalOption(signal),
    });
  },
  async putChunk(id, offset, chunk, signal) {
    return await apiRequest(
      uploadPath(id, `/content?offset=${String(offset)}`),
      UploadChunkResponseSchema,
      { method: 'PUT', rawBody: chunk, sessionScoped: true, ...signalOption(signal) },
    );
  },
  async complete(id, signal) {
    return await apiRequest(uploadPath(id, '/complete'), DocumentSchema, {
      method: 'POST',
      sessionScoped: true,
      ...signalOption(signal),
    });
  },
  async cancel(id) {
    await apiRequestVoid(uploadPath(id), { method: 'DELETE', sessionScoped: true });
  },
};
