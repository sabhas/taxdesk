import { Hono, type Context } from 'hono';
import { type z } from 'zod';
import {
  DOCUMENT_LIMITS,
  DocumentListQuerySchema,
  DocumentListSchema,
  DocumentReviewRequestSchema,
  DocumentSchema,
  DocumentUpdateRequestSchema,
  ReconciliationRunListSchema,
  ReconciliationRunSchema,
  UploadChunkResponseSchema,
  UploadCreateRequestSchema,
  UploadSessionSchema,
  UuidSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

/**
 * Document, upload, and reconciliation routes (TD-405–TD-410). Routes parse
 * and map only; every authorization and storage rule lives in
 * `DocumentService`. Bytes are proxied through the Worker: the browser never
 * talks to the storage provider directly.
 */
export const documentRoutes = new Hono<AppEnv>();

const read = () => protect({ access: 'any_permission', permissions: ['documents.read'] });
const write = () => protect({ access: 'permission', permission: 'documents.manage' });
const administer = () => protect({ access: 'permission', permission: 'storage.manage' });

function idParam(c: Context<AppEnv>, name: 'documentId' | 'uploadId'): string {
  const value = c.req.param(name) ?? '';
  if (!UuidSchema.safeParse(value).success) {
    throw name === 'documentId'
      ? new AuthError(404, 'DOCUMENT_NOT_FOUND', 'The requested document was not found.')
      : new AuthError(404, 'UPLOAD_NOT_FOUND', 'The upload was not found.');
  }
  return value;
}

function parseQuery<T>(c: Context<AppEnv>, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the document filters.', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? 'query' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function chunkOffset(c: Context<AppEnv>): number {
  const raw = c.req.query('offset') ?? '';
  const offset = /^\d{1,15}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(offset)) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Send the chunk offset as ?offset=<bytes>.', {
      errors: [{ field: 'offset', message: 'Send a whole-number byte offset.' }],
    });
  }
  return offset;
}

async function chunkBody(c: Context<AppEnv>): Promise<Uint8Array> {
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > DOCUMENT_LIMITS.chunkBytes) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'The chunk is larger than 5 MiB.', {
      errors: [{ field: 'body', message: 'The chunk is larger than 5 MiB.' }],
    });
  }
  // A chunked request carries no Content-Length, so bound the bytes actually read too.
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > DOCUMENT_LIMITS.chunkBytes) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'The chunk is larger than 5 MiB.', {
      errors: [{ field: 'body', message: 'The chunk is larger than 5 MiB.' }],
    });
  }
  return bytes;
}

/** RFC 6266 `Content-Disposition` with an ASCII fallback and a UTF-8 name. */
function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
}

// ---------------------------------------------------------------------------
// Uploads (TD-406)
// ---------------------------------------------------------------------------

documentRoutes.post('/documents/uploads', write(), async (c) => {
  const request = await parseJsonBody(c, UploadCreateRequestSchema);
  const { upload, created } = await c.get('dependencies').documentService.createUpload({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  noStore(c);
  return c.json(UploadSessionSchema.parse(upload), created ? 201 : 200);
});

documentRoutes.get('/documents/uploads/:uploadId', write(), async (c) => {
  const upload = await c
    .get('dependencies')
    .documentService.getUpload(c.get('actor'), idParam(c, 'uploadId'));
  noStore(c);
  return c.json(UploadSessionSchema.parse(upload));
});

documentRoutes.put('/documents/uploads/:uploadId/content', write(), async (c) => {
  const uploadId = idParam(c, 'uploadId');
  const offset = chunkOffset(c);
  const bytes = await chunkBody(c);
  const result = await c.get('dependencies').documentService.uploadChunk({
    actor: c.get('actor'),
    uploadId,
    offset,
    bytes,
    requestId: c.get('requestId'),
  });
  noStore(c);
  return c.json(UploadChunkResponseSchema.parse(result));
});

documentRoutes.post('/documents/uploads/:uploadId/complete', write(), async (c) => {
  const { document, created } = await c.get('dependencies').documentService.completeUpload({
    actor: c.get('actor'),
    uploadId: idParam(c, 'uploadId'),
    requestId: c.get('requestId'),
  });
  setEtag(c, document.version);
  noStore(c);
  return c.json(DocumentSchema.parse(document), created ? 201 : 200);
});

documentRoutes.delete('/documents/uploads/:uploadId', write(), async (c) => {
  await c.get('dependencies').documentService.cancelUpload({
    actor: c.get('actor'),
    uploadId: idParam(c, 'uploadId'),
    requestId: c.get('requestId'),
  });
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Documents (TD-407, TD-408, TD-409)
// ---------------------------------------------------------------------------

documentRoutes.get('/documents', read(), async (c) => {
  const query = parseQuery(c, DocumentListQuerySchema);
  const list = await c.get('dependencies').documentService.listDocuments(c.get('actor'), query);
  noStore(c);
  return c.json(DocumentListSchema.parse(list));
});

documentRoutes.get('/documents/:documentId', read(), async (c) => {
  const found = await c
    .get('dependencies')
    .documentService.getDocument(c.get('actor'), idParam(c, 'documentId'));
  setEtag(c, found.version);
  noStore(c);
  return c.json(DocumentSchema.parse(found));
});

/** Streams the file. Access is re-checked and audited on every request. */
documentRoutes.get('/documents/:documentId/content', read(), async (c) => {
  const { document, download } = await c.get('dependencies').documentService.openDocument({
    actor: c.get('actor'),
    id: idParam(c, 'documentId'),
    requestId: c.get('requestId'),
  });
  c.header('Content-Type', document.contentType);
  c.header('Content-Disposition', attachmentDisposition(document.fileName));
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', 'sandbox');
  if (download.sizeBytes !== null) {
    c.header('Content-Length', String(download.sizeBytes));
  }
  return c.body(download.body, 200);
});

documentRoutes.patch('/documents/:documentId', write(), async (c) => {
  const id = idParam(c, 'documentId');
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, DocumentUpdateRequestSchema);
  const updated = await c.get('dependencies').documentService.updateDocument({
    actor: c.get('actor'),
    id,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, updated.version);
  return c.json(DocumentSchema.parse(updated));
});

documentRoutes.post('/documents/:documentId/review', write(), async (c) => {
  const id = idParam(c, 'documentId');
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, DocumentReviewRequestSchema);
  const reviewed = await c.get('dependencies').documentService.reviewDocument({
    actor: c.get('actor'),
    id,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, reviewed.version);
  return c.json(DocumentSchema.parse(reviewed));
});

documentRoutes.delete('/documents/:documentId', write(), async (c) => {
  const id = idParam(c, 'documentId');
  const expectedVersion = requireIfMatch(c);
  const deleted = await c.get('dependencies').documentService.deleteDocument({
    actor: c.get('actor'),
    id,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, deleted.version);
  return c.json(DocumentSchema.parse(deleted));
});

documentRoutes.post('/documents/:documentId/restore', write(), async (c) => {
  const id = idParam(c, 'documentId');
  const expectedVersion = requireIfMatch(c);
  const restored = await c.get('dependencies').documentService.restoreDocument({
    actor: c.get('actor'),
    id,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, restored.version);
  return c.json(DocumentSchema.parse(restored));
});

// ---------------------------------------------------------------------------
// Reconciliation (TD-410)
// ---------------------------------------------------------------------------

documentRoutes.get('/storage/reconciliation', administer(), async (c) => {
  const runs = await c.get('dependencies').documentService.listReconciliationRuns();
  noStore(c);
  return c.json(ReconciliationRunListSchema.parse({ runs }));
});

documentRoutes.post('/storage/reconciliation', administer(), async (c) => {
  const run = await c.get('dependencies').documentService.runReconciliation({
    actor: c.get('actor'),
    requestId: c.get('requestId'),
  });
  return c.json(ReconciliationRunSchema.parse(run), 201);
});
