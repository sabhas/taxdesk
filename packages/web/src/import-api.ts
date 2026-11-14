import {
  ImportBatchListSchema,
  ImportBatchSchema,
  ImportReconciliationSchema,
  ImportRowListSchema,
  ImportDecisionResultSchema,
  ImportTemplateListSchema,
  type ImportBatch,
  type ImportBatchList,
  type ImportDecision,
  type ImportReconciliation,
  type ImportRow,
  type ImportRowAction,
  type ImportRowList,
  type ImportTemplateId,
  type ImportTemplateList,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/**
 * Data import clients (Epic 7). The browser reads the chosen CSV as text and
 * sends it to the API; the API keeps only the checksum and row plan, so the
 * same file is sent again to revalidate or commit.
 */

function read(signal: AbortSignal | undefined) {
  return { sessionScoped: true, ...(signal === undefined ? {} : { signal }) } as const;
}

export async function listImportTemplates(signal?: AbortSignal): Promise<ImportTemplateList> {
  return await apiRequest('/api/v1/imports/templates', ImportTemplateListSchema, read(signal));
}

/** Same-origin template download; the API rechecks the permission. */
export function importTemplateUrl(id: ImportTemplateId): string {
  return `/api/v1/imports/templates/${encodeURIComponent(id)}/csv`;
}

export function importRowsCsvUrl(batchId: string, scope: 'exceptions' | 'all'): string {
  return `/api/v1/imports/${encodeURIComponent(batchId)}/rows.csv?scope=${scope}`;
}

export async function listImportBatches(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ImportBatchList> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return await apiRequest(`/api/v1/imports${query}`, ImportBatchListSchema, read(signal));
}

export async function getImportBatch(id: string, signal?: AbortSignal): Promise<ImportBatch> {
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(id)}`,
    ImportBatchSchema,
    read(signal),
  );
}

export async function listImportRows(
  id: string,
  filter: { action?: ImportRowAction | undefined; cursor?: string | null },
  signal?: AbortSignal,
): Promise<ImportRowList> {
  const parameters = new URLSearchParams();
  if (filter.action !== undefined) parameters.set('action', filter.action);
  if (filter.cursor != null) parameters.set('cursor', filter.cursor);
  const query = parameters.toString();
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(id)}/rows${query.length === 0 ? '' : `?${query}`}`,
    ImportRowListSchema,
    read(signal),
  );
}

export async function startDryRun(input: {
  template: ImportTemplateId;
  fileName: string;
  content: string;
}): Promise<ImportBatch> {
  return await apiRequest('/api/v1/imports', ImportBatchSchema, {
    method: 'POST',
    body: input,
    sessionScoped: true,
  });
}

export async function revalidateImport(batch: ImportBatch, content: string): Promise<ImportBatch> {
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(batch.id)}/revalidate`,
    ImportBatchSchema,
    { method: 'POST', body: { content }, ifMatch: batch.version, sessionScoped: true },
  );
}

export async function discardImport(batch: ImportBatch): Promise<ImportBatch> {
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(batch.id)}/discard`,
    ImportBatchSchema,
    { method: 'POST', ifMatch: batch.version, sessionScoped: true },
  );
}

/** One key per commit attempt, reused on every retry so the server resumes it. */
export async function commitImport(
  batch: ImportBatch,
  content: string,
  idempotencyKey: string,
): Promise<ImportBatch> {
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(batch.id)}/commit`,
    ImportBatchSchema,
    {
      method: 'POST',
      body: { content },
      ifMatch: batch.version,
      idempotencyKey,
      sessionScoped: true,
    },
  );
}

export async function decideImportRow(
  batch: ImportBatch,
  rowNumber: number,
  decision: ImportDecision,
  reason: string,
): Promise<{ batch: ImportBatch; row: ImportRow }> {
  return await apiRequest(
    `/api/v1/imports/${encodeURIComponent(batch.id)}/rows/${String(rowNumber)}/decision`,
    ImportDecisionResultSchema,
    {
      method: 'POST',
      body: { decision, reason },
      ifMatch: batch.version,
      sessionScoped: true,
    },
  );
}

export async function getImportReconciliation(signal?: AbortSignal): Promise<ImportReconciliation> {
  return await apiRequest(
    '/api/v1/imports/reconciliation?sample=10',
    ImportReconciliationSchema,
    read(signal),
  );
}

/**
 * Files chosen in this tab, by batch ID, so the batch page can revalidate or
 * commit without asking for the file again. Memory only: never persisted.
 */
const chosenFiles = new Map<string, string>();

export function rememberImportFile(batchId: string, content: string): void {
  chosenFiles.set(batchId, content);
}

export function rememberedImportFile(batchId: string): string | null {
  return chosenFiles.get(batchId) ?? null;
}

export function forgetImportFile(batchId: string): void {
  chosenFiles.delete(batchId);
}
