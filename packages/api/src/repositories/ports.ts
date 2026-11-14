import type {
  ActivationPurpose,
  ActivationTokenRecord,
  AuditEventRecord,
  FirmRecord,
  LoginAttemptRecord,
  LoginChallengeRecord,
  MfaCredentialRecord,
  RecoveryCodeRecord,
  RoleRecord,
  SessionRecord,
  UserRecord,
} from '../domain/auth/types.js';
import type {
  ClientChanges,
  ClientContactRecord,
  ClientListFilter,
  ClientListPage,
  ClientRecord,
  DuplicateCandidate,
  DuplicateCandidateQuery,
} from '../domain/clients/types.js';
import type {
  ServiceTypeChanges,
  ServiceTypeRecord,
  WorkflowTemplateRecord,
  WorkflowVersionRecord,
} from '../domain/catalog/types.js';
import type {
  CaseChecklistItemRecord,
  CaseDetailChanges,
  CaseListFilter,
  CaseListPage,
  CaseQueryFilter,
  CaseStatusHistoryRecord,
  ChecklistItemChanges,
  TaxCaseRecord,
} from '../domain/cases/types.js';
import type {
  ReconciliationRunRecord,
  StorageConnectionChanges,
  StorageConnectionRecord,
  StorageOAuthStateRecord,
} from '../domain/storage/types.js';
import type {
  DocumentChanges,
  DocumentListFilter,
  DocumentListPage,
  DocumentRecord,
  DocumentUploadChanges,
  DocumentUploadRecord,
} from '../domain/documents/types.js';
import type {
  BillingDocumentRecord,
  IdempotencyBegin,
  InvoiceBalance,
  InvoiceDraftChanges,
  InvoiceFinalization,
  InvoiceItemRecord,
  InvoiceListFilter,
  InvoiceListPage,
  InvoiceRecord,
  InvoiceVoiding,
  PaymentRecord,
  PaymentReversalRecord,
} from '../domain/billing/types.js';
import type { BillingPdfState, WorkflowDefinition } from '@taxdesk/shared';

export interface PaginatedAuditEvents {
  readonly events: readonly AuditEventRecord[];
  readonly nextCursor: string | null;
}

export interface FirmRepository {
  get(): Promise<FirmRecord | null>;
  create(input: {
    readonly id: string;
    readonly firmName: string;
    readonly timezone: string;
    readonly createdAt: string;
  }): Promise<FirmRecord>;
  completeBootstrap(id: string, at: string): Promise<void>;
  updateSettings(input: {
    readonly id: string;
    readonly firmName: string;
    readonly timezone: string;
    readonly currency: string;
    readonly invoicePrefix: string;
    readonly receiptPrefix: string;
    readonly documentMaxUploadBytes: number;
    readonly dueSoonDays: number;
    readonly expectedVersion: number;
    readonly updatedAt: string;
  }): Promise<FirmRecord | null>;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByUsername(username: string): Promise<UserRecord | null>;
  list(): Promise<UserRecord[]>;
  create(input: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly passwordHash: string | null;
    readonly passwordHashVersion: number | null;
    readonly status: UserRecord['status'];
    readonly createdAt: string;
  }): Promise<UserRecord>;
  updatePassword(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly passwordHashVersion: number;
    readonly at: string;
  }): Promise<void>;
  activateWithPassword(input: {
    readonly userId: string;
    readonly passwordHash: string;
    readonly passwordHashVersion: number;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<UserRecord | null>;
  updateStatus(input: {
    readonly userId: string;
    readonly status: 'active' | 'deactivated';
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<UserRecord | null>;
  bumpVersion(input: {
    readonly userId: string;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<UserRecord | null>;
  setMfaEnrolledAt(userId: string, at: string | null): Promise<void>;
  touchLastLogin(userId: string, at: string): Promise<void>;
  countActiveAdministrators(): Promise<number>;
}

export interface RoleRepository {
  seedBuiltInRoles(at: string): Promise<void>;
  listRoles(): Promise<RoleRecord[]>;
  rolesForUser(userId: string): Promise<RoleRecord[]>;
  permissionsForUser(userId: string): Promise<string[]>;
  replaceRoles(input: {
    readonly userId: string;
    readonly roleKeys: readonly string[];
    readonly assignedAt: string;
    readonly assignedBy: string | null;
  }): Promise<void>;
}

export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: string, idleExpiresAt: string): Promise<void>;
  markMfaVerified(id: string, at: string): Promise<void>;
  revoke(id: string, at: string): Promise<void>;
  revokeAllForUser(input: {
    readonly userId: string;
    readonly at: string;
    readonly exceptSessionId?: string;
  }): Promise<number>;
}

export interface ActivationTokenRepository {
  create(record: ActivationTokenRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ActivationTokenRecord | null>;
  consume(id: string, at: string): Promise<boolean>;
  invalidateForUser(input: {
    readonly userId: string;
    readonly purpose: ActivationPurpose;
    readonly at: string;
  }): Promise<number>;
}

export interface LoginChallengeRepository {
  create(record: LoginChallengeRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<LoginChallengeRecord | null>;
  consume(id: string, at: string): Promise<boolean>;
  invalidateForUser(userId: string, at: string): Promise<number>;
}

export interface MfaRepository {
  getCredential(userId: string): Promise<MfaCredentialRecord | null>;
  upsertUnconfirmed(input: {
    readonly userId: string;
    readonly secretCiphertext: string;
    readonly keyVersion: number;
    readonly at: string;
  }): Promise<void>;
  confirm(userId: string, at: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<void>;
  listRecoveryCodes(userId: string): Promise<RecoveryCodeRecord[]>;
  replaceRecoveryCodes(userId: string, records: readonly RecoveryCodeRecord[]): Promise<void>;
  consumeRecoveryCode(userId: string, codeHash: string, at: string): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
}

/** Audit explorer filter (TD-604). Dates are firm-calendar days, inclusive. */
export interface AuditSearchFilter {
  readonly actorUserId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  /** Timezone the `from`/`to` days are read in. */
  readonly timezone: string;
  /** An exact action, or a prefix ending in `.*`. */
  readonly action: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly requestId: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface AuditRepository {
  append(record: AuditEventRecord): Promise<void>;
  /** Newest first. */
  search(filter: AuditSearchFilter): Promise<PaginatedAuditEvents>;
  list(input: {
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<PaginatedAuditEvents>;
  /** One record's history, newest first (client activity). */
  listForEntity(input: {
    readonly entityType: string;
    readonly entityId: string;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<PaginatedAuditEvents>;
}

/**
 * Raised by a client repository when a write would duplicate a CNIC or NTN
 * blind index (a concurrent create, or an update to an existing identifier).
 */
export class DuplicateClientIdentifierError extends Error {
  constructor() {
    super('A client with this identifier already exists.');
    this.name = 'DuplicateClientIdentifierError';
  }
}

export interface ClientRepository {
  /** Draws the next client-code number. Numbers are never reused. */
  nextClientNumber(): Promise<number>;
  create(client: ClientRecord, contacts: readonly ClientContactRecord[]): Promise<void>;
  findById(id: string): Promise<ClientRecord | null>;
  listContacts(clientIds: readonly string[]): Promise<ClientContactRecord[]>;
  /** Optimistic update; `null` when `expectedVersion` is stale or the client is missing. */
  update(input: {
    readonly id: string;
    readonly changes: ClientChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<ClientRecord | null>;
  replaceContacts(clientId: string, contacts: readonly ClientContactRecord[]): Promise<void>;
  /** Archives (`archivedAt` set) or restores (`null`); `null` result when stale. */
  setArchived(input: {
    readonly id: string;
    readonly archivedAt: string | null;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<ClientRecord | null>;
  list(filter: ClientListFilter): Promise<ClientListPage>;
  findDuplicateCandidates(query: DuplicateCandidateQuery): Promise<DuplicateCandidate[]>;
}

/** Raised when a write would duplicate a unique name (service type or template). */
export class DuplicateNameError extends Error {
  constructor() {
    super('The name is already in use.');
    this.name = 'DuplicateNameError';
  }
}

/** Raised when a template already has a draft version. */
export class DraftExistsError extends Error {
  constructor() {
    super('The template already has a draft.');
    this.name = 'DraftExistsError';
  }
}

export interface ServiceTypeRepository {
  create(record: ServiceTypeRecord): Promise<void>;
  findById(id: string): Promise<ServiceTypeRecord | null>;
  /** Ordered by name. */
  list(state: 'active' | 'archived' | 'all'): Promise<ServiceTypeRecord[]>;
  update(input: {
    readonly id: string;
    readonly changes: ServiceTypeChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<ServiceTypeRecord | null>;
  setArchived(input: {
    readonly id: string;
    readonly archivedAt: string | null;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<ServiceTypeRecord | null>;
}

export interface WorkflowTemplateRepository {
  create(template: WorkflowTemplateRecord, draft: WorkflowVersionRecord): Promise<void>;
  findTemplate(id: string): Promise<WorkflowTemplateRecord | null>;
  /** Ordered by name. */
  listTemplates(): Promise<WorkflowTemplateRecord[]>;
  updateTemplate(input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<WorkflowTemplateRecord | null>;
  /** Versions of the given templates, ordered by template then version number. */
  listVersions(templateIds: readonly string[]): Promise<WorkflowVersionRecord[]>;
  findVersion(id: string): Promise<WorkflowVersionRecord | null>;
  /** Throws `DraftExistsError` when the template already has a draft. */
  createVersion(record: WorkflowVersionRecord): Promise<void>;
  /** Replaces a draft's definition; `null` when stale or no longer a draft. */
  updateDraft(input: {
    readonly id: string;
    readonly definition: WorkflowDefinition;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<WorkflowVersionRecord | null>;
  /** Publishes a draft; `null` when stale or no longer a draft. */
  publish(input: {
    readonly id: string;
    readonly publishedBy: string;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<WorkflowVersionRecord | null>;
}

export interface CaseRepository {
  /** Draws the next case-code number. Numbers are never reused. */
  nextCaseNumber(): Promise<number>;
  /**
   * Serializes case creation for one client inside the current transaction,
   * so two concurrent creates cannot both pass the duplicate check.
   */
  lockClientForCaseCreation(clientId: string): Promise<void>;
  /** Cases for the client/service/tax year that are not closed or archived. */
  findActiveDuplicates(input: {
    readonly clientId: string;
    readonly serviceTypeId: string;
    readonly taxYear: number;
  }): Promise<TaxCaseRecord[]>;
  create(
    record: TaxCaseRecord,
    initialStatus: CaseStatusHistoryRecord,
    items: readonly CaseChecklistItemRecord[],
  ): Promise<void>;
  findById(id: string): Promise<TaxCaseRecord | null>;
  /** Reads and row-locks a case for the rest of the transaction. */
  lockById(id: string): Promise<TaxCaseRecord | null>;
  updateDetails(input: {
    readonly id: string;
    readonly changes: CaseDetailChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<TaxCaseRecord | null>;
  /**
   * Appends the history row and moves the case to its status in one step;
   * `null` (and nothing written) when the expected version is stale.
   */
  transition(input: {
    readonly entry: CaseStatusHistoryRecord;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<TaxCaseRecord | null>;
  archive(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<TaxCaseRecord | null>;
  /** Ordered by case then position. */
  listItems(caseIds: readonly string[]): Promise<CaseChecklistItemRecord[]>;
  updateItem(input: {
    readonly caseId: string;
    readonly itemId: string;
    readonly changes: ChecklistItemChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<CaseChecklistItemRecord | null>;
  /** Oldest first. */
  listStatusHistory(caseId: string): Promise<CaseStatusHistoryRecord[]>;
  list(filter: CaseListFilter): Promise<CaseListPage>;
  count(filter: CaseQueryFilter): Promise<number>;
}

/** The deployment's single storage connection (TD-402–TD-404). */
export interface StorageConnectionRepository {
  get(): Promise<StorageConnectionRecord | null>;
  /**
   * Reads and row-locks the connection for the rest of the transaction, so a
   * token refresh or disconnect is serialized with every other writer.
   */
  lock(): Promise<StorageConnectionRecord | null>;
  /** Inserts the singleton row; throws if one already exists. */
  create(record: StorageConnectionRecord): Promise<void>;
  /** Optimistic update; `null` when `expectedVersion` is stale. */
  update(input: {
    readonly id: string;
    readonly changes: StorageConnectionChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<StorageConnectionRecord | null>;
}

export interface StorageOAuthStateRepository {
  create(record: StorageOAuthStateRecord): Promise<void>;
  findByStateHash(stateHash: string): Promise<StorageOAuthStateRecord | null>;
  /** Marks a state consumed; `false` when it was already consumed (single use). */
  consume(id: string, at: string): Promise<boolean>;
  pruneBefore(before: string): Promise<number>;
}

/** Raised when a second document would be created from the same upload. */
export class DuplicateDocumentUploadError extends Error {
  constructor() {
    super('A document already exists for this upload.');
    this.name = 'DuplicateDocumentUploadError';
  }
}

export interface DocumentRepository {
  /** Throws `DuplicateDocumentUploadError` when `uploadId` already produced a document. */
  create(record: DocumentRecord): Promise<void>;
  findById(id: string): Promise<DocumentRecord | null>;
  findByUploadId(uploadId: string): Promise<DocumentRecord | null>;
  /** Reads and row-locks a document for the rest of the transaction. */
  lockById(id: string): Promise<DocumentRecord | null>;
  update(input: {
    readonly id: string;
    readonly changes: DocumentChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<DocumentRecord | null>;
  /** Newest first (`uploadedAt` desc, `id` desc). */
  list(filter: DocumentListFilter): Promise<DocumentListPage>;
  /** Non-deleted documents linked to any of the checklist items. */
  listForChecklistItems(itemIds: readonly string[]): Promise<DocumentRecord[]>;
  /**
   * A page of non-deleted documents for reconciliation, ordered by `id`,
   * starting after `afterId`.
   */
  listForReconciliation(input: {
    readonly afterId: string | null;
    readonly limit: number;
  }): Promise<DocumentRecord[]>;
}

export interface DocumentUploadRepository {
  create(record: DocumentUploadRecord): Promise<void>;
  findById(id: string): Promise<DocumentUploadRecord | null>;
  /** The upload a user already started with this request ID (idempotent create). */
  findByRequest(createdBy: string, requestId: string): Promise<DocumentUploadRecord | null>;
  lockById(id: string): Promise<DocumentUploadRecord | null>;
  update(input: {
    readonly id: string;
    readonly changes: DocumentUploadChanges;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<DocumentUploadRecord | null>;
}

export interface ReconciliationRunRepository {
  append(record: ReconciliationRunRecord): Promise<void>;
  /** Newest first. */
  listRecent(limit: number): Promise<ReconciliationRunRecord[]>;
}

/** Raised when two invoices or payments would share a number (a counter bug). */
export class DuplicateBillingNumberError extends Error {
  constructor() {
    super('The billing number is already in use.');
    this.name = 'DuplicateBillingNumberError';
  }
}

export interface InvoiceRepository {
  /** Inserts a draft and its line items. */
  create(record: InvoiceRecord, items: readonly InvoiceItemRecord[]): Promise<void>;
  findById(id: string): Promise<InvoiceRecord | null>;
  /** Reads and row-locks an invoice for the rest of the transaction. */
  lockById(id: string): Promise<InvoiceRecord | null>;
  /** Ordered by position. */
  listItems(invoiceId: string): Promise<InvoiceItemRecord[]>;
  /**
   * Replaces a draft's content and line items; `null` (and nothing written)
   * when `expectedVersion` is stale or the invoice is no longer a draft.
   */
  replaceDraft(input: {
    readonly id: string;
    readonly changes: InvoiceDraftChanges;
    readonly items: readonly InvoiceItemRecord[];
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<InvoiceRecord | null>;
  /** Draft → finalized with its number; `null` when stale or not a draft. */
  finalize(input: {
    readonly id: string;
    readonly finalization: InvoiceFinalization;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<InvoiceRecord | null>;
  /** Draft/finalized → void. The caller holds the row lock and has checked the version. */
  void(input: {
    readonly id: string;
    readonly voiding: InvoiceVoiding;
    readonly expectedVersion: number;
    readonly at: string;
  }): Promise<InvoiceRecord>;
  /** Applies a recalculated balance to a row-locked invoice and bumps its version. */
  applyBalance(input: {
    readonly id: string;
    readonly balance: InvoiceBalance;
    readonly at: string;
  }): Promise<InvoiceRecord>;
  /** Records PDF generation state without bumping the invoice version. */
  setPdf(input: {
    readonly id: string;
    readonly state: BillingPdfState;
    readonly documentId: string | null;
    readonly at: string;
  }): Promise<void>;
  /** Newest first (`createdAt` desc, `id` desc). */
  list(filter: InvoiceListFilter): Promise<InvoiceListPage>;
}

/** Money totals for the billing report and dashboard (TD-601, TD-603). */
export interface InvoiceTotalsFilter {
  readonly issuedFrom: string | null;
  readonly issuedTo: string | null;
  /** Firm-calendar today; an invoice is overdue when its due date is before it. */
  readonly today: string;
  readonly clientId: string | null;
  /** Empty array means no invoice is visible. */
  readonly visibleClientIds: readonly string[] | null;
}

export interface CollectionTotalsFilter {
  readonly from: string;
  readonly to: string;
  /** Timezone a reversal's timestamp is read in to find its calendar day. */
  readonly timezone: string;
  readonly clientId: string | null;
  readonly visibleClientIds: readonly string[] | null;
}

export interface CountAmount {
  readonly count: number;
  readonly amountMinor: number;
}

export interface BillingReportRepository {
  /** Finalized invoices only; void and draft invoices never count. */
  invoiceTotals(filter: InvoiceTotalsFilter): Promise<{
    readonly invoiced: CountAmount;
    readonly outstanding: CountAmount;
    readonly overdue: CountAmount;
  }>;
  collectionTotals(filter: CollectionTotalsFilter): Promise<{
    readonly collected: CountAmount;
    readonly reversed: CountAmount;
  }>;
}

export interface PaymentRepository {
  create(record: PaymentRecord): Promise<void>;
  findById(id: string): Promise<PaymentRecord | null>;
  /** Oldest first. */
  listForInvoice(invoiceId: string): Promise<PaymentRecord[]>;
  setReceiptPdf(input: {
    readonly id: string;
    readonly state: BillingPdfState;
    readonly documentId: string | null;
    readonly at: string;
  }): Promise<void>;
  appendReversal(record: PaymentReversalRecord): Promise<void>;
  /** Oldest first. */
  listReversalsForInvoice(invoiceId: string): Promise<PaymentReversalRecord[]>;
}

export interface BillingDocumentRepository {
  create(record: BillingDocumentRecord): Promise<void>;
  findById(id: string): Promise<BillingDocumentRecord | null>;
}

export interface NumberSequenceRepository {
  /**
   * Draws the next gapless number. The counter row is locked by the calling
   * transaction, so a rollback returns the number and concurrent callers
   * queue instead of skipping or repeating one.
   */
  next(key: 'invoice' | 'receipt'): Promise<number>;
}

export interface IdempotencyRepository {
  /**
   * Claims `(actor, scope, key)` for this transaction. A concurrent claim of
   * the same key waits for the first transaction to finish, then sees its
   * stored response (`replay`) or, if it rolled back, claims the key itself.
   */
  begin(input: {
    readonly actorUserId: string;
    readonly scope: string;
    readonly key: string;
    readonly requestHash: string;
    readonly at: string;
  }): Promise<IdempotencyBegin>;
  /** Stores the outcome so a retry returns it unchanged. */
  complete(input: {
    readonly actorUserId: string;
    readonly scope: string;
    readonly key: string;
    readonly resourceId: string | null;
    readonly response: unknown;
  }): Promise<void>;
}

export interface LoginAttemptRepository {
  record(record: LoginAttemptRecord): Promise<void>;
  countFailures(input: {
    readonly accountKey: string;
    readonly networkKey: string;
    readonly since: string;
  }): Promise<{ readonly accountFailures: number; readonly networkFailures: number }>;
  pruneBefore(before: string): Promise<number>;
}

export interface Repositories {
  readonly firm: FirmRepository;
  readonly users: UserRepository;
  readonly roles: RoleRepository;
  readonly sessions: SessionRepository;
  readonly activationTokens: ActivationTokenRepository;
  readonly loginChallenges: LoginChallengeRepository;
  readonly mfa: MfaRepository;
  readonly audit: AuditRepository;
  readonly loginAttempts: LoginAttemptRepository;
  readonly clients: ClientRepository;
  readonly serviceTypes: ServiceTypeRepository;
  readonly workflowTemplates: WorkflowTemplateRepository;
  readonly cases: CaseRepository;
  readonly storageConnections: StorageConnectionRepository;
  readonly storageOAuthStates: StorageOAuthStateRepository;
  readonly documents: DocumentRepository;
  readonly documentUploads: DocumentUploadRepository;
  readonly reconciliationRuns: ReconciliationRunRepository;
  readonly invoices: InvoiceRepository;
  readonly payments: PaymentRepository;
  readonly billingDocuments: BillingDocumentRepository;
  readonly numberSequences: NumberSequenceRepository;
  readonly idempotency: IdempotencyRepository;
  readonly billingReports: BillingReportRepository;
}

/**
 * Runs a set of repository operations in one database transaction. In-memory
 * repositories used by tests execute the callback directly because the test
 * process is single-threaded.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
