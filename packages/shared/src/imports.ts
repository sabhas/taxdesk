import { z } from 'zod';
import { UuidSchema, UuidV7Schema } from './id.js';

/**
 * Data import contracts (Epic 7, TD-701–TD-705).
 *
 * An import is a protected, administrator-only write path. A CSV file is first
 * validated in a dry run that writes nothing but the batch and its row plan;
 * only a later commit with an `Idempotency-Key` creates records. The server
 * never stores the file itself and never echoes a cell value back in an error:
 * row errors carry a column name, a stable code, and a fixed message.
 */

export const IMPORT_KINDS = ['clients', 'cases', 'opening_balances'] as const;
export const ImportKindSchema = z.enum(IMPORT_KINDS);
export type ImportKind = z.infer<typeof ImportKindSchema>;

export const IMPORT_LIMITS = {
  /** Largest accepted CSV file (UTF-8 bytes). */
  maxFileBytes: 2 * 1024 * 1024,
  /** Largest accepted number of data rows (excluding the header). */
  maxRows: 5_000,
  /** Longest accepted single cell. */
  maxCellLength: 4_000,
  fileNameMax: 200,
  /** Rows committed per database transaction. */
  commitChunkRows: 100,
  overrideReasonMin: 10,
  overrideReasonMax: 500,
  listDefaultLimit: 25,
  listMaxLimit: 100,
  rowsDefaultLimit: 50,
  rowsMaxLimit: 200,
  sampleDefault: 10,
  sampleMax: 50,
} as const;

/** A source system's own row identifier: letters, digits, and `._/-`. */
export const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;

export const IMPORT_BATCH_CODE_PATTERN = /^IMP-\d{5,}$/u;

/** Server-side batch code format: `IMP-00042`. */
export function formatImportBatchCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('An import batch sequence must be a positive integer.');
  }
  return `IMP-${String(sequence).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Versioned templates (TD-701)
// ---------------------------------------------------------------------------

export interface ImportColumnSpec {
  readonly name: string;
  readonly required: 'always' | 'conditional' | 'optional';
  readonly format: string;
  readonly description: string;
  readonly example: string;
}

export interface ImportTemplateSpec {
  readonly id: string;
  readonly kind: ImportKind;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly columns: readonly ImportColumnSpec[];
  /** Synthetic example rows, in column order. Never real client data. */
  readonly examples: readonly (readonly string[])[];
}

const CLIENTS_V1: ImportTemplateSpec = {
  id: 'clients.v1',
  kind: 'clients',
  version: 1,
  title: 'Clients',
  description:
    'Existing clients. Import these first: cases and opening balances refer to clients by client code or by this file’s external reference.',
  columns: [
    {
      name: 'external_ref',
      required: 'always',
      format: '1–64 letters, digits, or . _ / - (unique in the file)',
      description:
        'The client’s identifier in the old system. Re-importing a row with the same reference updates that client instead of creating another.',
      example: 'LEGACY-C-0001',
    },
    {
      name: 'client_type',
      required: 'always',
      format: 'individual | business',
      description: 'Cannot change after import.',
      example: 'individual',
    },
    {
      name: 'legal_name',
      required: 'always',
      format: 'Text, up to 200 characters',
      description: 'Name as registered with the tax authority.',
      example: 'Sample Person One',
    },
    {
      name: 'display_name',
      required: 'optional',
      format: 'Text, up to 200 characters',
      description: 'Name shown in lists. Defaults to the legal name.',
      example: 'Sample One',
    },
    {
      name: 'cnic',
      required: 'conditional',
      format: '13 digits, 12345-1234567-1 or 1234512345671',
      description: 'Required for an individual; must be empty for a business. Stored encrypted.',
      example: '00000-0000001-1',
    },
    {
      name: 'ntn',
      required: 'conditional',
      format: '7 digits with optional check digit (1234567-8), or a 13-digit CNIC-based NTN',
      description: 'Required for a business; optional for an individual. Stored encrypted.',
      example: '',
    },
    {
      name: 'contact_name',
      required: 'optional',
      format: 'Text, up to 120 characters',
      description:
        'Primary contact. When set, give a contact email or phone. Contacts are written on create only.',
      example: 'Sample Person One',
    },
    {
      name: 'contact_relationship',
      required: 'optional',
      format: 'Text, up to 80 characters',
      description: 'For example: self, director, accountant.',
      example: 'self',
    },
    {
      name: 'contact_email',
      required: 'optional',
      format: 'Email address',
      description: 'Stored lowercase for duplicate checks.',
      example: 'sample.one@example.test',
    },
    {
      name: 'contact_phone',
      required: 'optional',
      format: '7–15 digits; spaces, brackets, hyphens, and a leading + allowed',
      description: 'National numbers (0300…) are normalized to international form (92300…).',
      example: '0300 0000001',
    },
    {
      name: 'assigned_manager_username',
      required: 'optional',
      format: 'Username of an active staff member',
      description: 'Leave empty for no assigned manager.',
      example: '',
    },
    {
      name: 'notes',
      required: 'optional',
      format: 'Text, up to 4000 characters',
      description: 'Internal notes. Never copied into audit history.',
      example: 'Synthetic example row',
    },
  ],
  examples: [
    [
      'LEGACY-C-0001',
      'individual',
      'Sample Person One',
      'Sample One',
      '00000-0000001-1',
      '',
      'Sample Person One',
      'self',
      'sample.one@example.test',
      '0300 0000001',
      '',
      'Synthetic example row',
    ],
    [
      'LEGACY-C-0002',
      'business',
      'Sample Trading Company (Pvt.) Ltd.',
      'Sample Trading',
      '',
      '0000002-1',
      'Sample Accountant',
      'accountant',
      'accounts@example.test',
      '',
      '',
      '',
    ],
  ],
};

const CASES_V1: ImportTemplateSpec = {
  id: 'cases.v1',
  kind: 'cases',
  version: 1,
  title: 'Active cases',
  description:
    'Open tax cases. Each case uses the service’s default workflow template (latest published version).',
  columns: [
    {
      name: 'external_ref',
      required: 'always',
      format: '1–64 letters, digits, or . _ / - (unique in the file)',
      description: 'The case’s identifier in the old system. A row already imported is skipped.',
      example: 'LEGACY-T-0001',
    },
    {
      name: 'client_ref',
      required: 'always',
      format: 'Client code (CL-00001) or a client external_ref already imported',
      description: 'The client must exist and must not be archived.',
      example: 'LEGACY-C-0001',
    },
    {
      name: 'service',
      required: 'always',
      format: 'Name of an active service (case-insensitive)',
      description: 'The service must have a default workflow template with a published version.',
      example: 'Income tax return',
    },
    {
      name: 'tax_year',
      required: 'always',
      format: 'Year, 2000–2100',
      description: 'An open case for the same client, service, and year is skipped and linked.',
      example: '2026',
    },
    {
      name: 'due_date',
      required: 'optional',
      format: 'YYYY-MM-DD',
      description: 'Defaults to the import date plus the service’s deadline offset.',
      example: '2026-09-30',
    },
    {
      name: 'status',
      required: 'optional',
      format: 'Status key of an open status in the workflow',
      description:
        'Defaults to the initial status. Only open statuses are allowed: import active work only.',
      example: '',
    },
    {
      name: 'primary_consultant_username',
      required: 'optional',
      format: 'Username of an active staff member who can work cases',
      description: 'Leave empty to place the case in the unassigned queue.',
      example: '',
    },
    {
      name: 'reviewer_username',
      required: 'optional',
      format: 'Username of an active staff member who can work cases',
      description: 'Must differ from the primary consultant.',
      example: '',
    },
    {
      name: 'notes',
      required: 'optional',
      format: 'Text, up to 4000 characters',
      description: 'Internal notes.',
      example: '',
    },
  ],
  examples: [
    ['LEGACY-T-0001', 'LEGACY-C-0001', 'Income tax return', '2026', '2026-09-30', '', '', '', ''],
    ['LEGACY-T-0002', 'CL-00002', 'Income tax return', '2026', '', '', '', '', 'Synthetic row'],
  ],
};

const OPENING_BALANCES_V1: ImportTemplateSpec = {
  id: 'opening_balances.v1',
  kind: 'opening_balances',
  version: 1,
  title: 'Opening balances',
  description:
    'Amounts clients already owe. Each row becomes one finalized invoice for the outstanding amount, numbered from the firm’s invoice sequence.',
  columns: [
    {
      name: 'external_ref',
      required: 'always',
      format: '1–64 letters, digits, or . _ / - (unique in the file)',
      description: 'The balance’s identifier in the old system. A row already imported is skipped.',
      example: 'LEGACY-B-0001',
    },
    {
      name: 'client_ref',
      required: 'always',
      format: 'Client code (CL-00001) or a client external_ref already imported',
      description: 'The client must exist and must not be archived.',
      example: 'LEGACY-C-0001',
    },
    {
      name: 'case_ref',
      required: 'optional',
      format: 'Case code (TC-00001) or a case external_ref already imported',
      description: 'When set, the case must belong to the same client.',
      example: '',
    },
    {
      name: 'as_of_date',
      required: 'always',
      format: 'YYYY-MM-DD, not in the future',
      description: 'Becomes the invoice issue date.',
      example: '2026-06-30',
    },
    {
      name: 'due_date',
      required: 'optional',
      format: 'YYYY-MM-DD, on or after as_of_date',
      description: 'Leave empty for no due date.',
      example: '2026-07-31',
    },
    {
      name: 'amount',
      required: 'always',
      format: 'PKR amount above zero, at most two decimals (12500 or 12,500.50)',
      description: 'The outstanding balance carried over.',
      example: '12500.00',
    },
    {
      name: 'description',
      required: 'optional',
      format: 'Text, up to 300 characters',
      description: 'Invoice line text. Defaults to "Opening balance as of <as_of_date>".',
      example: '',
    },
  ],
  examples: [
    ['LEGACY-B-0001', 'LEGACY-C-0001', '', '2026-06-30', '2026-07-31', '12500.00', ''],
    ['LEGACY-B-0002', 'CL-00002', 'LEGACY-T-0002', '2026-06-30', '', '3,000', 'Prior-year fee'],
  ],
};

export const IMPORT_TEMPLATES: readonly ImportTemplateSpec[] = [
  CLIENTS_V1,
  CASES_V1,
  OPENING_BALANCES_V1,
];

export const IMPORT_TEMPLATE_IDS = ['clients.v1', 'cases.v1', 'opening_balances.v1'] as const;
export const ImportTemplateIdSchema = z.enum(IMPORT_TEMPLATE_IDS);
export type ImportTemplateId = z.infer<typeof ImportTemplateIdSchema>;

export function importTemplate(id: ImportTemplateId): ImportTemplateSpec {
  const template = IMPORT_TEMPLATES.find((candidate) => candidate.id === id);
  if (template === undefined) {
    throw new Error(`Unknown import template ${id}.`);
  }
  return template;
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180)
// ---------------------------------------------------------------------------

export type CsvParseResult =
  | { readonly ok: true; readonly rows: string[][] }
  | { readonly ok: false; readonly line: number; readonly code: CsvErrorCode };

export const CSV_ERROR_CODES = [
  'EMPTY_FILE',
  'BINARY_CONTENT',
  'UNTERMINATED_QUOTE',
  'QUOTE_IN_UNQUOTED_FIELD',
  'TEXT_AFTER_QUOTE',
  'CELL_TOO_LONG',
  'TOO_MANY_ROWS',
] as const;
export type CsvErrorCode = (typeof CSV_ERROR_CODES)[number];

export const CSV_ERROR_MESSAGES: Readonly<Record<CsvErrorCode, string>> = {
  EMPTY_FILE: 'The file has no header row.',
  BINARY_CONTENT: 'The file contains binary or control characters. Save it as UTF-8 CSV.',
  UNTERMINATED_QUOTE: 'A quoted cell is never closed.',
  QUOTE_IN_UNQUOTED_FIELD: 'A cell contains a quote but is not wrapped in quotes.',
  TEXT_AFTER_QUOTE: 'A quoted cell has text after its closing quote.',
  CELL_TOO_LONG: `A cell is longer than ${String(IMPORT_LIMITS.maxCellLength)} characters.`,
  TOO_MANY_ROWS: `The file has more than ${String(IMPORT_LIMITS.maxRows)} data rows. Split it into smaller files.`,
};

/**
 * Parses CSV text into rows of cells. Accepts a UTF-8 BOM, CRLF or LF line
 * endings, quoted cells with doubled quotes, and newlines inside quotes.
 * Entirely blank lines are dropped. Errors report a line number and a code,
 * never the offending text.
 */
export function parseCsv(
  input: string,
  maxDataRows: number = IMPORT_LIMITS.maxRows,
): CsvParseResult {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    return { ok: false, line: 1, code: 'BINARY_CONTENT' };
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let line = 1;
  let rowLine = 1;
  let inQuotes = false;
  let quotedCell = false;
  let afterQuote = false;
  const pushCell = (): CsvErrorCode | null => {
    if (cell.length > IMPORT_LIMITS.maxCellLength) {
      return 'CELL_TOO_LONG';
    }
    row.push(cell);
    cell = '';
    quotedCell = false;
    afterQuote = false;
    return null;
  };
  const pushRow = (): CsvErrorCode | null => {
    const failure = pushCell();
    if (failure !== null) {
      return failure;
    }
    if (!(row.length === 1 && row[0] === '')) {
      rows.push(row);
      if (rows.length > maxDataRows + 1) {
        return 'TOO_MANY_ROWS';
      }
    }
    row = [];
    return null;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (character === '\n') {
          line += 1;
        }
        cell += character;
      }
      continue;
    }
    if (character === ',') {
      const failure = pushCell();
      if (failure !== null) {
        return { ok: false, line: rowLine, code: failure };
      }
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      const failure = pushRow();
      if (failure !== null) {
        return { ok: false, line: rowLine, code: failure };
      }
      line += 1;
      rowLine = line;
      continue;
    }
    if (afterQuote) {
      return { ok: false, line, code: 'TEXT_AFTER_QUOTE' };
    }
    if (character === '"') {
      if (cell.length > 0 || quotedCell) {
        return { ok: false, line, code: 'QUOTE_IN_UNQUOTED_FIELD' };
      }
      inQuotes = true;
      quotedCell = true;
      continue;
    }
    cell += character;
  }
  if (inQuotes) {
    return { ok: false, line: rowLine, code: 'UNTERMINATED_QUOTE' };
  }
  if (cell.length > 0 || row.length > 0 || quotedCell) {
    const failure = pushRow();
    if (failure !== null) {
      return { ok: false, line: rowLine, code: failure };
    }
  }
  if (rows.length === 0) {
    return { ok: false, line: 1, code: 'EMPTY_FILE' };
  }
  return { ok: true, rows };
}

/** Renders a template as a CSV file: header row plus its synthetic examples. */
export function templateCsv(template: ImportTemplateSpec): string {
  const quote = (value: string): string =>
    /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = [
    template.columns.map((column) => column.name),
    ...template.examples.map((example) => [...example]),
  ].map((cells) => cells.map(quote).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Row plans and outcomes
// ---------------------------------------------------------------------------

/**
 * What a dry run proposes for a row. `review` is a possible (non-exact)
 * duplicate that needs an administrator's decision with a reason before the
 * batch can be committed; `error` blocks the commit.
 */
export const IMPORT_ROW_ACTIONS = ['create', 'update', 'skip', 'review', 'error'] as const;
export const ImportRowActionSchema = z.enum(IMPORT_ROW_ACTIONS);
export type ImportRowAction = z.infer<typeof ImportRowActionSchema>;

export const IMPORT_ROW_OUTCOMES = ['created', 'updated', 'skipped', 'failed'] as const;
export const ImportRowOutcomeSchema = z.enum(IMPORT_ROW_OUTCOMES);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcomeSchema>;

export const IMPORT_DECISIONS = ['create', 'skip'] as const;
export const ImportDecisionSchema = z.enum(IMPORT_DECISIONS);
export type ImportDecision = z.infer<typeof ImportDecisionSchema>;

export const IMPORT_BATCH_STATUSES = [
  'validated',
  'blocked',
  'committing',
  'committed',
  'discarded',
] as const;
export const ImportBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatusSchema>;

/**
 * Stable reason codes. The messages are fixed text: an error never includes
 * the value that failed, so an exported error list cannot leak a CNIC, NTN,
 * name, or contact detail.
 */
export const IMPORT_REASON_MESSAGES = {
  // Row and cell validation
  REQUIRED: 'This column is required.',
  INVALID_FORMAT: 'The value does not match the documented format.',
  TOO_LONG: 'The value is too long.',
  NOT_ALLOWED: 'This column must be empty for this row.',
  INVALID_CHOICE: 'The value is not one of the allowed choices.',
  INVALID_DATE: 'Use a real date in YYYY-MM-DD form.',
  DATE_IN_FUTURE: 'The date is in the future.',
  DATE_BEFORE_START: 'The date is before the as-of date.',
  INVALID_AMOUNT: 'Use an amount above zero with at most two decimals.',
  WRONG_COLUMN_COUNT: 'The row has a different number of cells than the header.',
  DUPLICATE_IN_FILE: 'Another row in this file has the same value.',
  // References
  CLIENT_NOT_FOUND: 'No client matches this reference.',
  CLIENT_ARCHIVED: 'The client is archived. Restore it before importing.',
  CASE_NOT_FOUND: 'No case matches this reference.',
  CASE_OTHER_CLIENT: 'The case belongs to a different client.',
  SERVICE_NOT_FOUND: 'No active service has this name.',
  SERVICE_WITHOUT_WORKFLOW: 'The service has no default workflow with a published version.',
  STATUS_NOT_FOUND: 'The workflow has no open status with this key.',
  USER_NOT_FOUND: 'No active staff member with this username can take this role.',
  SAME_REVIEWER: 'The reviewer must differ from the primary consultant.',
  // Duplicates and existing records
  ALREADY_IMPORTED: 'This external reference was already imported; nothing changes.',
  UPDATES_EXISTING: 'This external reference was already imported; the changed fields update it.',
  EXISTING_CLIENT: 'A client with the same CNIC or NTN already exists; the row links to it.',
  EXISTING_CASE:
    'An open case for this client, service, and tax year already exists; the row links to it.',
  IDENTIFIER_CHANGED:
    'The CNIC, NTN, or type differs from the client this reference was imported as.',
  IDENTIFIER_IN_USE: 'The CNIC or NTN belongs to a different client than this reference.',
  POSSIBLE_DUPLICATE:
    'A client with a similar name, email, or phone exists. Decide whether to create or skip.',
  DUPLICATE_CASE_BLOCKED:
    'An open case for this client, service, and tax year exists and the service blocks duplicates.',
  DECIDED_CREATE: 'An administrator chose to create this row despite a possible duplicate.',
  DECIDED_SKIP: 'An administrator chose to skip this row.',
  // Commit-time failures
  CHANGED_SINCE_VALIDATION: 'The data changed after the dry run, so this row was not imported.',
  PROTECTION_UNAVAILABLE: 'Client identifier protection is not configured.',
} as const;

export type ImportReasonCode = keyof typeof IMPORT_REASON_MESSAGES;
export const IMPORT_REASON_CODES = Object.keys(IMPORT_REASON_MESSAGES) as ImportReasonCode[];
export const ImportReasonCodeSchema = z.enum(
  IMPORT_REASON_CODES as [ImportReasonCode, ...ImportReasonCode[]],
);

export function importReasonMessage(code: ImportReasonCode): string {
  return IMPORT_REASON_MESSAGES[code];
}

export const ImportCellErrorSchema = z
  .object({
    column: z.string().min(1).max(64),
    code: ImportReasonCodeSchema,
    message: z.string().min(1).max(200),
  })
  .strict();
export type ImportCellError = z.infer<typeof ImportCellErrorSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const ImportFileNameSchema = z
  .string()
  .trim()
  .min(1, 'Name the file.')
  .max(IMPORT_LIMITS.fileNameMax, 'Use a shorter file name.')
  .regex(/^[^\\/\p{Cc}]+$/u, 'Use a plain file name.');

export const ImportContentSchema = z
  .string()
  .min(1, 'The file is empty.')
  .refine(
    (value) => new TextEncoder().encode(value).length <= IMPORT_LIMITS.maxFileBytes,
    `The file is larger than ${String(IMPORT_LIMITS.maxFileBytes / 1024 / 1024)} MiB. Split it into smaller files.`,
  );

/** Starts a dry run. The file content is sent as UTF-8 text. */
export const ImportDryRunRequestSchema = z
  .object({
    template: ImportTemplateIdSchema,
    fileName: ImportFileNameSchema,
    content: ImportContentSchema,
  })
  .strict();
export type ImportDryRunRequest = z.infer<typeof ImportDryRunRequestSchema>;

/**
 * Revalidates or commits a batch. The same file is sent again and must match
 * the stored checksum: the server keeps only the plan, never the file.
 */
export const ImportContentRequestSchema = z
  .object({
    content: ImportContentSchema,
  })
  .strict();
export type ImportContentRequest = z.infer<typeof ImportContentRequestSchema>;

export const ImportDecisionRequestSchema = z
  .object({
    decision: ImportDecisionSchema,
    reason: z
      .string()
      .trim()
      .min(
        IMPORT_LIMITS.overrideReasonMin,
        `Explain the decision in at least ${String(IMPORT_LIMITS.overrideReasonMin)} characters.`,
      )
      .max(IMPORT_LIMITS.overrideReasonMax, 'Use a shorter reason.'),
  })
  .strict();
export type ImportDecisionRequest = z.infer<typeof ImportDecisionRequestSchema>;

export const ImportBatchListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(IMPORT_LIMITS.listMaxLimit)
      .default(IMPORT_LIMITS.listDefaultLimit),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ImportBatchListQuery = z.infer<typeof ImportBatchListQuerySchema>;

export const ImportRowListQuerySchema = z
  .object({
    action: ImportRowActionSchema.optional(),
    outcome: ImportRowOutcomeSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(IMPORT_LIMITS.rowsMaxLimit)
      .default(IMPORT_LIMITS.rowsDefaultLimit),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ImportRowListQuery = z.infer<typeof ImportRowListQuerySchema>;

export const ImportReconciliationQuerySchema = z
  .object({
    sample: z.coerce
      .number()
      .int()
      .min(0)
      .max(IMPORT_LIMITS.sampleMax)
      .default(IMPORT_LIMITS.sampleDefault),
  })
  .strict();
export type ImportReconciliationQuery = z.infer<typeof ImportReconciliationQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const ImportTemplateColumnSchema = z
  .object({
    name: z.string(),
    required: z.enum(['always', 'conditional', 'optional']),
    format: z.string(),
    description: z.string(),
    example: z.string(),
  })
  .strict();

export const ImportTemplateSchema = z
  .object({
    id: ImportTemplateIdSchema,
    kind: ImportKindSchema,
    version: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    columns: z.array(ImportTemplateColumnSchema),
  })
  .strict();
export type ImportTemplate = z.infer<typeof ImportTemplateSchema>;

export const ImportTemplateListSchema = z
  .object({
    templates: z.array(ImportTemplateSchema),
    limits: z
      .object({
        maxFileBytes: z.number().int().positive(),
        maxRows: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ImportTemplateList = z.infer<typeof ImportTemplateListSchema>;

const PersonSchema = z.object({ id: UuidSchema, displayName: z.string() }).strict();

const CountsSchema = z
  .object({
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  })
  .strict();
export type ImportPlanCounts = z.infer<typeof CountsSchema>;

const OutcomeCountsSchema = z
  .object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();
export type ImportOutcomeCounts = z.infer<typeof OutcomeCountsSchema>;

/** Reconciliation summary of one batch: rows in the file against what was written. */
export const ImportBatchReconciliationSchema = z
  .object({
    sourceRows: z.number().int().nonnegative(),
    accountedRows: z.number().int().nonnegative(),
    /** Opening balances only: the sum of `amount` in the file. */
    sourceAmountMinor: z.number().int().nonnegative().nullable(),
    /** Opening balances only: the sum of the invoices created by this batch. */
    importedAmountMinor: z.number().int().nonnegative().nullable(),
    /** Skipped rows' amounts (already imported or decided skip). */
    skippedAmountMinor: z.number().int().nonnegative().nullable(),
    /** Every row has an outcome, none failed, and amounts add up. */
    balanced: z.boolean(),
  })
  .strict();
export type ImportBatchReconciliation = z.infer<typeof ImportBatchReconciliationSchema>;

export const ImportBatchSchema = z
  .object({
    id: UuidV7Schema,
    batchCode: z.string().regex(IMPORT_BATCH_CODE_PATTERN),
    template: ImportTemplateIdSchema,
    kind: ImportKindSchema,
    fileName: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sourceChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
    rowCount: z.number().int().nonnegative(),
    status: ImportBatchStatusSchema,
    plan: CountsSchema,
    outcomes: OutcomeCountsSchema,
    reconciliation: ImportBatchReconciliationSchema,
    canCommit: z.boolean(),
    createdBy: PersonSchema.nullable(),
    createdAt: z.iso.datetime(),
    validatedAt: z.iso.datetime(),
    commitStartedAt: z.iso.datetime().nullable(),
    committedAt: z.iso.datetime().nullable(),
    committedBy: PersonSchema.nullable(),
    discardedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

export const ImportBatchListSchema = z
  .object({
    batches: z.array(ImportBatchSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ImportBatchList = z.infer<typeof ImportBatchListSchema>;

export const ImportRowSchema = z
  .object({
    rowNumber: z.number().int().min(2),
    externalRef: z.string().nullable(),
    action: ImportRowActionSchema,
    reason: ImportReasonCodeSchema.nullable(),
    reasonMessage: z.string().nullable(),
    errors: z.array(ImportCellErrorSchema),
    match: z
      .object({
        entityType: z.string(),
        entityId: UuidSchema,
        code: z.string(),
      })
      .strict()
      .nullable(),
    amountMinor: z.number().int().nonnegative().nullable(),
    decision: z
      .object({
        decision: ImportDecisionSchema,
        reason: z.string(),
        decidedBy: PersonSchema.nullable(),
        decidedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    outcome: ImportRowOutcomeSchema.nullable(),
    outcomeReason: ImportReasonCodeSchema.nullable(),
    record: z
      .object({
        entityType: z.string(),
        entityId: UuidSchema,
        code: z.string(),
      })
      .strict()
      .nullable(),
    committedAt: z.iso.datetime().nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportRowListSchema = z
  .object({
    rows: z.array(ImportRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ImportRowList = z.infer<typeof ImportRowListSchema>;

/** Response of a row decision: the recounted batch and the decided row. */
export const ImportDecisionResultSchema = z
  .object({ batch: ImportBatchSchema, row: ImportRowSchema })
  .strict();
export type ImportDecisionResult = z.infer<typeof ImportDecisionResultSchema>;

/** Deployment-wide migration reconciliation (TD-706). */
export const ImportReconciliationSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    clients: z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
      })
      .strict(),
    cases: z
      .object({
        active: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        importedStillActive: z.number().int().nonnegative(),
      })
      .strict(),
    openingBalances: z
      .object({
        invoices: z.number().int().nonnegative(),
        totalMinor: z.number().int().nonnegative(),
        outstandingMinor: z.number().int().nonnegative(),
      })
      .strict(),
    batches: z
      .object({
        committed: z.number().int().nonnegative(),
        failedRows: z.number().int().nonnegative(),
      })
      .strict(),
    samples: z.array(
      z
        .object({
          kind: ImportKindSchema,
          batchCode: z.string(),
          rowNumber: z.number().int().min(2),
          externalRef: z.string(),
          entityType: z.string(),
          entityId: UuidSchema,
          code: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type ImportReconciliation = z.infer<typeof ImportReconciliationSchema>;
