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
}

/**
 * Runs a set of repository operations in one database transaction. In-memory
 * repositories used by tests execute the callback directly because the test
 * process is single-threaded.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
