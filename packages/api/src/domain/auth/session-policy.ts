export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Only slide the idle deadline at most once a minute to avoid a write per request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
export const ACTIVATION_TOKEN_TTL_MS = 30 * 60 * 1000;
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

export interface SessionExpiry {
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export function computeSessionExpiry(now: Date): SessionExpiry {
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + SESSION_IDLE_TIMEOUT_MS, now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS),
  );
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
  return {
    idleExpiresAt: idleExpiresAt.toISOString(),
    absoluteExpiresAt: absoluteExpiresAt.toISOString(),
  };
}

export function nextIdleExpiry(now: Date, absoluteExpiresAt: string): string {
  const absolute = new Date(absoluteExpiresAt).getTime();
  return new Date(Math.min(now.getTime() + SESSION_IDLE_TIMEOUT_MS, absolute)).toISOString();
}

export function isSessionExpired(
  session: { readonly idleExpiresAt: string; readonly absoluteExpiresAt: string },
  now: Date,
): boolean {
  return (
    now.getTime() >= new Date(session.idleExpiresAt).getTime() ||
    now.getTime() >= new Date(session.absoluteExpiresAt).getTime()
  );
}
