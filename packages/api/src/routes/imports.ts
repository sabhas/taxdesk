import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  IMPORT_LIMITS,
  ImportBatchListQuerySchema,
  ImportBatchListSchema,
  ImportBatchSchema,
  ImportContentRequestSchema,
  ImportDecisionRequestSchema,
  ImportDryRunRequestSchema,
  ImportReconciliationQuerySchema,
  ImportReconciliationSchema,
  ImportRowListQuerySchema,
  ImportRowListSchema,
  ImportDecisionResultSchema,
  ImportTemplateIdSchema,
  ImportTemplateListSchema,
  UuidSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import type { ImportCsvExport } from '../domain/imports/import-service.js';
import { protect } from '../middleware/auth.js';
import {
  parseJsonBody,
  requireIdempotencyKey,
  requireIfMatch,
  setEtag,
} from '../transport/request.js';
import { parseQuery } from './reports.js';

/**
 * CSV import routes (TD-701–TD-706). Administrator-only (`imports.manage`).
 * Routes parse and map; the dry-run, decision, and commit rules live in
 * `ImportService`. A commit needs `If-Match` and an `Idempotency-Key`; a retry
 * with the same key resumes or replays it and never imports a row twice.
 */
export const importRoutes = new Hono<AppEnv>();

const manage = () => protect({ access: 'permission', permission: 'imports.manage' });

/**
 * JSON bodies carry the CSV as text. The limit leaves room for JSON escaping
 * of a file at the size limit; the shared contract enforces the file limit.
 */
const MAX_BODY_BYTES = IMPORT_LIMITS.maxFileBytes * 2 + 16 * 1024;

function rejectOversizedBody(c: Context<AppEnv>): void {
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new AuthError(
      413,
      'IMPORT_FILE_TOO_LARGE',
      `The file is larger than ${String(IMPORT_LIMITS.maxFileBytes / 1024 / 1024)} MiB. Split it into smaller files.`,
    );
  }
}

function batchId(c: Context<AppEnv>): string {
  const value = c.req.param('batchId') ?? '';
  if (!UuidSchema.safeParse(value).success) {
    throw new AuthError(404, 'IMPORT_NOT_FOUND', 'The requested import batch was not found.');
  }
  return value;
}

function rowNumber(c: Context<AppEnv>): number {
  const value = c.req.param('rowNumber') ?? '';
  if (!/^\d{1,6}$/u.test(value) || Number(value) < 2) {
    throw new AuthError(404, 'IMPORT_ROW_NOT_FOUND', 'The requested import row was not found.');
  }
  return Number(value);
}

function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
}

function csvResponse(c: Context<AppEnv>, exported: ImportCsvExport): Response {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${exported.fileName}"`);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Report-Rows', String(exported.rows));
  return c.body(exported.csv);
}

const ExportQuerySchema = z
  .object({ scope: z.enum(['exceptions', 'all']).default('exceptions') })
  .strict();

importRoutes.get('/imports/templates', manage(), (c) => {
  const list = c.get('dependencies').importService.listTemplates(c.get('actor'));
  noStore(c);
  return c.json(ImportTemplateListSchema.parse(list));
});

importRoutes.get('/imports/templates/:templateId/csv', manage(), (c) => {
  const parsed = ImportTemplateIdSchema.safeParse(c.req.param('templateId'));
  if (!parsed.success) {
    throw new AuthError(404, 'IMPORT_NOT_FOUND', 'The requested import template was not found.');
  }
  return csvResponse(
    c,
    c.get('dependencies').importService.templateFile(c.get('actor'), parsed.data),
  );
});

importRoutes.get('/imports/reconciliation', manage(), async (c) => {
  const query = parseQuery(c, ImportReconciliationQuerySchema);
  const result = await c.get('dependencies').importService.reconciliation(c.get('actor'), query);
  noStore(c);
  return c.json(ImportReconciliationSchema.parse(result));
});

importRoutes.post('/imports', manage(), async (c) => {
  rejectOversizedBody(c);
  const request = await parseJsonBody(c, ImportDryRunRequestSchema);
  const batch = await c.get('dependencies').importService.dryRun({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  setEtag(c, batch.version);
  noStore(c);
  return c.json(ImportBatchSchema.parse(batch), 201);
});

importRoutes.get('/imports', manage(), async (c) => {
  const query = parseQuery(c, ImportBatchListQuerySchema);
  const list = await c.get('dependencies').importService.listBatches(c.get('actor'), query);
  noStore(c);
  return c.json(ImportBatchListSchema.parse(list));
});

importRoutes.get('/imports/:batchId', manage(), async (c) => {
  const batch = await c.get('dependencies').importService.getBatch(c.get('actor'), batchId(c));
  setEtag(c, batch.version);
  noStore(c);
  return c.json(ImportBatchSchema.parse(batch));
});

importRoutes.get('/imports/:batchId/rows', manage(), async (c) => {
  const id = batchId(c);
  const query = parseQuery(c, ImportRowListQuerySchema);
  const list = await c.get('dependencies').importService.listRows(c.get('actor'), id, query);
  noStore(c);
  return c.json(ImportRowListSchema.parse(list));
});

importRoutes.get('/imports/:batchId/rows.csv', manage(), async (c) => {
  const id = batchId(c);
  const { scope } = parseQuery(c, ExportQuerySchema);
  return csvResponse(
    c,
    await c.get('dependencies').importService.exportRows({
      actor: c.get('actor'),
      id,
      scope,
      requestId: c.get('requestId'),
    }),
  );
});

importRoutes.post('/imports/:batchId/rows/:rowNumber/decision', manage(), async (c) => {
  const id = batchId(c);
  const row = rowNumber(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, ImportDecisionRequestSchema);
  const result = await c.get('dependencies').importService.decideRow({
    actor: c.get('actor'),
    id,
    rowNumber: row,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, result.batch.version);
  return c.json(ImportDecisionResultSchema.parse(result));
});

importRoutes.post('/imports/:batchId/revalidate', manage(), async (c) => {
  rejectOversizedBody(c);
  const id = batchId(c);
  const expectedVersion = requireIfMatch(c);
  const { content } = await parseJsonBody(c, ImportContentRequestSchema);
  const batch = await c.get('dependencies').importService.revalidate({
    actor: c.get('actor'),
    id,
    content,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, batch.version);
  return c.json(ImportBatchSchema.parse(batch));
});

importRoutes.post('/imports/:batchId/discard', manage(), async (c) => {
  const id = batchId(c);
  const expectedVersion = requireIfMatch(c);
  const batch = await c.get('dependencies').importService.discard({
    actor: c.get('actor'),
    id,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, batch.version);
  return c.json(ImportBatchSchema.parse(batch));
});

importRoutes.post('/imports/:batchId/commit', manage(), async (c) => {
  rejectOversizedBody(c);
  const id = batchId(c);
  const expectedVersion = requireIfMatch(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const { content } = await parseJsonBody(c, ImportContentRequestSchema);
  const result = await c.get('dependencies').importService.commit({
    actor: c.get('actor'),
    id,
    content,
    expectedVersion,
    idempotencyKey,
    requestId: c.get('requestId'),
  });
  setEtag(c, result.batch.version);
  return c.json(ImportBatchSchema.parse(result.batch), 200);
});
