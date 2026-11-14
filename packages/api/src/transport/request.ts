import type { Context } from 'hono';
import { type z } from 'zod';
import { IDEMPOTENCY_KEY_PATTERN } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { parseIfMatch } from './cookies.js';

/** Trusted Cloudflare client IP header, falling back to the first XFF hop. */
export function clientIp(c: Context<AppEnv>): string | undefined {
  const connecting = c.req.header('CF-Connecting-IP')?.trim();
  if (connecting !== undefined && connecting.length > 0 && connecting.length <= 64) {
    return connecting;
  }
  const forwarded = c.req.header('X-Forwarded-For');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 && first.length <= 64 ? first : undefined;
}

export function requestOrigin(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}

export function publicBaseUrl(c: Context<AppEnv>): string {
  const configured = c.get('dependencies').authConfig.appPublicUrl;
  return configured ?? requestOrigin(c);
}

/** Parses a JSON body with a shared Zod contract and maps failures to 400. */
export async function parseJsonBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Send a valid JSON request body.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the highlighted fields.', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? 'body' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function requireIfMatch(c: Context<AppEnv>): number {
  const header = c.req.header('If-Match');
  if (header === undefined) {
    throw new AuthError(
      428,
      'PRECONDITION_REQUIRED',
      'Send the record version in an If-Match header.',
    );
  }
  const version = parseIfMatch(header);
  if (version === null) {
    throw new AuthError(
      428,
      'PRECONDITION_REQUIRED',
      'The If-Match header is not a valid version.',
    );
  }
  return version;
}

export function setEtag(c: Context<AppEnv>, version: number): void {
  c.header('ETag', `"${String(version)}"`);
}

/**
 * Financial commands require an `Idempotency-Key` header so a network retry
 * returns the original outcome instead of repeating the entry.
 */
export function requireIdempotencyKey(c: Context<AppEnv>): string {
  const header = c.req.header('Idempotency-Key');
  if (header === undefined || header.trim().length === 0) {
    throw new AuthError(
      428,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send an Idempotency-Key header with this request.',
    );
  }
  const key = header.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'The Idempotency-Key header is not valid.', {
      errors: [
        {
          field: 'Idempotency-Key',
          message: 'Use 16 to 128 letters, digits, hyphens, or underscores.',
        },
      ],
    });
  }
  return key;
}
