import { AuthError } from './errors.js';
import { LOGIN_THROTTLE_WINDOW_MS } from './session-policy.js';

export const ACCOUNT_TURNSTILE_THRESHOLD = 5;
export const ACCOUNT_DENY_THRESHOLD = 10;
export const NETWORK_TURNSTILE_THRESHOLD = 15;
export const NETWORK_DENY_THRESHOLD = 30;

export type LoginThrottleDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'require_turnstile' }
  | { readonly action: 'deny'; readonly retryAfterSeconds: number };

/**
 * Pure login-throttle policy. Repeated failures are counted separately per
 * normalized account and per network identity so one noisy network cannot lock
 * every account and one targeted account cannot be brute-forced.
 */
export function evaluateLoginThrottle(counts: {
  readonly accountFailures: number;
  readonly networkFailures: number;
}): LoginThrottleDecision {
  if (
    counts.accountFailures >= ACCOUNT_DENY_THRESHOLD ||
    counts.networkFailures >= NETWORK_DENY_THRESHOLD
  ) {
    return { action: 'deny', retryAfterSeconds: Math.ceil(LOGIN_THROTTLE_WINDOW_MS / 1000) };
  }
  if (
    counts.accountFailures >= ACCOUNT_TURNSTILE_THRESHOLD ||
    counts.networkFailures >= NETWORK_TURNSTILE_THRESHOLD
  ) {
    return { action: 'require_turnstile' };
  }
  return { action: 'allow' };
}

export function throttleDenied(
  decision: Extract<LoginThrottleDecision, { action: 'deny' }>,
): AuthError {
  return new AuthError(
    429,
    'TOO_MANY_ATTEMPTS',
    'Too many sign-in attempts. Wait a few minutes and try again.',
    { retryAfterSeconds: decision.retryAfterSeconds },
  );
}
