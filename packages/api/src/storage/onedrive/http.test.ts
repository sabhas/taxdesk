import { describe, expect, it } from 'vitest';
import { kindForGraphStatus, parseRetryAfter, readErrorCode } from './http.js';

describe('OneDrive HTTP helpers', () => {
  it('maps Graph statuses to error kinds', () => {
    expect(kindForGraphStatus(401)).toBe('unauthorized');
    expect(kindForGraphStatus(403)).toBe('rejected');
    expect(kindForGraphStatus(404)).toBe('not_found');
    expect(kindForGraphStatus(409)).toBe('conflict');
    expect(kindForGraphStatus(429)).toBe('rate_limited');
    expect(kindForGraphStatus(503)).toBe('unavailable');
    expect(kindForGraphStatus(400)).toBe('rejected');
    expect(kindForGraphStatus(413)).toBe('rejected');
    expect(kindForGraphStatus(416)).toBe('rejected');
  });

  it('parses Retry-After as seconds or a date', () => {
    const now = new Date('2026-11-11T10:00:00.000Z');
    expect(parseRetryAfter('15', now)).toBe(15);
    expect(parseRetryAfter('Wed, 11 Nov 2026 10:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('reads Graph and identity error codes', () => {
    expect(readErrorCode({ error: { code: 'itemNotFound' } })).toBe('itemNotFound');
    expect(readErrorCode({ error: 'invalid_grant' })).toBe('invalid_grant');
    expect(readErrorCode({})).toBeNull();
    expect(readErrorCode('x')).toBeNull();
  });
});
