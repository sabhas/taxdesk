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
import type { WorkflowDefinition } from '@taxdesk/shared';

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

export interface AuditRepository {
  append(record: AuditEventRecord): Promise<void>;
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
}

/**
 * Runs a set of repository operations in one database transaction. In-memory
 * repositories used by tests execute the callback directly because the test
 * process is single-threaded.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
