import type {
  ImportBatchStatus,
  ImportCellError,
  ImportDecision,
  ImportKind,
  ImportReasonCode,
  ImportRowAction,
  ImportRowOutcome,
  ImportTemplateId,
} from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
import type {
  ImportBatchRecord,
  ImportEntityRef,
  ImportEntityType,
  ImportRowRecord,
} from '../domain/imports/types.js';
import {
  DuplicateImportLineageError,
  DuplicateImportSourceError,
  type ImportRepository,
} from './ports.js';

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected a string column "${key}".`);
  }
  return value;
}

function nullableText(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected a nullable string column "${key}".`);
  }
  return value;
}

/** Integer and bigint columns; bigint arrives as a string and must stay a safe integer. */
function integer(row: SqlRow, key: string): number {
  const value = row[key];
  let result: number;
  if (typeof value === 'number') {
    result = value;
  } else if (typeof value === 'bigint') {
    result = Number(value);
  } else if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    result = Number(value);
  } else {
    throw new Error(`Expected an integer column "${key}".`);
  }
  if (!Number.isSafeInteger(result)) {
    throw new Error(`The integer column "${key}" exceeds the safe integer range.`);
  }
  return result;
}

function nullableInteger(row: SqlRow, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : integer(row, key);
}

function iso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  throw new Error('Expected a timestamp column.');
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function json(row: SqlRow, key: string): unknown {
  const value = row[key];
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505' &&
    String((error as { constraint_name?: unknown }).constraint_name) === constraint
  );
}

function mapBatch(row: SqlRow): ImportBatchRecord {
  return {
    id: text(row, 'id'),
    batchCode: text(row, 'batch_code'),
    kind: text(row, 'kind') as ImportKind,
    templateId: text(row, 'template_id') as ImportTemplateId,
    fileName: text(row, 'file_name'),
    sizeBytes: integer(row, 'size_bytes'),
    rowCount: integer(row, 'row_count'),
    sourceChecksum: text(row, 'source_checksum'),
    status: text(row, 'status') as ImportBatchStatus,
    plan: {
      create: integer(row, 'plan_create'),
      update: integer(row, 'plan_update'),
      skip: integer(row, 'plan_skip'),
      review: integer(row, 'plan_review'),
      error: integer(row, 'plan_error'),
    },
    sourceAmountMinor: nullableInteger(row, 'source_amount_minor'),
    validatedAt: iso(row['validated_at']),
    commitIdempotencyKey: nullableText(row, 'commit_idempotency_key'),
    commitStartedAt: nullableIso(row['commit_started_at']),
    commitStartedBy: nullableText(row, 'commit_started_by'),
    committedAt: nullableIso(row['committed_at']),
    committedBy: nullableText(row, 'committed_by'),
    discardedAt: nullableIso(row['discarded_at']),
    discardedBy: nullableText(row, 'discarded_by'),
    createdBy: text(row, 'created_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function entityRef(row: SqlRow, prefix: 'match' | 'entity'): ImportEntityRef | null {
  const id = nullableText(row, prefix === 'match' ? 'match_entity_id' : 'entity_id');
  if (id === null) {
    return null;
  }
  return {
    entityType: text(
      row,
      prefix === 'match' ? 'match_entity_type' : 'entity_type',
    ) as ImportEntityType,
    entityId: id,
    code: text(row, prefix === 'match' ? 'match_code' : 'entity_code'),
  };
}

function mapRow(row: SqlRow): ImportRowRecord {
  const decision = nullableText(row, 'decision');
  return {
    id: text(row, 'id'),
    batchId: text(row, 'batch_id'),
    kind: text(row, 'kind') as ImportKind,
    rowNumber: integer(row, 'row_number'),
    externalRef: nullableText(row, 'external_ref'),
    action: text(row, 'action') as ImportRowAction,
    reasonCode: nullableText(row, 'reason_code') as ImportReasonCode | null,
    errors: json(row, 'errors') as ImportCellError[],
    match: entityRef(row, 'match'),
    amountMinor: nullableInteger(row, 'amount_minor'),
    decision:
      decision === null
        ? null
        : {
            decision: decision as ImportDecision,
            reason: text(row, 'decision_reason'),
            decidedBy: text(row, 'decided_by'),
            decidedAt: iso(row['decided_at']),
          },
    outcome: nullableText(row, 'outcome') as ImportRowOutcome | null,
    outcomeCode: nullableText(row, 'outcome_code') as ImportReasonCode | null,
    entity: entityRef(row, 'entity'),
    committedAt: nullableIso(row['committed_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

/** Row plans as a JSON array (sent as `jsonb`) for one set-based insert or update. */
function plansJson(
  rows: readonly {
    rowNumber: number;
    externalRef: string | null;
    action: ImportRowAction;
    reasonCode: ImportReasonCode | null;
    errors: readonly ImportCellError[];
    match: ImportEntityRef | null;
    amountMinor: number | null;
  }[],
): unknown[] {
  return rows.map((row) => ({
    row_number: row.rowNumber,
    external_ref: row.externalRef,
    action: row.action,
    reason_code: row.reasonCode,
    errors: row.errors,
    match_entity_type: row.match?.entityType ?? null,
    match_entity_id: row.match?.entityId ?? null,
    match_code: row.match?.code ?? null,
    amount_minor: row.amountMinor,
  }));
}

const PLAN_RECORDSET = `jsonb_to_recordset($1::jsonb) AS p(
  row_number integer, external_ref text, action text, reason_code text, errors jsonb,
  match_entity_type text, match_entity_id uuid, match_code text, amount_minor bigint
)`;

export function createPostgresImportRepository(executor: SqlExecutor): ImportRepository {
  return {
    nextBatchNumber: async () => {
      const rows = await executor.query("SELECT nextval('import_batch_code_seq') AS value");
      const row = rows[0];
      if (row === undefined) {
        throw new Error('The import batch sequence returned no value.');
      }
      return integer(row, 'value');
    },
    createBatch: async (batch, rows) => {
      try {
        await executor.query(
          `INSERT INTO import_batches (
             id, batch_code, kind, template_id, file_name, size_bytes, row_count, source_checksum,
             status, plan_create, plan_update, plan_skip, plan_review, plan_error,
             source_amount_minor, validated_at, created_by, created_at, updated_at, version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, 1)`,
          [
            batch.id,
            batch.batchCode,
            batch.kind,
            batch.templateId,
            batch.fileName,
            batch.sizeBytes,
            batch.rowCount,
            batch.sourceChecksum,
            batch.status,
            batch.plan.create,
            batch.plan.update,
            batch.plan.skip,
            batch.plan.review,
            batch.plan.error,
            batch.sourceAmountMinor,
            batch.validatedAt,
            batch.createdBy,
            batch.createdAt,
          ],
        );
      } catch (error) {
        if (uniqueViolation(error, 'import_batches_source_unique')) {
          throw new DuplicateImportSourceError();
        }
        throw error;
      }
      if (rows.length === 0) {
        return;
      }
      await executor.query(
        `INSERT INTO import_batch_rows (
           id, batch_id, kind, row_number, external_ref, action, reason_code, errors,
           match_entity_type, match_entity_id, match_code, amount_minor, created_at, updated_at, version
         )
         SELECT gen_random_uuid(), $2, $3, p.row_number, p.external_ref, p.action, p.reason_code,
                p.errors, p.match_entity_type, p.match_entity_id, p.match_code, p.amount_minor,
                $4, $4, 1
         FROM ${PLAN_RECORDSET}`,
        [plansJson(rows), batch.id, batch.kind, batch.createdAt],
      );
    },
    findBatch: async (id) => {
      const rows = await executor.query('SELECT * FROM import_batches WHERE id = $1', [id]);
      return rows[0] === undefined ? null : mapBatch(rows[0]);
    },
    lockBatch: async (id) => {
      const rows = await executor.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      return rows[0] === undefined ? null : mapBatch(rows[0]);
    },
    findOpenBySourceChecksum: async (checksum) => {
      const rows = await executor.query(
        `SELECT * FROM import_batches WHERE source_checksum = $1 AND status <> 'discarded'`,
        [checksum],
      );
      return rows[0] === undefined ? null : mapBatch(rows[0]);
    },
    updateBatch: async ({ id, changes, expectedVersion, at }) => {
      const rows = await executor.query(
        `UPDATE import_batches
         SET status = $3, plan_create = $4, plan_update = $5, plan_skip = $6, plan_review = $7,
             plan_error = $8, source_amount_minor = $9, validated_at = $10,
             commit_idempotency_key = $11, commit_started_at = $12, commit_started_by = $13,
             committed_at = $14, committed_by = $15, discarded_at = $16, discarded_by = $17,
             updated_at = $18, version = version + 1
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [
          id,
          expectedVersion,
          changes.status,
          changes.plan.create,
          changes.plan.update,
          changes.plan.skip,
          changes.plan.review,
          changes.plan.error,
          changes.sourceAmountMinor,
          changes.validatedAt,
          changes.commitIdempotencyKey,
          changes.commitStartedAt,
          changes.commitStartedBy,
          changes.committedAt,
          changes.committedBy,
          changes.discardedAt,
          changes.discardedBy,
          at,
        ],
      );
      return rows[0] === undefined ? null : mapBatch(rows[0]);
    },
    listBatches: async ({ limit, after }) => {
      const rows = await executor.query(
        `SELECT * FROM import_batches
         WHERE $1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid)
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [after?.createdAt ?? null, after?.id ?? null, limit + 1],
      );
      return { batches: rows.slice(0, limit).map(mapBatch), hasMore: rows.length > limit };
    },
    listRows: async (filter) => {
      const rows = await executor.query(
        `SELECT * FROM import_batch_rows
         WHERE batch_id = $1
           AND ($2::text IS NULL OR action = $2)
           AND ($3::text IS NULL OR outcome = $3)
           AND ($4::integer IS NULL OR row_number > $4)
         ORDER BY row_number
         LIMIT $5`,
        [filter.batchId, filter.action, filter.outcome, filter.afterRowNumber, filter.limit + 1],
      );
      return { rows: rows.slice(0, filter.limit).map(mapRow), hasMore: rows.length > filter.limit };
    },
    allRows: async (batchId) =>
      (
        await executor.query(
          'SELECT * FROM import_batch_rows WHERE batch_id = $1 ORDER BY row_number',
          [batchId],
        )
      ).map(mapRow),
    findRow: async (batchId, rowNumber) => {
      const rows = await executor.query(
        'SELECT * FROM import_batch_rows WHERE batch_id = $1 AND row_number = $2',
        [batchId, rowNumber],
      );
      return rows[0] === undefined ? null : mapRow(rows[0]);
    },
    replanRows: async (batchId, plans, at) => {
      if (plans.length === 0) {
        return;
      }
      // A decision survives only while its row is still a review.
      await executor.query(
        `UPDATE import_batch_rows r
         SET external_ref = p.external_ref, action = p.action, reason_code = p.reason_code,
             errors = p.errors, match_entity_type = p.match_entity_type,
             match_entity_id = p.match_entity_id, match_code = p.match_code,
             amount_minor = p.amount_minor,
             decision = CASE WHEN p.action = 'review' THEN r.decision END,
             decision_reason = CASE WHEN p.action = 'review' THEN r.decision_reason END,
             decided_by = CASE WHEN p.action = 'review' THEN r.decided_by END,
             decided_at = CASE WHEN p.action = 'review' THEN r.decided_at END,
             updated_at = $3, version = r.version + 1
         FROM ${PLAN_RECORDSET}
         WHERE r.batch_id = $2 AND r.row_number = p.row_number AND r.outcome IS NULL`,
        [plansJson(plans), batchId, at],
      );
    },
    decideRow: async ({ batchId, rowNumber, decision, expectedVersion, at }) => {
      const rows = await executor.query(
        `UPDATE import_batch_rows
         SET decision = $4, decision_reason = $5, decided_by = $6, decided_at = $7,
             updated_at = $8, version = version + 1
         WHERE batch_id = $1 AND row_number = $2 AND version = $3 AND outcome IS NULL
         RETURNING *`,
        [
          batchId,
          rowNumber,
          expectedVersion,
          decision.decision,
          decision.reason,
          decision.decidedBy,
          decision.decidedAt,
          at,
        ],
      );
      return rows[0] === undefined ? null : mapRow(rows[0]);
    },
    pendingRows: async (batchId, limit) =>
      (
        await executor.query(
          `SELECT * FROM import_batch_rows
           WHERE batch_id = $1 AND outcome IS NULL
           ORDER BY row_number
           LIMIT $2`,
          [batchId, limit],
        )
      ).map(mapRow),
    recordOutcome: async ({ batchId, rowNumber, outcome, outcomeCode, entity, at }) => {
      try {
        const rows = await executor.query(
          `UPDATE import_batch_rows
           SET outcome = $3, outcome_code = $4, entity_type = $5, entity_id = $6, entity_code = $7,
               committed_at = $8, updated_at = $8, version = version + 1
           WHERE batch_id = $1 AND row_number = $2 AND outcome IS NULL
           RETURNING id`,
          [
            batchId,
            rowNumber,
            outcome,
            outcomeCode,
            entity?.entityType ?? null,
            entity?.entityId ?? null,
            entity?.code ?? null,
            at,
          ],
        );
        if (rows.length !== 1) {
          throw new Error('An import row outcome is written once.');
        }
      } catch (error) {
        if (uniqueViolation(error, 'import_batch_rows_created_lineage')) {
          throw new DuplicateImportLineageError();
        }
        throw error;
      }
    },
    findLineage: async (kind, externalRef) => {
      const rows = await executor.query(
        `SELECT entity_type, entity_id, entity_code FROM import_batch_rows
         WHERE kind = $1 AND external_ref = $2 AND entity_id IS NOT NULL
         ORDER BY committed_at DESC
         LIMIT 1`,
        [kind, externalRef],
      );
      return rows[0] === undefined ? null : entityRef(rows[0], 'entity');
    },
    rowTotals: async (batchId) => {
      const rows = await executor.query(
        `SELECT
           count(*) FILTER (WHERE outcome = 'created') AS created,
           count(*) FILTER (WHERE outcome = 'updated') AS updated,
           count(*) FILTER (WHERE outcome = 'skipped') AS skipped,
           count(*) FILTER (WHERE outcome = 'failed') AS failed,
           count(*) FILTER (WHERE outcome IS NULL) AS pending,
           coalesce(sum(amount_minor) FILTER (WHERE outcome = 'created'), 0) AS created_amount,
           coalesce(sum(amount_minor) FILTER (WHERE outcome = 'skipped'), 0) AS skipped_amount
         FROM import_batch_rows WHERE batch_id = $1`,
        [batchId],
      );
      const row = rows[0] ?? {};
      return {
        created: integer(row, 'created'),
        updated: integer(row, 'updated'),
        skipped: integer(row, 'skipped'),
        failed: integer(row, 'failed'),
        pending: integer(row, 'pending'),
        createdAmountMinor: integer(row, 'created_amount'),
        skippedAmountMinor: integer(row, 'skipped_amount'),
      };
    },
    reconciliationTotals: async () => {
      const rows = await executor.query(
        `WITH imported AS (
           SELECT kind, entity_id FROM import_batch_rows WHERE outcome = 'created'
         )
         SELECT
           (SELECT count(*) FROM clients) AS clients_total,
           (SELECT count(*) FROM clients WHERE deleted_at IS NULL) AS clients_active,
           (SELECT count(DISTINCT entity_id) FROM imported WHERE kind = 'clients') AS clients_imported,
           (SELECT count(*) FROM tax_cases
              WHERE deleted_at IS NULL AND current_status_kind = 'open') AS cases_active,
           (SELECT count(DISTINCT entity_id) FROM imported WHERE kind = 'cases') AS cases_imported,
           (SELECT count(*) FROM tax_cases c JOIN imported i ON i.entity_id = c.id AND i.kind = 'cases'
              WHERE c.deleted_at IS NULL AND c.current_status_kind = 'open') AS cases_imported_active,
           (SELECT count(*) FROM invoices v
              JOIN imported i ON i.entity_id = v.id AND i.kind = 'opening_balances'
              WHERE v.status = 'finalized') AS opening_invoices,
           (SELECT coalesce(sum(v.total_minor), 0) FROM invoices v
              JOIN imported i ON i.entity_id = v.id AND i.kind = 'opening_balances'
              WHERE v.status = 'finalized') AS opening_total,
           (SELECT coalesce(sum(v.outstanding_minor), 0) FROM invoices v
              JOIN imported i ON i.entity_id = v.id AND i.kind = 'opening_balances'
              WHERE v.status = 'finalized') AS opening_outstanding,
           (SELECT count(*) FROM import_batches WHERE status = 'committed') AS committed_batches,
           (SELECT count(*) FROM import_batch_rows WHERE outcome = 'failed') AS failed_rows`,
      );
      const row = rows[0] ?? {};
      return {
        clientsTotal: integer(row, 'clients_total'),
        clientsActive: integer(row, 'clients_active'),
        clientsImported: integer(row, 'clients_imported'),
        casesActive: integer(row, 'cases_active'),
        casesImported: integer(row, 'cases_imported'),
        casesImportedStillActive: integer(row, 'cases_imported_active'),
        openingInvoices: integer(row, 'opening_invoices'),
        openingTotalMinor: integer(row, 'opening_total'),
        openingOutstandingMinor: integer(row, 'opening_outstanding'),
        committedBatches: integer(row, 'committed_batches'),
        failedRows: integer(row, 'failed_rows'),
      };
    },
    sampleLineage: async (limit) => {
      const rows = await executor.query(
        `SELECT r.kind, b.batch_code, r.row_number, r.external_ref, r.entity_type, r.entity_id,
                r.entity_code
         FROM import_batch_rows r
         JOIN import_batches b ON b.id = r.batch_id
         WHERE r.entity_id IS NOT NULL AND r.external_ref IS NOT NULL
         ORDER BY random()
         LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        kind: text(row, 'kind') as ImportKind,
        batchCode: text(row, 'batch_code'),
        rowNumber: integer(row, 'row_number'),
        externalRef: text(row, 'external_ref'),
        entity: entityRef(row, 'entity') ?? { entityType: 'client', entityId: '', code: '' },
      }));
    },
  };
}
