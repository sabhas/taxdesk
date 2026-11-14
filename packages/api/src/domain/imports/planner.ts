import {
  CASE_LIMITS,
  CLIENT_LIMITS,
  CLIENT_CODE_PATTERN,
  CASE_CODE_PATTERN,
  CSV_ERROR_MESSAGES,
  ContactEmailSchema,
  ContactPhoneSchema,
  EXTERNAL_REF_PATTERN,
  INVOICE_LIMITS,
  IsoDateSchema,
  addDaysToDate,
  calculateInvoiceTotals,
  importReasonMessage,
  importTemplate,
  normalizeClientName,
  normalizeCnic,
  normalizeEmail,
  normalizeNtn,
  normalizePhone,
  parseCsv,
  parseMajorAmount,
  type ClientType,
  type ImportCellError,
  type ImportKind,
  type ImportReasonCode,
  type ImportTemplateId,
  type WorkflowStatusDefinition,
} from '@taxdesk/shared';
import type {
  IdentifierProtector,
  ProtectedIdentifier,
} from '../../crypto/identifier-protection.js';
import type { Repositories } from '../../repositories/ports.js';
import { AuthError } from '../auth/errors.js';
import type { UserRecord } from '../auth/types.js';
import type {
  ServiceTypeRecord,
  WorkflowTemplateRecord,
  WorkflowVersionRecord,
} from '../catalog/types.js';
import type { ClientRecord } from '../clients/types.js';
import type { TaxCaseRecord } from '../cases/types.js';
import type { ImportEntityRef, ImportRowPlan } from './types.js';

// ---------------------------------------------------------------------------
// Phase 1: file → typed rows (pure; no database)
// ---------------------------------------------------------------------------

export interface ParsedFile {
  readonly templateId: ImportTemplateId;
  readonly kind: ImportKind;
  /** Data rows only; `rowNumber` counts the header as row 1. */
  readonly rows: readonly { readonly rowNumber: number; readonly cells: readonly string[] }[];
}

function fileInvalid(message: string): AuthError {
  return new AuthError(400, 'IMPORT_FILE_INVALID', message, {
    errors: [{ field: 'content', message }],
  });
}

/**
 * Parses and checks the header against the template. A malformed file fails
 * as a whole with a line number and a fixed message; it never echoes content.
 */
export function parseImportFile(templateId: ImportTemplateId, content: string): ParsedFile {
  const template = importTemplate(templateId);
  const parsed = parseCsv(content);
  if (!parsed.ok) {
    throw fileInvalid(`Line ${String(parsed.line)}: ${CSV_ERROR_MESSAGES[parsed.code]}`);
  }
  const [header = [], ...data] = parsed.rows;
  const names = header.map((name) => name.trim().toLowerCase());
  const expected = template.columns.map((column) => column.name);
  const missing = expected.filter((name) => !names.includes(name));
  const unknown = names.filter((name) => !expected.includes(name));
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (missing.length > 0 || unknown.length > 0 || repeated.length > 0) {
    // Column names are template vocabulary, not client data, so naming the
    // expected ones is safe. Unknown header text is never echoed.
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (unknown.length > 0) parts.push(`${String(unknown.length)} unknown column(s)`);
    if (repeated.length > 0) parts.push('repeated columns');
    throw fileInvalid(
      `The header does not match the ${template.id} template (${parts.join('; ')}). Download the template and keep its header row.`,
    );
  }
  // Re-order every row into template column order.
  const order = expected.map((name) => names.indexOf(name));
  return {
    templateId,
    kind: template.kind,
    rows: data.map((cells, index) => ({
      rowNumber: index + 2,
      cells:
        cells.length === names.length
          ? order.map((position) => (cells[position] ?? '').trim())
          : // A wrong cell count is reported per row as WRONG_COLUMN_COUNT.
            [],
    })),
  };
}

class RowErrors {
  readonly errors: ImportCellError[] = [];
  add(column: string, code: ImportReasonCode): void {
    if (!this.errors.some((error) => error.column === column)) {
      this.errors.push({ column, code, message: importReasonMessage(code) });
    }
  }
  merge(other: RowErrors): void {
    for (const error of other.errors) this.add(error.column, error.code);
  }
  get empty(): boolean {
    return this.errors.length === 0;
  }
}

function cellReader(kind: ImportKind, cells: readonly string[]): (name: string) => string {
  const columns = importTemplate(`${kind}.v1`).columns.map((c) => c.name);
  return (name) => cells[columns.indexOf(name)] ?? '';
}

function text(
  errors: RowErrors,
  value: string,
  column: string,
  options: { required?: boolean; max: number },
): string | null {
  if (value.length === 0) {
    if (options.required === true) errors.add(column, 'REQUIRED');
    return null;
  }
  if (value.length > options.max) {
    errors.add(column, 'TOO_LONG');
    return null;
  }
  return value;
}

function externalRef(errors: RowErrors, value: string): string | null {
  if (value.length === 0) {
    errors.add('external_ref', 'REQUIRED');
    return null;
  }
  if (!EXTERNAL_REF_PATTERN.test(value)) {
    errors.add('external_ref', 'INVALID_FORMAT');
    return null;
  }
  return value;
}

function username(errors: RowErrors, value: string, column: string): string | null {
  if (value.length === 0) return null;
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/u.test(normalized)) {
    errors.add(column, 'INVALID_FORMAT');
    return null;
  }
  return normalized;
}

function isoDate(
  errors: RowErrors,
  value: string,
  column: string,
  required: boolean,
): string | null {
  if (value.length === 0) {
    if (required) errors.add(column, 'REQUIRED');
    return null;
  }
  if (!IsoDateSchema.safeParse(value).success) {
    errors.add(column, 'INVALID_DATE');
    return null;
  }
  return value;
}

/** A client reference: a client code, or a client external_ref already imported. */
function reference(
  errors: RowErrors,
  value: string,
  column: string,
  pattern: RegExp,
  required: boolean,
): { readonly code: string } | { readonly externalRef: string } | null {
  if (value.length === 0) {
    if (required) errors.add(column, 'REQUIRED');
    return null;
  }
  const upper = value.toUpperCase();
  if (pattern.test(upper)) {
    return { code: upper };
  }
  if (!EXTERNAL_REF_PATTERN.test(value)) {
    errors.add(column, 'INVALID_FORMAT');
    return null;
  }
  return { externalRef: value };
}

export type Reference = { readonly code: string } | { readonly externalRef: string };

export interface ClientRowInput {
  readonly type: ClientType;
  readonly legalName: string;
  readonly displayName: string;
  readonly cnic: string | null;
  readonly ntn: string | null;
  readonly contact: {
    readonly name: string;
    readonly relationship: string | null;
    readonly email: string | null;
    readonly phone: string | null;
  } | null;
  readonly managerUsername: string | null;
  readonly notes: string;
}

export interface CaseRowInput {
  readonly client: Reference;
  readonly service: string;
  readonly taxYear: number;
  readonly dueDate: string | null;
  readonly statusKey: string | null;
  readonly primaryUsername: string | null;
  readonly reviewerUsername: string | null;
  readonly notes: string;
}

export interface BalanceRowInput {
  readonly client: Reference;
  readonly taxCase: Reference | null;
  readonly asOfDate: string;
  readonly dueDate: string | null;
  readonly amountMinor: number;
  readonly description: string;
}

export type RowInput =
  | { readonly kind: 'clients'; readonly value: ClientRowInput }
  | { readonly kind: 'cases'; readonly value: CaseRowInput }
  | { readonly kind: 'opening_balances'; readonly value: BalanceRowInput };

export interface ValidatedRow {
  readonly rowNumber: number;
  readonly externalRef: string | null;
  readonly errors: readonly ImportCellError[];
  /** `null` when the row has errors. */
  readonly input: RowInput | null;
  /** Earlier rows in the file that look like the same client (name, email, phone). */
  readonly similarInFile: boolean;
}

function validateClient(errors: RowErrors, cell: (name: string) => string): ClientRowInput | null {
  const typeText = cell('client_type').toLowerCase();
  let type: ClientType | null = null;
  if (typeText.length === 0) {
    errors.add('client_type', 'REQUIRED');
  } else if (typeText === 'individual' || typeText === 'business') {
    type = typeText;
  } else {
    errors.add('client_type', 'INVALID_CHOICE');
  }
  const legalName = text(errors, cell('legal_name'), 'legal_name', {
    required: true,
    max: CLIENT_LIMITS.nameMax,
  });
  const displayName = text(errors, cell('display_name'), 'display_name', {
    max: CLIENT_LIMITS.nameMax,
  });
  let cnic: string | null = null;
  const cnicText = cell('cnic');
  if (type === 'business' && cnicText.length > 0) {
    errors.add('cnic', 'NOT_ALLOWED');
  } else if (cnicText.length > 0) {
    cnic = normalizeCnic(cnicText);
    if (cnic === null) errors.add('cnic', 'INVALID_FORMAT');
  } else if (type === 'individual') {
    errors.add('cnic', 'REQUIRED');
  }
  let ntn: string | null = null;
  const ntnText = cell('ntn');
  if (ntnText.length > 0) {
    ntn = normalizeNtn(ntnText);
    if (ntn === null) errors.add('ntn', 'INVALID_FORMAT');
  } else if (type === 'business') {
    errors.add('ntn', 'REQUIRED');
  }
  const contactName = text(errors, cell('contact_name'), 'contact_name', {
    max: CLIENT_LIMITS.contactNameMax,
  });
  const relationship = text(errors, cell('contact_relationship'), 'contact_relationship', {
    max: CLIENT_LIMITS.relationshipMax,
  });
  let email: string | null = null;
  const emailText = cell('contact_email');
  if (emailText.length > 0) {
    if (ContactEmailSchema.safeParse(emailText).success) email = emailText;
    else errors.add('contact_email', 'INVALID_FORMAT');
  }
  let phone: string | null = null;
  const phoneText = cell('contact_phone');
  if (phoneText.length > 0) {
    if (ContactPhoneSchema.safeParse(phoneText).success) phone = phoneText;
    else errors.add('contact_phone', 'INVALID_FORMAT');
  }
  const hasContactDetail = emailText.length > 0 || phoneText.length > 0;
  if (
    contactName === null &&
    cell('contact_name').length === 0 &&
    (hasContactDetail || relationship !== null)
  ) {
    errors.add('contact_name', 'REQUIRED');
  }
  if (contactName !== null && !hasContactDetail) {
    errors.add('contact_email', 'REQUIRED');
  }
  const managerUsername = username(
    errors,
    cell('assigned_manager_username'),
    'assigned_manager_username',
  );
  const notes = text(errors, cell('notes'), 'notes', { max: CLIENT_LIMITS.notesMax }) ?? '';
  if (!errors.empty || type === null || legalName === null) {
    return null;
  }
  return {
    type,
    legalName,
    displayName: displayName ?? legalName,
    cnic,
    ntn,
    contact: contactName === null ? null : { name: contactName, relationship, email, phone },
    managerUsername,
    notes,
  };
}

function validateCase(errors: RowErrors, cell: (name: string) => string): CaseRowInput | null {
  const client = reference(errors, cell('client_ref'), 'client_ref', CLIENT_CODE_PATTERN, true);
  const service = text(errors, cell('service'), 'service', { required: true, max: 120 });
  const yearText = cell('tax_year');
  let taxYear: number | null = null;
  if (yearText.length === 0) {
    errors.add('tax_year', 'REQUIRED');
  } else if (!/^\d{4}$/u.test(yearText)) {
    errors.add('tax_year', 'INVALID_FORMAT');
  } else {
    const year = Number(yearText);
    if (year < CASE_LIMITS.taxYearMin || year > CASE_LIMITS.taxYearMax) {
      errors.add('tax_year', 'INVALID_FORMAT');
    } else {
      taxYear = year;
    }
  }
  const dueDate = isoDate(errors, cell('due_date'), 'due_date', false);
  const statusText = cell('status');
  let statusKey: string | null = null;
  if (statusText.length > 0) {
    if (/^[a-z][a-z0-9_]{0,39}$/u.test(statusText.toLowerCase()))
      statusKey = statusText.toLowerCase();
    else errors.add('status', 'INVALID_FORMAT');
  }
  const primaryUsername = username(
    errors,
    cell('primary_consultant_username'),
    'primary_consultant_username',
  );
  const reviewerUsername = username(errors, cell('reviewer_username'), 'reviewer_username');
  if (primaryUsername !== null && primaryUsername === reviewerUsername) {
    errors.add('reviewer_username', 'SAME_REVIEWER');
  }
  const notes = text(errors, cell('notes'), 'notes', { max: CASE_LIMITS.notesMax }) ?? '';
  if (!errors.empty || client === null || service === null || taxYear === null) {
    return null;
  }
  return { client, service, taxYear, dueDate, statusKey, primaryUsername, reviewerUsername, notes };
}

function validateBalance(
  errors: RowErrors,
  cell: (name: string) => string,
  today: string,
): BalanceRowInput | null {
  const client = reference(errors, cell('client_ref'), 'client_ref', CLIENT_CODE_PATTERN, true);
  const taxCase = reference(errors, cell('case_ref'), 'case_ref', CASE_CODE_PATTERN, false);
  const asOfDate = isoDate(errors, cell('as_of_date'), 'as_of_date', true);
  if (asOfDate !== null && asOfDate > today) {
    errors.add('as_of_date', 'DATE_IN_FUTURE');
  }
  const dueDate = isoDate(errors, cell('due_date'), 'due_date', false);
  if (dueDate !== null && asOfDate !== null && dueDate < asOfDate) {
    errors.add('due_date', 'DATE_BEFORE_START');
  }
  const amountText = cell('amount');
  let amountMinor: number | null = null;
  if (amountText.length === 0) {
    errors.add('amount', 'REQUIRED');
  } else {
    const parsed = parseMajorAmount(amountText);
    const totals =
      parsed === null
        ? null
        : calculateInvoiceTotals([{ description: 'x', quantity: 1, unitAmountMinor: parsed }], 0);
    if (parsed === null || parsed <= 0 || totals?.ok !== true) {
      errors.add('amount', 'INVALID_AMOUNT');
    } else {
      amountMinor = parsed;
    }
  }
  const description = text(errors, cell('description'), 'description', {
    max: INVOICE_LIMITS.descriptionMax,
  });
  if (!errors.empty || client === null || asOfDate === null || amountMinor === null) {
    return null;
  }
  return {
    client,
    taxCase,
    asOfDate,
    dueDate,
    amountMinor,
    description: description ?? `Opening balance as of ${asOfDate}`,
  };
}

/**
 * Validates every row's cells and the file-wide rules: an external reference,
 * CNIC, or NTN may appear only once. Rows that look like another row of the
 * same file (name, email, or phone) are flagged for review.
 */
export function validateRows(file: ParsedFile, today: string): ValidatedRow[] {
  const seenRefs = new Set<string>();
  const seenCnic = new Set<string>();
  const seenNtn = new Set<string>();
  const seenNames = new Set<string>();
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const result: ValidatedRow[] = [];
  for (const row of file.rows) {
    const errors = new RowErrors();
    if (row.cells.length === 0) {
      errors.add('row', 'WRONG_COLUMN_COUNT');
      result.push({
        rowNumber: row.rowNumber,
        externalRef: null,
        errors: errors.errors,
        input: null,
        similarInFile: false,
      });
      continue;
    }
    const cell = cellReader(file.kind, row.cells);
    const ref = externalRef(errors, cell('external_ref'));
    if (ref !== null) {
      const key = ref.toLowerCase();
      if (seenRefs.has(key)) errors.add('external_ref', 'DUPLICATE_IN_FILE');
      seenRefs.add(key);
    }
    let input: RowInput | null = null;
    let similarInFile = false;
    if (file.kind === 'clients') {
      const local = new RowErrors();
      const value = validateClient(local, cell);
      errors.merge(local);
      // Identifiers are unique per file even when another cell of a row is invalid.
      const cnic = normalizeCnic(cell('cnic'));
      if (cnic !== null) {
        if (seenCnic.has(cnic)) errors.add('cnic', 'DUPLICATE_IN_FILE');
        seenCnic.add(cnic);
      }
      const ntn = normalizeNtn(cell('ntn'));
      if (ntn !== null) {
        if (seenNtn.has(ntn)) errors.add('ntn', 'DUPLICATE_IN_FILE');
        seenNtn.add(ntn);
      }
      if (value !== null) {
        const name = normalizeClientName(value.legalName);
        const email = value.contact?.email == null ? null : normalizeEmail(value.contact.email);
        const phone = value.contact?.phone == null ? null : normalizePhone(value.contact.phone);
        similarInFile =
          seenNames.has(name) ||
          (email !== null && seenEmails.has(email)) ||
          (phone !== null && seenPhones.has(phone));
        seenNames.add(name);
        if (email !== null) seenEmails.add(email);
        if (phone !== null) seenPhones.add(phone);
        input = { kind: 'clients', value };
      }
    } else if (file.kind === 'cases') {
      const local = new RowErrors();
      const value = validateCase(local, cell);
      errors.merge(local);
      if (value !== null) input = { kind: 'cases', value };
    } else {
      const local = new RowErrors();
      const value = validateBalance(local, cell, today);
      errors.merge(local);
      if (value !== null) input = { kind: 'opening_balances', value };
    }
    result.push({
      rowNumber: row.rowNumber,
      externalRef: ref,
      errors: errors.errors,
      input: errors.empty ? input : null,
      similarInFile,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: resolve against the database
// ---------------------------------------------------------------------------

export type Execution =
  | {
      readonly kind: 'client_create';
      readonly input: ClientRowInput;
      readonly cnic: ProtectedIdentifier | null;
      readonly ntn: ProtectedIdentifier | null;
      readonly managerUserId: string | null;
    }
  | {
      readonly kind: 'client_update';
      readonly client: ClientRecord;
      readonly input: ClientRowInput;
      readonly managerUserId: string | null;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'case_create';
      readonly client: ClientRecord;
      readonly service: ServiceTypeRecord;
      readonly template: WorkflowTemplateRecord;
      readonly version: WorkflowVersionRecord;
      readonly initial: WorkflowStatusDefinition;
      readonly status: WorkflowStatusDefinition;
      readonly taxYear: number;
      readonly dueDate: string;
      readonly primaryUserId: string | null;
      readonly reviewerUserId: string | null;
      readonly notes: string;
    }
  | {
      readonly kind: 'invoice_create';
      readonly client: ClientRecord;
      readonly taxCase: TaxCaseRecord | null;
      readonly input: BalanceRowInput;
    };

export interface ResolvedRow {
  readonly plan: ImportRowPlan;
  /** What the commit writes for a create/update; `null` for skip/review/error. */
  readonly execution: Execution | null;
  /** For a review row, what a "create" decision would write. */
  readonly reviewExecution: Execution | null;
}

/** Per-run lookups shared by every row of one dry run or commit chunk. */
export class ResolveContext {
  private readonly users = new Map<string, UserRecord | null>();
  private readonly assignable = new Map<string, boolean>();
  private services: ServiceTypeRecord[] | null = null;
  private readonly workflows = new Map<
    string,
    { template: WorkflowTemplateRecord; version: WorkflowVersionRecord } | null
  >();
  /** File-wide (client, service, year) keys of cases planned for creation. */
  readonly plannedCases = new Set<string>();

  constructor(
    readonly repositories: Repositories,
    readonly identifiers: IdentifierProtector | null,
    readonly today: string,
  ) {}

  async user(name: string): Promise<UserRecord | null> {
    if (!this.users.has(name)) {
      const user = await this.repositories.users.findByUsername(name);
      this.users.set(name, user?.status === 'active' ? user : null);
    }
    return this.users.get(name) ?? null;
  }

  async caseWorker(name: string): Promise<UserRecord | null> {
    const user = await this.user(name);
    if (user === null) return null;
    if (!this.assignable.has(user.id)) {
      const permissions = await this.repositories.roles.permissionsForUser(user.id);
      this.assignable.set(
        user.id,
        permissions.includes('cases.work_assigned') || permissions.includes('cases.manage'),
      );
    }
    return this.assignable.get(user.id) === true ? user : null;
  }

  async service(name: string): Promise<ServiceTypeRecord | null> {
    this.services ??= await this.repositories.serviceTypes.list('active');
    const wanted = name.trim().toLowerCase();
    return this.services.find((service) => service.name.trim().toLowerCase() === wanted) ?? null;
  }

  async workflow(
    templateId: string,
  ): Promise<{ template: WorkflowTemplateRecord; version: WorkflowVersionRecord } | null> {
    if (!this.workflows.has(templateId)) {
      const template = await this.repositories.workflowTemplates.findTemplate(templateId);
      const versions = await this.repositories.workflowTemplates.listVersions([templateId]);
      const latest = versions
        .filter((version) => version.state === 'published')
        .sort((left, right) => right.versionNumber - left.versionNumber)[0];
      this.workflows.set(
        templateId,
        template === null || latest === undefined ? null : { template, version: latest },
      );
    }
    return this.workflows.get(templateId) ?? null;
  }

  async client(ref: Reference): Promise<ClientRecord | null> {
    if ('code' in ref) {
      return await this.repositories.clients.findByCode(ref.code);
    }
    const lineage = await this.repositories.imports.findLineage('clients', ref.externalRef);
    return lineage === null ? null : await this.repositories.clients.findById(lineage.entityId);
  }

  async taxCase(ref: Reference): Promise<TaxCaseRecord | null> {
    if ('code' in ref) {
      return await this.repositories.cases.findByCode(ref.code);
    }
    const lineage = await this.repositories.imports.findLineage('cases', ref.externalRef);
    return lineage === null ? null : await this.repositories.cases.findById(lineage.entityId);
  }
}

function base(row: ValidatedRow): Omit<ImportRowPlan, 'action' | 'reasonCode'> {
  return {
    rowNumber: row.rowNumber,
    externalRef: row.externalRef,
    errors: row.errors,
    match: null,
    amountMinor: row.input?.kind === 'opening_balances' ? row.input.value.amountMinor : null,
  };
}

function errorRow(row: ValidatedRow, column: string, code: ImportReasonCode): ResolvedRow {
  return {
    plan: {
      ...base(row),
      action: 'error',
      reasonCode: code,
      errors: [...row.errors, { column, code, message: importReasonMessage(code) }],
    },
    execution: null,
    reviewExecution: null,
  };
}

function skipRow(row: ValidatedRow, code: ImportReasonCode, match: ImportEntityRef): ResolvedRow {
  return {
    plan: { ...base(row), action: 'skip', reasonCode: code, match },
    execution: null,
    reviewExecution: null,
  };
}

function clientRef(client: ClientRecord): ImportEntityRef {
  return { entityType: 'client', entityId: client.id, code: client.clientCode };
}

function protectionUnavailable(): AuthError {
  return new AuthError(
    503,
    'SERVICE_UNAVAILABLE',
    'Client identifier protection is not configured for this deployment.',
  );
}

async function resolveClient(
  row: ValidatedRow,
  input: ClientRowInput,
  context: ResolveContext,
): Promise<ResolvedRow> {
  const protector = context.identifiers;
  if (protector === null) {
    throw protectionUnavailable();
  }
  let managerUserId: string | null = null;
  if (input.managerUsername !== null) {
    const manager = await context.user(input.managerUsername);
    if (manager === null) return errorRow(row, 'assigned_manager_username', 'USER_NOT_FOUND');
    managerUserId = manager.id;
  }
  const cnicIndex = input.cnic === null ? null : await protector.blindIndex('cnic', input.cnic);
  const ntnIndex = input.ntn === null ? null : await protector.blindIndex('ntn', input.ntn);

  const lineage =
    row.externalRef === null
      ? null
      : await context.repositories.imports.findLineage('clients', row.externalRef);
  if (lineage !== null) {
    const existing = await context.repositories.clients.findById(lineage.entityId);
    if (existing === null) return errorRow(row, 'external_ref', 'CLIENT_NOT_FOUND');
    if (
      existing.type !== input.type ||
      (cnicIndex !== null && existing.cnic?.blindIndex !== cnicIndex) ||
      (ntnIndex !== null && existing.ntn?.blindIndex !== ntnIndex)
    ) {
      return errorRow(row, 'external_ref', 'IDENTIFIER_CHANGED');
    }
    const changedFields: string[] = [];
    if (existing.legalName !== input.legalName) changedFields.push('legalName');
    if (existing.displayName !== input.displayName) changedFields.push('displayName');
    if (existing.notes !== input.notes) changedFields.push('notes');
    if (existing.assignedManagerUserId !== managerUserId) changedFields.push('assignedManager');
    if (changedFields.length === 0) {
      return skipRow(row, 'ALREADY_IMPORTED', clientRef(existing));
    }
    if (existing.deletedAt !== null) return errorRow(row, 'external_ref', 'CLIENT_ARCHIVED');
    return {
      plan: {
        ...base(row),
        action: 'update',
        reasonCode: 'UPDATES_EXISTING',
        match: clientRef(existing),
      },
      execution: { kind: 'client_update', client: existing, input, managerUserId, changedFields },
      reviewExecution: null,
    };
  }

  const emails = input.contact?.email == null ? [] : [normalizeEmail(input.contact.email)];
  const phones = input.contact?.phone == null ? [] : [normalizePhone(input.contact.phone)];
  const candidates = await context.repositories.clients.findDuplicateCandidates({
    cnicIndex,
    ntnIndex,
    emails,
    phones,
    normalizedName: normalizeClientName(input.legalName),
    excludeClientId: null,
  });
  const exact = candidates.find((candidate) =>
    candidate.reasons.some((reason) => reason === 'cnic' || reason === 'ntn'),
  );
  if (exact !== undefined) {
    return skipRow(row, 'EXISTING_CLIENT', clientRef(exact.client));
  }
  const execution: Execution = {
    kind: 'client_create',
    input,
    cnic: input.cnic === null ? null : await protector.protect('cnic', input.cnic),
    ntn: input.ntn === null ? null : await protector.protect('ntn', input.ntn),
    managerUserId,
  };
  const similar = candidates[0];
  if (similar !== undefined || row.similarInFile) {
    return {
      plan: {
        ...base(row),
        action: 'review',
        reasonCode: 'POSSIBLE_DUPLICATE',
        match: similar === undefined ? null : clientRef(similar.client),
      },
      execution: null,
      reviewExecution: execution,
    };
  }
  return {
    plan: { ...base(row), action: 'create', reasonCode: null },
    execution,
    reviewExecution: null,
  };
}

async function resolveCase(
  row: ValidatedRow,
  input: CaseRowInput,
  context: ResolveContext,
): Promise<ResolvedRow> {
  if (row.externalRef !== null) {
    const lineage = await context.repositories.imports.findLineage('cases', row.externalRef);
    if (lineage !== null) return skipRow(row, 'ALREADY_IMPORTED', lineage);
  }
  const client = await context.client(input.client);
  if (client === null) return errorRow(row, 'client_ref', 'CLIENT_NOT_FOUND');
  if (client.deletedAt !== null) return errorRow(row, 'client_ref', 'CLIENT_ARCHIVED');
  const service = await context.service(input.service);
  if (service === null) return errorRow(row, 'service', 'SERVICE_NOT_FOUND');
  const workflow =
    service.defaultWorkflowTemplateId === null
      ? null
      : await context.workflow(service.defaultWorkflowTemplateId);
  if (workflow === null) return errorRow(row, 'service', 'SERVICE_WITHOUT_WORKFLOW');
  const statuses = workflow.version.definition.statuses;
  const initial = statuses.find((status) => status.initial);
  if (initial === undefined) return errorRow(row, 'service', 'SERVICE_WITHOUT_WORKFLOW');
  let status = initial;
  if (input.statusKey !== null) {
    const found = statuses.find((candidate) => candidate.key === input.statusKey);
    if (found?.kind !== 'open') return errorRow(row, 'status', 'STATUS_NOT_FOUND');
    status = found;
  }
  let primaryUserId: string | null = null;
  if (input.primaryUsername !== null) {
    const user = await context.caseWorker(input.primaryUsername);
    if (user === null) return errorRow(row, 'primary_consultant_username', 'USER_NOT_FOUND');
    primaryUserId = user.id;
  }
  let reviewerUserId: string | null = null;
  if (input.reviewerUsername !== null) {
    const user = await context.caseWorker(input.reviewerUsername);
    if (user === null) return errorRow(row, 'reviewer_username', 'USER_NOT_FOUND');
    reviewerUserId = user.id;
  }
  const duplicates = await context.repositories.cases.findActiveDuplicates({
    clientId: client.id,
    serviceTypeId: service.id,
    taxYear: input.taxYear,
  });
  const first = duplicates[0];
  if (first !== undefined) {
    return skipRow(row, 'EXISTING_CASE', {
      entityType: 'tax_case',
      entityId: first.id,
      code: first.caseCode,
    });
  }
  const key = `${client.id}|${service.id}|${String(input.taxYear)}`;
  if (context.plannedCases.has(key)) {
    return errorRow(row, 'tax_year', 'DUPLICATE_IN_FILE');
  }
  context.plannedCases.add(key);
  return {
    plan: { ...base(row), action: 'create', reasonCode: null },
    execution: {
      kind: 'case_create',
      client,
      service,
      template: workflow.template,
      version: workflow.version,
      initial,
      status,
      taxYear: input.taxYear,
      dueDate: input.dueDate ?? addDaysToDate(context.today, service.defaultDeadlineOffsetDays),
      primaryUserId,
      reviewerUserId,
      notes: input.notes,
    },
    reviewExecution: null,
  };
}

async function resolveBalance(
  row: ValidatedRow,
  input: BalanceRowInput,
  context: ResolveContext,
): Promise<ResolvedRow> {
  if (row.externalRef !== null) {
    const lineage = await context.repositories.imports.findLineage(
      'opening_balances',
      row.externalRef,
    );
    if (lineage !== null) return skipRow(row, 'ALREADY_IMPORTED', lineage);
  }
  const client = await context.client(input.client);
  if (client === null) return errorRow(row, 'client_ref', 'CLIENT_NOT_FOUND');
  if (client.deletedAt !== null) return errorRow(row, 'client_ref', 'CLIENT_ARCHIVED');
  let taxCase: TaxCaseRecord | null = null;
  if (input.taxCase !== null) {
    taxCase = await context.taxCase(input.taxCase);
    if (taxCase === null) return errorRow(row, 'case_ref', 'CASE_NOT_FOUND');
    if (taxCase.clientId !== client.id) return errorRow(row, 'case_ref', 'CASE_OTHER_CLIENT');
  }
  return {
    plan: { ...base(row), action: 'create', reasonCode: null },
    execution: { kind: 'invoice_create', client, taxCase, input },
    reviewExecution: null,
  };
}

export async function resolveRow(row: ValidatedRow, context: ResolveContext): Promise<ResolvedRow> {
  if (row.input === null) {
    return {
      plan: {
        ...base(row),
        action: 'error',
        reasonCode: row.errors[0]?.code ?? 'INVALID_FORMAT',
      },
      execution: null,
      reviewExecution: null,
    };
  }
  switch (row.input.kind) {
    case 'clients':
      return await resolveClient(row, row.input.value, context);
    case 'cases':
      return await resolveCase(row, row.input.value, context);
    case 'opening_balances':
      return await resolveBalance(row, row.input.value, context);
  }
}
