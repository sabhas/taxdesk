export const SESSION_COOKIE_NAME = '__Host-taxdesk_session';

/** Parses a Cookie header into a small map. Duplicate names keep the first. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0 && cookies[name] === undefined) {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionTokenFromCookie(header: string | undefined): string | undefined {
  const value = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * `__Host-` cookies require Secure, Path=/, and no Domain attribute. The
 * browser only sends this cookie to the same origin, and SameSite=Strict keeps
 * cross-site form posts from carrying it.
 */
export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`,
  ].join('; ');
}

export function serializeClearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

/** Parses an If-Match header containing a single strong ETag (`"3"`). */
export function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined || !/^"[1-9]\d*"$/u.test(header)) {
    return null;
  }
  const version = Number(header.slice(1, -1));
  return Number.isSafeInteger(version) ? version : null;
}
