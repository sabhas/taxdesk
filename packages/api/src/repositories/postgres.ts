import { BUILT_IN_ROLES, PERMISSION_KEYS, type UserStatus } from '@taxdesk/shared';
import type { SqlExecutor, SqlRow } from '@taxdesk/database';
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
import type { PaginatedAuditEvents, Repositories, UnitOfWork } from './ports.js';

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

function integer(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected an integer column "${key}".`);
  }
  return value;
}

function boolean(row: SqlRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected a boolean column "${key}".`);
  }
  return value;
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

function mapUser(row: SqlRow): UserRecord {
  return {
    id: text(row, 'id'),
    username: text(row, 'username'),
    displayName: text(row, 'display_name'),
    passwordHash: nullableText(row, 'password_hash'),
    passwordHashVersion:
      row['password_hash_version'] === null || row['password_hash_version'] === undefined
        ? null
        : integer(row, 'password_hash_version'),
    status: text(row, 'status') as UserStatus,
    mfaEnrolledAt: nullableIso(row['mfa_enrolled_at']),
    lastLoginAt: nullableIso(row['last_login_at']),
    deactivatedAt: nullableIso(row['deactivated_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapRole(row: SqlRow): RoleRecord {
  return {
    id: text(row, 'id'),
    key: text(row, 'key'),
    name: text(row, 'name'),
    description: text(row, 'description'),
  };
}

function mapSession(row: SqlRow): SessionRecord {
  return {
    id: text(row, 'id'),
    userId: text(row, 'user_id'),
    tokenHash: text(row, 'token_hash'),
    createdAt: iso(row['created_at']),
    lastSeenAt: iso(row['last_seen_at']),
    idleExpiresAt: iso(row['idle_expires_at']),
    absoluteExpiresAt: iso(row['absolute_expires_at']),
    mfaVerifiedAt: nullableIso(row['mfa_verified_at']),
    revokedAt: nullableIso(row['revoked_at']),
    version: integer(row, 'version'),
  };
}

function mapActivationToken(row: SqlRow): ActivationTokenRecord {
  return {
    id: text(row, 'id'),
    userId: text(row, 'user_id'),
    tokenHash: text(row, 'token_hash'),
    purpose: text(row, 'purpose') as ActivationPurpose,
    expiresAt: iso(row['expires_at']),
    usedAt: nullableIso(row['used_at']),
    createdAt: iso(row['created_at']),
    createdBy: nullableText(row, 'created_by'),
  };
}

function mapChallenge(row: SqlRow): LoginChallengeRecord {
  return {
    id: text(row, 'id'),
    userId: text(row, 'user_id'),
    tokenHash: text(row, 'token_hash'),
    expiresAt: iso(row['expires_at']),
    consumedAt: nullableIso(row['consumed_at']),
    createdAt: iso(row['created_at']),
  };
}

function mapCredential(row: SqlRow): MfaCredentialRecord {
  return {
    userId: text(row, 'user_id'),
    secretCiphertext: text(row, 'secret_ciphertext'),
    keyVersion: integer(row, 'key_version'),
    confirmedAt: nullableIso(row['confirmed_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapRecoveryCode(row: SqlRow): RecoveryCodeRecord {
  return {
    id: text(row, 'id'),
    userId: text(row, 'user_id'),
    codeHash: text(row, 'code_hash'),
    usedAt: nullableIso(row['used_at']),
    createdAt: iso(row['created_at']),
  };
}

function mapFirm(row: SqlRow): FirmRecord {
  return {
    id: text(row, 'id'),
    firmName: text(row, 'firm_name'),
    timezone: text(row, 'timezone'),
    bootstrapCompletedAt: nullableIso(row['bootstrap_completed_at']),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    version: integer(row, 'version'),
  };
}

function mapAudit(row: SqlRow): AuditEventRecord {
  const metadata = row['metadata'];
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Expected an audit metadata object.');
  }
  const safeMetadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      safeMetadata[key] = value;
    }
  }
  return {
    id: text(row, 'id'),
    occurredAt: iso(row['occurred_at']),
    actorUserId: nullableText(row, 'actor_user_id'),
    action: text(row, 'action'),
    entityType: text(row, 'entity_type'),
    entityId: nullableText(row, 'entity_id'),
    requestId: text(row, 'request_id'),
    metadata: safeMetadata,
  };
}

function mapAttempt(row: SqlRow): LoginAttemptRecord {
  return {
    id: text(row, 'id'),
    accountKey: text(row, 'account_key'),
    networkKey: text(row, 'network_key'),
    succeeded: boolean(row, 'succeeded'),
    createdAt: iso(row['created_at']),
  };
}

/** Maps SQLSTATE 23505 to the public conflict handled by services. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createPostgresRepositories(executor: SqlExecutor): Repositories {
  return {
    firm: {
      get: async () => {
        const rows = await executor.query('SELECT * FROM firm_settings LIMIT 1');
        return rows[0] === undefined ? null : mapFirm(rows[0]);
      },
      create: async (input) => {
        const rows = await executor.query(
          `INSERT INTO firm_settings (id, firm_name, timezone, bootstrap_completed_at, created_at, updated_at, version)
           VALUES ($1, $2, $3, NULL, $4, $4, 1)
           RETURNING *`,
          [input.id, input.firmName, input.timezone, input.createdAt],
        );
        const row = rows[0];
        if (row === undefined) {
          throw new Error('The firm row was not created.');
        }
        return mapFirm(row);
      },
      completeBootstrap: async (id, at) => {
        await executor.query(
          `UPDATE firm_settings
           SET bootstrap_completed_at = $2, updated_at = $2, version = version + 1
           WHERE id = $1`,
          [id, at],
        );
      },
      updateSettings: async (input) => {
        const rows = await executor.query(
          `UPDATE firm_settings
           SET firm_name = $2, timezone = $3, updated_at = $4, version = version + 1
           WHERE id = $1 AND version = $5
           RETURNING *`,
          [input.id, input.firmName, input.timezone, input.updatedAt, input.expectedVersion],
        );
        return rows[0] === undefined ? null : mapFirm(rows[0]);
      },
    },
    users: {
      findById: async (id) => {
        const rows = await executor.query('SELECT * FROM users WHERE id = $1', [id]);
        return rows[0] === undefined ? null : mapUser(rows[0]);
      },
      findByUsername: async (username) => {
        const rows = await executor.query('SELECT * FROM users WHERE username = $1', [username]);
        return rows[0] === undefined ? null : mapUser(rows[0]);
      },
      list: async () => {
        const rows = await executor.query('SELECT * FROM users ORDER BY created_at, id');
        return rows.map(mapUser);
      },
      create: async (input) => {
        const rows = await executor.query(
          `INSERT INTO users (
             id, username, display_name, password_hash, password_hash_version,
             status, mfa_enrolled_at, last_login_at, deactivated_at, created_at, updated_at, version
           )
           VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, $7, $7, 1)
           RETURNING *`,
          [
            input.id,
            input.username,
            input.displayName,
            input.passwordHash,
            input.passwordHashVersion,
            input.status,
            input.createdAt,
          ],
        );
        const row = rows[0];
        if (row === undefined) {
          throw new Error('The user row was not created.');
        }
        return mapUser(row);
      },
      updatePassword: async (input) => {
        await executor.query(
          `UPDATE users
           SET password_hash = $2, password_hash_version = $3, updated_at = $4, version = version + 1
           WHERE id = $1`,
          [input.userId, input.passwordHash, input.passwordHashVersion, input.at],
        );
      },
      activateWithPassword: async (input) => {
        const rows = await executor.query(
          `UPDATE users
           SET password_hash = $2,
               password_hash_version = $3,
               status = 'active',
               deactivated_at = NULL,
               updated_at = $5,
               version = version + 1
           WHERE id = $1 AND version = $4 AND status = 'invited'
           RETURNING *`,
          [
            input.userId,
            input.passwordHash,
            input.passwordHashVersion,
            input.expectedVersion,
            input.at,
          ],
        );
        return rows[0] === undefined ? null : mapUser(rows[0]);
      },
      updateStatus: async (input) => {
        const rows = await executor.query(
          `UPDATE users
           SET status = $2,
               deactivated_at = CASE WHEN $2 = 'deactivated' THEN $4::timestamptz ELSE NULL END,
               updated_at = $4,
               version = version + 1
           WHERE id = $1 AND version = $3
           RETURNING *`,
          [input.userId, input.status, input.expectedVersion, input.at],
        );
        return rows[0] === undefined ? null : mapUser(rows[0]);
      },
      bumpVersion: async (input) => {
        const rows = await executor.query(
          `UPDATE users SET updated_at = $3, version = version + 1
           WHERE id = $1 AND version = $2
           RETURNING *`,
          [input.userId, input.expectedVersion, input.at],
        );
        return rows[0] === undefined ? null : mapUser(rows[0]);
      },
      setMfaEnrolledAt: async (userId, at) => {
        await executor.query('UPDATE users SET mfa_enrolled_at = $2 WHERE id = $1', [userId, at]);
      },
      touchLastLogin: async (userId, at) => {
        await executor.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [userId, at]);
      },
      countActiveAdministrators: async () => {
        const rows = await executor.query(
          `SELECT count(*)::int AS count
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           WHERE r.key = 'administrator' AND u.status = 'active'`,
        );
        return rows[0] === undefined ? 0 : integer(rows[0], 'count');
      },
    },
    roles: {
      seedBuiltInRoles: async (at) => {
        for (const role of BUILT_IN_ROLES) {
          await executor.query(
            `INSERT INTO roles (id, key, name, description, is_builtin, created_at, updated_at, version)
             VALUES (gen_random_uuid(), $1, $2, $3, true, $4, $4, 1)
             ON CONFLICT (key) DO NOTHING`,
            [role.key, role.name, role.description, at],
          );
        }
        for (const key of PERMISSION_KEYS) {
          await executor.query(
            `INSERT INTO permissions (id, key, description, created_at, updated_at, version)
             VALUES (gen_random_uuid(), $1, $1, $2, $2, 1)
             ON CONFLICT (key) DO NOTHING`,
            [key, at],
          );
        }
        for (const role of BUILT_IN_ROLES) {
          await executor.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT r.id, p.id
             FROM roles r
             JOIN permissions p ON p.key = ANY ($2::text[])
             WHERE r.key = $1
             ON CONFLICT DO NOTHING`,
            [role.key, [...role.permissions]],
          );
        }
      },
      listRoles: async () => {
        const rows = await executor.query('SELECT * FROM roles ORDER BY key');
        return rows.map(mapRole);
      },
      rolesForUser: async (userId) => {
        const rows = await executor.query(
          `SELECT r.*
           FROM roles r
           JOIN user_roles ur ON ur.role_id = r.id
           WHERE ur.user_id = $1
           ORDER BY r.key`,
          [userId],
        );
        return rows.map(mapRole);
      },
      permissionsForUser: async (userId) => {
        const rows = await executor.query(
          `SELECT DISTINCT p.key
           FROM permissions p
           JOIN role_permissions rp ON rp.permission_id = p.id
           JOIN user_roles ur ON ur.role_id = rp.role_id
           WHERE ur.user_id = $1
           ORDER BY p.key`,
          [userId],
        );
        return rows.map((row) => text(row, 'key'));
      },
      replaceRoles: async (input) => {
        await executor.query('DELETE FROM user_roles WHERE user_id = $1', [input.userId]);
        if (input.roleKeys.length === 0) {
          return;
        }
        await executor.query(
          `INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
           SELECT $1, r.id, $3, $4::uuid
           FROM roles r
           WHERE r.key = ANY ($2::text[])`,
          [input.userId, [...input.roleKeys], input.assignedAt, input.assignedBy],
        );
      },
    },
    sessions: {
      create: async (record) => {
        await executor.query(
          `INSERT INTO sessions (
             id, user_id, token_hash, created_at, last_seen_at, idle_expires_at,
             absolute_expires_at, mfa_verified_at, revoked_at, version
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
          [
            record.id,
            record.userId,
            record.tokenHash,
            record.createdAt,
            record.lastSeenAt,
            record.idleExpiresAt,
            record.absoluteExpiresAt,
            record.mfaVerifiedAt,
            record.version,
          ],
        );
      },
      findByTokenHash: async (tokenHash) => {
        const rows = await executor.query('SELECT * FROM sessions WHERE token_hash = $1', [
          tokenHash,
        ]);
        return rows[0] === undefined ? null : mapSession(rows[0]);
      },
      touch: async (id, lastSeenAt, idleExpiresAt) => {
        await executor.query(
          'UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1',
          [id, lastSeenAt, idleExpiresAt],
        );
      },
      markMfaVerified: async (id, at) => {
        await executor.query(
          'UPDATE sessions SET mfa_verified_at = $2 WHERE id = $1 AND mfa_verified_at IS NULL',
          [id, at],
        );
      },
      revoke: async (id, at) => {
        await executor.query(
          `UPDATE sessions SET revoked_at = $2, version = version + 1
           WHERE id = $1 AND revoked_at IS NULL`,
          [id, at],
        );
      },
      revokeAllForUser: async (input) => {
        const rows = await executor.query(
          `UPDATE sessions
           SET revoked_at = $2, version = version + 1
           WHERE user_id = $1 AND revoked_at IS NULL
             AND ($3::uuid IS NULL OR id <> $3::uuid)
           RETURNING id`,
          [input.userId, input.at, input.exceptSessionId ?? null],
        );
        return rows.length;
      },
    },
    activationTokens: {
      create: async (record) => {
        await executor.query(
          `INSERT INTO activation_tokens (
             id, user_id, token_hash, purpose, expires_at, used_at, created_at, created_by
           )
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
          [
            record.id,
            record.userId,
            record.tokenHash,
            record.purpose,
            record.expiresAt,
            record.createdAt,
            record.createdBy,
          ],
        );
      },
      findByTokenHash: async (tokenHash) => {
        const rows = await executor.query('SELECT * FROM activation_tokens WHERE token_hash = $1', [
          tokenHash,
        ]);
        return rows[0] === undefined ? null : mapActivationToken(rows[0]);
      },
      consume: async (id, at) => {
        const rows = await executor.query(
          `UPDATE activation_tokens SET used_at = $2
           WHERE id = $1 AND used_at IS NULL
           RETURNING id`,
          [id, at],
        );
        return rows.length > 0;
      },
      invalidateForUser: async (input) => {
        const rows = await executor.query(
          `UPDATE activation_tokens SET used_at = $3
           WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL
           RETURNING id`,
          [input.userId, input.purpose, input.at],
        );
        return rows.length;
      },
    },
    loginChallenges: {
      create: async (record) => {
        await executor.query(
          `INSERT INTO login_challenges (id, user_id, token_hash, expires_at, consumed_at, created_at)
           VALUES ($1, $2, $3, $4, NULL, $5)`,
          [record.id, record.userId, record.tokenHash, record.expiresAt, record.createdAt],
        );
      },
      findByTokenHash: async (tokenHash) => {
        const rows = await executor.query('SELECT * FROM login_challenges WHERE token_hash = $1', [
          tokenHash,
        ]);
        return rows[0] === undefined ? null : mapChallenge(rows[0]);
      },
      consume: async (id, at) => {
        const rows = await executor.query(
          `UPDATE login_challenges SET consumed_at = $2
           WHERE id = $1 AND consumed_at IS NULL
           RETURNING id`,
          [id, at],
        );
        return rows.length > 0;
      },
      invalidateForUser: async (userId, at) => {
        const rows = await executor.query(
          `UPDATE login_challenges SET consumed_at = $2
           WHERE user_id = $1 AND consumed_at IS NULL
           RETURNING id`,
          [userId, at],
        );
        return rows.length;
      },
    },
    mfa: {
      getCredential: async (userId) => {
        const rows = await executor.query('SELECT * FROM mfa_credentials WHERE user_id = $1', [
          userId,
        ]);
        return rows[0] === undefined ? null : mapCredential(rows[0]);
      },
      upsertUnconfirmed: async (input) => {
        await executor.query(
          `INSERT INTO mfa_credentials (
             user_id, secret_ciphertext, key_version, confirmed_at, created_at, updated_at, version
           )
           VALUES ($1, $2, $3, NULL, $4, $4, 1)
           ON CONFLICT (user_id) DO UPDATE
           SET secret_ciphertext = EXCLUDED.secret_ciphertext,
               key_version = EXCLUDED.key_version,
               confirmed_at = NULL,
               updated_at = EXCLUDED.updated_at,
               version = mfa_credentials.version + 1`,
          [input.userId, input.secretCiphertext, input.keyVersion, input.at],
        );
      },
      confirm: async (userId, at) => {
        const rows = await executor.query(
          `UPDATE mfa_credentials
           SET confirmed_at = $2, updated_at = $2, version = version + 1
           WHERE user_id = $1 AND confirmed_at IS NULL
           RETURNING user_id`,
          [userId, at],
        );
        return rows.length > 0;
      },
      deleteForUser: async (userId) => {
        await executor.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
        await executor.query('DELETE FROM mfa_credentials WHERE user_id = $1', [userId]);
      },
      listRecoveryCodes: async (userId) => {
        const rows = await executor.query(
          'SELECT * FROM mfa_recovery_codes WHERE user_id = $1 ORDER BY id',
          [userId],
        );
        return rows.map(mapRecoveryCode);
      },
      replaceRecoveryCodes: async (userId, records) => {
        await executor.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
        for (const record of records) {
          await executor.query(
            `INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at)
             VALUES ($1, $2, $3, NULL, $4)`,
            [record.id, record.userId, record.codeHash, record.createdAt],
          );
        }
      },
      consumeRecoveryCode: async (userId, codeHash, at) => {
        const rows = await executor.query(
          `UPDATE mfa_recovery_codes SET used_at = $3
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
           RETURNING id`,
          [userId, codeHash, at],
        );
        return rows.length > 0;
      },
      countUnusedRecoveryCodes: async (userId) => {
        const rows = await executor.query(
          `SELECT count(*)::int AS count
           FROM mfa_recovery_codes
           WHERE user_id = $1 AND used_at IS NULL`,
          [userId],
        );
        return rows[0] === undefined ? 0 : integer(rows[0], 'count');
      },
    },
    audit: {
      append: async (record) => {
        await executor.query(
          `INSERT INTO audit_events (
             id, occurred_at, actor_user_id, action, entity_type, entity_id, request_id, metadata
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            record.id,
            record.occurredAt,
            record.actorUserId,
            record.action,
            record.entityType,
            record.entityId,
            record.requestId,
            record.metadata,
          ],
        );
      },
      list: async (input): Promise<PaginatedAuditEvents> => {
        const cursor = input.cursor;
        const rows =
          cursor === null
            ? await executor.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT $1', [
                input.limit + 1,
              ])
            : await executor.query(
                'SELECT * FROM audit_events WHERE id < $2 ORDER BY id DESC LIMIT $1',
                [input.limit + 1, cursor],
              );
        const page = rows.slice(0, input.limit).map(mapAudit);
        return {
          events: page,
          nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
        };
      },
    },
    loginAttempts: {
      record: async (record) => {
        await executor.query(
          `INSERT INTO auth_attempts (id, account_key, network_key, succeeded, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [record.id, record.accountKey, record.networkKey, record.succeeded, record.createdAt],
        );
      },
      countFailures: async (input) => {
        const rows = await executor.query(
          `SELECT
             count(*) FILTER (WHERE account_key = $1)::int AS account_failures,
             count(*) FILTER (WHERE network_key = $2)::int AS network_failures
           FROM auth_attempts
           WHERE succeeded = false AND created_at >= $3::timestamptz`,
          [input.accountKey, input.networkKey, input.since],
        );
        const row = rows[0];
        return {
          accountFailures: row === undefined ? 0 : integer(row, 'account_failures'),
          networkFailures: row === undefined ? 0 : integer(row, 'network_failures'),
        };
      },
      pruneBefore: async (before) => {
        const rows = await executor.query(
          'DELETE FROM auth_attempts WHERE created_at < $1::timestamptz RETURNING id',
          [before],
        );
        return rows.length;
      },
    },
  };
}

export function createPostgresUnitOfWork(executor: SqlExecutor): UnitOfWork {
  return {
    run: async (work) =>
      await executor.transaction(
        async (transaction) => await work(createPostgresRepositories(transaction)),
      ),
  };
}

export { mapAttempt };
