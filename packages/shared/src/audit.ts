import { z } from 'zod';
import { UuidSchema } from './id.js';

export const AuditActionSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);

export const AuditMetadataValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
]);

export type AuditMetadataValue = z.infer<typeof AuditMetadataValueSchema>;

/**
 * An append-only audit event. Metadata is a shallow map of non-secret scalar
 * values; repositories reject nested structures and services never place
 * passwords, tokens, MFA secrets, or document contents in it.
 */
export const AuditEventSchema = z
  .object({
    id: UuidSchema,
    occurredAt: z.string().datetime(),
    actorUserId: UuidSchema.nullable(),
    action: AuditActionSchema,
    entityType: z.string().min(1).max(80),
    entityId: UuidSchema.nullable(),
    requestId: z.string().min(1).max(128),
    metadata: z.record(AuditMetadataValueSchema),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventListSchema = z
  .object({
    events: z.array(AuditEventSchema),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();

export type AuditEventList = z.infer<typeof AuditEventListSchema>;

export const AUDIT_ACTIONS = {
  firmBootstrapped: 'firm.bootstrapped',
  firmSettingsUpdated: 'firm.settings_updated',
  userInvited: 'user.invited',
  userActivated: 'user.activated',
  userDeactivated: 'user.deactivated',
  userReactivated: 'user.reactivated',
  userRolesChanged: 'user.roles_changed',
  userPasswordResetLinkIssued: 'user.password_reset_link_issued',
  userPasswordResetCompleted: 'user.password_reset_completed',
  userMfaEnabled: 'user.mfa_enabled',
  userMfaDisabled: 'user.mfa_disabled',
  userRecoveryCodesRegenerated: 'user.recovery_codes_regenerated',
  loginSucceeded: 'auth.login_succeeded',
  loginFailed: 'auth.login_failed',
  mfaChallengeFailed: 'auth.mfa_challenge_failed',
  sessionCreated: 'session.created',
  sessionRevoked: 'session.revoked',
  sessionsRevoked: 'session.sessions_revoked',
  recoveryPasswordReset: 'user.recovery_password_reset',
  recoveryMfaDisabled: 'user.recovery_mfa_disabled',
  recoveryReactivated: 'user.recovery_reactivated',
  clientCreated: 'client.created',
  clientUpdated: 'client.updated',
  clientArchived: 'client.archived',
  clientRestored: 'client.restored',
  clientDuplicateOverride: 'client.duplicate_override',
} as const;
