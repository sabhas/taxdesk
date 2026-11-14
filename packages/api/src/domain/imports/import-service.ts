import {
  AUDIT_ACTIONS,
  IMPORT_LIMITS,
  IMPORT_TEMPLATES,
  calendarDateIn,
  formatImportBatchCode,
  importReasonMessage,
  importTemplate,
  newUuidV7,
  templateCsv,
  type ImportBatch,
  type ImportBatchList,
  type ImportBatchListQuery,
  type ImportDecisionRequest,
  type ImportDryRunRequest,
  type ImportReasonCode,
  type ImportReconciliation,
  type ImportReconciliationQuery,
  type ImportRow,
  type ImportRowList,
  type ImportRowListQuery,
  type ImportTemplateId,
  type ImportTemplateList,
} from '@taxdesk/shared';
import type { IdentifierProtector } from '../../crypto/identifier-protection.js';
import { base64UrlToBytes, bytesToBase64Url } from '../../crypto/encoding.js';
import { sha256Hex } from '../../crypto/token.js';
import {
  DuplicateClientIdentifierError,
  DuplicateImportLineageError,
  DuplicateImportSourceError,
  type Repositories,
  type UnitOfWork,
} from '../../repositories/ports.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError, forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { personLookup, type Person } from '../people.js';
import { buildCsv } from '../reports/csv.js';
import { ImportRowConflictError, executeRow } from './executor.js';
import {
  ResolveContext,
  parseImportFile,
  resolveRow,
  validateRows,
  type ResolvedRow,
  type ValidatedRow,
} from './planner.js';
import {
  effectiveAction,
  planCounts,
  type ImportBatchChanges,
  type ImportBatchListCursor,
  type ImportBatchRecord,
  type ImportEntityRef,
  type ImportRowRecord,
} from './types.js';

export interface ImportServiceDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly identifiers: IdentifierProtector | null;
  readonly clock: () => Date;
}

const ENTITY_TYPE = 'import_batch';
const DEFAULT_TIMEZONE = 'Asia/Karachi';

export interface CommitResult {
  readonly batch: ImportBatch;
  /** `true` when an earlier commit with the same key already finished. */
  readonly replayed: boolean;
}

export interface ImportCsvExport {
  readonly fileName: string;
  readonly csv: string;
  readonly rows: number;
}

function notFound(): AuthError {
  return new AuthError(404, 'IMPORT_NOT_FOUND', 'The requested import batch was not found.');
}

function stale(): AuthError {
  return new AuthError(
    412,
    'PRECONDITION_FAILED',
    'This import batch changed since you loaded it. Refresh and try again.',
  );
}

function sourceMismatch(): AuthError {
  return new AuthError(
    409,
    'IMPORT_SOURCE_MISMATCH',
    'The file does not match the file this batch was validated with. Choose the same file.',
  );
}

function encodeCursor(cursor: ImportBatchListCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([cursor.createdAt, cursor.id])));
}

function decodeCursor(value: string): ImportBatchListCursor {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/u.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Fall through to the validation error.
  }
  throw new AuthError(400, 'VALIDATION_FAILED', 'The page cursor is not valid.', {
    errors: [{ field: 'cursor', message: 'The page cursor is not valid.' }],
  });
}

function decodeRowCursor(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d{1,6}$/u.test(value)) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'The page cursor is not valid.', {
      errors: [{ field: 'cursor', message: 'The page cursor is not valid.' }],
    });
  }
  return Number(value);
}

function sameEntity(left: ImportEntityRef | null, right: ImportEntityRef | null): boolean {
  return (left?.entityId ?? null) === (right?.entityId ?? null);
}

/**
 * CSV data import (TD-701–TD-706). The file is never stored: a dry run keeps
 * the checksum and each row's plan, and revalidate/commit require the same
 * file again. Commit runs in bounded transactions of
 * `IMPORT_LIMITS.commitChunkRows` rows; each chunk locks the batch, re-plans
 * its rows against the current data, writes records with their audit events,
 * and records each row's outcome and lineage in the same transaction, so a
 * retry with the same `Idempotency-Key` resumes without duplicating anything.
 */
export class ImportService {
  constructor(private readonly dependencies: ImportServiceDependencies) {}

  private get repositories(): Repositories {
    return this.dependencies.repositories;
  }

  private now(): Date {
    return this.dependencies.clock();
  }

  private requireManage(actor: Actor): void {
    if (!hasPermission(actor, 'imports.manage')) {
      throw forbidden();
    }
  }

  private async firmToday(): Promise<string> {
    const firm = await this.repositories.firm.get();
    return calendarDateIn(firm?.timezone ?? DEFAULT_TIMEZONE, this.now());
  }

  // -------------------------------------------------------------------------
  // Templates (TD-701)
  // -------------------------------------------------------------------------

  listTemplates(actor: Actor): ImportTemplateList {
    this.requireManage(actor);
    return {
      templates: IMPORT_TEMPLATES.map((template) => ({
        id: template.id as ImportTemplateId,
        kind: template.kind,
        version: template.version,
        title: template.title,
        description: template.description,
        columns: template.columns.map((column) => ({ ...column })),
      })),
      limits: { maxFileBytes: IMPORT_LIMITS.maxFileBytes, maxRows: IMPORT_LIMITS.maxRows },
    };
  }

  templateFile(actor: Actor, id: ImportTemplateId): ImportCsvExport {
    this.requireManage(actor);
    const template = importTemplate(id);
    return {
      fileName: `taxdesk-${template.kind.replaceAll('_', '-')}-v${String(template.version)}.csv`,
      csv: templateCsv(template),
      rows: template.examples.length,
    };
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private async toBatch(
    record: ImportBatchRecord,
    lookup: (id: string | null) => Promise<Person | null>,
  ): Promise<ImportBatch> {
    const totals = await this.repositories.imports.rowTotals(record.id);
    const accountedRows = totals.created + totals.updated + totals.skipped + totals.failed;
    const opening = record.kind === 'opening_balances';
    const sourceAmountMinor = opening ? (record.sourceAmountMinor ?? 0) : null;
    const amountsBalance =
      !opening || sourceAmountMinor === totals.createdAmountMinor + totals.skippedAmountMinor;
    return {
      id: record.id,
      batchCode: record.batchCode,
      template: record.templateId,
      kind: record.kind,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      sourceChecksum: record.sourceChecksum,
      rowCount: record.rowCount,
      status: record.status,
      plan: { ...record.plan },
      outcomes: {
        created: totals.created,
        updated: totals.updated,
        skipped: totals.skipped,
        failed: totals.failed,
        pending: totals.pending,
      },
      reconciliation: {
        sourceRows: record.rowCount,
        accountedRows,
        sourceAmountMinor,
        importedAmountMinor: opening ? totals.createdAmountMinor : null,
        skippedAmountMinor: opening ? totals.skippedAmountMinor : null,
        balanced:
          record.status === 'committed' &&
          totals.failed === 0 &&
          totals.pending === 0 &&
          accountedRows === record.rowCount &&
          amountsBalance,
      },
      canCommit: record.status === 'validated' || record.status === 'committing',
      createdBy: await lookup(record.createdBy),
      createdAt: record.createdAt,
      validatedAt: record.validatedAt,
      commitStartedAt: record.commitStartedAt,
      committedAt: record.committedAt,
      committedBy: await lookup(record.committedBy),
      discardedAt: record.discardedAt,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  private async toRow(
    row: ImportRowRecord,
    lookup: (id: string | null) => Promise<Person | null>,
  ): Promise<ImportRow> {
    return {
      rowNumber: row.rowNumber,
      externalRef: row.externalRef,
      action: row.action,
      reason: row.reasonCode,
      reasonMessage: row.reasonCode === null ? null : importReasonMessage(row.reasonCode),
      errors: row.errors.map((error) => ({ ...error })),
      match: row.match === null ? null : { ...row.match },
      amountMinor: row.amountMinor,
      decision:
        row.decision === null
          ? null
          : {
              decision: row.decision.decision,
              reason: row.decision.reason,
              decidedBy: await lookup(row.decision.decidedBy),
              decidedAt: row.decision.decidedAt,
            },
      outcome: row.outcome,
      outcomeReason: row.outcomeCode,
      record: row.entity === null ? null : { ...row.entity },
      committedAt: row.committedAt,
      version: row.version,
    };
  }

  private async view(record: ImportBatchRecord): Promise<ImportBatch> {
    return await this.toBatch(record, personLookup(this.repositories.users));
  }

  private async requireBatch(id: string): Promise<ImportBatchRecord> {
    const batch = await this.repositories.imports.findBatch(id);
    if (batch === null) throw notFound();
    return batch;
  }

  async getBatch(actor: Actor, id: string): Promise<ImportBatch> {
    this.requireManage(actor);
    return await this.view(await this.requireBatch(id));
  }

  async listBatches(actor: Actor, query: ImportBatchListQuery): Promise<ImportBatchList> {
    this.requireManage(actor);
    const page = await this.repositories.imports.listBatches({
      limit: query.limit,
      after: query.cursor === undefined ? null : decodeCursor(query.cursor),
    });
    const lookup = personLookup(this.repositories.users);
    const batches: ImportBatch[] = [];
    for (const record of page.batches) {
      batches.push(await this.toBatch(record, lookup));
    }
    const last = page.batches.at(-1);
    return {
      batches,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async listRows(actor: Actor, id: string, query: ImportRowListQuery): Promise<ImportRowList> {
    this.requireManage(actor);
    await this.requireBatch(id);
    const page = await this.repositories.imports.listRows({
      batchId: id,
      action: query.action ?? null,
      outcome: query.outcome ?? null,
      afterRowNumber: decodeRowCursor(query.cursor),
      limit: query.limit,
    });
    const lookup = personLookup(this.repositories.users);
    const rows: ImportRow[] = [];
    for (const row of page.rows) {
      rows.push(await this.toRow(row, lookup));
    }
    const last = page.rows.at(-1);
    return {
      rows,
      nextCursor: page.hasMore && last !== undefined ? String(last.rowNumber) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Dry run (TD-702)
  // -------------------------------------------------------------------------

  private async plan(
    templateId: ImportTemplateId,
    content: string,
    repositories: Repositories,
  ): Promise<{ validated: ValidatedRow[]; resolved: ResolvedRow[]; today: string }> {
    const file = parseImportFile(templateId, content);
    const today = await this.firmToday();
    const validated = validateRows(file, today);
    const context = new ResolveContext(repositories, this.dependencies.identifiers, today);
    const resolved: ResolvedRow[] = [];
    for (const row of validated) {
      resolved.push(await resolveRow(row, context));
    }
    return { validated, resolved, today };
  }

  async dryRun(input: {
    readonly actor: Actor;
    readonly request: ImportDryRunRequest;
    readonly requestId: string;
  }): Promise<ImportBatch> {
    const { actor, request } = input;
    this.requireManage(actor);
    const sizeBytes = new TextEncoder().encode(request.content).length;
    const checksum = await sha256Hex(request.content);
    const existing = await this.repositories.imports.findOpenBySourceChecksum(checksum);
    if (existing !== null) {
      throw duplicateSource(existing);
    }
    const template = importTemplate(request.template);
    const { resolved } = await this.plan(request.template, request.content, this.repositories);
    const plans = resolved.map((row) => row.plan);
    const plan = planCounts(plans.map((row) => ({ action: row.action, decision: null })));
    const now = this.now();
    const at = now.toISOString();
    const record = await this.dependencies.unitOfWork
      .run(async (repositories) => {
        const batch: ImportBatchRecord = {
          id: newUuidV7(now.getTime()),
          batchCode: formatImportBatchCode(await repositories.imports.nextBatchNumber()),
          kind: template.kind,
          templateId: request.template,
          fileName: request.fileName,
          sizeBytes,
          rowCount: plans.length,
          sourceChecksum: checksum,
          status: plan.error > 0 || plan.review > 0 ? 'blocked' : 'validated',
          plan,
          sourceAmountMinor:
            template.kind === 'opening_balances'
              ? plans.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0)
              : null,
          validatedAt: at,
          commitIdempotencyKey: null,
          commitStartedAt: null,
          commitStartedBy: null,
          committedAt: null,
          committedBy: null,
          discardedAt: null,
          discardedBy: null,
          createdBy: actor.userId,
          createdAt: at,
          updatedAt: at,
          version: 1,
        };
        await repositories.imports.createBatch(batch, plans);
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.importValidated,
          entityType: ENTITY_TYPE,
          entityId: batch.id,
          requestId: input.requestId,
          metadata: {
            batchCode: batch.batchCode,
            template: batch.templateId,
            rowCount: batch.rowCount,
            sizeBytes,
            ...plan,
          },
        });
        return batch;
      })
      .catch(async (error: unknown) => {
        if (error instanceof DuplicateImportSourceError) {
          const open = await this.repositories.imports.findOpenBySourceChecksum(checksum);
          throw open === null
            ? new AuthError(409, 'IMPORT_DUPLICATE_SOURCE', 'This file is already being imported.')
            : duplicateSource(open);
        }
        throw error;
      });
    return await this.view(record);
  }

  private async recount(
    repositories: Repositories,
    batch: ImportBatchRecord,
    overrides: Partial<ImportBatchChanges>,
    at: string,
  ): Promise<ImportBatchRecord> {
    const rows = await repositories.imports.allRows(batch.id);
    const plan = planCounts(rows);
    const updated = await repositories.imports.updateBatch({
      id: batch.id,
      changes: {
        ...changesOf(batch),
        plan,
        status: plan.error > 0 || plan.review > 0 ? 'blocked' : 'validated',
        sourceAmountMinor:
          batch.kind === 'opening_balances'
            ? rows.reduce((sum, row) => sum + (row.amountMinor ?? 0), 0)
            : null,
        ...overrides,
      },
      expectedVersion: batch.version,
      at,
    });
    if (updated === null) throw stale();
    return updated;
  }

  private assertEditable(batch: ImportBatchRecord): void {
    if (batch.status !== 'validated' && batch.status !== 'blocked') {
      throw new AuthError(
        409,
        'IMPORT_NOT_EDITABLE',
        batch.status === 'discarded'
          ? 'This import batch was discarded.'
          : 'This import batch is committing or committed and can no longer change.',
      );
    }
  }

  /** Re-plans a batch against current data with the same file (e.g. after adding a service). */
  async revalidate(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly content: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<ImportBatch> {
    this.requireManage(input.actor);
    const batch = await this.requireBatch(input.id);
    this.assertEditable(batch);
    if (batch.version !== input.expectedVersion) throw stale();
    if ((await sha256Hex(input.content)) !== batch.sourceChecksum) throw sourceMismatch();
    const { resolved } = await this.plan(batch.templateId, input.content, this.repositories);
    const now = this.now();
    const at = now.toISOString();
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const locked = await repositories.imports.lockBatch(batch.id);
      if (locked === null) throw notFound();
      this.assertEditable(locked);
      if (locked.version !== input.expectedVersion) throw stale();
      await repositories.imports.replanRows(
        batch.id,
        resolved.map((row) => row.plan),
        at,
      );
      const next = await this.recount(repositories, locked, { validatedAt: at }, at);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importRevalidated,
        entityType: ENTITY_TYPE,
        entityId: batch.id,
        requestId: input.requestId,
        metadata: { batchCode: batch.batchCode, ...next.plan },
      });
      return next;
    });
    return await this.view(updated);
  }

  // -------------------------------------------------------------------------
  // Review decisions (TD-704)
  // -------------------------------------------------------------------------

  async decideRow(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly rowNumber: number;
    readonly request: ImportDecisionRequest;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<{ batch: ImportBatch; row: ImportRow }> {
    this.requireManage(input.actor);
    const now = this.now();
    const at = now.toISOString();
    const result = await this.dependencies.unitOfWork.run(async (repositories) => {
      const batch = await repositories.imports.lockBatch(input.id);
      if (batch === null) throw notFound();
      this.assertEditable(batch);
      if (batch.version !== input.expectedVersion) throw stale();
      const row = await repositories.imports.findRow(batch.id, input.rowNumber);
      if (row === null) {
        throw new AuthError(404, 'IMPORT_ROW_NOT_FOUND', 'The requested import row was not found.');
      }
      if (row.action !== 'review') {
        throw new AuthError(
          409,
          'IMPORT_ROW_NOT_REVIEWABLE',
          'Only a possible duplicate needs a decision. Fix errors in the file instead.',
        );
      }
      const decided = await repositories.imports.decideRow({
        batchId: batch.id,
        rowNumber: row.rowNumber,
        decision: {
          decision: input.request.decision,
          reason: input.request.reason,
          decidedBy: input.actor.userId,
          decidedAt: at,
        },
        expectedVersion: row.version,
        at,
      });
      if (decided === null) throw stale();
      const next = await this.recount(repositories, batch, {}, at);
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importRowDecided,
        entityType: ENTITY_TYPE,
        entityId: batch.id,
        requestId: input.requestId,
        metadata: {
          batchCode: batch.batchCode,
          rowNumber: row.rowNumber,
          decision: input.request.decision,
          reason: input.request.reason,
          matchedRecord: row.match?.code ?? null,
        },
      });
      return { batch: next, row: decided };
    });
    const lookup = personLookup(this.repositories.users);
    return {
      batch: await this.toBatch(result.batch, lookup),
      row: await this.toRow(result.row, lookup),
    };
  }

  async discard(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<ImportBatch> {
    this.requireManage(input.actor);
    const now = this.now();
    const at = now.toISOString();
    const updated = await this.dependencies.unitOfWork.run(async (repositories) => {
      const batch = await repositories.imports.lockBatch(input.id);
      if (batch === null) throw notFound();
      this.assertEditable(batch);
      if (batch.version !== input.expectedVersion) throw stale();
      const next = await repositories.imports.updateBatch({
        id: batch.id,
        changes: {
          ...changesOf(batch),
          status: 'discarded',
          discardedAt: at,
          discardedBy: input.actor.userId,
        },
        expectedVersion: batch.version,
        at,
      });
      if (next === null) throw stale();
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importDiscarded,
        entityType: ENTITY_TYPE,
        entityId: batch.id,
        requestId: input.requestId,
        metadata: { batchCode: batch.batchCode },
      });
      return next;
    });
    return await this.view(updated);
  }

  // -------------------------------------------------------------------------
  // Commit (TD-703)
  // -------------------------------------------------------------------------

  async commit(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly content: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<CommitResult> {
    const { actor } = input;
    this.requireManage(actor);
    const batch = await this.requireBatch(input.id);
    if ((await sha256Hex(input.content)) !== batch.sourceChecksum) throw sourceMismatch();
    if (batch.status === 'committed') {
      if (batch.commitIdempotencyKey === input.idempotencyKey) {
        return { batch: await this.view(batch), replayed: true };
      }
      throw new AuthError(
        409,
        'IMPORT_ALREADY_COMMITTED',
        `Import batch ${batch.batchCode} is already committed. Nothing was imported again.`,
      );
    }
    if (batch.status === 'committing' && batch.commitIdempotencyKey !== input.idempotencyKey) {
      throw new AuthError(
        409,
        'IMPORT_COMMIT_IN_PROGRESS',
        `Import batch ${batch.batchCode} is being committed by another request. Retry that request to resume it.`,
      );
    }
    if (batch.status === 'blocked' || batch.status === 'discarded') {
      throw new AuthError(
        409,
        'IMPORT_NOT_COMMITTABLE',
        batch.status === 'discarded'
          ? 'This import batch was discarded.'
          : 'Fix every row error and decide every possible duplicate before committing.',
      );
    }

    const file = parseImportFile(batch.templateId, input.content);
    const today = await this.firmToday();
    const validated = validateRows(file, today);
    const byRow = new Map(validated.map((row) => [row.rowNumber, row]));

    if (batch.status === 'validated') {
      if (batch.version !== input.expectedVersion) throw stale();
      await this.assertPlanCurrent(batch, validated, today);
      await this.startCommit(input, batch);
    }

    // Bounded transactions: each chunk is atomic and resumable.
    for (;;) {
      const done = await this.dependencies.unitOfWork
        .run(async (repositories) => await this.commitChunk(input, repositories, byRow, today))
        .catch((error: unknown) => {
          if (
            error instanceof DuplicateImportLineageError ||
            error instanceof DuplicateClientIdentifierError
          ) {
            throw new AuthError(
              409,
              'IMPORT_STALE',
              'Another change touched the same records during the commit. Retry with the same request to resume.',
            );
          }
          throw error;
        });
      if (done) break;
    }
    return { batch: await this.view(await this.requireBatch(batch.id)), replayed: false };
  }

  /** Refuses to start when re-planning now gives a different plan than the dry run. */
  private async assertPlanCurrent(
    batch: ImportBatchRecord,
    validated: readonly ValidatedRow[],
    today: string,
  ): Promise<void> {
    const rows = await this.repositories.imports.allRows(batch.id);
    const context = new ResolveContext(this.repositories, this.dependencies.identifiers, today);
    const stored = new Map(rows.map((row) => [row.rowNumber, row]));
    let changed = validated.length !== rows.length;
    for (const row of validated) {
      if (changed) break;
      const plan = (await resolveRow(row, context)).plan;
      const previous = stored.get(row.rowNumber);
      changed =
        previous?.action !== plan.action ||
        previous.reasonCode !== plan.reasonCode ||
        !sameEntity(previous.match, plan.match);
    }
    if (changed) {
      throw new AuthError(
        409,
        'IMPORT_STALE',
        'Records changed since the dry run. Revalidate the batch and review the new plan before committing.',
      );
    }
  }

  private async startCommit(
    input: {
      readonly actor: Actor;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly requestId: string;
    },
    batch: ImportBatchRecord,
  ): Promise<void> {
    const now = this.now();
    const at = now.toISOString();
    await this.dependencies.unitOfWork.run(async (repositories) => {
      const locked = await repositories.imports.lockBatch(batch.id);
      if (locked === null) throw notFound();
      if (locked.status === 'committing' && locked.commitIdempotencyKey === input.idempotencyKey) {
        return; // A concurrent retry with the same key started it.
      }
      if (locked.status !== 'validated' || locked.version !== input.expectedVersion) {
        throw stale();
      }
      const next = await repositories.imports.updateBatch({
        id: locked.id,
        changes: {
          ...changesOf(locked),
          status: 'committing',
          commitIdempotencyKey: input.idempotencyKey,
          commitStartedAt: at,
          commitStartedBy: input.actor.userId,
        },
        expectedVersion: locked.version,
        at,
      });
      if (next === null) throw stale();
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importCommitStarted,
        entityType: ENTITY_TYPE,
        entityId: locked.id,
        requestId: input.requestId,
        metadata: { batchCode: locked.batchCode, rowCount: locked.rowCount, ...locked.plan },
      });
    });
  }

  /** Commits the next chunk; `true` once every row has an outcome and the batch is closed. */
  private async commitChunk(
    input: {
      readonly actor: Actor;
      readonly id: string;
      readonly idempotencyKey: string;
      readonly requestId: string;
    },
    repositories: Repositories,
    byRow: ReadonlyMap<number, ValidatedRow>,
    today: string,
  ): Promise<boolean> {
    const batch = await repositories.imports.lockBatch(input.id);
    if (batch === null) throw notFound();
    if (batch.status === 'committed') return true;
    if (batch.status !== 'committing' || batch.commitIdempotencyKey !== input.idempotencyKey) {
      throw new AuthError(
        409,
        'IMPORT_COMMIT_IN_PROGRESS',
        'This import batch is not being committed with this request.',
      );
    }
    const now = this.now();
    const at = now.toISOString();
    const pending = await repositories.imports.pendingRows(batch.id, IMPORT_LIMITS.commitChunkRows);
    if (pending.length === 0) {
      const totals = await repositories.imports.rowTotals(batch.id);
      const next = await repositories.imports.updateBatch({
        id: batch.id,
        changes: {
          ...changesOf(batch),
          status: 'committed',
          committedAt: at,
          committedBy: input.actor.userId,
        },
        expectedVersion: batch.version,
        at,
      });
      if (next === null) throw stale();
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importCommitted,
        entityType: ENTITY_TYPE,
        entityId: batch.id,
        requestId: input.requestId,
        metadata: {
          batchCode: batch.batchCode,
          template: batch.templateId,
          sourceRows: batch.rowCount,
          created: totals.created,
          updated: totals.updated,
          skipped: totals.skipped,
          failed: totals.failed,
          sourceAmountMinor: batch.sourceAmountMinor,
          importedAmountMinor: batch.kind === 'opening_balances' ? totals.createdAmountMinor : null,
        },
      });
      return true;
    }

    const context = new ResolveContext(repositories, this.dependencies.identifiers, today);
    for (const row of pending) {
      const validated = byRow.get(row.rowNumber);
      const outcome =
        validated === undefined
          ? failed('CHANGED_SINCE_VALIDATION')
          : await this.commitRow(row, await resolveRow(validated, context), {
              repositories,
              actorUserId: input.actor.userId,
              requestId: input.requestId,
              now,
              batchCode: batch.batchCode,
              rowNumber: row.rowNumber,
              identifierKeyVersion: this.dependencies.identifiers?.keyVersion ?? null,
            });
      await repositories.imports.recordOutcome({
        batchId: batch.id,
        rowNumber: row.rowNumber,
        ...outcome,
        at,
      });
    }
    return false;
  }

  private async commitRow(
    row: ImportRowRecord,
    resolved: ResolvedRow,
    context: Parameters<typeof executeRow>[1],
  ): Promise<RowOutcome> {
    const action = effectiveAction(row);
    const current = resolved.plan;
    if (action === 'skip') {
      if (row.decision !== null) {
        return { outcome: 'skipped', outcomeCode: 'DECIDED_SKIP', entity: null };
      }
      // A link (existing client/case, earlier import) keeps its lineage.
      return {
        outcome: 'skipped',
        outcomeCode: row.reasonCode,
        entity: current.action === 'skip' && current.match !== null ? current.match : row.match,
      };
    }
    let execution = null;
    if (action === 'create' && (current.action === 'create' || current.action === 'review')) {
      // Similarity warnings were reviewed in the dry run; only exact
      // conflicts (identifier, earlier import, open case) stop a create now.
      execution = resolved.execution ?? resolved.reviewExecution;
    } else if (action === 'update' && current.action === 'update') {
      execution = resolved.execution;
    } else if (
      action === 'update' &&
      current.action === 'skip' &&
      current.reasonCode === 'ALREADY_IMPORTED'
    ) {
      return { outcome: 'skipped', outcomeCode: 'ALREADY_IMPORTED', entity: current.match };
    }
    if (execution === null) {
      return failed('CHANGED_SINCE_VALIDATION');
    }
    try {
      const entity = await executeRow(execution, context);
      return {
        outcome: action === 'update' ? 'updated' : 'created',
        outcomeCode: row.decision === null ? null : 'DECIDED_CREATE',
        entity,
      };
    } catch (error) {
      if (error instanceof ImportRowConflictError) {
        // Throwing rolls back the whole chunk; the retry re-plans the row.
        throw new AuthError(
          409,
          'IMPORT_STALE',
          'A record changed during the commit. Retry with the same request to resume.',
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Exports (TD-704, TD-705)
  // -------------------------------------------------------------------------

  /**
   * Row errors, skips, decisions, and outcomes as CSV. Only row numbers,
   * external references (a restricted character set), codes, fixed messages,
   * record codes, and decision reasons appear: never a cell value.
   */
  async exportRows(input: {
    readonly actor: Actor;
    readonly id: string;
    readonly scope: 'exceptions' | 'all';
    readonly requestId: string;
  }): Promise<ImportCsvExport> {
    this.requireManage(input.actor);
    const batch = await this.requireBatch(input.id);
    const rows = await this.repositories.imports.allRows(batch.id);
    const lookup = personLookup(this.repositories.users);
    const lines: (string | number | null)[][] = [];
    for (const row of rows) {
      const exceptional =
        row.action === 'error' ||
        row.action === 'review' ||
        row.action === 'skip' ||
        row.outcome === 'skipped' ||
        row.outcome === 'failed';
      if (input.scope === 'exceptions' && !exceptional) continue;
      const decidedBy = row.decision === null ? null : await lookup(row.decision.decidedBy);
      const common = (
        error: { column: string; code: ImportReasonCode; message: string } | null,
      ) => [
        row.rowNumber,
        row.externalRef,
        row.action,
        row.reasonCode,
        row.reasonCode === null ? null : importReasonMessage(row.reasonCode),
        error?.column ?? null,
        error?.code ?? null,
        error?.message ?? null,
        row.match?.code ?? null,
        row.decision?.decision ?? null,
        row.decision?.reason ?? null,
        decidedBy?.displayName ?? null,
        row.outcome,
        row.outcomeCode,
        row.entity?.entityType ?? null,
        row.entity?.entityId ?? null,
        row.entity?.code ?? null,
      ];
      if (row.errors.length === 0) {
        lines.push(common(null));
      } else {
        for (const error of row.errors) lines.push(common(error));
      }
    }
    const csv = buildCsv(
      [
        'row_number',
        'external_ref',
        'planned_action',
        'reason_code',
        'reason',
        'column',
        'error_code',
        'error',
        'matched_record',
        'decision',
        'decision_reason',
        'decided_by',
        'outcome',
        'outcome_code',
        'record_type',
        'record_id',
        'record_code',
      ],
      lines,
    );
    await this.dependencies.unitOfWork.run(async (repositories) => {
      await appendAuditEvent(repositories.audit, this.now(), {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.importExceptionsExported,
        entityType: ENTITY_TYPE,
        entityId: batch.id,
        requestId: input.requestId,
        metadata: { batchCode: batch.batchCode, scope: input.scope, rows: lines.length },
      });
    });
    return {
      fileName: `${batch.batchCode.toLowerCase()}-${input.scope === 'all' ? 'lineage' : 'exceptions'}.csv`,
      csv,
      rows: lines.length,
    };
  }

  // -------------------------------------------------------------------------
  // Migration reconciliation (TD-706)
  // -------------------------------------------------------------------------

  async reconciliation(
    actor: Actor,
    query: ImportReconciliationQuery,
  ): Promise<ImportReconciliation> {
    this.requireManage(actor);
    const totals = await this.repositories.imports.reconciliationTotals();
    const samples =
      query.sample === 0 ? [] : await this.repositories.imports.sampleLineage(query.sample);
    return {
      generatedAt: this.now().toISOString(),
      clients: {
        total: totals.clientsTotal,
        active: totals.clientsActive,
        imported: totals.clientsImported,
      },
      cases: {
        active: totals.casesActive,
        imported: totals.casesImported,
        importedStillActive: totals.casesImportedStillActive,
      },
      openingBalances: {
        invoices: totals.openingInvoices,
        totalMinor: totals.openingTotalMinor,
        outstandingMinor: totals.openingOutstandingMinor,
      },
      batches: { committed: totals.committedBatches, failedRows: totals.failedRows },
      samples: samples.map((sample) => ({
        kind: sample.kind,
        batchCode: sample.batchCode,
        rowNumber: sample.rowNumber,
        externalRef: sample.externalRef,
        entityType: sample.entity.entityType,
        entityId: sample.entity.entityId,
        code: sample.entity.code,
      })),
    };
  }
}

interface RowOutcome {
  readonly outcome: 'created' | 'updated' | 'skipped' | 'failed';
  readonly outcomeCode: ImportReasonCode | null;
  readonly entity: ImportEntityRef | null;
}

function failed(code: ImportReasonCode): RowOutcome {
  return { outcome: 'failed', outcomeCode: code, entity: null };
}

function duplicateSource(existing: ImportBatchRecord): AuthError {
  return new AuthError(
    409,
    'IMPORT_DUPLICATE_SOURCE',
    `This file is already in import batch ${existing.batchCode} (${existing.status}). Open that batch, or discard it to upload the file again.`,
  );
}

function changesOf(batch: ImportBatchRecord): ImportBatchChanges {
  return {
    status: batch.status,
    plan: batch.plan,
    sourceAmountMinor: batch.sourceAmountMinor,
    validatedAt: batch.validatedAt,
    commitIdempotencyKey: batch.commitIdempotencyKey,
    commitStartedAt: batch.commitStartedAt,
    commitStartedBy: batch.commitStartedBy,
    committedAt: batch.committedAt,
    committedBy: batch.committedBy,
    discardedAt: batch.discardedAt,
    discardedBy: batch.discardedBy,
  };
}
