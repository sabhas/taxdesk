import {
  ActivationLinkSchema,
  ActivationResponseSchema,
  AuditEventListSchema,
  CurrentSessionSchema,
  FirmSettingsSchema,
  InviteUserResponseSchema,
  LoginResponseSchema,
  MfaEnrollmentSchema,
  RecoveryCodesSchema,
  UserListSchema,
  UserSummarySchema,
  type ActivationLink,
  type ActivationResponse,
  type AuditEventList,
  type CurrentSession,
  type FirmSettings,
  type FirmSettingsUpdate,
  type InviteUserRequest,
  type InviteUserResponse,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrollment,
  type RecoveryCodes,
  type UserList,
  type UserSummary,
  type UserUpdateRequest,
} from '@taxdesk/shared';
import { apiRequest, apiRequestVoid } from './api-client.js';

export async function fetchSession(signal?: AbortSignal): Promise<CurrentSession> {
  return await apiRequest('/api/v1/auth/session', CurrentSessionSchema, {
    sessionScoped: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function login(request: LoginRequest): Promise<LoginResponse> {
  return await apiRequest('/api/v1/auth/login', LoginResponseSchema, {
    method: 'POST',
    body: request,
  });
}

export async function completeMfaChallenge(input: {
  challengeToken: string;
  code: string;
}): Promise<LoginResponse> {
  return await apiRequest('/api/v1/auth/mfa/challenge', LoginResponseSchema, {
    method: 'POST',
    body: input,
  });
}

export async function completeMfaRecovery(input: {
  challengeToken: string;
  recoveryCode: string;
}): Promise<LoginResponse> {
  return await apiRequest('/api/v1/auth/mfa/recovery', LoginResponseSchema, {
    method: 'POST',
    body: input,
  });
}

export async function logout(): Promise<void> {
  await apiRequestVoid('/api/v1/auth/logout', { sessionScoped: true });
}

export async function activate(input: {
  token: string;
  password: string;
}): Promise<ActivationResponse> {
  return await apiRequest('/api/v1/auth/activate', ActivationResponseSchema, {
    method: 'POST',
    body: input,
  });
}

export async function enrollMfa(): Promise<MfaEnrollment> {
  return await apiRequest('/api/v1/auth/mfa/enroll', MfaEnrollmentSchema, {
    method: 'POST',
    body: {},
    sessionScoped: true,
  });
}

export async function confirmMfa(code: string): Promise<RecoveryCodes> {
  return await apiRequest('/api/v1/auth/mfa/confirm', RecoveryCodesSchema, {
    method: 'POST',
    body: { code },
    sessionScoped: true,
  });
}

export async function disableMfa(input: { password: string; code: string }): Promise<void> {
  await apiRequestVoid('/api/v1/auth/mfa/disable', {
    method: 'POST',
    body: input,
    sessionScoped: true,
  });
}

export async function regenerateRecoveryCodes(input: {
  password: string;
  code: string;
}): Promise<RecoveryCodes> {
  return await apiRequest('/api/v1/auth/mfa/recovery-codes/regenerate', RecoveryCodesSchema, {
    method: 'POST',
    body: input,
    sessionScoped: true,
  });
}

export async function listUsers(signal?: AbortSignal): Promise<UserList> {
  return await apiRequest('/api/v1/admin/users', UserListSchema, {
    sessionScoped: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function inviteUser(request: InviteUserRequest): Promise<InviteUserResponse> {
  return await apiRequest('/api/v1/admin/users/invitations', InviteUserResponseSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function updateUser(
  userId: string,
  update: UserUpdateRequest,
  version: number,
): Promise<UserSummary> {
  return await apiRequest(`/api/v1/admin/users/${encodeURIComponent(userId)}`, UserSummarySchema, {
    method: 'PATCH',
    body: update,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function createResetLink(userId: string): Promise<ActivationLink> {
  return await apiRequest(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/reset-link`,
    ActivationLinkSchema,
    { method: 'POST', body: {}, sessionScoped: true },
  );
}

export async function getFirmSettings(signal?: AbortSignal): Promise<FirmSettings> {
  return await apiRequest('/api/v1/firm/settings', FirmSettingsSchema, {
    sessionScoped: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function updateFirmSettings(
  update: FirmSettingsUpdate,
  version: number,
): Promise<FirmSettings> {
  return await apiRequest('/api/v1/firm/settings', FirmSettingsSchema, {
    method: 'PATCH',
    body: update,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function listAuditEvents(
  input: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<AuditEventList> {
  const parameters = new URLSearchParams();
  parameters.set('limit', String(input.limit ?? 25));
  if (input.cursor !== undefined && input.cursor !== null) {
    parameters.set('cursor', input.cursor);
  }
  return await apiRequest(
    `/api/v1/admin/audit-events?${parameters.toString()}`,
    AuditEventListSchema,
    {
      sessionScoped: true,
      ...(signal === undefined ? {} : { signal }),
    },
  );
}
