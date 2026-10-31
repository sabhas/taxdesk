import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ProblemDetailsSchema, type FieldError, type ProblemDetails } from '@taxdesk/shared';
import type { AppEnv } from './types.js';
import { REQUEST_ID_HEADER } from './middleware/request-id.js';

export interface ProblemDetailsInput {
  status: ContentfulStatusCode;
  code: string;
  title: string;
  detail: string;
  type?: string;
  errors?: FieldError[];
}

export function problemTypeForCode(code: string): string {
  return `https://taxdesk.app/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

export function buildProblemDetails(requestId: string, input: ProblemDetailsInput): ProblemDetails {
  return ProblemDetailsSchema.parse({
    type: input.type ?? problemTypeForCode(input.code),
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    requestId,
    ...(input.errors ? { errors: input.errors } : {}),
  });
}

/**
 * Maps a domain or transport failure to the public Problem Details contract.
 * Callers must never include secret, provider, or database values in `detail`.
 */
export function problemDetailsResponse(c: Context<AppEnv>, input: ProblemDetailsInput): Response {
  const requestId = c.get('requestId');
  const body = buildProblemDetails(requestId, input);
  return c.body(JSON.stringify(body), input.status, {
    'Content-Type': 'application/problem+json; charset=UTF-8',
    'Cache-Control': 'no-store',
    [REQUEST_ID_HEADER]: requestId,
  });
}
