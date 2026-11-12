/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-optional-chain -- in-memory fakes implement async repository ports synchronously with explicit null checks */
import { ROLE_DEFINITIONS, ROLE_KEYS, isRoleKey, newUuidV7 } from '@taxdesk/shared';
import type {
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
import type { Repositories, UnitOfWork } from './ports.js';
import {
  createInMemoryClientRepository,
  createInMemoryClientState,
  type InMemoryClientState,
} from './in-memory-clients.js';
import {
  createInMemoryCaseRepository,
  createInMemoryCaseState,
  createInMemoryServiceTypeRepository,
  createInMemoryWorkflowTemplateRepository,
  type InMemoryCaseState,
} from './in-memory-cases.js';
import {
  createInMemoryDocumentRepository,
  createInMemoryDocumentState,
  createInMemoryDocumentUploadRepository,
  createInMemoryReconciliationRunRepository,
  createInMemoryStorageConnectionRepository,
  createInMemoryStorageOAuthStateRepository,
  type InMemoryDocumentState,
} from './in-memory-documents.js';

export interface InMemoryState
  extends InMemoryClientState, InMemoryCaseState, InMemoryDocumentState {
  firm: FirmRecord | null;
  users: Map<string, UserRecord>;
  roles: Map<string, RoleRecord>;
  roleAssignments: Map<string, Set<string>>;
  sessions: Map<string, SessionRecord>;
  activationTokens: Map<string, ActivationTokenRecord>;
  loginChallenges: Map<string, LoginChallengeRecord>;
  mfaCredentials: Map<string, MfaCredentialRecord>;
  recoveryCodes: Map<string, RecoveryCodeRecord>;
  auditEvents: AuditEventRecord[];
  loginAttempts: LoginAttemptRecord[];
}

export interface InMemoryRepositories {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly state: InMemoryState;
}

function copyEvent(event: AuditEventRecord): AuditEventRecord {
  return { ...event, metadata: { ...event.metadata } };
}

/**
 * Test repositories with the same observable contract as the PostgreSQL
 * implementations. They are only imported by tests, never by the Worker entry.
 */
export function createInMemoryRepositories(): InMemoryRepositories {
  const state: InMemoryState = {
    firm: null,
    users: new Map(),
    roles: new Map(),
    roleAssignments: new Map(),
    sessions: new Map(),
    activationTokens: new Map(),
    loginChallenges: new Map(),
    mfaCredentials: new Map(),
    recoveryCodes: new Map(),
    auditEvents: [],
    loginAttempts: [],
    ...createInMemoryClientState(),
    ...createInMemoryCaseState(),
    ...createInMemoryDocumentState(),
  };

  const roles: RoleRecord[] = ROLE_KEYS.map((key) => ({
    id: newUuidV7(),
    key,
    name: ROLE_DEFINITIONS[key].name,
    description: ROLE_DEFINITIONS[key].description,
  }));
  for (const role of roles) {
    state.roles.set(role.key, role);
  }

  const repositories: Omit<
    Repositories,
    | 'clients'
    | 'serviceTypes'
    | 'workflowTemplates'
    | 'cases'
    | 'storageConnections'
    | 'storageOAuthStates'
    | 'documents'
    | 'documentUploads'
    | 'reconciliationRuns'
  > = {
    firm: {
      get: async () => (state.firm === null ? null : { ...state.firm }),
      create: async (input) => {
        if (state.firm !== null) {
          throw new Error('The firm already exists.');
        }
        const firm: FirmRecord = {
          id: input.id,
          firmName: input.firmName,
          timezone: input.timezone,
          bootstrapCompletedAt: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          version: 1,
        };
        state.firm = firm;
        return { ...firm };
      },
      completeBootstrap: async (id, at) => {
        if (state.firm !== null && state.firm.id === id) {
          state.firm = { ...state.firm, bootstrapCompletedAt: at, updatedAt: at };
        }
      },
      updateSettings: async (input) => {
        if (state.firm === null || state.firm.id !== input.id) {
          return null;
        }
        if (state.firm.version !== input.expectedVersion) {
          return null;
        }
        state.firm = {
          ...state.firm,
          firmName: input.firmName,
          timezone: input.timezone,
          updatedAt: input.updatedAt,
          version: state.firm.version + 1,
        };
        return { ...state.firm };
      },
    },
    users: {
      findById: async (id) => {
        const user = state.users.get(id);
        return user === undefined ? null : { ...user };
      },
      findByUsername: async (username) => {
        for (const user of state.users.values()) {
          if (user.username === username) {
            return { ...user };
          }
        }
        return null;
      },
      list: async () => [...state.users.values()].map((user) => ({ ...user })),
      create: async (input) => {
        for (const user of state.users.values()) {
          if (user.username === input.username) {
            throw new Error('A user with that username already exists.');
          }
        }
        const user: UserRecord = {
          id: input.id,
          username: input.username,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          passwordHashVersion: input.passwordHashVersion,
          status: input.status,
          mfaEnrolledAt: null,
          lastLoginAt: null,
          deactivatedAt: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          version: 1,
        };
        state.users.set(user.id, user);
        return { ...user };
      },
      updatePassword: async (input) => {
        const user = state.users.get(input.userId);
        if (user === undefined) {
          return;
        }
        state.users.set(user.id, {
          ...user,
          passwordHash: input.passwordHash,
          passwordHashVersion: input.passwordHashVersion,
          updatedAt: input.at,
          version: user.version + 1,
        });
      },
      activateWithPassword: async (input) => {
        const user = state.users.get(input.userId);
        if (
          user === undefined ||
          user.status !== 'invited' ||
          user.version !== input.expectedVersion
        ) {
          return null;
        }
        const activated: UserRecord = {
          ...user,
          passwordHash: input.passwordHash,
          passwordHashVersion: input.passwordHashVersion,
          status: 'active',
          deactivatedAt: null,
          updatedAt: input.at,
          version: user.version + 1,
        };
        state.users.set(user.id, activated);
        return { ...activated };
      },
      updateStatus: async (input) => {
        const user = state.users.get(input.userId);
        if (user === undefined || user.version !== input.expectedVersion) {
          return null;
        }
        const updated: UserRecord = {
          ...user,
          status: input.status,
          deactivatedAt: input.status === 'deactivated' ? input.at : null,
          updatedAt: input.at,
          version: user.version + 1,
        };
        state.users.set(user.id, updated);
        return { ...updated };
      },
      bumpVersion: async (input) => {
        const user = state.users.get(input.userId);
        if (user === undefined || user.version !== input.expectedVersion) {
          return null;
        }
        const updated: UserRecord = {
          ...user,
          updatedAt: input.at,
          version: user.version + 1,
        };
        state.users.set(user.id, updated);
        return { ...updated };
      },
      setMfaEnrolledAt: async (userId, at) => {
        const user = state.users.get(userId);
        if (user !== undefined) {
          state.users.set(userId, { ...user, mfaEnrolledAt: at });
        }
      },
      touchLastLogin: async (userId, at) => {
        const user = state.users.get(userId);
        if (user !== undefined) {
          state.users.set(userId, { ...user, lastLoginAt: at });
        }
      },
      countActiveAdministrators: async () => {
        let count = 0;
        for (const user of state.users.values()) {
          if (
            user.status === 'active' &&
            state.roleAssignments.get(user.id)?.has('administrator') === true
          ) {
            count += 1;
          }
        }
        return count;
      },
    },
    roles: {
      seedBuiltInRoles: async () => {
        for (const key of ROLE_KEYS) {
          if (!state.roles.has(key)) {
            state.roles.set(key, {
              id: newUuidV7(),
              key,
              name: ROLE_DEFINITIONS[key].name,
              description: ROLE_DEFINITIONS[key].description,
            });
          }
        }
      },
      listRoles: async () => [...state.roles.values()].map((role) => ({ ...role })),
      rolesForUser: async (userId) => {
        const assigned = state.roleAssignments.get(userId) ?? new Set<string>();
        return [...assigned]
          .sort()
          .map((key) => state.roles.get(key))
          .filter((role): role is RoleRecord => role !== undefined)
          .map((role) => ({ ...role }));
      },
      permissionsForUser: async (userId) => {
        const assigned = state.roleAssignments.get(userId) ?? new Set<string>();
        const permissions = new Set<string>();
        for (const key of assigned) {
          if (!isRoleKey(key)) {
            continue;
          }
          for (const permission of ROLE_DEFINITIONS[key].permissions) {
            permissions.add(permission);
          }
        }
        return [...permissions].sort();
      },
      replaceRoles: async (input) => {
        const next = new Set<string>();
        for (const key of input.roleKeys) {
          if (!state.roles.has(key)) {
            throw new Error(`Unknown role ${key}.`);
          }
          next.add(key);
        }
        state.roleAssignments.set(input.userId, next);
      },
    },
    sessions: {
      create: async (record) => {
        state.sessions.set(record.id, { ...record });
      },
      findByTokenHash: async (tokenHash) => {
        for (const session of state.sessions.values()) {
          if (session.tokenHash === tokenHash) {
            return { ...session };
          }
        }
        return null;
      },
      touch: async (id, lastSeenAt, idleExpiresAt) => {
        const session = state.sessions.get(id);
        if (session !== undefined) {
          state.sessions.set(id, { ...session, lastSeenAt, idleExpiresAt });
        }
      },
      markMfaVerified: async (id, at) => {
        const session = state.sessions.get(id);
        if (session !== undefined) {
          state.sessions.set(id, { ...session, mfaVerifiedAt: at });
        }
      },
      revoke: async (id, at) => {
        const session = state.sessions.get(id);
        if (session !== undefined && session.revokedAt === null) {
          state.sessions.set(id, {
            ...session,
            revokedAt: at,
            version: session.version + 1,
          });
        }
      },
      revokeAllForUser: async (input) => {
        let revoked = 0;
        for (const session of state.sessions.values()) {
          if (
            session.userId === input.userId &&
            session.revokedAt === null &&
            session.id !== input.exceptSessionId
          ) {
            state.sessions.set(session.id, {
              ...session,
              revokedAt: input.at,
              version: session.version + 1,
            });
            revoked += 1;
          }
        }
        return revoked;
      },
    },
    activationTokens: {
      create: async (record) => {
        state.activationTokens.set(record.id, { ...record });
      },
      findByTokenHash: async (tokenHash) => {
        for (const token of state.activationTokens.values()) {
          if (token.tokenHash === tokenHash) {
            return { ...token };
          }
        }
        return null;
      },
      consume: async (id, at) => {
        const token = state.activationTokens.get(id);
        if (token === undefined || token.usedAt !== null) {
          return false;
        }
        state.activationTokens.set(id, { ...token, usedAt: at });
        return true;
      },
      invalidateForUser: async (input) => {
        let invalidated = 0;
        for (const token of state.activationTokens.values()) {
          if (
            token.userId === input.userId &&
            token.purpose === input.purpose &&
            token.usedAt === null
          ) {
            state.activationTokens.set(token.id, { ...token, usedAt: input.at });
            invalidated += 1;
          }
        }
        return invalidated;
      },
    },
    loginChallenges: {
      create: async (record) => {
        state.loginChallenges.set(record.id, { ...record });
      },
      findByTokenHash: async (tokenHash) => {
        for (const challenge of state.loginChallenges.values()) {
          if (challenge.tokenHash === tokenHash) {
            return { ...challenge };
          }
        }
        return null;
      },
      consume: async (id, at) => {
        const challenge = state.loginChallenges.get(id);
        if (challenge === undefined || challenge.consumedAt !== null) {
          return false;
        }
        state.loginChallenges.set(id, { ...challenge, consumedAt: at });
        return true;
      },
      invalidateForUser: async (userId, at) => {
        let invalidated = 0;
        for (const challenge of state.loginChallenges.values()) {
          if (challenge.userId === userId && challenge.consumedAt === null) {
            state.loginChallenges.set(challenge.id, { ...challenge, consumedAt: at });
            invalidated += 1;
          }
        }
        return invalidated;
      },
    },
    mfa: {
      getCredential: async (userId) => {
        const credential = state.mfaCredentials.get(userId);
        return credential === undefined ? null : { ...credential };
      },
      upsertUnconfirmed: async (input) => {
        const existing = state.mfaCredentials.get(input.userId);
        state.mfaCredentials.set(input.userId, {
          userId: input.userId,
          secretCiphertext: input.secretCiphertext,
          keyVersion: input.keyVersion,
          confirmedAt: null,
          createdAt: existing?.createdAt ?? input.at,
          updatedAt: input.at,
          version: (existing?.version ?? 0) + 1,
        });
      },
      confirm: async (userId, at) => {
        const credential = state.mfaCredentials.get(userId);
        if (credential === undefined || credential.confirmedAt !== null) {
          return false;
        }
        state.mfaCredentials.set(userId, {
          ...credential,
          confirmedAt: at,
          updatedAt: at,
          version: credential.version + 1,
        });
        return true;
      },
      deleteForUser: async (userId) => {
        state.mfaCredentials.delete(userId);
        for (const [id, code] of state.recoveryCodes) {
          if (code.userId === userId) {
            state.recoveryCodes.delete(id);
          }
        }
      },
      listRecoveryCodes: async (userId) =>
        [...state.recoveryCodes.values()]
          .filter((code) => code.userId === userId)
          .map((code) => ({ ...code })),
      replaceRecoveryCodes: async (userId, records) => {
        for (const [id, code] of state.recoveryCodes) {
          if (code.userId === userId) {
            state.recoveryCodes.delete(id);
          }
        }
        for (const record of records) {
          state.recoveryCodes.set(record.id, { ...record });
        }
      },
      consumeRecoveryCode: async (userId, codeHash, at) => {
        for (const code of state.recoveryCodes.values()) {
          if (code.userId === userId && code.codeHash === codeHash && code.usedAt === null) {
            state.recoveryCodes.set(code.id, { ...code, usedAt: at });
            return true;
          }
        }
        return false;
      },
      countUnusedRecoveryCodes: async (userId) => {
        let count = 0;
        for (const code of state.recoveryCodes.values()) {
          if (code.userId === userId && code.usedAt === null) {
            count += 1;
          }
        }
        return count;
      },
    },
    audit: {
      append: async (record) => {
        state.auditEvents.push(copyEvent(record));
      },
      list: async (input) => {
        const sorted = [...state.auditEvents].sort((left, right) =>
          right.id.localeCompare(left.id),
        );
        const cursor = input.cursor;
        const filtered = cursor === null ? sorted : sorted.filter((event) => event.id < cursor);
        const page = filtered.slice(0, input.limit);
        const hasMore = filtered.length > input.limit;
        return {
          events: page.map(copyEvent),
          nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        };
      },
      listForEntity: async (input) => {
        const cursor = input.cursor;
        const filtered = state.auditEvents
          .filter(
            (event) =>
              event.entityType === input.entityType &&
              event.entityId === input.entityId &&
              (cursor === null || event.id < cursor),
          )
          .sort((left, right) => right.id.localeCompare(left.id));
        const page = filtered.slice(0, input.limit);
        return {
          events: page.map(copyEvent),
          nextCursor: filtered.length > input.limit ? (page.at(-1)?.id ?? null) : null,
        };
      },
    },
    loginAttempts: {
      record: async (record) => {
        state.loginAttempts.push({ ...record });
      },
      countFailures: async (input) => {
        let accountFailures = 0;
        let networkFailures = 0;
        for (const attempt of state.loginAttempts) {
          if (attempt.succeeded || attempt.createdAt < input.since) {
            continue;
          }
          if (attempt.accountKey === input.accountKey) {
            accountFailures += 1;
          }
          if (attempt.networkKey === input.networkKey) {
            networkFailures += 1;
          }
        }
        return { accountFailures, networkFailures };
      },
      pruneBefore: async (before) => {
        const beforeCount = state.loginAttempts.length;
        state.loginAttempts = state.loginAttempts.filter((attempt) => attempt.createdAt >= before);
        return beforeCount - state.loginAttempts.length;
      },
    },
  };

  const repositoriesWithClients: Repositories = {
    ...repositories,
    clients: createInMemoryClientRepository(state),
    serviceTypes: createInMemoryServiceTypeRepository(state),
    workflowTemplates: createInMemoryWorkflowTemplateRepository(state),
    cases: createInMemoryCaseRepository(state, state.clients),
    storageConnections: createInMemoryStorageConnectionRepository(state),
    storageOAuthStates: createInMemoryStorageOAuthStateRepository(state),
    documents: createInMemoryDocumentRepository(state),
    documentUploads: createInMemoryDocumentUploadRepository(state),
    reconciliationRuns: createInMemoryReconciliationRunRepository(state),
  };

  const unitOfWork: UnitOfWork = {
    run: async (work) => await work(repositoriesWithClients),
  };

  return { repositories: repositoriesWithClients, unitOfWork, state };
}
