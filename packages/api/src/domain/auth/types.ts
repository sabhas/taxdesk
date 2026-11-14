import type { UserStatus } from '@taxdesk/shared';

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly passwordHashVersion: number | null;
  readonly status: UserStatus;
  readonly mfaEnrolledAt: string | null;
  readonly lastLoginAt: string | null;
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface RoleRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly mfaVerifiedAt: string | null;
  readonly revokedAt: string | null;
  readonly version: number;
}

export type ActivationPurpose = 'activation' | 'password_reset';

export interface ActivationTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly purpose: ActivationPurpose;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
}

export interface LoginChallengeRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface MfaCredentialRecord {
  readonly userId: string;
  readonly secretCiphertext: string;
  readonly keyVersion: number;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface RecoveryCodeRecord {
  readonly id: string;
  readonly userId: string;
  readonly codeHash: string;
  readonly usedAt: string | null;
  readonly createdAt: string;
}

export interface FirmRecord {
  readonly id: string;
  readonly firmName: string;
  readonly timezone: string;
  readonly currency: string;
  readonly invoicePrefix: string;
  readonly receiptPrefix: string;
  readonly documentMaxUploadBytes: number;
  readonly dueSoonDays: number;
  readonly bootstrapCompletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly requestId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface LoginAttemptRecord {
  readonly id: string;
  readonly accountKey: string;
  readonly networkKey: string;
  readonly succeeded: boolean;
  readonly createdAt: string;
}

/**
 * The authenticated principal attached by middleware. `roles` and `permissions`
 * always come from the database, never from the request.
 */
export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly session: SessionRecord;
  readonly user: UserRecord;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly mfaEnrolled: boolean;
  readonly mfaVerified: boolean;
}
