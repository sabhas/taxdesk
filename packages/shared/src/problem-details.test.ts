import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema, RequestIdSchema } from './problem-details.js';

describe('RequestIdSchema', () => {
  it('accepts bounded header-safe request IDs', () => {
    expect(RequestIdSchema.safeParse('req-123').success).toBe(true);
    expect(RequestIdSchema.safeParse('0f2c4a3e-1b2c-4d5e-8f90-123456789abc').success).toBe(true);
    expect(RequestIdSchema.safeParse('a'.repeat(128)).success).toBe(true);
  });

  it('rejects empty, oversized, or header-injecting values', () => {
    expect(RequestIdSchema.safeParse('').success).toBe(false);
    expect(RequestIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(RequestIdSchema.safeParse('req-123\r\nX-Injected: yes').success).toBe(false);
    expect(RequestIdSchema.safeParse('req 123').success).toBe(false);
    expect(RequestIdSchema.safeParse('-leading').success).toBe(false);
  });
});

describe('ProblemDetailsSchema', () => {
  it('accepts a valid error with optional field errors', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: 'https://taxdesk.app/problems/validation-error',
      title: 'Validation Error',
      status: 422,
      code: 'VALIDATION_ERROR',
      detail: 'One or more fields are invalid.',
      requestId: 'req-123',
      errors: [{ field: 'email', message: 'Enter a valid email address.' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an error without field errors', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: 'https://taxdesk.app/problems/not-found',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested resource was not found.',
      requestId: 'req-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing fields, invalid status, and malformed codes', () => {
    const base = {
      type: 'https://taxdesk.app/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Please try again later.',
      requestId: 'req-123',
    };

    expect(ProblemDetailsSchema.safeParse({ ...base, requestId: undefined }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base, status: 200 }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base, status: 600 }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base, code: 'internal-error' }).success).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ ...base, errors: [] }).success).toBe(false);
  });

  it('rejects infrastructure extensions', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: 'https://taxdesk.app/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Please try again later.',
      requestId: 'req-123',
      databaseUrl: 'postgres://user:password@db.internal/taxdesk',
    });
    expect(result.success).toBe(false);
  });
});
