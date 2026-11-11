import type { FieldError } from '@taxdesk/shared';

export type AuthErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_UNAVAILABLE'
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT_REQUIRED'
  | 'MFA_UNAVAILABLE'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_CODE_INVALID'
  | 'MFA_ALREADY_ENROLLED'
  | 'TURNSTILE_REQUIRED'
  | 'TURNSTILE_FAILED'
  | 'TOO_MANY_ATTEMPTS'
  | 'ACTIVATION_TOKEN_INVALID'
  | 'ACTIVATION_TOKEN_EXPIRED'
  | 'USERNAME_IN_USE'
  | 'USER_NOT_FOUND'
  | 'ROLE_INVALID'
  | 'CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'VALIDATION_FAILED'
  | 'REQUEST_ID_REQUIRED'
  | 'FIRM_NOT_BOOTSTRAPPED'
  | 'FIRM_ALREADY_BOOTSTRAPPED'
  | 'SERVICE_UNAVAILABLE'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CLIENT_NOT_FOUND'
  | 'CLIENT_IDENTIFIER_EXISTS'
  | 'CLIENT_DUPLICATE_WARNING'
  | 'CLIENT_ARCHIVED'
  | 'CLIENT_NOT_ARCHIVED'
  | 'ASSIGNEE_INVALID'
  | 'SERVICE_TYPE_NOT_FOUND'
  | 'SERVICE_TYPE_NAME_EXISTS'
  | 'SERVICE_TYPE_ARCHIVED'
  | 'SERVICE_TYPE_NOT_ARCHIVED'
  | 'WORKFLOW_TEMPLATE_NOT_FOUND'
  | 'WORKFLOW_TEMPLATE_NAME_EXISTS'
  | 'WORKFLOW_VERSION_NOT_FOUND'
  | 'WORKFLOW_DRAFT_EXISTS'
  | 'WORKFLOW_VERSION_PUBLISHED'
  | 'WORKFLOW_VERSION_NOT_PUBLISHED'
  | 'WORKFLOW_INVALID'
  | 'CASE_NOT_FOUND'
  | 'CASE_DUPLICATE_WARNING'
  | 'CASE_DUPLICATE_BLOCKED'
  | 'CASE_CLOSED'
  | 'CASE_ARCHIVED'
  | 'CASE_NOT_CLOSED'
  | 'TRANSITION_NOT_ALLOWED'
  | 'CHECKLIST_INCOMPLETE'
  | 'CHECKLIST_ITEM_NOT_FOUND'
  | 'CHECKLIST_ACTION_NOT_ALLOWED'
  | 'CHECKLIST_LOCKED';

export interface AuthErrorOptions {
  readonly errors?: readonly FieldError[];
  readonly retryAfterSeconds?: number;
}

/**
 * A domain/security failure with an HTTP status and a stable public code. The
 * route layer maps this to Problem Details; the `message` is deliberately the
 * public detail, so it must never contain secrets or database/provider data.
 */
export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;
  readonly errors: readonly FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: AuthErrorCode,
    message: string,
    options: AuthErrorOptions = {},
  ) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
    this.errors = options.errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function unauthenticated(
  code: 'UNAUTHENTICATED' | 'SESSION_EXPIRED' = 'UNAUTHENTICATED',
): AuthError {
  return new AuthError(401, code, 'Sign in to continue.');
}

export function forbidden(
  message = 'You do not have permission to perform this action.',
): AuthError {
  return new AuthError(403, 'FORBIDDEN', message);
}
