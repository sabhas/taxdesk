import type {
  BillingPdfState,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  StorageProviderType,
} from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
import type {
  BillingDocumentRecord,
  InvoiceItemRecord,
  InvoiceRecord,
  PaymentRecord,
  PaymentReversalRecord,
} from '../domain/billing/types.js';
import type {
  BillingDocumentRepository,
  BillingReportRepository,
  CountAmount,
  IdempotencyRepository,
  InvoiceRepository,
  NumberSequenceRepository,
  PaymentRepository,
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
  } else if (typeof value === 'string' && /^\d+$/u.test(value)) {
    result = Number(value);
  } else {
    throw new Error(`Expected an integer column "${key}".`);
  }
  if (!Number.isSafeInteger(result)) {
    throw new Error(`The integer column "${key}" exceeds the safe integer range.`);
  }
  return result;
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

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const INVOICE_SELECT = `
  SELECT i.*,
         to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date_text,
         to_char(i.due_date, 'YYYY-MM-DD') AS due_date_text,
         cl.client_code AS client_code, cl.display_name AS client_display_name,
         tc.case_code AS case_code, tc.service_name AS case_service_name
  FROM invoices i
  JOIN clients cl ON cl.id = i.client_id
  LEFT JOIN tax_cases tc ON tc.id = i.case_id`;

function mapInvoice(row: SqlRow): InvoiceRecord {
  return {
    id: text(row, 'id'),
    clientId: text(row, 'client_id'),
    clientCode: text(row, 'client_code'),
    clientDisplayName: text(row, 'client_display_name'),
    caseId: nullableText(row, 'case_id'),
    caseCode: nullableText(row, 'case_code'),
    caseServiceName: nullableText(row, 'case_service_name'),
    currency: text(row, 'currency'),
    status: text(row, 'status') as InvoiceStatus,
    invoiceNumber: nullableText(row, 'invoice_number'),
    issueDate: nullableText(row, 'issue_date_text'),
    dueDate: nullableText(row, 'due_date_text'),
    subtotalMinor: integer(row, 'subtotal_minor'),
    discountMinor: integer(row, 'discount_minor'),
    totalMinor: integer(row, 'total_minor'),
    paidMinor: integer(row, 'paid_minor'),
    outstandingMinor: integer(row, 'outstanding_minor'),
    paymentStatus: text(row, 'payment_status') as PaymentStatus,
    notes: text(row, 'notes'),
    finalizedAt: nullableIso(row['finalized_at']),
    finalizedBy: nullableText(row, 'finalized_by'),
    voidReason: nullableText(row, 'void_reason'),
    voidedAt: nullableIso(row['voided_at']),
    voidedBy: nullableText(row, 'voided_by'),
    pdfState: text(row, 'pdf_state') as BillingPdfState,
    pdfDocumentId: nullableText(row, 'pdf_document_id'),
    createdBy: text(row, 'created_by'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapItem(row: SqlRow): InvoiceItemRecord {
  return {
    id: text(row, 'id'),
    invoiceId: text(row, 'invoice_id'),
    position: integer(row, 'position'),
    description: text(row, 'description'),
    quantity: integer(row, 'quantity'),
    unitAmountMinor: integer(row, 'unit_amount_minor'),
    lineTotalMinor: integer(row, 'line_total_minor'),
    createdAt: iso(row['created_at']),
  };
}

async function insertItems(
  executor: SqlExecutor,
  items: readonly InvoiceItemRecord[],
): Promise<void> {
  for (const item of items) {
    await executor.query(
      `INSERT INTO invoice_items (
         id, invoice_id, position, description, quantity, unit_amount_minor,
         line_total_minor, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        item.id,
        item.invoiceId,
        item.position,
        item.description,
        item.quantity,
        item.unitAmountMinor,
        item.lineTotalMinor,
        item.createdAt,
      ],
    );
  }
}

export function createPostgresInvoiceRepository(executor: SqlExecutor): InvoiceRepository {
  const findOne = async (id: string, lock: boolean): Promise<InvoiceRecord | null> => {
    const rows = await executor.query(
      `${INVOICE_SELECT} WHERE i.id = $1${lock ? ' FOR UPDATE OF i' : ''}`,
      [id],
    );
    return rows[0] === undefined ? null : mapInvoice(rows[0]);
  };
  const reload = async (rows: SqlRow[]): Promise<InvoiceRecord | null> => {
    const id = rows[0]?.['id'];
    return typeof id === 'string' ? await findOne(id, false) : null;
  };
  const reloadRequired = async (rows: SqlRow[]): Promise<InvoiceRecord> => {
    const record = await reload(rows);
    if (record === null) {
      throw new Error('The invoice update returned no row.');
    }
    return record;
  };
  return {
    create: async (record, items) => {
      await executor.query(
        `INSERT INTO invoices (
           id, client_id, case_id, currency, status, invoice_number, issue_date, due_date,
           subtotal_minor, discount_minor, total_minor, paid_minor, outstanding_minor,
           payment_status, notes, pdf_state, created_by, created_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14,
                   $15, $16, $17, $18, $19, $20)`,
        [
          record.id,
          record.clientId,
          record.caseId,
          record.currency,
          record.status,
          record.invoiceNumber,
          record.issueDate,
          record.dueDate,
          record.subtotalMinor,
          record.discountMinor,
          record.totalMinor,
          record.paidMinor,
          record.outstandingMinor,
          record.paymentStatus,
          record.notes,
          record.pdfState,
          record.createdBy,
          record.createdAt,
          record.updatedAt,
          record.version,
        ],
      );
      await insertItems(executor, items);
    },
    findById: async (id) => await findOne(id, false),
    lockById: async (id) => await findOne(id, true),
    listItems: async (invoiceId) => {
      const rows = await executor.query(
        'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position',
        [invoiceId],
      );
      return rows.map(mapItem);
    },
    replaceDraft: async ({ id, changes, items, expectedVersion, at }) => {
      const rows = await executor.query(
        `UPDATE invoices
         SET subtotal_minor = $3, discount_minor = $4, total_minor = $5, outstanding_minor = $6,
             issue_date = $7::date, due_date = $8::date, notes = $9,
             updated_at = $10, version = version + 1
         WHERE id = $1 AND version = $2 AND status = 'draft'
         RETURNING id`,
        [
          id,
          expectedVersion,
          changes.subtotalMinor,
          changes.discountMinor,
          changes.totalMinor,
          changes.outstandingMinor,
          changes.issueDate,
          changes.dueDate,
          changes.notes,
          at,
        ],
      );
      if (rows[0] === undefined) {
        return null;
      }
      await executor.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id]);
      await insertItems(executor, items);
      return await findOne(id, false);
    },
    finalize: async ({ id, finalization, expectedVersion, at }) =>
      await reload(
        await executor.query(
          `UPDATE invoices
           SET status = 'finalized', invoice_number = $3, issue_date = $4::date,
               finalized_at = $5, finalized_by = $6, pdf_state = 'pending',
               updated_at = $7, version = version + 1
           WHERE id = $1 AND version = $2 AND status = 'draft'
           RETURNING id`,
          [
            id,
            expectedVersion,
            finalization.invoiceNumber,
            finalization.issueDate,
            finalization.finalizedAt,
            finalization.finalizedBy,
            at,
          ],
        ),
      ),
    void: async ({ id, voiding, at }) =>
      await reloadRequired(
        await executor.query(
          `UPDATE invoices
           SET status = 'void', void_reason = $2, voided_at = $3, voided_by = $4,
               updated_at = $5, version = version + 1
           WHERE id = $1
           RETURNING id`,
          [id, voiding.reason, voiding.voidedAt, voiding.voidedBy, at],
        ),
      ),
    applyBalance: async ({ id, balance, at }) =>
      await reloadRequired(
        await executor.query(
          `UPDATE invoices
           SET paid_minor = $2, outstanding_minor = $3, payment_status = $4,
               updated_at = $5, version = version + 1
           WHERE id = $1
           RETURNING id`,
          [id, balance.paidMinor, balance.outstandingMinor, balance.paymentStatus, at],
        ),
      ),
    setPdf: async ({ id, state, documentId }) => {
      await executor.query(
        'UPDATE invoices SET pdf_state = $2, pdf_document_id = $3 WHERE id = $1',
        [id, state, documentId],
      );
    },
    list: async (filter) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${String(values.length)}`;
      };
      const where: string[] = [];
      if (filter.clientId !== undefined) {
        where.push(`i.client_id = ${bind(filter.clientId)}::uuid`);
      }
      if (filter.caseId !== undefined) {
        where.push(`i.case_id = ${bind(filter.caseId)}::uuid`);
      }
      if (filter.status !== undefined) {
        where.push(`i.status = ${bind(filter.status)}`);
      }
      if (filter.paymentStatus !== undefined) {
        where.push(`i.payment_status = ${bind(filter.paymentStatus)}`);
      }
      if (filter.issuedFrom !== undefined) {
        where.push(`i.issue_date >= ${bind(filter.issuedFrom)}::date`);
      }
      if (filter.issuedTo !== undefined) {
        where.push(`i.issue_date <= ${bind(filter.issuedTo)}::date`);
      }
      if (filter.dueFrom !== undefined) {
        where.push(`i.due_date >= ${bind(filter.dueFrom)}::date`);
      }
      if (filter.dueTo !== undefined) {
        where.push(`i.due_date <= ${bind(filter.dueTo)}::date`);
      }
      if (filter.outstandingOnly === true) {
        where.push(`i.status = 'finalized' AND i.outstanding_minor > 0`);
      }
      if (filter.dueBefore !== undefined) {
        where.push(`i.due_date < ${bind(filter.dueBefore)}::date`);
      }
      if (filter.visibleClientIds !== undefined) {
        where.push(`i.client_id = ANY (${bind([...filter.visibleClientIds])}::uuid[])`);
      }
      if (filter.after !== null) {
        where.push(
          `(i.created_at, i.id) < (${bind(filter.after.createdAt)}::timestamptz, ${bind(filter.after.id)}::uuid)`,
        );
      }
      const limit = bind(filter.limit + 1);
      const rows = await executor.query(
        `${INVOICE_SELECT}
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT ${limit}`,
        values,
      );
      return {
        invoices: rows.slice(0, filter.limit).map(mapInvoice),
        hasMore: rows.length > filter.limit,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Payments and reversals
// ---------------------------------------------------------------------------

function mapPayment(row: SqlRow): PaymentRecord {
  return {
    id: text(row, 'id'),
    invoiceId: text(row, 'invoice_id'),
    receiptNumber: text(row, 'receipt_number'),
    amountMinor: integer(row, 'amount_minor'),
    method: text(row, 'method') as PaymentMethod,
    receivedOn: text(row, 'received_on_text'),
    reference: text(row, 'reference'),
    recordedBy: text(row, 'recorded_by'),
    receiptPdfState: text(row, 'receipt_pdf_state') as BillingPdfState,
    receiptDocumentId: nullableText(row, 'receipt_document_id'),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapReversal(row: SqlRow): PaymentReversalRecord {
  return {
    id: text(row, 'id'),
    paymentId: text(row, 'payment_id'),
    invoiceId: text(row, 'invoice_id'),
    amountMinor: integer(row, 'amount_minor'),
    reason: text(row, 'reason'),
    reversedBy: text(row, 'reversed_by'),
    createdAt: iso(row['created_at']),
  };
}

const PAYMENT_SELECT = `SELECT p.*, to_char(p.received_on, 'YYYY-MM-DD') AS received_on_text FROM payments p`;

export function createPostgresPaymentRepository(executor: SqlExecutor): PaymentRepository {
  return {
    create: async (record) => {
      await executor.query(
        `INSERT INTO payments (
           id, invoice_id, receipt_number, amount_minor, method, received_on, reference,
           recorded_by, receipt_pdf_state, receipt_document_id, created_at, updated_at, version
         ) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.invoiceId,
          record.receiptNumber,
          record.amountMinor,
          record.method,
          record.receivedOn,
          record.reference,
          record.recordedBy,
          record.receiptPdfState,
          record.receiptDocumentId,
          record.createdAt,
          record.updatedAt,
          record.version,
        ],
      );
    },
    findById: async (id) => {
      const rows = await executor.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [id]);
      return rows[0] === undefined ? null : mapPayment(rows[0]);
    },
    listForInvoice: async (invoiceId) => {
      const rows = await executor.query(
        `${PAYMENT_SELECT} WHERE p.invoice_id = $1 ORDER BY p.created_at, p.id`,
        [invoiceId],
      );
      return rows.map(mapPayment);
    },
    setReceiptPdf: async ({ id, state, documentId }) => {
      await executor.query(
        'UPDATE payments SET receipt_pdf_state = $2, receipt_document_id = $3 WHERE id = $1',
        [id, state, documentId],
      );
    },
    appendReversal: async (record) => {
      await executor.query(
        `INSERT INTO payment_reversals (
           id, payment_id, invoice_id, amount_minor, reason, reversed_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.id,
          record.paymentId,
          record.invoiceId,
          record.amountMinor,
          record.reason,
          record.reversedBy,
          record.createdAt,
        ],
      );
    },
    listReversalsForInvoice: async (invoiceId) => {
      const rows = await executor.query(
        'SELECT * FROM payment_reversals WHERE invoice_id = $1 ORDER BY created_at, id',
        [invoiceId],
      );
      return rows.map(mapReversal);
    },
  };
}

// ---------------------------------------------------------------------------
// Billing documents, numbers, idempotency
// ---------------------------------------------------------------------------

function mapBillingDocument(row: SqlRow): BillingDocumentRecord {
  return {
    id: text(row, 'id'),
    kind: text(row, 'kind') as 'invoice' | 'receipt',
    invoiceId: text(row, 'invoice_id'),
    paymentId: nullableText(row, 'payment_id'),
    clientId: text(row, 'client_id'),
    caseId: nullableText(row, 'case_id'),
    providerType: text(row, 'provider_type') as StorageProviderType,
    externalItemId: text(row, 'external_item_id'),
    externalDriveId: nullableText(row, 'external_drive_id'),
    fileName: text(row, 'file_name'),
    sizeBytes: integer(row, 'size_bytes'),
    createdBy: nullableText(row, 'created_by'),
    createdAt: iso(row['created_at']),
  };
}

export function createPostgresBillingDocumentRepository(
  executor: SqlExecutor,
): BillingDocumentRepository {
  return {
    create: async (record) => {
      await executor.query(
        `INSERT INTO billing_documents (
           id, kind, invoice_id, payment_id, client_id, case_id, provider_type,
           external_item_id, external_drive_id, file_name, size_bytes, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.kind,
          record.invoiceId,
          record.paymentId,
          record.clientId,
          record.caseId,
          record.providerType,
          record.externalItemId,
          record.externalDriveId,
          record.fileName,
          record.sizeBytes,
          record.createdBy,
          record.createdAt,
        ],
      );
    },
    findById: async (id) => {
      const rows = await executor.query('SELECT * FROM billing_documents WHERE id = $1', [id]);
      return rows[0] === undefined ? null : mapBillingDocument(rows[0]);
    },
  };
}

export function createPostgresNumberSequenceRepository(
  executor: SqlExecutor,
): NumberSequenceRepository {
  return {
    next: async (key) => {
      // The UPDATE takes the counter row's lock for the rest of the transaction.
      const rows = await executor.query(
        `UPDATE number_sequences
         SET next_value = next_value + 1, updated_at = now()
         WHERE key = $1
         RETURNING next_value - 1 AS value`,
        [key],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`The ${key} number counter is missing.`);
      }
      return integer(row, 'value');
    },
  };
}

export function createPostgresIdempotencyRepository(executor: SqlExecutor): IdempotencyRepository {
  return {
    begin: async ({ actorUserId, scope, key, requestHash, at }) => {
      const claimed = await executor.query(
        `INSERT INTO idempotency_keys (id, actor_user_id, scope, key, request_hash, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         ON CONFLICT (actor_user_id, scope, key) DO NOTHING
         RETURNING id`,
        [actorUserId, scope, key, requestHash, at],
      );
      if (claimed[0] !== undefined) {
        return { kind: 'new' };
      }
      // ON CONFLICT waited for the first claimant to commit or roll back, so the
      // committed row is visible here with its stored response.
      const rows = await executor.query(
        `SELECT request_hash, response FROM idempotency_keys
         WHERE actor_user_id = $1 AND scope = $2 AND key = $3`,
        [actorUserId, scope, key],
      );
      const row = rows[0];
      if (row === undefined) {
        return { kind: 'new' };
      }
      if (text(row, 'request_hash') !== requestHash) {
        return { kind: 'conflict' };
      }
      const response = row['response'];
      return {
        kind: 'replay',
        response: typeof response === 'string' ? (JSON.parse(response) as unknown) : response,
      };
    },
    complete: async ({ actorUserId, scope, key, resourceId, response }) => {
      await executor.query(
        `UPDATE idempotency_keys SET resource_id = $4, response = $5::jsonb
         WHERE actor_user_id = $1 AND scope = $2 AND key = $3`,
        [actorUserId, scope, key, resourceId, JSON.stringify(response)],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Report aggregates (TD-601, TD-603)
// ---------------------------------------------------------------------------

function countAmount(row: SqlRow | undefined, prefix: string): CountAmount {
  return row === undefined
    ? { count: 0, amountMinor: 0 }
    : { count: integer(row, `${prefix}_count`), amountMinor: integer(row, `${prefix}_amount`) };
}

export function createPostgresBillingReportRepository(
  executor: SqlExecutor,
): BillingReportRepository {
  return {
    invoiceTotals: async (filter) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${String(values.length)}`;
      };
      const where = [`i.status = 'finalized'`];
      if (filter.issuedFrom !== null) {
        where.push(`i.issue_date >= ${bind(filter.issuedFrom)}::date`);
      }
      if (filter.issuedTo !== null) {
        where.push(`i.issue_date <= ${bind(filter.issuedTo)}::date`);
      }
      if (filter.clientId !== null) {
        where.push(`i.client_id = ${bind(filter.clientId)}::uuid`);
      }
      if (filter.visibleClientIds !== null) {
        where.push(`i.client_id = ANY (${bind([...filter.visibleClientIds])}::uuid[])`);
      }
      const today = bind(filter.today);
      const rows = await executor.query(
        `SELECT
           count(*)::int AS invoiced_count,
           COALESCE(sum(i.total_minor), 0)::bigint AS invoiced_amount,
           (count(*) FILTER (WHERE i.outstanding_minor > 0))::int AS outstanding_count,
           COALESCE(sum(i.outstanding_minor) FILTER (WHERE i.outstanding_minor > 0), 0)::bigint
             AS outstanding_amount,
           (count(*) FILTER (WHERE i.outstanding_minor > 0 AND i.due_date < ${today}::date))::int
             AS overdue_count,
           COALESCE(sum(i.outstanding_minor)
             FILTER (WHERE i.outstanding_minor > 0 AND i.due_date < ${today}::date), 0)::bigint
             AS overdue_amount
         FROM invoices i
         WHERE ${where.join(' AND ')}`,
        values,
      );
      return {
        invoiced: countAmount(rows[0], 'invoiced'),
        outstanding: countAmount(rows[0], 'outstanding'),
        overdue: countAmount(rows[0], 'overdue'),
      };
    },
    collectionTotals: async (filter) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${String(values.length)}`;
      };
      const from = bind(filter.from);
      const to = bind(filter.to);
      const timezone = bind(filter.timezone);
      const scope: string[] = [];
      if (filter.clientId !== null) {
        scope.push(`i.client_id = ${bind(filter.clientId)}::uuid`);
      }
      if (filter.visibleClientIds !== null) {
        scope.push(`i.client_id = ANY (${bind([...filter.visibleClientIds])}::uuid[])`);
      }
      const extra = scope.length === 0 ? '' : ` AND ${scope.join(' AND ')}`;
      const paymentRange = `p.received_on BETWEEN ${from}::date AND ${to}::date${extra}`;
      const reversalRange = `(r.created_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date${extra}`;
      const rows = await executor.query(
        `SELECT
           (SELECT count(*)::int FROM payments p JOIN invoices i ON i.id = p.invoice_id
             WHERE ${paymentRange}) AS collected_count,
           (SELECT COALESCE(sum(p.amount_minor), 0)::bigint FROM payments p
             JOIN invoices i ON i.id = p.invoice_id WHERE ${paymentRange}) AS collected_amount,
           (SELECT count(*)::int FROM payment_reversals r JOIN invoices i ON i.id = r.invoice_id
             WHERE ${reversalRange}) AS reversed_count,
           (SELECT COALESCE(sum(r.amount_minor), 0)::bigint FROM payment_reversals r
             JOIN invoices i ON i.id = r.invoice_id WHERE ${reversalRange}) AS reversed_amount`,
        values,
      );
      return {
        collected: countAmount(rows[0], 'collected'),
        reversed: countAmount(rows[0], 'reversed'),
      };
    },
  };
}
