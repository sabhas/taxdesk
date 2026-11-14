import { z } from 'zod';
import { UuidV7Schema } from './id.js';
import { PermissionKeySchema, RoleKeySchema } from './identity.js';

export const UserStatusSchema = z.enum(['invited', 'active', 'deactivated']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const DisplayNameSchema = z.string().trim().min(1).max(120);
/**
 * Sign-in name. Stored and compared in lowercase: 3–32 characters of letters,
 * digits, `.`, `_`, or `-`, starting and ending with a letter or digit.
 * Usernames are permanent so audit history always names the same account.
 */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/u;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    USERNAME_PATTERN,
    'Use 3–32 letters, digits, dots, underscores, or hyphens, starting and ending with a letter or digit.',
  );

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Public user shape. Never includes password hashes, tokens, or MFA secrets. */
export const PublicUserSchema = z
  .object({
    id: UuidV7Schema,
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    status: UserStatusSchema,
    mfaEnrolled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type PublicUser = z.infer<typeof PublicUserSchema>;

export const SessionDetailsSchema = z
  .object({
    idleExpiresAt: z.iso.datetime(),
    absoluteExpiresAt: z.iso.datetime(),
    mfaVerified: z.boolean(),
  })
  .strict();

export type SessionDetails = z.infer<typeof SessionDetailsSchema>;

/**
 * Minimal current-session payload. It is loaded once by the web application to
 * gate navigation. The server remains the authority for every API request.
 */
export const CurrentSessionSchema = z
  .object({
    user: PublicUserSchema,
    roles: z.array(RoleKeySchema),
    permissions: z.array(PermissionKeySchema),
    session: SessionDetailsSchema,
  })
  .strict();

export type CurrentSession = z.infer<typeof CurrentSessionSchema>;

export const LoginRequestSchema = z
  .object({
    // Login never reveals the username or password policy; it only bounds input.
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(512),
    turnstileToken: z.string().min(1).max(4096).optional(),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MfaChallengeRequestSchema = z
  .object({
    challengeToken: z.string().min(20).max(256),
    code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app.'),
  })
  .strict();

export type MfaChallengeRequest = z.infer<typeof MfaChallengeRequestSchema>;

export const MfaRecoveryRequestSchema = z
  .object({
    challengeToken: z.string().min(20).max(256),
    recoveryCode: z.string().trim().min(8).max(64),
  })
  .strict();

export type MfaRecoveryRequest = z.infer<typeof MfaRecoveryRequestSchema>;

export const TurnstileChallengeSchema = z
  .object({
    status: z.literal('turnstile_required'),
    siteKey: z.string().min(1),
  })
  .strict();

export const MfaRequiredResponseSchema = z
  .object({
    status: z.literal('mfa_required'),
    challengeToken: z.string().min(20).max(256),
    expiresAt: z.iso.datetime(),
    siteKey: z.string().min(1).optional(),
  })
  .strict();

export const AuthenticatedResponseSchema = z
  .object({
    status: z.literal('authenticated'),
    session: CurrentSessionSchema,
  })
  .strict();

/**
 * A signed-in user who has not completed MFA enrollment receives a restricted
 * session: they may only reach enrollment, session, and logout routes.
 */
export const MfaEnrollmentRequiredResponseSchema = z
  .object({
    status: z.literal('mfa_enrollment_required'),
    session: CurrentSessionSchema,
  })
  .strict();

export const LoginResponseSchema = z.discriminatedUnion('status', [
  AuthenticatedResponseSchema,
  MfaRequiredResponseSchema,
  MfaEnrollmentRequiredResponseSchema,
  TurnstileChallengeSchema,
]);

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** Token returned once to the authenticated user; only its hash is stored. */
export const MfaEnrollmentSchema = z
  .object({
    secret: z.string().min(16).max(128),
    otpauthUri: z.string().min(1).max(2048),
    issuer: z.string().min(1).max(80),
  })
  .strict();

export type MfaEnrollment = z.infer<typeof MfaEnrollmentSchema>;

export const MfaConfirmRequestSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app.'),
  })
  .strict();

export const RecoveryCodesSchema = z
  .object({
    recoveryCodes: z.array(z.string().min(8).max(64)).min(1).max(20),
  })
  .strict();

export type RecoveryCodes = z.infer<typeof RecoveryCodesSchema>;

export const MfaDisableRequestSchema = z
  .object({
    password: z.string().min(1).max(512),
    code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app.'),
  })
  .strict();

export type MfaDisableRequest = z.infer<typeof MfaDisableRequestSchema>;

export const RegenerateRecoveryCodesRequestSchema = z
  .object({
    password: z.string().min(1).max(512),
    code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app.'),
  })
  .strict();

export type RegenerateRecoveryCodesRequest = z.infer<typeof RegenerateRecoveryCodesRequestSchema>;

export const PasswordPolicySchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');

export const ActivationRequestSchema = z
  .object({
    token: z.string().min(20).max(256),
    password: PasswordPolicySchema,
  })
  .strict();

export type ActivationRequest = z.infer<typeof ActivationRequestSchema>;

export const ActivationResponseSchema = z
  .object({
    status: z.literal('activated'),
    username: UsernameSchema,
  })
  .strict();

export type ActivationResponse = z.infer<typeof ActivationResponseSchema>;

export const UserSummarySchema = z
  .object({
    id: UuidV7Schema,
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    status: UserStatusSchema,
    roles: z.array(RoleKeySchema),
    mfaEnrolled: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
  })
  .strict();

export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserListSchema = z
  .object({
    users: z.array(UserSummarySchema),
  })
  .strict();

export type UserList = z.infer<typeof UserListSchema>;

export const InviteUserRequestSchema = z
  .object({
    username: UsernameSchema,
    displayName: DisplayNameSchema,
    role: RoleKeySchema,
  })
  .strict();

export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

export const ActivationLinkSchema = z
  .object({
    activationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type ActivationLink = z.infer<typeof ActivationLinkSchema>;

export const InviteUserResponseSchema = z
  .object({
    user: UserSummarySchema,
    activationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type InviteUserResponse = z.infer<typeof InviteUserResponseSchema>;

export const UserUpdateRequestSchema = z
  .object({
    status: z.enum(['active', 'deactivated']).optional(),
    role: RoleKeySchema.optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.role !== undefined, {
    message: 'Supply a status or a role change.',
  });

export type UserUpdateRequest = z.infer<typeof UserUpdateRequestSchema>;

export const ETagSchema = z.string().regex(/^"[1-9]\d*"$/, 'Expected a strong ETag such as "3".');

export const IfMatchSchema = ETagSchema;
