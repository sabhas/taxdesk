import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema } from '@taxdesk/shared';
import { buildProblemDetails, problemTypeForCode } from './problem-details.js';

describe('problemTypeForCode', () => {
  it('builds a stable type URI from the error code', () => {
    expect(problemTypeForCode('VALIDATION_ERROR')).toBe(
      'https://taxdesk.app/problems/validation-error',
    );
  });
});

describe('buildProblemDetails', () => {
  it('builds a validated Problem Details body with request ID and field errors', () => {
    const problem = buildProblemDetails('req-123', {
      status: 422,
      code: 'VALIDATION_ERROR',
      title: 'Validation Error',
      detail: 'One or more fields are invalid.',
      errors: [{ field: 'name', message: 'Name is required.' }],
    });

    expect(ProblemDetailsSchema.safeParse(problem).success).toBe(true);
    expect(problem.requestId).toBe('req-123');
    expect(problem.errors).toEqual([{ field: 'name', message: 'Name is required.' }]);
  });
});
